/**
 * Conformance checking, graded rather than pass/fail.
 *
 * A binary suite would force every outcome into "supported" or "broken", and the honest
 * answer for most of them is neither: the mechanism is designed, sometimes documented,
 * and not yet witnessed. Grading by evidence keeps that distinction visible instead of
 * letting a reasoned claim inherit the credibility of a tested one.
 *
 * The suite's job is therefore to check claims against fixtures:
 *
 *   claimed `observed`  -> a real recording must exist, or the claim is downgraded
 *   claimed weaker      -> report it; a fixture found is a prompt to upgrade the claim
 *   claimed unsupported -> no fixture may exist
 *
 * It never upgrades a claim on its own. Finding evidence produces a recommendation,
 * because deciding that a fixture really demonstrates an outcome is a judgement about
 * the fixture, not a property of the file's existence.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AdapterCapabilities } from '../contract/session.ts'
import type { EvidenceLevel, Outcome } from '../contract/outcome.ts'
import { OUTCOMES } from '../contract/outcome.ts'
import { classify, evidence, emptyTranscriptState } from '../outcomes/classify.ts'
import { parseCodex } from '../transcript/parse.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const JOURNAL = join(ROOT, 'spikes', 'hooks', 'journal', 'hook-journal.ndjson')
const RESULTS = join(ROOT, 'spikes', 'hooks', 'results.ndjson')

export interface FixtureEvidence {
  found: boolean
  where?: string | undefined
  /** CLI version that produced the fixture, when the transcript records it. */
  cliVersion?: string | undefined
  /** True when the fixture predates the installed CLI. */
  historical?: boolean | undefined
}

export interface ConformanceRow {
  agent: string
  outcome: Outcome
  claimed: EvidenceLevel
  fixture: FixtureEvidence
  verdict: 'ok' | 'unsupported_claim' | 'upgrade_available' | 'contradiction'
  note?: string | undefined
}

export interface ConformanceReport {
  rows: ConformanceRow[]
  failures: ConformanceRow[]
  recommendations: ConformanceRow[]
}

/**
 * Version of the installed CLI, so a fixture can be compared against what is actually
 * running. Cached: this shells out.
 */
const versionCache = new Map<string, string>()

export function currentVersion(agent: string): string {
  const hit = versionCache.get(agent)
  if (hit) return hit
  let v = 'unknown'
  try {
    v = execFileSync(agent, ['--version'], { encoding: 'utf8', timeout: 30_000 })
      .trim()
      .split('\n')[0]!
  } catch {
    /* CLI absent or unwilling; unknown compares unequal to everything */
  }
  versionCache.set(agent, v)
  return v
}

/** Compare on the version number alone: "codex-cli 0.146.0" vs "0.146.0". */
export function sameVersion(a: string, b: string): boolean {
  const num = (s: string) => s.match(/\d+\.\d+\.\d+/)?.[0]
  const na = num(a)
  const nb = num(b)
  return na !== undefined && na === nb
}

function readNdjson(path: string): Record<string, any>[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
}

/**
 * Replay the recorded step-2/3 runs through the classifier and see which outcomes real
 * recordings actually produce. This is the same corpus the classifier was validated
 * against, used here to answer a different question: not "is the rule right" but "did
 * we ever witness this".
 */
function claudeFixtureOutcomes(): Map<Outcome, FixtureEvidence> {
  const byRun = new Map<string, { hooks: string[]; payloads: Record<string, any> }>()
  for (const r of readNdjson(JOURNAL)) {
    if (!r.run_id || r.phase !== 'fired') continue
    const e = byRun.get(r.run_id) ?? { hooks: [], payloads: {} }
    e.hooks.push(r.event)
    try {
      e.payloads[r.event] = JSON.parse(r.body ?? '{}')
    } catch {
      /* older records may lack a body */
    }
    byRun.set(r.run_id, e)
  }

  const found = new Map<Outcome, FixtureEvidence>()
  for (const res of readNdjson(RESULTS)) {
    const h = byRun.get(res.run_id)
    if (!h) continue
    const obs = res.obs ?? {}
    // Runs that did not exercise the scenario they are named for are not evidence.
    if ('saw_prompt' in obs || obs.note) continue

    const got = classify(
      evidence({
        agent: 'claude',
        hooks: h.hooks,
        hookPayloads: h.payloads,
        transcript: emptyTranscriptState(),
        process: {
          alive: res.scenario !== 'sigterm' && res.scenario !== 'sigkill',
          howEnded: obs.ended,
        },
        orchestrator: {
          sentCancel: res.scenario === 'interrupted',
          sentPermissionDecision: res.scenario === 'permission_denied' ? 'deny' : undefined,
          inputIsMediated: true,
        },
      }),
    )
    if (got.state !== 'in_progress' && !found.has(got.state)) {
      // Claude fixtures all come from the currently installed CLI; the journal records
      // the version the run was made against.
      const cliVersion = String(
        Object.values(h.payloads)[0]?.['cli_version'] ?? currentVersion('claude'),
      )
      found.set(got.state, {
        found: true,
        where: `${res.scenario} run ${String(res.run_id).slice(-10)}`,
        cliVersion,
        historical: !sameVersion(cliVersion, currentVersion('claude')),
      })
    }
  }
  return found
}

/**
 * Codex evidence comes from the live fixture run (spikes/codex/runs), falling back to
 * historical rollouts for anything the run did not cover.
 *
 * The distinction is the point of the temporal grade: a 2026-02 rollout proves the record
 * existed in 0.104.0, while a run recorded against the installed CLI proves current
 * behaviour.
 */
function codexFixtureOutcomes(): Map<Outcome, FixtureEvidence> {
  const found = new Map<Outcome, FixtureEvidence>()
  const current = currentVersion('codex')

  // --- live fixtures, current version ---------------------------------------------
  const runsDir = join(ROOT, 'spikes', 'codex', 'runs')
  if (existsSync(runsDir)) {
    for (const name of readdirSync(runsDir).filter((f) => f.endsWith('.json') && f !== 'summary.json')) {
      let obs: any
      try {
        obs = JSON.parse(readFileSync(join(runsDir, name), 'utf8'))
      } catch {
        continue
      }
      const events: string[] = (obs.hooks ?? []).map((h: any) => h.event)
      const aborts: string[] = obs.transcript?.abortReasons ?? []
      const evidence = (where: string): FixtureEvidence => ({
        found: true,
        where,
        cliVersion: current,
        historical: false,
      })

      if (obs.scenario === 'completed' && events.includes('Stop') && !found.has('completed')) {
        found.set('completed', evidence(`Stop + task_complete in ${name}`))
      }
      // A run only evidences cancellation if it actually aborted -- the first attempt
      // finished before the interrupt landed and recorded task_complete instead.
      if (obs.scenario === 'cancelled' && aborts.length > 0 && !found.has('cancelled')) {
        found.set('cancelled', evidence(`turn_aborted=${aborts[0]} in ${name}`))
      }
      // Refusal needs BOTH the permission event and the abort: turn_aborted alone is
      // indistinguishable from a user cancellation.
      if (
        obs.scenario === 'permission_deny' &&
        events.includes('PermissionRequest') &&
        aborts.length > 0 &&
        !found.has('permission_refused')
      ) {
        found.set('permission_refused', evidence(`PermissionRequest + turn_aborted in ${name}`))
      }
      // Death is evidenced by the ABSENCE of any terminal record alongside a killed
      // process, so this asserts what is missing rather than what is present.
      if (
        obs.scenario === 'process_exit' &&
        !events.includes('Stop') &&
        !events.includes('SessionEnd') &&
        aborts.length === 0 &&
        !(obs.transcript?.eventTypes ?? {})['task_complete'] &&
        !found.has('process_exited')
      ) {
        found.set('process_exited', evidence(`no terminal record after SIGTERM in ${name}`))
      }
    }
  }

  // --- historical rollouts, for anything the live run did not cover -----------------
  const root = join(homedir(), '.codex', 'sessions')
  if (!existsSync(root)) return found

  const files: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) files.push(p)
    }
  }
  walk(root)
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

  for (const f of files) {
    if (found.has('completed') && found.has('cancelled')) break
    const records = readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l)]
        } catch {
          return []
        }
      })
    const meta = records.find((r) => r.type === 'session_meta')
    const cliVersion = String(meta?.payload?.cli_version ?? 'unknown')
    const historical = !sameVersion(cliVersion, current)
    for (const t of parseCodex(records).turns) {
      if (t.state === 'completed' && !found.has('completed')) {
        found.set('completed', {
          found: true,
          where: `task_complete in ${f.split('/').pop()}`,
          cliVersion,
          historical,
        })
      }
      if (t.state === 'cancelled' && !found.has('cancelled')) {
        found.set('cancelled', {
          found: true,
          where: `turn_aborted in ${f.split('/').pop()}`,
          cliVersion,
          historical,
        })
      }
    }
  }
  return found
}

/**
 * OpenCode evidence, from the recorded stdout of `run --format json`.
 *
 * Simpler than the other two by a wide margin, and the simplicity is the finding rather
 * than a gap: there is no journal to correlate and no transcript to reconcile, because the
 * agent states its own terminal condition in the stream. A `step_finish` carrying
 * `reason: "stop"` IS the completion record.
 *
 * Only `completed` can be witnessed this way today. The other outcomes need a run that was
 * killed, timed out or lost, and none has been captured -- so they stay claimed at
 * `reasoned_but_unverified` and this function reports nothing for them, which is what keeps
 * the claim honest.
 */
function openCodeFixtureOutcomes(): Map<Outcome, FixtureEvidence> {
  const found = new Map<Outcome, FixtureEvidence>()
  const dir = join(ROOT, 'spikes', 'opencode', 'fixtures')
  if (!existsSync(dir)) return found

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ndjson'))) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('{')) continue
      let record: { type?: string; part?: { reason?: string } }
      try {
        record = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (record.type === 'step_finish' && record.part?.reason === 'stop') {
        found.set('completed', {
          found: true,
          where: `step_finish reason=stop in ${file}`,
          cliVersion: OPENCODE_FIXTURE_VERSION,
          historical: false,
        })
      }
    }
  }
  return found
}

/**
 * The OpenCode the fixtures were recorded against.
 *
 * Hardcoded rather than probed. `opencode --version` reports whatever is installed now,
 * which says nothing about what produced a file on disk -- and a fixture silently
 * re-attributed to a newer CLI is exactly the false reassurance `historical` exists to
 * prevent.
 */
const OPENCODE_FIXTURE_VERSION = '1.18.15'

/**
 * Kimi evidence, from a recorded `--output-format stream-json` run.
 *
 * The witness for `completed` is an assistant message carrying no tool calls -- the model
 * finishing rather than continuing. Weaker than OpenCode's announced `reason: "stop"`, which
 * is why the capability records confidence `inferred`; the fixture proves the outcome is
 * producible and parsed, not that the agent declared it.
 */
function kimiFixtureOutcomes(): Map<Outcome, FixtureEvidence> {
  const found = new Map<Outcome, FixtureEvidence>()
  const dir = join(ROOT, 'spikes', 'kimi', 'fixtures')
  if (!existsSync(dir)) return found
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ndjson'))) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('{')) continue
      let record: { role?: string; tool_calls?: unknown[] }
      try {
        record = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (record.role === 'assistant' && (record.tool_calls ?? []).length === 0) {
        found.set('completed', {
          found: true,
          where: `terminal assistant message in ${file}`,
          cliVersion: KIMI_FIXTURE_VERSION,
          historical: false,
        })
      }
    }
  }
  return found
}

/** The Kimi the fixtures were recorded against. Hardcoded, for the reason above. */
const KIMI_FIXTURE_VERSION = '1.49.0'

export function fixtureOutcomesFor(agent: string): Map<Outcome, FixtureEvidence> {
  if (agent === 'claude') return claudeFixtureOutcomes()
  if (agent === 'codex') return codexFixtureOutcomes()
  if (agent === 'opencode') return openCodeFixtureOutcomes()
  if (agent === 'kimi') return kimiFixtureOutcomes()
  return new Map()
}

export function checkAdapter(caps: AdapterCapabilities): ConformanceRow[] {
  const fixtures = fixtureOutcomesFor(caps.agent)
  const rows: ConformanceRow[] = []

  for (const outcome of OUTCOMES) {
    const claimed = caps.outcomes[outcome]
    const fixture: FixtureEvidence = fixtures.get(outcome) ?? { found: false }
    const witnessed = fixture.found

    let verdict: ConformanceRow['verdict'] = 'ok'
    let note: string | undefined

    if (claimed === 'observed' && !witnessed) {
      verdict = 'unsupported_claim'
      note = 'claimed observed, but no recording produces this outcome'
    } else if (claimed === 'observed' && fixture.historical) {
      // The distinction the temporal grade exists for: a fixture from an older CLI
      // proves the record and the parser shape existed, not that the installed version
      // still emits it under the same circumstances.
      verdict = 'unsupported_claim'
      note =
        `claimed observed, but the only fixture is from ${fixture.cliVersion} ` +
        `and ${caps.agent} is now ${currentVersion(caps.agent)}; claim observed_historically`
    } else if (claimed === 'observed_historically' && !witnessed) {
      verdict = 'unsupported_claim'
      note = 'claimed observed_historically, but no recording produces this outcome'
    } else if (claimed === 'observed_historically' && witnessed && !fixture.historical) {
      verdict = 'upgrade_available'
      note = 'the fixture matches the installed CLI; consider claiming observed'
    } else if (claimed === 'unsupported' && witnessed) {
      verdict = 'contradiction'
      note = 'claimed unsupported, yet a recording produces it'
    } else if (
      claimed !== 'observed' &&
      claimed !== 'observed_historically' &&
      claimed !== 'unsupported' &&
      witnessed
    ) {
      verdict = 'upgrade_available'
      note = fixture.historical
        ? 'a recording from an older CLI produces this; consider observed_historically'
        : 'a recording produces this; review the fixture and consider claiming observed'
    }

    rows.push({ agent: caps.agent, outcome, claimed, fixture, verdict, note })
  }
  return rows
}

export function runConformance(all: AdapterCapabilities[]): ConformanceReport {
  const rows = all.flatMap(checkAdapter)
  return {
    rows,
    failures: rows.filter((r) => r.verdict === 'unsupported_claim' || r.verdict === 'contradiction'),
    recommendations: rows.filter((r) => r.verdict === 'upgrade_available'),
  }
}

export function formatReport(report: ConformanceReport): string {
  const lines: string[] = []
  const pad = (s: string, n: number) => s.padEnd(n)
  lines.push(
    `${pad('agent', 8)} ${pad('outcome', 22)} ${pad('claimed', 32)} ${pad('verdict', 20)} fixture`,
  )
  for (const r of report.rows) {
    const fx = r.fixture.where
      ? `${r.fixture.where}${r.fixture.historical ? `  [from ${r.fixture.cliVersion}]` : ''}`
      : '-'
    lines.push(
      `${pad(r.agent, 8)} ${pad(r.outcome, 22)} ${pad(r.claimed, 32)} ${pad(r.verdict, 20)} ${fx}`,
    )
    if (r.note) lines.push(`${' '.repeat(8)} -> ${r.note}`)
  }
  lines.push('')
  lines.push(`${report.rows.length} claims, ${report.failures.length} failing`)
  if (report.recommendations.length) {
    lines.push(`${report.recommendations.length} claim(s) could be upgraded:`)
    for (const r of report.recommendations) {
      lines.push(`  ${r.agent}/${r.outcome}: ${r.fixture.where}`)
    }
  }
  return lines.join('\n')
}
