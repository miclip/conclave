#!/usr/bin/env node
/**
 * Codex runtime-semantics fixture collection.
 *
 * The classifier, revision semantics, evidence precedence and non-resurrection behaviour
 * are already decided and tested against either answer. This run establishes only which
 * runtime records Codex 0.146.0 actually emits:
 *
 *   - what accompanies task_complete
 *   - whether cancellation produces turn_aborted, Stop, or both
 *   - permission deny and allow
 *   - what process exit leaves in hooks and transcript
 *   - readiness, and when input is first accepted
 *
 * Corpus safety: the project's registered hooks default to writing
 * spikes/hooks/journal/hook-journal.ndjson, which is the FROZEN evidence corpus behind
 * the parity test's exact 17/4 counts. Every child here is launched with
 * SPIKE_HOOK_JOURNAL redirected, so nothing appends to it. That is done via the
 * environment rather than by editing hooks.json, because editing the sidecar would
 * re-hash the handlers and drop Codex trust.
 *
 *   node spikes/codex/collect.ts [scenario...]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sanitizedCopy } from '../../src/process/childenv.ts'
import { PtyProcess, squash, stripAnsi } from '../../src/process/pty.ts'
import { parseCodex } from '../../src/transcript/parse.ts'

const HERE = import.meta.dirname
const ROOT = join(HERE, '..', '..')
const OUT = join(HERE, 'runs')
const JOURNAL_DIR = join(HERE, 'journal')

const CODEX_ARGS = ['-c', 'check_for_update_on_startup=false', '-c', 'disable_paste_burst=true']

interface Observation {
  scenario: string
  runId: string
  hooks: { event: string; turnId?: string; payload: Record<string, any> }[]
  transcript?:
    | {
        path: string
        eventTypes: Record<string, number>
        turns: { key: string; state: string; confidence?: string | undefined }[]
        abortReasons: string[]
      }
    | undefined
  notes: Record<string, unknown>
}

function journalPath(runId: string): string {
  mkdirSync(JOURNAL_DIR, { recursive: true })
  return join(JOURNAL_DIR, `${runId}.ndjson`)
}

function readJournal(path: string) {
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
    .filter((r) => r.phase === 'fired')
    .map((r) => {
      let payload: Record<string, any> = {}
      try {
        payload = JSON.parse(r.body ?? '{}')
      } catch {
        /* keep empty */
      }
      return { event: r.event as string, turnId: payload.turn_id, payload }
    })
}

async function launch(runId: string, extraArgs: string[] = []) {
  const env = sanitizedCopy(process.env as Record<string, string>, {
    extra: { SPIKE_HOOK_JOURNAL: journalPath(runId), SPIKE_RUN_ID: runId },
  })
  const pty = await PtyProcess.spawn({
    file: 'codex',
    args: [...CODEX_ARGS, ...extraArgs],
    cwd: ROOT,
    env,
  })
  // Capture the raw stream for every run. If a dialog appears in wording we did not
  // anticipate, the observation must survive in the fixture rather than being lost to a
  // failed match -- there is only one chance to see a new runtime behaviour cleanly.
  pty.on('exit', () => {
    try {
      mkdirSync(OUT, { recursive: true })
      writeFileSync(join(OUT, `${runId}.pty.log`), pty.output)
    } catch {
      /* best effort */
    }
  })
  return pty
}

/** Codex renders inline; readiness here is spike-grade and only gates typing. */
async function waitComposer(pty: PtyProcess): Promise<boolean> {
  const interactive = await pty.waitForOutput(() => pty.isInteractive, 30_000)
  await pty.waitQuiet(1200, 25_000)
  return interactive
}

async function typeAndSubmit(pty: PtyProcess, text: string) {
  pty.write(text)
  await new Promise((r) => setTimeout(r, 500))
  pty.write('\r')
}

function transcriptFor(hooks: ReturnType<typeof readJournal>) {
  const withPath = hooks.find((h) => h.payload.transcript_path)
  if (!withPath) return undefined
  const path = withPath.payload.transcript_path as string
  if (!existsSync(path)) return undefined
  const records = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
  const eventTypes: Record<string, number> = {}
  const abortReasons: string[] = []
  for (const r of records) {
    if (r.type === 'event_msg') {
      const t = String(r.payload?.type)
      eventTypes[t] = (eventTypes[t] ?? 0) + 1
      if (t === 'turn_aborted') abortReasons.push(String(r.payload?.reason))
    }
  }
  const parsed = parseCodex(records)
  return {
    path,
    eventTypes,
    turns: parsed.turns.map((t) => ({
      key: String(t.key),
      state: t.state,
      confidence: t.confidence,
    })),
    abortReasons,
  }
}

// --- scenarios ----------------------------------------------------------------------

async function completed(runId: string): Promise<Observation> {
  const pty = await launch(runId)
  const notes: Record<string, unknown> = {}
  try {
    notes.interactive = await waitComposer(pty)
    await typeAndSubmit(pty, 'Reply with exactly CDX-N and nothing else, where N is 41 plus 1. No tools.')
    notes.answered = await pty.waitForOutput((a) => stripAnsi(a).includes('CDX-42'), 180_000)
    await pty.waitQuiet(2500, 40_000)
  } finally {
    notes.ended = (await pty.terminate()).reason
  }
  return finish('completed', runId, notes)
}

async function cancelled(runId: string): Promise<Observation> {
  const pty = await launch(runId)
  const notes: Record<string, unknown> = {}
  try {
    notes.interactive = await waitComposer(pty)
    // Counting to 500 finished in under seven seconds, so the first attempt sent ESC
    // after the turn was already over and recorded task_complete. Needs work that keeps
    // the model generating long enough to interrupt.
    await typeAndSubmit(
      pty,
      'Write a detailed 3000-word technical essay on the history of terminal emulators. ' +
        'Be exhaustive and do not stop early.',
    )
    // Interrupt only once it is demonstrably mid-turn, rather than after a fixed delay.
    notes.sawWorking = await pty.waitForOutput((a) => squash(a).includes('esctointerrupt'), 60_000)
    await new Promise((r) => setTimeout(r, 6000))
    pty.write('\x1b')
    await pty.waitQuiet(2500, 40_000)
  } finally {
    notes.ended = (await pty.terminate()).reason
  }
  return finish('cancelled', runId, notes)
}

async function permissionDeny(runId: string): Promise<Observation> {
  return permission(runId, 'deny')
}
async function permissionAllow(runId: string): Promise<Observation> {
  return permission(runId, 'allow')
}

async function permission(runId: string, decision: 'allow' | 'deny'): Promise<Observation> {
  // Default TUI settings approved an out-of-workspace write with no prompt at all, so
  // the first attempt never exercised a permission decision. A read-only sandbox forces
  // the model to escalate, and on-request approval means the escalation is put to the
  // user rather than auto-denied the way `codex exec` does it.
  const pty = await launch(runId, [
    '-c', 'approval_policy="on-request"',
    '-c', 'sandbox_mode="read-only"',
  ])
  const notes: Record<string, unknown> = { decision }
  try {
    notes.interactive = await waitComposer(pty)
    await typeAndSubmit(
      pty,
      `Use your file-writing tool to create /tmp/codex-perm-${decision}.txt containing the word probe. Do this immediately.`,
    )
    const sawDialog = await pty.waitForOutput((a) => {
      const s = squash(a)
      return (
        s.includes('Allowcommand') ||
        s.includes('Doyouwant') ||
        s.includes('Yes,proceed') ||
        s.includes('wantsto') ||
        s.includes('Approve') ||
        s.includes('requestsapproval') ||
        s.includes('Allowthis')
      )
    }, 120_000)
    notes.sawDialog = sawDialog
    if (sawDialog) {
      await new Promise((r) => setTimeout(r, 1500))
      // Encodings read off the captured dialog:
      //   1. Yes, proceed (y)
      //   2. Yes, and don't ask again for these files (a)
      //   3. No, and tell Codex what to do differently (esc)
      pty.write(decision === 'deny' ? '\x1b' : 'y')
      notes.sent = decision === 'deny' ? 'ESC' : 'y'
      await pty.waitQuiet(2500, 60_000)
    }
    notes.fileCreated = existsSync(`/tmp/codex-perm-${decision}.txt`)
  } finally {
    notes.ended = (await pty.terminate()).reason
  }
  return finish(`permission_${decision}`, runId, notes)
}

async function processExit(runId: string): Promise<Observation> {
  const pty = await launch(runId)
  const notes: Record<string, unknown> = {}
  try {
    notes.interactive = await waitComposer(pty)
    await typeAndSubmit(pty, 'Count slowly from 1 to 500, one number per line. Do not stop early.')
    await new Promise((r) => setTimeout(r, 7000))
    notes.ended = (await pty.terminate({ graceMs: 6000 })).reason
    await new Promise((r) => setTimeout(r, 2500))
  } catch (err) {
    notes.error = String(err)
  }
  return finish('process_exit', runId, notes)
}

async function readiness(runId: string): Promise<Observation> {
  const pty = await launch(runId)
  const notes: Record<string, unknown> = {}
  const t0 = Date.now()
  try {
    notes.interactive = await waitComposer(pty)
    notes.msToInteractive = Date.now() - t0
    // Does SessionStart arrive before any turn? Spike 2 said no; confirm on 0.146.0.
    notes.hooksBeforeAnyTurn = readJournal(journalPath(runId)).map((h) => h.event)
    const mark = pty.output.length
    pty.write('readiness-probe')
    notes.echoed = await pty.waitForOutput(
      (a) => squash(a.slice(mark)).includes('readiness-probe'),
      20_000,
    )
    notes.msToFirstAcceptedInput = Date.now() - t0
  } finally {
    notes.ended = (await pty.terminate()).reason
  }
  return finish('readiness', runId, notes)
}

function finish(scenario: string, runId: string, notes: Record<string, unknown>): Observation {
  const hooks = readJournal(journalPath(runId))
  return { scenario, runId, hooks, transcript: transcriptFor(hooks), notes }
}

const SCENARIOS: Record<string, (runId: string) => Promise<Observation>> = {
  readiness,
  completed,
  cancelled,
  permission_deny: permissionDeny,
  permission_allow: permissionAllow,
  process_exit: processExit,
}

async function main() {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const names = requested.length ? requested : Object.keys(SCENARIOS)

  const corpus = join(ROOT, 'spikes', 'hooks', 'journal', 'hook-journal.ndjson')
  const before = existsSync(corpus) ? readFileSync(corpus) : Buffer.alloc(0)

  mkdirSync(OUT, { recursive: true })
  const results: Observation[] = []

  for (const name of names) {
    const fn = SCENARIOS[name]
    if (!fn) throw new Error(`unknown scenario ${name}; have ${Object.keys(SCENARIOS).join(', ')}`)
    const runId = `codex-${name}-${Math.floor(Date.now() / 1000)}`
    process.stdout.write(`\n=== ${name} (${runId})\n`)
    const obs = await fn(runId)
    results.push(obs)

    const events = obs.hooks.map((h) => h.event)
    process.stdout.write(`    hooks:      ${events.join(', ') || '(none)'}\n`)
    process.stdout.write(`    transcript: ${JSON.stringify(obs.transcript?.eventTypes ?? {})}\n`)
    if (obs.transcript?.abortReasons.length) {
      process.stdout.write(`    aborts:     ${obs.transcript.abortReasons.join(', ')}\n`)
    }
    process.stdout.write(`    notes:      ${JSON.stringify(obs.notes)}\n`)
    writeFileSync(join(OUT, `${runId}.json`), JSON.stringify(obs, null, 2))
  }

  const after = existsSync(corpus) ? readFileSync(corpus) : Buffer.alloc(0)
  process.stdout.write(
    `\nfrozen corpus ${before.equals(after) ? 'UNTOUCHED' : '!!! MUTATED — investigate'}\n`,
  )
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(results, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
