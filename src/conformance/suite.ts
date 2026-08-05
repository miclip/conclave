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
  where?: string
  /** CLI version that produced the fixture, when the transcript records it. */
  cliVersion?: string
  /** True when the fixture predates the installed CLI. */
  historical?: boolean
}

export interface ConformanceRow {
  agent: string
  outcome: Outcome
  claimed: EvidenceLevel
  fixture: FixtureEvidence
  verdict: 'ok' | 'unsupported_claim' | 'upgrade_available' | 'contradiction'
  note?: string
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

/** Codex has no adapter yet, so its evidence is whatever its transcripts already show. */
function codexFixtureOutcomes(): Map<Outcome, FixtureEvidence> {
  const found = new Map<Outcome, FixtureEvidence>()
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
  // Newest first: recent rollouts match the installed CLI version.
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

  for (const f of files) {
    if (found.size >= 2) break
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
    // session_meta records the CLI that wrote the rollout -- the whole point of the
    // temporal grade is that an old rollout proves the old version's behaviour.
    const meta = records.find((r) => r.type === 'session_meta')
    const cliVersion = String(meta?.payload?.cli_version ?? 'unknown')
    const historical = !sameVersion(cliVersion, currentVersion('codex'))
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

export function fixtureOutcomesFor(agent: string): Map<Outcome, FixtureEvidence> {
  if (agent === 'claude') return claudeFixtureOutcomes()
  if (agent === 'codex') return codexFixtureOutcomes()
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
