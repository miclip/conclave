/**
 * What a pause costs a run, and what still stops a run that is going nowhere (#112).
 *
 *   node --test src/relay/pauseBudget.test.ts
 *
 * The reported run said `ended: budget` after five pause/continue cycles on one healthy piece
 * of work that eventually produced 2,000+ lines. The ceilings had bounded the TOOL rather than
 * the run: an operator answering `/continue` has not advanced the goal, so charging the
 * interruption against the same allowance makes one number measure two things.
 *
 * ## What was actually charged, before anything here changed
 *
 * Read rather than assumed, because the issue's framing and the code's behaviour are close and
 * not identical:
 *
 *   - `#turnsTaken` is incremented in `#exchangeTurn`, where a turn is actually sent. A pause
 *     increments nothing, and a resumed loop falls through inside the SAME advisor-turn
 *     iteration -- `#halt` returning `undefined` does not `continue advisor` -- so a pause cost
 *     no advisor turn either. The first two tests below pin that, because "already true" is a
 *     claim with nothing holding it in place.
 *   - What a `turn_incomplete` pause DID cost is the truncated turn it was raised about: a turn
 *     ended by an expired deadline is charged exactly what a turn that produced a report is
 *     charged. That is left alone deliberately -- see the last three tests -- because a turn
 *     that burned a full watchdog to produce nothing is the most expensive kind of turn and the
 *     signature of a wedged run, so exempting it is what would turn a bounded failure into an
 *     unbounded one.
 *   - `--max-minutes` was wall-clock. That is the charge that was wrong, and the only one where
 *     removing it cannot unbound anything: a suspended run dispatches nothing and spends no
 *     quota, and the interval being counted was a human's deliberation.
 *
 * ## Why these drive a real relay on an injected clock
 *
 * A duration ceiling proved by sleeping is a fixture calibrated to the machine it was written
 * on; `FakeRotationSession.holdTurn` carries the story of the last one of those in this
 * repository. `RelayOptions.now` moves the ceiling's clock and nothing else, so the two facts
 * that a sleep cannot separate -- a paused interval does not advance it, an active one does --
 * are asserted by advancing time in exactly one of the two places.
 *
 * Every millisecond these runs experience is put there by the test, which is what lets the time
 * assertions be equalities rather than ranges: the paused total, the active total, the count of
 * pauses, and the figure the ceiling quotes when it fires are all known before the run starts.
 * An inequality here would pass on a run that stopped for the wrong reason.
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type { Verdict } from '../contract/outcome.ts'
import type { AgentSession } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { tempDir } from '../testkit/tempDir.ts'
import { runReport } from './report.ts'
import { Relay, type RelayOptions } from './relay.ts'
import { resolutionFor } from './resolution.ts'
import { RunHandle, type RunControl, type RunPause } from './run.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** The verdict the reported run's watchdog produced, over and over, on work that was fine. */
const TIMED_OUT: Verdict = {
  outcome: 'timed_out',
  confidence: 'uncertain',
  provenance: [{ source: 'orchestrator', detail: 'past the watchdog at 2700s with no Stop' }],
}

/**
 * A clock a test moves by hand.
 *
 * Starting somewhere plausible rather than at zero, so a reading that accidentally came from
 * `Date.now()` is off by decades instead of by milliseconds and cannot pass by luck.
 */
function clockFrom(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

function repo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-pause-budget')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'work.ts'), 'export const answer = 42\n')
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

function registryOf(queues: Record<string, AgentSession[]>): AgentRegistry {
  const r = new AgentRegistry()
  for (const [agent, sessions] of Object.entries(queues)) {
    const remaining = [...sessions]
    r.register({
      id: agent,
      displayName: agent,
      capabilities: {
        agent,
        readinessSignal: 'unknown',
        turnKeySource: 'prompt_id',
        outcomes: {
          completed: 'observed',
          cancelled: 'reasoned_but_unverified',
          permission_refused: 'reasoned_but_unverified',
          process_exited: 'reasoned_but_unverified',
          timed_out: 'reasoned_but_unverified',
          transport_lost: 'reasoned_but_unverified',
          unknown_abnormal_end: 'reasoned_but_unverified',
        },
      },
      deadlines: NO_DEADLINE_CLOCKS,
      launch: { command: agent, baseArgs: [] },
      async create() {
        const next = remaining.shift()
        if (!next) throw new Error(`no session left for ${agent}`)
        return next
      },
    })
  }
  return r
}

async function relayOf(
  cwd: string,
  advisor: FakeRotationSession,
  impl: FakeRotationSession,
  over: Partial<RelayOptions> = {},
): Promise<Relay> {
  return Relay.start({
    registry: registryOf({ codex: [advisor], claude: [impl] }),
    cwd,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 4,
    ...over,
  })
}

/**
 * A seat whose every working turn trips the deadline, and never a completed one after the ack.
 *
 * The fake still returns its scripted prose -- an adapter reports whatever the transcript held
 * when the clock ran out -- so this is "a turn that produced no REPORT" in the sense the run
 * cares about: nothing the advisor may steer on, and a human asked about every one of them.
 */
function alwaysTimesOut(seat: FakeRotationSession): void {
  seat.onSend = () => {
    const index = seat.received.length - 1
    seat.endTurn = index === 0 ? undefined : { index, verdict: TIMED_OUT }
  }
}

/** Enough scripted turns that only a ceiling can end the run. */
function endlessly(prefix: string): string[] {
  return Array.from({ length: 60 }, (_, i) => `${prefix} ${i + 1}.`)
}

/**
 * Drive a run to its end, answering every pause with `/continue` after holding it for `heldMs`.
 *
 * The hold is what an operator costs a run: time on the clock and nothing else. Returns the
 * pauses so a test can say what it was asked about, and the outcome so it can say how the run
 * actually ended -- taken off `settled()` rather than `result()`, which is what keeps a
 * looping caller from parking on a promise that cannot settle (see `RunHandle.result`).
 */
async function continueThrough(
  run: ReturnType<Relay['start']>,
  clock: { advance: (ms: number) => void },
  heldMs: number,
): Promise<{ pauses: RunPause[]; reason: string; detail: string }> {
  const pauses: RunPause[] = []
  for (;;) {
    const s = await run.settled()
    if (s.kind === 'ended') return { pauses, reason: s.outcome.reason, detail: s.outcome.detail ?? '' }
    pauses.push(s.pause)
    clock.advance(heldMs)
    await run.continue()
  }
}

// ---------------------------------------------------------------------------------------
// The ledger itself. Four ways out of a pause, and a total that has to survive all of them.
// ---------------------------------------------------------------------------------------

/** A control surface that does nothing, for a handle driven directly. */
function inertControl(): RunControl {
  return {
    rotate: async () => {
      throw new Error('not used')
    },
    rotationTarget: () => undefined,
    constrain: () => {
      throw new Error('not used')
    },
    requestStop: () => {},
    requestPause: () => {},
  }
}

function pauseShape(): Omit<RunPause, 'at'> {
  return {
    reason: 'turn_incomplete',
    resolution: resolutionFor({ reason: 'turn_incomplete', participant: 'implementer' }, { rotationArmed: false }),
    detail: 'implementer turn ended timed_out (uncertain)',
    evidence: [],
    options: ['continue', 'abort'],
    atSeq: 1,
  }
}

test('the handle totals every suspension and none of the time between them', async () => {
  const clock = clockFrom()
  const handle = new RunHandle(inertControl(), { now: clock.now })
  assert.equal(handle.suspendedMs, 0, 'a run that has never paused has spent nothing waiting')

  for (const held of [HOUR, 30 * MINUTE, 5 * MINUTE]) {
    const deciding = handle.pauseAt(pauseShape())
    clock.advance(held)
    await handle.continue()
    await deciding
    // Between pauses the run is working, and that time is not the ledger's.
    clock.advance(2 * MINUTE)
  }

  assert.equal(handle.suspendedMs, HOUR + 30 * MINUTE + 5 * MINUTE)
})

test('the suspension currently being decided is already on the ledger', async () => {
  // Read live because the ceiling that consults it is checked while the run is going -- and the
  // longest pause a run ever has is the one nobody has answered yet. A ledger that only added
  // on release would report zero for exactly the run this issue is about.
  const clock = clockFrom()
  const handle = new RunHandle(inertControl(), { now: clock.now })
  const deciding = handle.pauseAt(pauseShape())
  clock.advance(HOUR)
  assert.equal(handle.suspendedMs, HOUR, 'an unanswered pause is time already spent waiting')
  // Not awaited: `abort()` returns `result()`, and nothing here is going to settle a handle
  // whose control surface is inert. What is under test is the ledger, which closes synchronously.
  void handle.abort('the operator gave up')
  // `pauseAt` can also resolve with `undefined` -- no decision, the run ended underneath the
  // question (#142). This is the other case: an operator who answered, so a decision is exactly
  // what must come back, and asserting the shape says the two are not being confused.
  assert.deepEqual(await deciding, { kind: 'abort', detail: 'the operator gave up' })
  clock.advance(HOUR)
  assert.equal(handle.suspendedMs, HOUR, 'and an abort closes the interval like any other answer')
})

test('a handle settled while it is still paused stops the ledger where the run stopped', async () => {
  // A ledger closed only at the halt site runs forever when the handle is settled out from under
  // an unresolved pause, and a report read afterwards claims a suspension that is still going.
  //
  // NOT a test of `relay.stop()`, and an earlier version of this comment said it was. At the time
  // it could not have been: `stop()` did not settle the handle at all, so the loop stayed parked
  // on the unresolved `pauseAt()` and `run.state` never left `paused`. That hole is closed --
  // `stop()` settles the handle now, and `stopWhilePaused.test.ts` drives a real relay through it
  // (#142) -- and this still exercises `settle()` directly, because the ledger's contract is that
  // ANY settle closes the interval, whoever called it. A test that names a caller it never
  // invokes is the failure this repository keeps finding, so the caller is tested where it lives.
  const clock = clockFrom()
  const handle = new RunHandle(inertControl(), { now: clock.now })
  void handle.pauseAt(pauseShape())
  clock.advance(20 * MINUTE)
  handle.settle({ reason: 'stopped' })
  clock.advance(HOUR)
  assert.equal(handle.suspendedMs, 20 * MINUTE)
})

// ---------------------------------------------------------------------------------------
// Healthy work, interrupted repeatedly. The half the issue was filed about.
// ---------------------------------------------------------------------------------------

test('a healthy run interrupted five times is not ended by the budget it did not spend', async (t) => {
  // The reported shape, with the interruption in its purest form: nothing is wrong, an operator
  // steps away and comes back, five times, five hours in total. The run is under a ten-minute
  // duration ceiling the whole way, which the old wall-clock reading would have breached at the
  // first pause -- and it must still do all of its work and end because the work was done.
  //
  // Every millisecond this run experiences is put there by this test: a minute of work at the
  // top of each of the implementer's working turns, an hour at each pause, and nothing anywhere
  // else. That is what makes the arithmetic at the bottom an assertion rather than a sanity
  // check -- both figures are known exactly before the run starts.
  const dir = repo(t)
  const clock = clockFrom()
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'Do it.',
    'Keep going.',
    'Keep going.',
    'Keep going.',
    'Keep going.',
    'Keep going.',
    'DONE',
  ])
  const impl = new FakeRotationSession('impl', 'claude', endlessly('Did step'))
  /** Working turns: the briefing is turn 0 and happens before the ceiling window opens. */
  let worked = 0
  impl.onSend = () => {
    if (impl.received.length - 1 === 0) return
    worked += 1
    clock.advance(MINUTE)
  }
  const relay = await relayOf(dir, advisor, impl, {
    now: clock.now,
    maxAdvisorTurns: 8,
    ceilings: { maxDurationMs: 10 * MINUTE },
  })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const pauses: RunPause[] = []
  void run.requestPause('the operator stepped away')
  for (;;) {
    const s = await run.settled()
    if (s.kind === 'ended') {
      assert.equal(
        s.outcome.reason,
        'done',
        `an interrupted run must end on its work, not on a ceiling it never spent: ${s.outcome.detail}`,
      )
      break
    }
    pauses.push(s.pause)
    // An hour with the run suspended: no seat is dispatched, no child is spending anything.
    clock.advance(HOUR)
    await run.continue()
    if (pauses.length < 5) void run.requestPause('the operator stepped away again')
  }

  assert.equal(pauses.length, 5, 'the run must have been interrupted five times, no fewer and no more')
  assert.deepEqual(
    [...new Set(pauses.map((p) => p.reason))],
    ['operator_requested'],
    'and interrupted by the operator rather than by anything going wrong',
  )

  // What the record says, against what the clock was told to do. `activeMs` is the ceiling's own
  // reading -- the number `breached` compared -- so this is the report agreeing with the thing
  // that decides, not with a second derivation of it.
  const report = await runReport(relay, {
    goal: 'Keep the work moving.',
    outcome: { reason: 'done' },
    startedAt: Date.now() - 1,
    build: 'test',
  })
  assert.equal(report.pausedMs, 5 * HOUR, 'five hours were spent waiting for the operator, exactly')
  assert.equal(report.activeMs, worked * MINUTE, `and ${worked} minute(s) were spent working, exactly`)
  // The two halves of the point, stated as inequalities against the ceiling that was set. The
  // first is why this run survived; the second is why it would not have before, and it is what
  // makes the first non-trivial -- a run that never came near the ceiling on either clock would
  // pass this test with the fix reverted.
  assert.ok(report.activeMs < 10 * MINUTE, `the work must fit inside the ceiling: ${report.activeMs}ms`)
  assert.ok(
    report.activeMs + report.pausedMs > 10 * MINUTE,
    'and wall-clock must not: this run would have been ended by the old reading',
  )
  // Both halves stop when the run does, not when someone next asks. The pair has to freeze
  // together: a run ended by `stop()` while a pause is still open has a paused total that is
  // also still moving at that instant, and freezing one of two figures that must add up is how
  // a record comes to contradict itself.
  clock.advance(HOUR)
  assert.equal(relay.pausedMs, 5 * HOUR, 'the paused total is terminal once the run has ended')
  assert.equal(relay.activeMs, worked * MINUTE, 'and so is the active one')
})

test('an interrupted run does exactly the work the same run does uninterrupted', async (t) => {
  // The sharpest form of "a pause costs no turn". Two identical runs, one of them stopped and
  // resumed at every boundary, compared on what the implementer was actually SENT. A pause that
  // consumed an advisor turn or a turn would show up here as work the interrupted run never got
  // to -- which is the run in the issue, which ended holding uncommitted work.
  const dir = repo(t)
  const scripted = (): [FakeRotationSession, FakeRotationSession] => [
    new FakeRotationSession('advisor', 'codex', [
      'Do it.',
      'Keep going.',
      'And again.',
      'And again.',
      'And again.',
      'And again.',
      'DONE',
    ]),
    new FakeRotationSession('impl', 'claude', endlessly('Did step')),
  ]

  const [advisorA, implA] = scripted()
  const straight = await relayOf(dir, advisorA, implA, { maxAdvisorTurns: 8 })
  t.after(() => straight.stop())
  const plain = await straight.run('Keep the work moving.')

  const [advisorB, implB] = scripted()
  const clock = clockFrom()
  const interrupted = await relayOf(dir, advisorB, implB, {
    maxAdvisorTurns: 8,
    now: clock.now,
    ceilings: { maxDurationMs: 10 * MINUTE },
  })
  t.after(() => interrupted.stop())
  const run = interrupted.start('Keep the work moving.')
  let cycles = 0
  void run.requestPause('the operator stepped away')
  for (;;) {
    const s = await run.settled()
    if (s.kind === 'ended') {
      assert.equal(s.outcome.reason, plain.reason, 'both runs must end the same way')
      break
    }
    cycles += 1
    clock.advance(HOUR)
    await run.continue()
    if (cycles < 5) void run.requestPause('and again')
  }

  assert.equal(cycles, 5, 'the second run must have been stopped and resumed five times')
  // The comparison the whole test is for: what the interrupted implementer was sent, against
  // what the uninterrupted one was sent. Not a self-comparison -- `implB` is the run that was
  // stopped five times, `implA` the run nobody touched, and a pause that consumed an advisor
  // turn or a turn would show up here as an instruction the interrupted run never reached.
  assert.ok(implA.received.length > 3, `the baseline must have done real work: ${implA.received.length} turns`)
  assert.deepEqual(
    implB.received,
    implA.received,
    'the interrupted run must be sent the same work, in the same order, as the run nobody interrupted',
  )
})

test('watchdog pauses on one continuous piece of work do not spend the duration ceiling', async (t) => {
  // #112's own scenario rather than the abstract one: the pauses are `turn_incomplete`, raised
  // by a deadline on work that is going fine, and each is answered `/continue` after the
  // operator has taken an hour to look at it. #107 has since made these rarer -- a repeat of an
  // ANSWERED question is suppressed -- but the seat here has no child pid to measure, so no
  // answer can be carried forward and every deadline is put to the human. That is the worst
  // case the ceiling has to survive, and it is a real adapter shape rather than a contrivance.
  const dir = repo(t)
  const clock = clockFrom()
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'Do it.',
    'Keep going.',
    'Keep going.',
    'Keep going.',
    'Keep going.',
    'DONE',
  ])
  const impl = new FakeRotationSession('impl', 'claude', endlessly('Still going'))
  alwaysTimesOut(impl)
  const relay = await relayOf(dir, advisor, impl, {
    now: clock.now,
    maxAdvisorTurns: 8,
    ceilings: { maxDurationMs: 10 * MINUTE },
  })
  t.after(() => relay.stop())

  const { pauses, reason, detail } = await continueThrough(relay.start('Keep the work moving.'), clock, HOUR)

  assert.equal(pauses.length, 5, 'the watchdog must have interrupted this work five times')
  assert.deepEqual(
    [...new Set(pauses.map((p) => p.reason))],
    ['turn_incomplete'],
    'and interrupted it with the pause this issue was filed about',
  )
  assert.notEqual(reason, 'ceiling', `hours spent waiting for an operator must not end the run: ${detail}`)
  assert.equal(relay.pausedMs, 5 * HOUR, 'and every one of those hours is on the record as paused')
  assert.ok(
    relay.activeMs < 10 * MINUTE,
    `the ceiling's own reading must be the work only: ${relay.activeMs}ms of a 10-minute ceiling`,
  )
})

// ---------------------------------------------------------------------------------------
// The other half, which is the one worth rejecting the change over: a run that never makes
// progress must still end. Three different ceilings, three different reasons, no clock that
// has to be believed.
// ---------------------------------------------------------------------------------------

test('a run that never produces a report still burns the duration ceiling while it runs', async (t) => {
  // The same never-completing seat, and the same operator answering every pause -- but here the
  // clock advances only while a turn is in flight. That is what a wedged run actually costs: a
  // watchdog running out is a child running for the whole watchdog. So the ceiling still fires,
  // and it fires on the time the run spent RUNNING rather than on the time it spent waiting.
  const dir = repo(t)
  const clock = clockFrom()
  const advisor = new FakeRotationSession('advisor', 'codex', endlessly('Keep going'))
  const impl = new FakeRotationSession('impl', 'claude', endlessly('Still going'))
  alwaysTimesOut(impl)
  const timesOut = impl.onSend!
  // Every turn takes four minutes of real work before the deadline gives up waiting on it and
  // reports timed_out.
  impl.onSend = (m) => {
    timesOut(m)
    clock.advance(4 * MINUTE)
  }
  const relay = await relayOf(dir, advisor, impl, {
    now: clock.now,
    // Above what this run can reach, so nothing but the duration ceiling can be what ended it.
    maxAdvisorTurns: 50,
    ceilings: { maxDurationMs: 10 * MINUTE },
  })
  t.after(() => relay.stop())

  // Answered instantly, every time: not one millisecond of this run is the operator's.
  const { pauses, reason, detail } = await continueThrough(relay.start('Keep the work moving.'), clock, 0)

  // Three turns of four minutes fit under a ten-minute ceiling and the fourth boundary does not,
  // so the run is asked about three times and then stopped. Pinned exactly, because "at least
  // two" would also be satisfied by a run that stopped for the wrong reason.
  assert.equal(pauses.length, 3, `the run must have gone nowhere three times: ${pauses.length}`)
  assert.equal(reason, 'ceiling', `a run that never progresses must still be stopped: ${detail}`)
  assert.match(detail, /time ceiling reached/)
  // The line says WHICH clock, because it is no longer the wall one. A reader comparing an
  // elapsed figure against a ceiling needs to know what was and was not counted into it.
  assert.match(detail, /of active run time/)
  assert.match(detail, /time paused for an operator is not counted/)
  assert.equal(relay.pausedMs, 0, 'and nothing was deducted, because nobody was kept waiting')

  // The record against the ending. The ceiling quoted a figure when it fired; the report carries
  // the same reading, so a reader holding both cannot be told two different stories about the
  // one number that ended the run. Not `durationMs` minus `pausedMs`: that arithmetic looks like
  // this quantity and is not it, which is why `activeMs` is reported rather than left to be
  // derived (see `Relay.activeMs`).
  const report = await runReport(relay, {
    goal: 'Keep the work moving.',
    outcome: { reason, detail },
    startedAt: Date.now() - 1,
    build: 'test',
  })
  assert.equal(report.pausedMs, 0)
  assert.ok(
    report.activeMs >= 10 * MINUTE,
    `the reported active time must be what breached the ceiling: ${report.activeMs}ms`,
  )
  const quoted = /(\d+)s of active run time/.exec(detail)
  assert.ok(quoted, `the ending must quote its reading: ${detail}`)
  assert.equal(
    Number(quoted[1]) * 1000,
    report.activeMs,
    'and the figure it quoted must be the figure the report carries',
  )

  // AND IT MUST STILL AGREE AN HOUR LATER. A report is not assembled at the instant a run ends:
  // teardown runs, `runReport` awaits a snapshot per participant, and a front end may write the
  // document later still. A reading that kept counting through that would grow past anything the
  // ceiling observed and would contradict the detail printed beside it -- so the clock stops
  // where the run stopped, and a second report taken after an hour of teardown says the same
  // thing as the first.
  const ended = report.activeMs
  clock.advance(HOUR)
  assert.equal(relay.activeMs, ended, 'the ceiling reading must stop when the run does')
  assert.equal(relay.pausedMs, 0, 'and so must the paused total')
  const later = await runReport(relay, {
    goal: 'Keep the work moving.',
    outcome: { reason, detail },
    startedAt: Date.now() - 1,
    build: 'test',
  })
  assert.equal(later.activeMs, ended, 'a report written after teardown must carry the terminal reading')
  assert.equal(
    Number(quoted[1]) * 1000,
    later.activeMs,
    'and must still agree with the figure the ending quoted',
  )
})

test('a run that never produces a report still ends when no clock moves at all', async (t) => {
  // The strongest version of the constraint. The duration ceiling here can never fire -- the
  // injected clock is frozen, so active time is zero forever -- and the run must STILL end. It
  // does, on the advisor-turn budget, which every pass through the dispatcher spends and which
  // this change does not touch. A pause is free; going round the loop is not.
  const dir = repo(t)
  const frozen = clockFrom()
  const advisor = new FakeRotationSession('advisor', 'codex', endlessly('Keep going'))
  const impl = new FakeRotationSession('impl', 'claude', endlessly('Still going'))
  alwaysTimesOut(impl)
  const relay = await relayOf(dir, advisor, impl, {
    now: frozen.now,
    maxAdvisorTurns: 4,
    ceilings: { maxDurationMs: 10 * MINUTE },
  })
  t.after(() => relay.stop())

  const { pauses, reason, detail } = await continueThrough(
    relay.start('Keep the work moving.'),
    // Hours of operator time, on a clock that is the only one this run has.
    { advance: (ms) => frozen.advance(ms) },
    HOUR,
  )

  // One pause per advisor turn, four advisor turns, and then the budget. Exact, because the
  // number IS the claim here: nothing else was left to stop this run.
  assert.equal(pauses.length, 4, `one pause per advisor turn was expected, got ${pauses.length}`)
  assert.equal(reason, 'budget', `a run that makes no progress must still hit a ceiling: ${detail}`)
  assert.match(detail, /advisor turn budget spent: 4 of a maximum 4/)
  assert.equal(relay.activeMs, 0, 'and it ended with no active time at all, so no duration ceiling could have')
})

test('a turn abandoned at its deadline is charged exactly what a completed turn is charged', async (t) => {
  // "Abandoned at", not "ended by": the deadline releases the run's wait and emits a verdict,
  // and the child is not stopped by it. What is being charged is the wait, which is the whole
  // reason it costs what a completed turn costs.
  //
  // The decision this change did NOT make, pinned so it is a decision rather than an oversight.
  // #112 offers "do not charge a turn that produced no report" as a candidate. It is refused:
  // such a turn held this run waiting for the whole of its watchdog and produced nothing, which
  // makes it the most expensive turn a run can take, and a run wedged in a loop of them takes no
  // other kind. Exempting it is precisely the change that would convert a bounded failure into
  // an unbounded one, so `--max-turns` counts it like any other and ends the run.
  const dir = repo(t)
  const clock = clockFrom()
  const advisor = new FakeRotationSession('advisor', 'codex', endlessly('Keep going'))
  const impl = new FakeRotationSession('impl', 'claude', endlessly('Still going'))
  alwaysTimesOut(impl)
  const relay = await relayOf(dir, advisor, impl, {
    now: clock.now,
    maxAdvisorTurns: 50,
    ceilings: { maxTurns: 6 },
  })
  t.after(() => relay.stop())

  const { reason, detail } = await continueThrough(relay.start('Keep the work moving.'), clock, HOUR)

  assert.equal(reason, 'ceiling', `truncated turns must still be counted: ${detail}`)
  assert.match(detail, /turn ceiling reached: 6 of a maximum 6/)
})
