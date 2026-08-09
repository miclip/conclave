/**
 * Regression tests for the deadline rule actually firing.
 *
 * `classify()` has been able to return `timed_out` since it was ported, and
 * `classify.test.ts` proves it does when handed a large `elapsedSeconds`. That was never
 * the broken half. Nothing set `elapsedSeconds`: `observeElapsed()` had no caller, so in a
 * running session the deadline was unreachable and a hung turn stayed `in_progress`
 * forever.
 *
 * These tests are therefore written against the CLOCK, not against the rule. Each one
 * drives a real `TurnVerdictTracker` through a real timer and asserts on what a consumer
 * would receive, because a test that called `observeElapsed()` itself would pass just as
 * happily against the bug.
 *
 * Deadlines here are milliseconds. Production uses ten minutes.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { VerdictUpdate } from './tracker.ts'
import { TurnVerdictTracker } from './tracker.ts'
import { TurnWatchdog, type WatchdogTarget } from './watchdog.ts'

const MS = 40

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Turn extends WatchdogTarget {
  key: string
}

function turnAt(startedAt: number, opts: { mediated?: boolean; ms?: number } = {}): Turn {
  return {
    key: 'turn-1',
    startedAt,
    tracker: new TurnVerdictTracker({
      agent: 'claude',
      orchestrator: { sentCancel: false, inputIsMediated: opts.mediated ?? true },
      watchdogSeconds: (opts.ms ?? MS) / 1000,
    }),
  }
}

/** The adapter wiring, reduced to what it does with an update: record it. */
function collector(): { updates: VerdictUpdate[]; onUpdate: (t: Turn, u?: VerdictUpdate) => void } {
  const updates: VerdictUpdate[] = []
  return { updates, onUpdate: (_t, u) => { if (u) updates.push(u) } }
}

test('a turn that reports nothing at all is classified timed_out once the deadline passes', async () => {
  const turn = turnAt(Date.now())
  const { updates, onUpdate } = collector()
  const w = new TurnWatchdog<Turn>(MS, onUpdate)

  w.arm(turn.key, turn)
  // Captured into a local: asserting on the getter path narrows it for the rest of the
  // function, and the whole point is that it changes.
  const before = turn.tracker.verdict
  assert.equal(before, undefined, 'nothing has happened yet')

  await sleep(MS * 5)

  assert.equal(updates.length, 1, 'the deadline must produce exactly one update')
  assert.equal(updates[0]!.verdict?.outcome, 'timed_out')
  assert.equal(updates[0]!.supersedes, undefined, 'there was no earlier verdict to withdraw')
  assert.equal(turn.tracker.verdict?.outcome, 'timed_out', 'the tracker must hold it too')
  assert.equal(turn.tracker.settled, true)
})

test('the deadline carries its uncertainty and refuses to call a hang a cancellation', async () => {
  const turn = turnAt(Date.now())
  const { updates, onUpdate } = collector()
  new TurnWatchdog<Turn>(MS, onUpdate).arm(turn.key, turn)

  await sleep(MS * 5)

  const v = updates[0]!.verdict!
  assert.equal(v.confidence, 'uncertain', 'silence is not proof of anything')
  assert.notEqual(v.outcome, 'cancelled')
  assert.ok(
    v.provenance.some((p) => p.detail.includes('not evidence of cancellation')),
    'the caveat must be carried, not implied',
  )
  assert.ok(v.provenance.some((p) => p.source === 'watchdog'), 'provenance must name the clock')
})

test('the elapsed time reported is past the deadline, never merely at it', async () => {
  const turn = turnAt(Date.now())
  const { onUpdate } = collector()
  new TurnWatchdog<Turn>(MS, onUpdate).arm(turn.key, turn)

  await sleep(MS * 5)

  const ev = turn.tracker.evidence
  assert.ok(
    ev.elapsedSeconds > ev.watchdogSeconds,
    `elapsed ${ev.elapsedSeconds}s must exceed the deadline ${ev.watchdogSeconds}s; ` +
      'a timer firing a hair early must not report a duration that classifies as in_progress',
  )
})

test('the deadline is measured from the turn start, not from when the watchdog was armed', async () => {
  // A turn already older than its deadline when armed is overdue immediately. Measuring
  // from `arm()` instead would give it a fresh full deadline it has not earned.
  const turn = turnAt(Date.now() - 5_000)
  const { updates, onUpdate } = collector()
  new TurnWatchdog<Turn>(MS, onUpdate).arm(turn.key, turn)

  await sleep(MS)

  assert.equal(updates[0]?.verdict?.outcome, 'timed_out')
  assert.ok(turn.tracker.evidence.elapsedSeconds >= 5, 'it must report the real age of the turn')
})

test('a turn that completed before its deadline is not reclassified when the clock fires', async () => {
  const turn = turnAt(Date.now())
  const { updates, onUpdate } = collector()
  const w = new TurnWatchdog<Turn>(MS, onUpdate)
  w.arm(turn.key, turn)

  // Stop arrives well inside the deadline. The watchdog is deliberately NOT disarmed:
  // rule order in classify() is what makes the late fire harmless, and that is the
  // property under test.
  turn.tracker.observeHook('Stop', { hook_event_name: 'Stop' })

  await sleep(MS * 5)

  assert.deepEqual(updates, [], 'the deadline must produce no update for a completed turn')
  assert.equal(turn.tracker.verdict?.outcome, 'completed', 'completion must survive the clock')
})

test('a turn cancelled before its deadline is not overwritten either', async () => {
  const turn = turnAt(Date.now())
  const { updates, onUpdate } = collector()
  new TurnWatchdog<Turn>(MS, onUpdate).arm(turn.key, turn)

  turn.tracker.observeOrchestrator({ sentCancel: true })

  await sleep(MS * 5)

  assert.deepEqual(updates, [])
  assert.equal(turn.tracker.verdict?.outcome, 'cancelled')
})

test('a Stop arriving after the deadline withdraws timed_out rather than leaving it standing', async () => {
  const turn = turnAt(Date.now())
  const { updates, onUpdate } = collector()
  new TurnWatchdog<Turn>(MS, onUpdate).arm(turn.key, turn)

  await sleep(MS * 5)
  assert.equal(turn.tracker.verdict?.outcome, 'timed_out', 'precondition: the deadline fired')

  // The turn was slow, not dead. The watchdog must not be a one-way door.
  const late = turn.tracker.observeHook('Stop', { hook_event_name: 'Stop' })

  assert.equal(late?.verdict?.outcome, 'completed')
  assert.equal(late?.supersedes?.outcome, 'timed_out', 'the earlier verdict must be withdrawn')
  assert.equal(turn.tracker.verdict?.outcome, 'completed')
  void updates
})

test('unmediated input downgrades the deadline to unknown_abnormal_end', async () => {
  // Someone else can type into the child, so a keystroke could have ended the turn
  // unseen. That is not a timeout, and the clock must not claim it is.
  const turn = turnAt(Date.now(), { mediated: false })
  const { updates, onUpdate } = collector()
  new TurnWatchdog<Turn>(MS, onUpdate).arm(turn.key, turn)

  await sleep(MS * 5)

  assert.equal(updates[0]?.verdict?.outcome, 'unknown_abnormal_end')
  assert.ok(
    updates[0]!.verdict!.provenance.some((p) => p.detail.includes('not mediated')),
    'the reason for the downgrade must be stated',
  )
})

test('disarmAll stops a pending deadline, and close() relies on it', async () => {
  const turn = turnAt(Date.now())
  const { updates, onUpdate } = collector()
  const w = new TurnWatchdog<Turn>(MS, onUpdate)

  w.arm(turn.key, turn)
  assert.equal(w.armed, 1)
  w.disarmAll()
  assert.equal(w.armed, 0)

  await sleep(MS * 5)

  assert.deepEqual(updates, [], 'a disarmed deadline must never fire')
  assert.equal(turn.tracker.verdict, undefined, 'and must not settle the turn')
})

test('disarm targets one turn and leaves the others running', async () => {
  const kept = { ...turnAt(Date.now()), key: 'kept' }
  const dropped = { ...turnAt(Date.now()), key: 'dropped' }
  const fired: string[] = []
  const w = new TurnWatchdog<Turn>(MS, (t, u) => { if (u) fired.push(t.key) })

  w.arm(kept.key, kept)
  w.arm(dropped.key, dropped)
  w.disarm(dropped.key)

  await sleep(MS * 5)

  assert.deepEqual(fired, ['kept'])
})

test('re-arming a key replaces its timer rather than stacking a second one', async () => {
  const turn = turnAt(Date.now())
  const { updates, onUpdate } = collector()
  const w = new TurnWatchdog<Turn>(MS, onUpdate)

  w.arm(turn.key, turn)
  w.arm(turn.key, turn)
  assert.equal(w.armed, 1, 'two arms of one key must leave one timer')

  await sleep(MS * 5)

  assert.equal(updates.length, 1, 'and must produce one update, not two')
})

test('silence is what fires the deadline, not elapsed time (#36)', async () => {
  // On claude 2.1.224 an implementer took a tool result, then produced no further output and
  // no Stop. The absolute deadline was 45 minutes, so the session sat idle ~44 of them --
  // every second of that wait information-free, because the turn was knowably hung by
  // minute two.
  const { updates, onUpdate } = collector()
  // Absolute deadline far away; idle deadline short.
  const w = new TurnWatchdog<Turn>(10_000, onUpdate, MS)
  const turn = turnAt(Date.now())
  turn.lastActivityAt = Date.now()

  w.arm(turn.key, turn)
  await sleep(MS * 3)

  assert.equal(updates.length, 1, 'silence fires it well before the absolute deadline')
  const v = updates[0]!.verdict!
  assert.equal(v.outcome, 'timed_out')
  assert.match(v.provenance[0]!.detail, /no output for/)
  w.disarmAll()
})

test('a turn that keeps producing events is not called hung', async () => {
  // The failure the idle deadline must not introduce. A turn editing five files and running
  // a suite is legitimately long, and firing on it manufactures a pause out of ordinary work
  // -- which is exactly why the absolute deadline was raised from 10 minutes to 45.
  const { updates, onUpdate } = collector()
  const w = new TurnWatchdog<Turn>(10_000, onUpdate, MS * 2)
  const turn = turnAt(Date.now())
  turn.lastActivityAt = Date.now()
  w.arm(turn.key, turn)

  // Busy for well past the idle window, in steps shorter than it.
  for (let i = 0; i < 5; i++) {
    await sleep(MS)
    w.touch(turn.key)
  }
  assert.deepEqual(updates, [], 'activity keeps it alive')
  w.disarmAll()
})

test('the absolute deadline still bounds a turn that never stops talking', async () => {
  // Both clocks are kept. A participant emitting a heartbeat forever without finishing would
  // otherwise never be bounded at all -- a worse failure, because it looks like progress.
  const { updates, onUpdate } = collector()
  const w = new TurnWatchdog<Turn>(MS * 2, onUpdate, 10_000)
  const turn = turnAt(Date.now())
  turn.lastActivityAt = Date.now()
  w.arm(turn.key, turn)

  for (let i = 0; i < 4; i++) {
    await sleep(MS)
    w.touch(turn.key)
  }
  assert.ok(updates.length >= 1, 'the absolute cap fires despite continuous activity')
  w.disarmAll()
})

test('a target that never records activity keeps the absolute deadline', async () => {
  // Targets predating `lastActivityAt` must keep working rather than becoming immortal.
  const { updates, onUpdate } = collector()
  const w = new TurnWatchdog<Turn>(MS, onUpdate, 10_000)
  const turn = turnAt(Date.now()) // no lastActivityAt
  w.arm(turn.key, turn)
  await sleep(MS * 3)

  assert.equal(updates.length, 1)
  w.disarmAll()
})

test('an idle deadline that fires early re-arms on ITSELF, not on the absolute one', async () => {
  // The regression this exists to prevent, caught by CI on Linux where timers ran early.
  //
  // `#fire` tested the idle deadline, found it a hair short, and fell through to the absolute
  // branch -- which re-armed for the whole remaining absolute budget and therefore skipped
  // the idle deadline for the rest of the turn. Silently: nothing errors, the turn simply
  // waits out 45 minutes again, which is the exact behaviour the idle clock was added to fix.
  const { updates, onUpdate } = collector()
  // A very short idle window against a very long absolute one, so an early fire that fell
  // through would park for effectively forever and this test would see nothing.
  const w = new TurnWatchdog<Turn>(600_000, onUpdate, 5)
  const turn = turnAt(Date.now())
  turn.lastActivityAt = Date.now()

  w.arm(turn.key, turn)
  await sleep(200)

  assert.equal(updates.length, 1, 'the idle deadline must still fire after an early wake')
  assert.match(updates[0]!.verdict!.provenance[0]!.detail, /no output for/)
  w.disarmAll()
})

test('activity refreshes the live turn even when the event key differs', async () => {
  // The regression this exists to catch. Adapters emit events keyed by whatever produced
  // them: on Claude Code the watchdog is armed under the hook's prompt_id while transcript
  // events carry `claude-transcript-turn-N`. A keyed touch matched nothing, so every Claude
  // turn was capped at the idle deadline however busy it was.
  const { updates, onUpdate } = collector()
  // The idle window is TEN touch intervals, not two. It was two, which is not a margin: a
  // `sleep(40)` overrunning to 80ms on a loaded runner fired the deadline between touches
  // and failed a release. The property under test is that `touchAll` refreshes a turn armed
  // under a different key -- nothing about it needs the margin to be tight, and a test whose
  // result depends on how busy the machine is proves something other than what it claims.
  const w = new TurnWatchdog<Turn>(10_000, onUpdate, MS * 10)
  const turn = turnAt(Date.now())
  turn.lastActivityAt = Date.now()
  w.arm('hook-key-prompt_id', turn)

  // Busy for well past the idle window, reported under a key the watchdog has never seen.
  for (let i = 0; i < 5; i++) {
    await sleep(MS)
    w.touchAll()
  }
  assert.deepEqual(updates, [], 'a busy turn must not be called hung')
  w.disarmAll()
})
