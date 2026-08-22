/**
 * A shutdown must not be parked by a transcript read that is never coming back.
 *
 * `close('graceful')` reconciles from the transcript on its way out, and it does so with no
 * bound of its own -- deliberately, because the point of that reconcile is to settle the turns
 * on the strongest evidence available before the process is terminated. That made it the worst
 * caller of a read that could wedge: not delayed, parked, and the event stream that #143 has to
 * end parked behind it.
 *
 * So `close()` gives up on whatever read is in flight before it reconciles. From that moment the
 * view is stalled: it answers callers instead of queueing them, so the shutdown comes back.
 *
 * What it does NOT get is a read of its own. Nothing at this layer can cancel a filesystem
 * operation, so the read it gave up on is still running, and authorising a second one against a
 * file that is not answering is the thing the view refuses to do at any price -- least of all
 * during a shutdown. `transcript/reconcile.ts` (`#reads`) holds the argument; these are the
 * consequences at the adapter boundary, which are not all comfortable:
 *
 *   the bounded retry     is answered at its own bound, which is what frees its single-flight
 *                         slot. It does not reach the filesystem while the wedge holds, and no
 *                         retry ever will -- so a turn whose only proof is in the transcript is
 *                         not recovered until the read comes back. The run is not stuck; it is
 *                         uninformed, which is the honest state of a process that cannot read.
 *   Codex cancellation    comes back on its own evidence budget rather than parking on the
 *                         read. Under a wedge it spends that budget and reports what it can
 *                         actually support, instead of the child's own `turn_aborted` record.
 *
 * Both of those used to look better than they were: the wedge here holds ONE poll, so a second
 * read walked straight past it. A filesystem that is not answering does not work that way, and
 * a second read into it is not a retry -- it is one more descriptor held by the same wedge.
 *
 * Driven through the REAL adapters over a stand-in child (`fakeCli.ts`), with the wedge inside
 * the real view queue (`transcript/tailWedge.ts`), because the claims are about what `close()`,
 * a deadline retry and `cancel()` do -- not about what the view does when asked nicely.
 *
 *   node --test src/adapters/wedgedTranscriptRead.test.ts
 */

import { strict as assert } from 'node:assert'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AgentEvent, AgentSession, RevisionEvent, TurnEndEvent } from '../contract/session.ts'
import { wedgeOneTailPoll, type TailWedge } from '../transcript/tailWedge.ts'
import { ClaudePtyHookAdapter } from './claude.ts'
import { CANCEL_EVIDENCE_BUDGET_MS, CodexPtyHookAdapter } from './codex.ts'
import { installFakeClis } from './fakeCli.ts'

const { dir: RUN } = installFakeClis()

/**
 * Far enough out that no clock fires during this test.
 *
 * The subject is the close path, not the deadline. A watchdog going off mid-test would start a
 * bounded re-check of its own and put a second reader on the queue, which is a different story
 * with its own suite.
 */
const IDLE_MS = 120_000
const ABSOLUTE_MS = 300_000

/** The tail runs on a 400ms interval, so this is several chances to be caught. */
const CATCH_MS = 2_000

const userRecord = (content: string): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content } })

const workingRecord = (text: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

function scratch(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'orch-wedge-')), name)
}

async function sessionOver(transcript: string): Promise<AgentSession> {
  const previous = process.env['ORCH_FAKE_TRANSCRIPT']
  process.env['ORCH_FAKE_TRANSCRIPT'] = transcript
  try {
    return await ClaudePtyHookAdapter.start({
      cwd: RUN,
      role: 'implementer',
      inputOwnership: 'mediated',
      watchdogMs: ABSOLUTE_MS,
      idleMs: IDLE_MS,
      readyTimeoutMs: 20_000,
    })
  } finally {
    if (previous === undefined) delete process.env['ORCH_FAKE_TRANSCRIPT']
    else process.env['ORCH_FAKE_TRANSCRIPT'] = previous
  }
}

test('claude: close() completes while a transcript read is wedged inside the view queue', async () => {
  const transcript = scratch('wedged.jsonl')
  writeFileSync(transcript, [userRecord('hang please'), workingRecord('still working on it')].join('\n') + '\n')

  const wedge = wedgeOneTailPoll()
  let session: AgentSession | undefined
  let released = false
  try {
    session = await sessionOver(transcript)
    // The send takes its own snapshot first, to record how many turns the transcript held
    // before the prompt was typed. Arming before that wedges the send itself, which is a
    // different hang and not the one under test.
    await session.send('hang please', { kind: 'orchestrator' })
    wedge.arm()

    const caught = Date.now() + CATCH_MS
    while (!wedge.taken && Date.now() < caught) await new Promise((r) => setTimeout(r, 25))
    assert.equal(wedge.taken, true, 'precondition: the tailer must actually be holding the read')

    // The claim. Nothing releases the wedge, and `close()` must still come back -- and come back
    // on its own account rather than by waiting out the view's read lease, which is three orders
    // of magnitude longer than the budget below.
    const started = Date.now()
    await Promise.race([
      session.close(),
      new Promise((_r, reject) =>
        setTimeout(() => reject(new Error('close() never returned; the wedged read still parks it')), 8_000),
      ),
    ])
    const waited = Date.now() - started
    assert.equal(released, false, 'and it did it with the read still held, not because the wedge lifted')
    assert.ok(waited < 8_000, `close() took ${waited}ms`)

    // The stream has to END, because that is what everything downstream of a close waits for
    // (#143). A close that returns while its queue stays open is not a close.
    const seen: string[] = []
    for await (const e of session.events()) seen.push(e.type)
    assert.ok(seen.length >= 0, 'the event iteration terminated rather than hanging')
  } finally {
    released = true
    wedge.release()
    wedge.restore()
    await session?.close()
  }
})

// --- Codex: the bounded retry, and the cancellation ---------------------------------------

/** Codex records, in the shape `parseCodex` reads. Same builders as `codexDeadlineTranscript`. */
const codexEvent = (payload: Record<string, unknown>): string =>
  JSON.stringify({ type: 'event_msg', timestamp: new Date(0).toISOString(), payload })

const started = (turnId: string): string => codexEvent({ type: 'task_started', turn_id: turnId })
const prompted = (text: string): string => codexEvent({ type: 'user_message', message: text })
const finished = (turnId: string, message: string): string =>
  codexEvent({ type: 'task_complete', turn_id: turnId, last_agent_message: message })
const aborted = (turnId: string): string =>
  codexEvent({ type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' })

/** The turn ids the stand-in CLI puts on its hooks, in order. */
const TURN_ONE = 'fake-turn-1'
const TURN_TWO = 'fake-turn-2'

/**
 * Short enough that a deadline lands promptly, long enough to survive a hook round trip.
 *
 * The silence clock, as everywhere else: it is what a real hang trips, and the absolute one
 * must stay out of reach or a turn ended by the wrong clock would still read `timed_out` and
 * the test would pass without checking what it meant to.
 */
const DEADLINE_IDLE_MS = 1_200

async function codexSessionOver(transcript: string, idleMs: number): Promise<AgentSession> {
  const previous = process.env['ORCH_FAKE_TRANSCRIPT']
  process.env['ORCH_FAKE_TRANSCRIPT'] = transcript
  try {
    return await CodexPtyHookAdapter.start({
      cwd: RUN,
      role: 'implementer',
      inputOwnership: 'mediated',
      watchdogMs: ABSOLUTE_MS,
      idleMs,
      readyTimeoutMs: 20_000,
    })
  } finally {
    if (previous === undefined) delete process.env['ORCH_FAKE_TRANSCRIPT']
    else process.env['ORCH_FAKE_TRANSCRIPT'] = previous
  }
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

const endsOf = (e: AgentEvent[]): TurnEndEvent[] => e.filter((x) => x.type === 'turn_end') as TurnEndEvent[]

/** Arm the wedge and wait until the tailer has actually walked into it. */
async function heldBy(wedge: TailWedge): Promise<void> {
  wedge.arm()
  const until = Date.now() + CATCH_MS
  while (!wedge.taken && Date.now() < until) await new Promise((r) => setTimeout(r, 25))
  assert.equal(wedge.taken, true, 'precondition: the tailer must actually be holding the read')
}

/**
 * How long the stand-in child waits before it ends a turn with `Stop`.
 *
 * The seat-reopener, and it is chosen rather than `cancel()` on purpose: cancellation detaches
 * in-flight reads itself, so a retry test that cancelled between its two turns would pass on
 * either mechanism and prove neither. A `Stop` hook never touches the view's reads.
 *
 * It has to land after turn one's re-check has spent its bound (deadline + DEADLINE_TRANSCRIPT_MS
 * = ~3.2s) and before anything else needs to happen.
 */
const STOP_AFTER_MS = 4_000

test('codex: a deadline retry is answered at its own bound and reads nothing while the wedge holds', async () => {
  // The blocker, and the shape of the answer to it that is actually available.
  //
  // `BoundedSingleFlight` gives up its slot at `DEADLINE_TRANSCRIPT_MS` so that the NEXT
  // deadline can make a fresh attempt. What it used to be given was a read: turn one's expiry
  // detached the head, the queue advanced, and turn two's re-check walked past the wedge and
  // read the file. That worked here because this wedge holds exactly ONE poll. A filesystem
  // that is not answering does not hold exactly one poll, and the second read was not a retry
  // -- it was a second outstanding operation against the same unresponsive file, one more per
  // lease interval for as long as the condition lasted.
  //
  // So the retry is ANSWERED and not served. Two things have to be true at once, and this test
  // is about both: no second read is authorised while the first is outstanding, and the run
  // does not seize up -- every deadline comes back, every turn ends, and the seat stays usable.
  // What is lost while the file cannot be read is transcript EVIDENCE, and the turn then ends on
  // whatever else the adapter has: here, the child's own `Stop`.
  const path = join(mkdtempSync(join(tmpdir(), 'orch-wedge-codex-')), 'rollout.jsonl')
  writeFileSync(path, [started(TURN_ONE), prompted('hang please')].join('\n') + '\n')

  const wedge = wedgeOneTailPoll()
  const previousStop = process.env['ORCH_FAKE_STOP_MS']
  process.env['ORCH_FAKE_STOP_MS'] = String(STOP_AFTER_MS)
  let session: AgentSession | undefined
  let released = false
  try {
    session = await codexSessionOver(path, DEADLINE_IDLE_MS)
    await session.send('hang please', { kind: 'orchestrator' })
    // Armed after the send, so the send's own baseline read is behind us, and before the
    // deadline, so the read the deadline queues behind is this one.
    await heldBy(wedge)
    const before = wedge.calls

    const first = await collect(
      session,
      (e) => endsOf(e).some((x) => x.verdict.outcome === 'completed'),
      20_000,
    )
    const firstEnds = endsOf(first)
    assert.equal(firstEnds[0]?.verdict.outcome, 'timed_out', 'the clock fires on turn one')
    assert.equal(
      firstEnds.at(-1)?.verdict.outcome,
      'completed',
      `turn one has to end for the seat to be usable again: ${JSON.stringify(first.map((e) => e.type))}`,
    )
    assert.equal(released, false, 'precondition: the wedge is still held, and stays held')

    // Turn two, and a transcript that proves it finished. The record is there; what is not there
    // is any way to read it, and the point of this test is that the adapter does not try to make
    // one by opening a second read.
    appendFileSync(path, [started(TURN_TWO), prompted('and again'), finished(TURN_TWO, 'done')].join('\n') + '\n')
    await session.send('and again', { kind: 'orchestrator' })

    const second = await collect(
      session,
      (e) => endsOf(e).some((x) => x.verdict.outcome === 'completed'),
      12_000,
    )
    assert.equal(released, false, 'and it was still held throughout')

    // THE INVARIANT. Two turns, two deadlines, two bounded re-checks, a 400ms tailer running the
    // whole time, and a shutdown-free run of roughly ten seconds: not one further read.
    assert.equal(
      wedge.calls,
      before,
      `no second read may be authorised while the first is outstanding: ${wedge.calls - before} were`,
    )

    const ends = endsOf(second)
    const clock = ends[0]
    assert.ok(clock, `the deadline must fire on turn two: ${JSON.stringify(second.map((e) => e.type))}`)
    assert.equal(clock.verdict.outcome, 'timed_out', 'the clock reports silence, as it must')

    // And the run keeps moving. The turn ends, the seat reopens, and the verdict says where it
    // came from -- the child's `Stop`, because the transcript could not be consulted. That is
    // the cost, stated rather than hidden: while a read is wedged, transcript evidence is not
    // available to anyone, and a verdict that claimed otherwise would be inventing it.
    const recovered = ends.at(-1)!
    assert.equal(recovered.verdict.outcome, 'completed', 'the seat is not left stuck by the wedge')
    assert.ok(
      !recovered.verdict.provenance.some((p) => p.source === 'transcript'),
      `nothing can have come from the file while it cannot be read: ${JSON.stringify(recovered.verdict.provenance)}`,
    )

    // And the read that could not be joined is the read that answers in the end. Asked for
    // BEFORE the wedge lifts, so it attaches to the operation that has been outstanding this
    // whole time rather than starting one of its own -- and when that operation finally lands it
    // commits the records nobody could reach, and this is what they are handed to. Still one
    // tail call, for the entire test.
    const attached = session.snapshot()
    released = true
    wedge.release()
    const readable = await attached
    assert.equal(wedge.calls, before, `answered by the sole outstanding read: ${wedge.calls - before} more`)
    assert.ok(
      readable.turns.some((t) => t.prompt === 'and again'),
      `the records that were unreadable throughout were still there, unconsumed: ${JSON.stringify(
        readable.turns.map((t) => t.prompt),
      )}`,
    )
  } finally {
    released = true
    wedge.release()
    wedge.restore()
    await session?.close()
    if (previousStop === undefined) delete process.env['ORCH_FAKE_STOP_MS']
    else process.env['ORCH_FAKE_STOP_MS'] = previousStop
  }
})

test('codex: cancel() returns at once while a transcript read is wedged, and reads nothing', async () => {
  // `cancel()` types ESC and then waits for the child to write `turn_aborted`, polling the
  // transcript on a budget. The wait has no bound of its own, so a read that is not answering
  // does not slow it down -- it stops it: the first reconcile never returned, the budget was
  // never consulted again, and the escape from a turn the watchdog gave up on was itself stuck.
  //
  // So cancellation gives up on the reads already in flight, which answers its own poll and
  // everyone else's at once. What it must not do is buy itself a read by starting a second one
  // beside the first; and what it must not become, having been denied that, is a fifteen-second
  // wait for evidence that provably cannot arrive. The view says it is stalled, the wait reads
  // that and stops, and the cancellation comes back on its first poll interval.
  //
  // Both halves are asserted here, because either one alone is satisfiable by something worse:
  // a fast cancel that opened a second descriptor, or a single-read cancel that took the budget.
  const path = join(mkdtempSync(join(tmpdir(), 'orch-wedge-cancel-')), 'rollout.jsonl')
  writeFileSync(
    path,
    [started(TURN_ONE), prompted('hang please'), aborted(TURN_ONE)].join('\n') + '\n',
  )

  const wedge = wedgeOneTailPoll()
  let session: AgentSession | undefined
  let released = false
  try {
    session = await codexSessionOver(path, IDLE_MS)
    await session.send('hang please', { kind: 'orchestrator' })
    // A completed read BEFORE anything is wedged, so the view has something to fall back on.
    // Without it `snapshot()` below would park rather than answer -- correctly, because a view
    // that has never read cannot describe a session and must not invent one, and it can no
    // longer buy an answer by opening a second read. That is its own behaviour, covered in
    // `transcript/readLease.test.ts`; here it would only hide what this test is measuring.
    assert.ok((await session.snapshot()).turns.length >= 1, 'precondition: the view has read once')
    await heldBy(wedge)
    const before = wedge.calls

    const started_at = Date.now()
    const key = await Promise.race([
      session.cancel(),
      new Promise<never>((_r, reject) =>
        setTimeout(() => reject(new Error('cancel() never returned; the wedged read still parks it')), 8_000),
      ),
    ])
    const waited = Date.now() - started_at

    assert.equal(released, false, 'and it came back with the read still held, not because the wedge lifted')
    assert.ok(key, 'a cancel with a live turn reports which turn it cancelled')
    assert.ok(waited < 5_000, `cancel() took ${waited}ms; it must not be waiting out a read lease or a budget`)
    assert.ok(
      waited < CANCEL_EVIDENCE_BUDGET_MS,
      `and it must not spend the evidence budget on a view that cannot read: ${waited}ms`,
    )
    assert.equal(
      wedge.calls,
      before,
      `nor may it buy its speed with a second read: ${wedge.calls - before} were opened`,
    )

    // The verdict is what the adapter can support, and no more. `turn_aborted` is on the file
    // and was never read, so a `proven` cancellation here would be a claim about a record
    // nobody saw.
    const snap = await session.snapshot()
    const cancelled = snap.turns.find((t) => String(t.key) === String(key))
    assert.equal(cancelled?.state, 'cancelled', 'the turn is cancelled, which the ESC itself establishes')
    assert.notEqual(
      cancelled?.confidence,
      'proven',
      "a transcript that could not be read cannot be cited as the child's own record",
    )

    // What the early return costs, measured rather than assumed.
    //
    // The wedge lifting does not upgrade anything by itself: nothing between here and `close()`
    // runs a reconcile, because the tailer emits events rather than re-adjudicating a turn that
    // has already settled. So the verdict stays `assumed` even once the file is readable again.
    released = true
    wedge.release()
    await wedge.landed
    await new Promise((r) => setTimeout(r, 1_500))
    const readable = await session.snapshot()
    assert.ok(wedge.calls > before, 'the operation settling is what lets the next read happen')
    assert.equal(
      readable.turns.find((t) => String(t.key) === String(key))?.confidence,
      'assumed',
      'the wedge lifting does not re-adjudicate a settled turn on its own',
    )

    // And what it does not cost: the evidence. An abandoned read consumes nothing, so
    // `turn_aborted` was on the file the whole time and is still there for the next thing that
    // actually reconciles -- which is the close path, on its way out.
    await session.close()
    const afterClose = await session.snapshot()
    const settled = afterClose.turns.find((t) => String(t.key) === String(key))
    assert.equal(settled?.confidence, 'proven', `the record survived the wedge: ${JSON.stringify(settled)}`)
    assert.ok(
      settled?.provenance?.some((pr) => pr.source === 'transcript'),
      `and it is the child's own record that proves it: ${JSON.stringify(settled?.provenance)}`,
    )
    session = undefined
  } finally {
    released = true
    wedge.release()
    wedge.restore()
    await session?.close()
  }
})
