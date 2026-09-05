/**
 * What a deadline MEANS on Codex, decided against the child's own transcript (#36, #35).
 *
 * The Claude side of this lives in `deadlineTranscript.test.ts` and the reasoning is the same:
 * a clock cannot tell a child stuck mid-work from one that finished and whose end-of-turn
 * signal never arrived, and the transcript can. What is NOT the same is what a Codex transcript
 * can say, which is why these are adapter tests rather than another parser suite.
 *
 * Codex writes three terminal records where Claude writes one inference:
 *
 *   task_complete                a real completion. Superseded to `completed`, seat sendable.
 *   task_complete with an error  the turn's machinery finished and produced a FAILURE (#35).
 *                                Terminal `unknown_abnormal_end`, proven from the transcript,
 *                                and the seat is sendable -- a turn that ended badly is still
 *                                a turn that ended.
 *   turn_aborted                 cancellation, covered elsewhere.
 *
 * The errored case is the one a parser test cannot settle. `parse.test.ts` proves the RECORD is
 * read correctly; what matters to a run is whether the adapter, at the moment a deadline fires,
 * rebuilds that into evidence, supersedes the verdict the clock minted, closes the transport
 * first so the replacement does not go out still claiming the child may be running, and leaves
 * the seat sendable. None of that is visible from the parser, and all of it is what #35 cost
 * when it was missing: an empty message forwarded as a report, a resend requested, and advisor
 * turns burned on a failure nobody was shown.
 *
 * The last test is the ownership branch. `#reconsiderDeadline` runs from the watchdog callback,
 * and under EXTERNAL input ownership that callback's verdict is `unknown_abnormal_end` rather
 * than `timed_out` -- the deadline rule degrades its own claim, because a keystroke it never
 * saw could have ended the turn. Gating the re-check on `timed_out` alone skipped it on exactly
 * those sessions. The degradation is about attributing an UNSEEN ending; it says nothing about
 * a record the child wrote down, so positive proof of completion must still recover the seat.
 *
 * Real adapter over a fake child: see `fakeCli.ts`.
 */

import { strict as assert } from 'node:assert'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type { AgentEvent, AgentSession, RevisionEvent, TurnEndEvent } from '../contract/session.ts'
import { CodexPtyHookAdapter } from './codex.ts'
import { installFakeClis } from './fakeCli.ts'
import { containAdapterRunDirs, tempDir } from '../testkit/tempDir.ts'

/**
 * The run directories the adapters this file boots make for themselves, contained.
 *
 * `Claude.#boot` and `Codex.#boot` each `mkdtemp` a run directory under `os.tmpdir()` and
 * never remove it. That is PRODUCTION behaviour and issue #203's business, not this file's --
 * so rather than change it, the floor it lands on moves: `tmpdir()` re-reads `TMPDIR` on every
 * call, so pointing it at a directory the testkit issued puts every run directory booted here
 * inside something whose lifetime the helper already owns.
 *
 * Per FILE, and that is what makes it safe rather than a shared global: every test file runs
 * in its own process under `node --test`, so this reaches no other suite, and the tests in
 * this one stay isolated from each other exactly as before -- by `tempDir` handing each its
 * own uniquely named child of this root.
 */
const ADAPTER_TMP_ROOT = containAdapterRunDirs()

const { dir: RUN } = installFakeClis()

/** As on the Claude side: the silence clock is what a real hang trips, so it is the one used. */
const IDLE_MS = 1_500
const ABSOLUTE_MS = 120_000

/**
 * The turn id the stand-in CLI puts on its first turn's hooks.
 *
 * Codex correlates by `turn_id` in BOTH channels, so the transcript records below have to use
 * the same one -- that is the whole reason this adapter matches by key where Claude has to
 * count positionally.
 */
const TURN = 'fake-turn-1'

const event = (payload: Record<string, unknown>): string =>
  JSON.stringify({ type: 'event_msg', timestamp: new Date(0).toISOString(), payload })

const started = (turnId: string) => event({ type: 'task_started', turn_id: turnId })
const prompt = (text: string) => event({ type: 'user_message', message: text })
const spoke = (text: string) => event({ type: 'agent_message', message: text })
const finished = (turnId: string, message: string) =>
  event({ type: 'task_complete', turn_id: turnId, last_agent_message: message })
/** The #35 record: terminal, and carrying a failure instead of a report. */
const failed = (turnId: string, info: string, message: string) =>
  event({
    type: 'task_complete',
    turn_id: turnId,
    last_agent_message: null,
    error: { codex_error_info: info, message },
  })

function transcriptOf(t: TestContext, ...lines: string[]): string {
  const path = join(tempDir(t, 'orch-codex-deadline'), 'rollout.jsonl')
  writeFileSync(path, lines.join('\n') + '\n')
  return path
}

/** Collect events until `done`, or give up. Returns what it saw either way. */
async function collect(
  session: AgentSession,
  done: (e: AgentEvent[]) => boolean,
  timeoutMs: number,
): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = []
  const deadline = Date.now() + timeoutMs
  const it = session.events()[Symbol.asyncIterator]()
  while (Date.now() < deadline) {
    let timer: NodeJS.Timeout | undefined
    const next = await Promise.race([
      it.next(),
      new Promise<'timeout'>((r) => {
        timer = setTimeout(() => r('timeout'), Math.max(0, deadline - Date.now()))
      }),
    ]).finally(() => clearTimeout(timer))
    if (next === 'timeout' || next.done) break
    seen.push(next.value)
    if (done(seen)) break
  }
  return seen
}

const endsOf = (e: AgentEvent[]): TurnEndEvent[] =>
  e.filter((x) => x.type === 'turn_end') as TurnEndEvent[]
const revisionsOf = (e: AgentEvent[]): RevisionEvent[] =>
  e.filter((x) => x.type === 'revision') as RevisionEvent[]

/** Start a codex session whose child announces `transcript`, with the clocks above. */
async function sessionOver(
  transcript: string,
  inputOwnership: 'mediated' | 'external' = 'mediated',
): Promise<AgentSession> {
  const previous = process.env['ORCH_FAKE_TRANSCRIPT']
  process.env['ORCH_FAKE_TRANSCRIPT'] = transcript
  try {
    return await CodexPtyHookAdapter.start({
      cwd: RUN,
      role: 'implementer',
      inputOwnership,
      watchdogMs: ABSOLUTE_MS,
      idleMs: IDLE_MS,
      readyTimeoutMs: 20_000,
    })
  } finally {
    if (previous === undefined) delete process.env['ORCH_FAKE_TRANSCRIPT']
    else process.env['ORCH_FAKE_TRANSCRIPT'] = previous
  }
}

test('codex: a deadline on a turn the transcript shows COMPLETE is superseded by completed', async (t) => {
  // The lost-end-of-turn population. Codex says `task_complete` outright, so this needs no
  // positional credit at all -- the record is keyed by the same `turn_id` the hook armed.
  const path = transcriptOf(t, started(TURN), prompt('hang please'), finished(TURN, 'all done, actually'))
  const session = await sessionOver(path)
  try {
    await session.send('hang please', { kind: 'orchestrator' })
    const events = await collect(
      session,
      (e) => endsOf(e).some((x) => x.verdict.outcome === 'completed'),
      20_000,
    )

    const ends = endsOf(events)
    const first = ends[0]
    assert.ok(first, `the deadline must fire first: ${JSON.stringify(events.map((e) => e.type))}`)
    assert.equal(first.verdict.outcome, 'timed_out', 'the clock reports what it sees, which is silence')
    assert.equal(first.transportOpen, true, 'and says the child was never seen to stop')

    const revision = revisionsOf(events).find((r) => r.replaces.includes(first.seq))
    assert.ok(revision, `the deadline verdict must be withdrawn: ${JSON.stringify(events.map((e) => e.type))}`)
    assert.equal(revision.reason, 'late_signal')

    const last = ends.at(-1)!
    assert.equal(last.verdict.outcome, 'completed', 'the transcript proved the turn ended')
    assert.notEqual(last.transportOpen, true, 'and the child is no longer executing anything')

    const key = await session.send('now the next thing', { kind: 'orchestrator' })
    assert.ok(String(key).length > 0, 'a turn proven finished must leave the session sendable')
  } finally {
    await session.close()
  }
})

test('codex: a deadline on a turn whose task_complete carried an ERROR is superseded, and the seat recovers (#35)', async (t) => {
  // The record that made #35 expensive, now arriving through the deadline path. Observed live as
  // `usage_limit_exceeded` with `last_agent_message: null` -- the workspace was out of credits.
  //
  // Three things have to happen together, and each was independently missing before: the verdict
  // must become terminal `unknown_abnormal_end` rather than staying a clock's guess; it must be
  // PROVEN from the transcript rather than inferred, because the child wrote it down; and the
  // seat must be sendable, because a turn that ended badly is still a turn that ended.
  const path = transcriptOf(
    t,
    started(TURN),
    prompt('hang please'),
    spoke('starting on it'),
    failed(TURN, 'usage_limit_exceeded', 'You have hit your usage limit.'),
  )
  const session = await sessionOver(path)
  try {
    await session.send('hang please', { kind: 'orchestrator' })
    const events = await collect(
      session,
      (e) => endsOf(e).some((x) => x.verdict.outcome === 'unknown_abnormal_end'),
      20_000,
    )

    const ends = endsOf(events)
    const first = ends[0]
    assert.ok(first, `the deadline must fire first: ${JSON.stringify(events.map((e) => e.type))}`)
    assert.equal(first.verdict.outcome, 'timed_out')
    assert.equal(first.transportOpen, true)

    const revision = revisionsOf(events).find((r) => r.replaces.includes(first.seq))
    assert.ok(revision, 'the clock verdict must be withdrawn, not left standing beside the truth')
    assert.equal(revision.reason, 'late_signal')

    const last = ends.at(-1)!
    assert.equal(
      last.verdict.outcome,
      'unknown_abnormal_end',
      'terminal, and NOT completed: there is no report here to forward',
    )
    assert.equal(last.verdict.confidence, 'proven', 'the child wrote this down; nothing is inferred')
    assert.ok(
      last.verdict.provenance.some(
        (p) => p.source === 'transcript' && /usage_limit_exceeded/.test(p.detail),
      ),
      `the reason must reach the operator: ${JSON.stringify(last.verdict.provenance)}`,
    )
    assert.notEqual(
      last.transportOpen,
      true,
      'the transport must be closed BEFORE the replacement verdict, or the seat stays unsendable',
    )

    // The recovery #35 needed and did not have. Without it the run's only options were to
    // forward an empty message or to hold the seat open forever.
    const key = await session.send('try something smaller', { kind: 'orchestrator' })
    assert.ok(String(key).length > 0, 'an errored turn must leave the seat usable')
  } finally {
    await session.close()
  }
})

test('codex: a deadline on a turn the transcript shows IN PROGRESS stands, and refuses a send', async (t) => {
  // #117's subject. `task_started` and narration, no terminal record of any kind. Nothing has
  // observed the child stop, so nothing may be typed at it.
  const path = transcriptOf(t, started(TURN), prompt('hang please'), spoke('still working on it'))
  const session = await sessionOver(path)
  try {
    await session.send('hang please', { kind: 'orchestrator' })
    const events = await collect(session, (e) => endsOf(e).length > 0, 20_000)

    const ends = endsOf(events)
    assert.equal(ends.length, 1, 'one verdict, and nothing that supersedes it')
    assert.equal(ends[0]!.verdict.outcome, 'timed_out')
    assert.equal(ends[0]!.transportOpen, true, 'the child may still be running, and the event says so')

    // Give the re-check every chance to have run and got it wrong.
    await new Promise((r) => setTimeout(r, 1_000))
    assert.equal(
      endsOf(await collect(session, () => true, 200)).length,
      0,
      'no second verdict may arrive: the transcript never proved this turn ended',
    )

    await assert.rejects(
      session.send('are you there', { kind: 'orchestrator' }),
      /turn is already open/,
      'a turn with no evidence of ending must not be sent into',
    )
  } finally {
    await session.close()
  }
})

test('codex: a transcript that cannot be read leaves the deadline exactly as it was', async (t) => {
  // Reading a directory throws, standing in for every way the check can fail to answer. All of
  // them keep the verdict and keep the transport open: an unreadable transcript and a wedged
  // child have causes in common, so "cannot tell" must never be resolved as "finished".
  const unreadable = tempDir(t, 'orch-codex-deadline-dir')
  const session = await sessionOver(unreadable)
  try {
    await session.send('hang please', { kind: 'orchestrator' })
    const events = await collect(session, (e) => endsOf(e).length > 0, 20_000)

    const ends = endsOf(events)
    assert.equal(ends.length, 1)
    assert.equal(ends[0]!.verdict.outcome, 'timed_out', 'an unreadable transcript proves nothing')
    assert.equal(ends[0]!.transportOpen, true)
    assert.ok(
      !revisionsOf(events).some((r) => r.reason === 'late_signal'),
      'and nothing may be withdrawn on the strength of a read that failed',
    )
    await assert.rejects(session.send('are you there', { kind: 'orchestrator' }), /turn is already open/)
  } finally {
    await session.close()
  }
})

test('codex: EXTERNAL input ownership still recovers a turn the transcript proves finished', async (t) => {
  // The ownership branch, and the reason it is a test rather than a comment.
  //
  // Under external ownership the deadline rule degrades its own verdict to
  // `unknown_abnormal_end (uncertain)`: a keystroke the orchestrator never saw could have ended
  // the turn, and it will not claim otherwise. `#reconsiderDeadline` used to gate on
  // `timed_out`, so on precisely these sessions -- a human sitting at the same terminal -- the
  // transcript was never consulted and a lost end-of-turn signal held the seat forever.
  //
  // The degradation is about ATTRIBUTING AN UNSEEN ENDING. It says nothing about a record the
  // child wrote down: `task_complete` is positive proof of completion, and who else could type
  // at the terminal does not weaken it. So the recovery has to be exactly as good here.
  const path = transcriptOf(t, started(TURN), prompt('hang please'), finished(TURN, 'finished while you were away'))
  const session = await sessionOver(path, 'external')
  try {
    assert.equal(session.guarantees.inputOwnership, 'external', 'precondition: the seat is externally owned')

    await session.send('hang please', { kind: 'orchestrator' })
    const events = await collect(
      session,
      (e) => endsOf(e).some((x) => x.verdict.outcome === 'completed'),
      20_000,
    )

    const ends = endsOf(events)
    const first = ends[0]
    assert.ok(first, `the deadline must fire first: ${JSON.stringify(events.map((e) => e.type))}`)
    assert.equal(
      first.verdict.outcome,
      'unknown_abnormal_end',
      'the ownership-degraded verdict is what the clock mints here, and it is what must be re-checked',
    )
    assert.equal(first.verdict.confidence, 'uncertain')
    assert.equal(first.transportOpen, true)

    const revision = revisionsOf(events).find((r) => r.replaces.includes(first.seq))
    assert.ok(
      revision,
      `the degraded verdict must be withdrawn too: ${JSON.stringify(events.map((e) => e.type))}`,
    )
    assert.equal(revision.reason, 'late_signal')

    const last = ends.at(-1)!
    assert.equal(last.verdict.outcome, 'completed', 'positive transcript proof survives external ownership')
    assert.notEqual(last.transportOpen, true)

    const key = await session.send('now the next thing', { kind: 'orchestrator' })
    assert.ok(String(key).length > 0, 'and the seat is usable again, exactly as under mediated input')
  } finally {
    await session.close()
  }
})
