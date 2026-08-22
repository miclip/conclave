/**
 * Parity check: the TypeScript classifier must agree with the Python one that was
 * validated 17/17 against the recorded corpus, on that same corpus.
 *
 * A rule engine rewritten in another language is exactly the kind of change that stays
 * plausible while quietly disagreeing with its predecessor, so this reads the real
 * step-2 recordings rather than hand-written cases. The hand-written cases below cover
 * the rules the corpus does not yet exercise.
 *
 *   node --test src/outcomes/classify.test.ts
 */

import { strict as assert } from 'node:assert'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { classify, evidence, emptyTranscriptState } from './classify.ts'
import type { Evidence, TranscriptState } from './classify.ts'
import type { Outcome } from '../contract/outcome.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const JOURNAL = join(ROOT, 'spikes', 'hooks', 'journal', 'hook-journal.ndjson')
const RESULTS = join(ROOT, 'spikes', 'hooks', 'results.ndjson')
const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects')

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

/** Mirrors outcomes.py:claude_transcript_state. */
function claudeTranscriptState(sessionId?: string): TranscriptState {
  const st = emptyTranscriptState()
  if (!sessionId || !existsSync(CLAUDE_PROJECTS)) return st
  let path: string | undefined
  for (const proj of readdirSync(CLAUDE_PROJECTS)) {
    const p = join(CLAUDE_PROJECTS, proj, `${sessionId}.jsonl`)
    if (existsSync(p)) {
      path = p
      break
    }
  }
  if (!path) return st
  st.exists = true
  let seenUser = false
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.type === 'user') {
      const c = d.message?.content
      if (typeof c === 'string') seenUser = true
      else if (Array.isArray(c)) {
        for (const x of c) if (x?.type === 'tool_result' && x.is_error) st.toolResultError = true
      }
    } else if (d.type === 'assistant' && seenUser) {
      st.hasAssistantAfterPrompt = true
      if (d.message?.stop_reason) st.finalStopReason = d.message.stop_reason
    }
  }
  return st
}

/** Ground truth, identical to outcomes.py:EXPECTED. */
const EXPECTED: Record<string, Outcome | null> = {
  normal: 'completed',
  two_turns: 'completed',
  tool_error: 'completed',
  session_start_only: null,
  interrupted: 'cancelled',
  permission_denied: 'permission_refused',
  sigterm: 'process_exited',
  sigkill: 'process_exited',
  slow_hook: 'completed',
  receiver_down: 'completed',
  hook_nonzero: 'completed',
}

/** Runs recorded under a scenario name that they did not actually exercise. */
function supersededReason(obs: Record<string, any>): string | undefined {
  if ('saw_prompt' in obs) return 'matched its own echoed prompt, never reached a dialog'
  if (obs.note) return String(obs.note)
  return undefined
}

function loadCorpus() {
  const byRun = new Map<string, { hooks: string[]; payloads: Record<string, any>; session?: string }>()
  for (const r of readNdjson(JOURNAL)) {
    if (!r.run_id || r.phase !== 'fired') continue
    const e = byRun.get(r.run_id) ?? { hooks: [], payloads: {} }
    e.hooks.push(r.event)
    if (r.session_id) e.session = r.session_id
    try {
      e.payloads[r.event] = JSON.parse(r.body ?? '{}')
    } catch {
      /* body may be absent on old records */
    }
    byRun.set(r.run_id, e)
  }

  return readNdjson(RESULTS)
    .filter((res) => byRun.has(res.run_id))
    .map((res) => {
      const h = byRun.get(res.run_id)!
      const obs = res.obs ?? {}
      return {
        runId: res.run_id as string,
        scenario: res.scenario as string,
        agent: res.agent as string,
        hooks: h.hooks,
        payloads: h.payloads,
        session: h.session,
        obs,
        ended: obs.ended as string | undefined,
      }
    })
}

function evidenceFor(c: ReturnType<typeof loadCorpus>[number]): Evidence {
  return evidence({
    agent: c.agent,
    hooks: c.hooks,
    hookPayloads: c.payloads,
    transcript: claudeTranscriptState(c.session),
    process: {
      alive: c.scenario !== 'sigterm' && c.scenario !== 'sigkill',
      howEnded: c.ended,
    },
    orchestrator: {
      sentCancel: c.scenario === 'interrupted',
      sentPermissionDecision: c.scenario === 'permission_denied' ? 'deny' : undefined,
      inputIsMediated: true,
    },
  })
}

test('parity with the validated Python classifier over the recorded corpus', () => {
  const corpus = loadCorpus()
  assert.ok(corpus.length > 0, 'no recorded corpus found; run the step-2 matrix first')

  let checked = 0
  const skipped: string[] = []
  const mismatches: string[] = []

  for (const c of corpus) {
    const expected = EXPECTED[c.scenario]
    if (expected == null) continue
    const why = supersededReason(c.obs)
    if (why) {
      skipped.push(`${c.scenario} ${c.runId.slice(-10)}: ${why}`)
      continue
    }
    const got = classify(evidenceFor(c))
    checked++
    if (got.state !== expected) {
      mismatches.push(`${c.scenario} ${c.runId.slice(-10)}: expected ${expected}, got ${got.state}`)
    }
  }

  // The Python run reports 17 classified / 0 mismatches / 4 excluded.
  //
  // These counts are exact ON PURPOSE. The corpus is labelled evidence supporting the
  // conformance claims, not an append-only runtime log, so a spike rerun that appends
  // records SHOULD break this test. See docs/NOTES.md, "Evidence corpus counts are
  // intentionally exact" — updating the baseline requires reviewing the new evidence,
  // its expected classifications, supersession relationships, parity and any affected
  // grades. Do not loosen this to a lower bound to make casual reruns pass.
  assert.deepEqual(mismatches, [], `classifier disagrees with ground truth:\n${mismatches.join('\n')}`)
  assert.equal(checked, 17, `expected 17 classifiable runs, found ${checked}`)
  assert.equal(skipped.length, 4, `expected 4 superseded runs, found ${skipped.length}`)
})

test('Stop proves completion even when a tool failed', () => {
  const got = classify(
    evidence({
      agent: 'claude',
      hooks: ['Stop'],
      transcript: { ...emptyTranscriptState(), toolResultError: true, finalStopReason: 'end_turn' },
    }),
  )
  assert.equal(got.state, 'completed')
  assert.equal(got.confidence, 'proven')
  assert.ok(got.provenance!.some((p) => p.caveat), 'the tool failure should survive as a caveat')
})

test('codex proves cancellation from its transcript, with no hooks at all', () => {
  const got = classify(
    evidence({
      agent: 'codex',
      transcript: { ...emptyTranscriptState(), exists: true, turnAbortedReason: 'interrupted' },
    }),
  )
  assert.equal(got.state, 'cancelled')
  assert.equal(got.confidence, 'proven')
})

test('claude cancellation is only ever assumed, and degrades when input is not ours', () => {
  const mediated = classify(
    evidence({ agent: 'claude', orchestrator: { sentCancel: true, inputIsMediated: true } }),
  )
  assert.equal(mediated.state, 'cancelled')
  assert.equal(mediated.confidence, 'assumed')

  const external = classify(
    evidence({ agent: 'claude', orchestrator: { sentCancel: true, inputIsMediated: false } }),
  )
  assert.equal(external.state, 'cancelled')
  assert.equal(external.confidence, 'uncertain')
})

test('the watchdog never returns cancelled', () => {
  const mediated = classify(evidence({ agent: 'claude', elapsedSeconds: 400, watchdogSeconds: 300 }))
  assert.equal(mediated.state, 'timed_out')

  const external = classify(
    evidence({
      agent: 'claude',
      elapsedSeconds: 400,
      watchdogSeconds: 300,
      orchestrator: { sentCancel: false, inputIsMediated: false },
    }),
  )
  assert.equal(external.state, 'unknown_abnormal_end')

  for (const v of [mediated, external]) {
    assert.notEqual(v.state, 'cancelled')
    assert.ok(
      v.provenance!.some((p) => p.detail.includes('not evidence of cancellation')),
      'the caveat must be carried, not implied',
    )
  }
})

test('silence within the watchdog is in_progress, not an abnormal end', () => {
  const got = classify(evidence({ agent: 'claude', elapsedSeconds: 10, watchdogSeconds: 300 }))
  assert.equal(got.state, 'in_progress')
  assert.equal(got.confidence, undefined, 'a non-terminal state must not carry a verdict')
})

test('a dead process outranks a pending permission request', () => {
  const got = classify(
    evidence({
      agent: 'claude',
      hooks: ['PermissionRequest', 'SessionEnd'],
      hookPayloads: { PermissionRequest: { tool_name: 'Write' }, SessionEnd: { reason: 'other' } },
      process: { alive: false, howEnded: 'sigterm' },
    }),
  )
  assert.equal(got.state, 'process_exited')
  assert.equal(got.confidence, 'proven')
})

test('an unclean death is inferred, not proven', () => {
  const got = classify(
    evidence({ agent: 'claude', hooks: ['SessionStart'], process: { alive: false, howEnded: 'sigkill' } }),
  )
  assert.equal(got.state, 'process_exited')
  assert.equal(got.confidence, 'inferred')
})

test('transcript-evidenced completion outranks process death (hook-loss recovery)', () => {
  // The case the live checkpoint caught: a turn finished, its Stop delivery was lost,
  // and the session was then shut down. Reporting process_exited here would be cleanup
  // manufacturing an outcome the transcript contradicts.
  const got = classify(
    evidence({
      agent: 'claude',
      hooks: ['SessionStart', 'UserPromptSubmit'],
      transcript: {
        ...emptyTranscriptState(),
        exists: true,
        hasAssistantAfterPrompt: true,
        finalStopReason: 'end_turn',
      },
      process: { alive: false, howEnded: 'sigterm' },
    }),
  )
  assert.equal(got.state, 'completed')
  assert.equal(got.confidence, 'inferred', 'only Stop proves completion')
  assert.ok(
    got.provenance!.some((p) => p.caveat && p.detail.includes('no Stop delivery')),
    'recovery must be visible, not silently equivalent to a real Stop',
  )
})

test('an unfinished turn in a dead process is still process_exited', () => {
  // The guard on the rule above: transcript evidence must be of COMPLETION, not merely
  // of the transcript existing.
  const got = classify(
    evidence({
      agent: 'claude',
      hooks: ['SessionStart', 'UserPromptSubmit', 'SessionEnd'],
      hookPayloads: { SessionEnd: { reason: 'other' } },
      transcript: { ...emptyTranscriptState(), exists: true, hasAssistantAfterPrompt: false },
      process: { alive: false, howEnded: 'sigterm' },
    }),
  )
  assert.equal(got.state, 'process_exited')
})

test('the TS classifier has one rule the Python reference lacks', () => {
  // Transcript-evidenced completion was added after the live checkpoint exposed the gap.
  // The recorded corpus does not exercise it -- every corpus run either has a Stop or has
  // no transcript completion -- so the parity assertion above still holds. This test
  // exists so the divergence is stated rather than discovered later.
  const pythonWouldSay = classify(
    evidence({
      agent: 'claude',
      hooks: ['SessionStart'],
      transcript: {
        ...emptyTranscriptState(),
        hasAssistantAfterPrompt: true,
        finalStopReason: 'end_turn',
      },
    }),
  )
  assert.equal(pythonWouldSay.state, 'completed')
})

// --- an errored task_complete (#35) ------------------------------------------------

test('an errored task_complete is terminal, proven, and not a completion (#35)', () => {
  // Observed live on Codex: `task_complete` with `error.codex_error_info = usage_limit_exceeded`
  // and `last_agent_message: null`. The turn's machinery finished; what it produced is a
  // failure. Two facts, both true, and collapsing them either way is a bug -- calling it
  // `completed` forwards an empty message as a report, and calling it `in_progress` leaves a
  // turn open that the child has already closed.
  const got = classify(
    evidence({
      agent: 'codex',
      transcript: {
        ...emptyTranscriptState(),
        exists: true,
        taskComplete: true,
        taskCompleteError: 'usage_limit_exceeded: out of credits',
      },
    }),
  )
  assert.equal(got.state, 'unknown_abnormal_end', 'terminal: the child said the turn ended')
  assert.equal(got.confidence, 'proven', 'the transcript says so directly; nothing is inferred')
  assert.ok(
    got.provenance!.some((p) => p.source === 'transcript' && /usage_limit_exceeded/.test(p.detail)),
    `the reason must survive into the verdict: ${JSON.stringify(got.provenance)}`,
  )
  assert.ok(
    got.provenance!.some((p) => p.caveat && /no report/.test(p.detail)),
    'and the absence of a report must be stated, since there is nothing to forward',
  )
})

test('an errored task_complete outranks a Stop that fired alongside it (#35)', () => {
  // The ordering that IS the fix. Codex reaches a turn boundary on an errored completion too,
  // so a `Stop` is very likely present -- and rule 3 reads a `Stop` as `completed/proven`. Let
  // that rule see it first and the relay is handed an empty message to forward, the implementer
  // asks for a resend, and the run burns advisor turns on a failure nobody was shown.
  const got = classify(
    evidence({
      agent: 'codex',
      hooks: ['UserPromptSubmit', 'Stop'],
      transcript: {
        ...emptyTranscriptState(),
        exists: true,
        taskComplete: true,
        taskCompleteError: 'usage_limit_exceeded: out of credits',
      },
    }),
  )
  assert.equal(got.outcome, 'unknown_abnormal_end', 'the error outranks the boundary signal')
  assert.ok(
    got.provenance!.some((p) => p.caveat && p.source === 'hook' && /terminal boundary/.test(p.detail)),
    'and says what the Stop actually proved, rather than dropping it silently',
  )
})

test('a turn_aborted still outranks an errored task_complete', () => {
  // The other side of the ordering. An abort is a more specific account of an ending than "it
  // ended badly", and on Codex a denied permission is IMPLEMENTED as an abort -- so ranking the
  // error above it would report a refusal as a vendor failure.
  const got = classify(
    evidence({
      agent: 'codex',
      transcript: {
        ...emptyTranscriptState(),
        exists: true,
        taskComplete: true,
        taskCompleteError: 'usage_limit_exceeded: out of credits',
        turnAbortedReason: 'interrupted',
      },
    }),
  )
  assert.equal(got.outcome, 'cancelled')
  assert.equal(got.confidence, 'proven')
})

test('an errored task_complete outranks a deadline, and is not weakened by input ownership', () => {
  // Two claims in one, because they are the same claim. This is POSITIVE evidence from the
  // child about how its turn ended, so it must supersede a verdict a clock minted from silence
  // -- and it must not degrade when someone else can type at the terminal, because who else
  // could type changes nothing about what the child wrote down.
  const state: TranscriptState = {
    ...emptyTranscriptState(),
    exists: true,
    taskComplete: true,
    taskCompleteError: 'usage_limit_exceeded: out of credits',
  }
  const timedOut = classify(
    evidence({ agent: 'codex', transcript: state, idleSeconds: 900, watchdogSeconds: 2_700 }),
  )
  assert.equal(timedOut.outcome, 'unknown_abnormal_end')
  assert.equal(timedOut.confidence, 'proven', 'a clock reading cannot weaken a written record')
  assert.ok(
    timedOut.provenance!.every((p) => !/no output for/.test(p.detail)),
    'and the verdict is the error, not the silence that happened to be measured beside it',
  )

  const external = classify(
    evidence({
      agent: 'codex',
      transcript: state,
      orchestrator: { sentCancel: false, inputIsMediated: false },
    }),
  )
  assert.deepEqual(
    { outcome: external.outcome, confidence: external.confidence },
    { outcome: 'unknown_abnormal_end', confidence: 'proven' },
    'external input ownership weakens attribution of an UNSEEN ending, not a recorded one',
  )
})
