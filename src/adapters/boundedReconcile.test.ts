/**
 * The bound on the deadline's transcript re-check, as a property rather than a duration (#36).
 *
 * Both pty adapters run that re-check through `BoundedSingleFlight`, and what they need from it
 * is not "finish in two seconds" -- nothing here can make a filesystem read finish -- but three
 * things that hold whether it finishes or not:
 *
 *   the caller stops waiting          the deadline verdict is already out; nothing waits on this
 *   the over-runner goes quiet        it may finish its own work, but may not act on it
 *   the slot is freed at the bound    so the next deadline retries instead of joining a corpse
 *
 * The third is the one that was wrong before and the reason this file exists. The slot used to
 * be released on COMPLETION, so a read that took a minute held every deadline in that minute
 * behind it -- each one attaching to a promise that had been written off long ago and returning
 * its abandoned non-answer, which reads from outside exactly like a re-check that ran and found
 * nothing.
 *
 * ## Time is advanced here, never waited out (#311)
 *
 * The bound is the SUBJECT of these tests, so a real sleep on either side of it asserts nothing
 * about the class and everything about the machine: the successor's half of the eviction test
 * took ~20ms on an idle laptop and more than its 300ms bound on a loaded CI runner, and failed
 * there for that reason alone. Every test whose claim involves the bound hands the class a
 * manual `TimeSource` and moves it by hand, so the edges -- one millisecond inside, the instant
 * of the bound itself -- are reachable exactly.
 *
 * The manual source moves in two ways, and the difference is the subject of the last two tests.
 * `tick(ms)` is the loop turning: the clock advances and every timer that falls due runs, in
 * order. `block(ms)` is the loop NOT turning: the clock advances and nothing runs, which is what
 * a synchronous stretch does to a real timer. The overrun tests use `block`, so the answer the
 * token gives can only have come from the clock.
 *
 * Jobs "land" when a test resolves their gate, not after a delay: the one wait that remains in
 * this file is a `setImmediate`, and it is a turn of the loop for the job's continuations
 * rather than a measurement of anything.
 *
 *   node --test src/adapters/boundedReconcile.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { type Abandonment, BoundedSingleFlight, type TimeSource } from './boundedReconcile.ts'

/** A fixed epoch for the manual clock; the value is arbitrary and only the differences matter. */
const T0 = 1_700_000_000_000

interface ManualTime extends TimeSource {
  /** The loop turns: the clock advances `ms`, and every timer that falls due runs, in order. */
  tick(ms: number): void
  /** The loop is blocked: the clock advances `ms`, and no timer runs, however overdue. */
  block(ms: number): void
  /** Timers armed and not yet run or disarmed. A finished run must leave none behind. */
  armed(): number
}

function manualTime(): ManualTime {
  let now = T0
  const armed: { at: number; fn: () => void }[] = []
  return {
    now: () => now,
    after(ms, fn) {
      const entry = { at: now + ms, fn }
      armed.push(entry)
      return () => {
        const i = armed.indexOf(entry)
        if (i >= 0) armed.splice(i, 1)
      }
    },
    block(ms) {
      now += ms
    },
    armed: () => armed.length,
    tick(ms) {
      const until = now + ms
      for (;;) {
        const due = armed.filter((e) => e.at <= until).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        armed.splice(armed.indexOf(due), 1)
        now = due.at
        due.fn()
      }
      now = until
    },
  }
}

/** A job that finishes when the test says so. */
function gate(): { landed: Promise<void>; land: () => void } {
  let land!: () => void
  const landed = new Promise<void>((r) => {
    land = r
  })
  return { landed, land }
}

/**
 * One real turn of the loop, so a job that has just landed gets to run its continuations --
 * including the `.then()` in `BoundedSingleFlight` that disarms the timer and frees the slot.
 */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

test('a second caller joins the run in flight rather than starting its own', async () => {
  const flight = new BoundedSingleFlight(1_000)
  const read = gate()
  let runs = 0
  const job = async () => {
    runs++
    await read.landed
  }

  const all = Promise.all([flight.run(job), flight.run(job), flight.run(job)])
  read.land()
  await all
  assert.equal(runs, 1, 'three clocks firing at once must not read the file three times')
  assert.equal(flight.busy, false, 'and the slot is free once it finishes')
})

test('a run that beats its bound is never marked abandoned', async () => {
  const time = manualTime()
  const flight = new BoundedSingleFlight(500, time)
  const read = gate()

  let sawAbandoned: boolean | undefined
  const run = flight.run(async (token) => {
    await read.landed
    sawAbandoned = token.abandoned
  })

  // One millisecond inside the bound: the last instant at which the job may still act.
  time.tick(499)
  read.land()
  await run
  assert.equal(sawAbandoned, false, 'the ordinary case must be able to act on what it read')
  assert.equal(flight.busy, false)
  assert.equal(time.armed(), 0, 'and a run that finished disarms its timer rather than leaving it to fire')
})

test('a run that exceeds the bound releases the caller, is told, and frees the slot', async () => {
  const time = manualTime()
  const flight = new BoundedSingleFlight(60, time)
  const read = gate()

  let told: boolean | undefined
  let finished = false
  let callerReleased = false
  const slow = flight.run(async (token) => {
    await read.landed
    // The read has landed. This is the moment the adapter checks before closing a transport or
    // superseding a verdict, and the answer must be that nobody is listening any more.
    told = token.abandoned
    finished = true
  })
  void slow.then(() => {
    callerReleased = true
  })

  time.tick(59)
  await flush()
  assert.equal(callerReleased, false, 'inside the bound the caller is still waiting on the run')
  assert.equal(flight.busy, true, 'and the run still holds the slot')

  time.tick(1)
  await flush()
  assert.equal(callerReleased, true, 'the caller returns at the bound, not at completion')
  assert.equal(finished, false, 'precondition: the job is still running, because nothing cancelled it')
  assert.equal(flight.busy, false, 'the slot is free at the bound, so a later deadline can retry')

  // A later deadline arriving while the abandoned run is still going gets a FRESH run, not the
  // abandoned one's promise. That is the whole point: a retry has to be able to succeed.
  let retried = 0
  await flight.run(async (token) => {
    retried++
    assert.equal(token.abandoned, false, 'the retry starts with its own bound, not the dead one')
  })
  assert.equal(retried, 1, 'the retry actually ran')

  read.land()
  await flush()
  assert.equal(finished, true, 'the abandoned run still finished; there is no cancellation here')
  assert.equal(told, true, 'and it was told, so everything it would have done is skipped')
})

test('an abandoned run does not evict the run that replaced it when it finally lands', async () => {
  // Entirely gated: the point is WHEN the first run lands relative to the second one's bound,
  // and with the clock in hand that is a position, not a race (#311).
  const time = manualTime()
  const flight = new BoundedSingleFlight(300, time)
  const first = gate()
  const second = gate()

  let firstToken!: Abandonment
  void flight.run((token) => {
    firstToken = token
    return first.landed
  })
  time.tick(300) // the first run's bound: it is abandoned, the slot is free, it runs on
  assert.equal(firstToken.abandoned, true, 'precondition: at its bound the first run reads abandoned')
  assert.equal(flight.busy, false, 'precondition: and the bound freed the slot')

  let secondSawAbandoned: boolean | undefined
  const joined = flight.run(async (token) => {
    await second.landed
    secondSawAbandoned = token.abandoned
  })
  assert.equal(flight.busy, true, 'the replacement took the freed slot')

  // The first run lands here, inside its successor's bound. Releasing the slot unconditionally
  // would free the SUCCESSOR's, and the next deadline would start a third concurrent read while
  // the second was still going.
  first.land()
  await flush()
  assert.equal(flight.busy, true, 'a landing corpse does not release a slot it no longer owns')

  // The successor's whole bound bar one millisecond, and none of it spent on anyone's machine.
  time.tick(299)
  second.land()
  await joined
  assert.equal(secondSawAbandoned, false, 'and the successor beat its own bound, so it may act')
  assert.equal(flight.busy, false)
})

test('a job that rejects is a run that had no answer, not an error for the caller', async () => {
  const flight = new BoundedSingleFlight(1_000)
  // An unreadable transcript is a documented no-answer case: it must leave the verdict alone
  // rather than propagate out of a fire-and-forget path and become an unhandled rejection.
  await flight.run(async () => {
    throw new Error('transcript unreadable')
  })
  assert.equal(flight.busy, false, 'and it must not leave the slot held, or nothing retries ever')

  let ran = false
  await flight.run(async () => {
    ran = true
  })
  assert.equal(ran, true)
})

// --- the synchronous overrun ------------------------------------------------------

test('a job that BLOCKS the loop past its bound is abandoned the instant it looks', async () => {
  // The hole a timer-written flag leaves, and the reason `abandoned` is a getter.
  //
  // Node drains microtasks before it runs the timers phase. So when a job blocks the loop
  // synchronously -- which is exactly what parsing a large transcript and rebuilding a view do
  // -- the job's own continuations run FIRST when it finally yields, and the overdue
  // `setTimeout` callback runs after them. A flag written by that callback is therefore still
  // `false` at the one moment anybody consults it, and the adapter goes on to close a transport
  // and supersede a verdict on evidence the bound had already disowned.
  //
  // Deterministic on purpose: `block`, not `tick`. The clock moves and the timer stays armed,
  // which is exactly what a blocked loop does to a real one, so the answer the token gives can
  // only have come from the clock.
  const time = manualTime()
  const flight = new BoundedSingleFlight(50, time)

  let abandonedInsideJob: boolean | undefined
  let slotStillHeld: boolean | undefined
  await flight.run(async (token) => {
    // The blocked quarter second: the clock moves, the loop does not turn, the timer does not run.
    time.block(250)
    // Read BEFORE yielding. This is the line the adapter's `if (token?.abandoned) return`
    // stands in for, and the whole point is that it is reached without an intervening tick.
    abandonedInsideJob = token.abandoned
    // The timer has not fired and cannot have: the loop never turned. If this is still true
    // while the line above is also true, the abandonment did not come from the timer.
    slotStillHeld = flight.busy
  })

  assert.equal(abandonedInsideJob, true, 'a result 250ms old under a 50ms bound must not be acted on')
  assert.equal(
    slotStillHeld,
    true,
    'and the timer demonstrably had not run yet, so the clock is what answered -- this is the ' +
      'assertion that fails if `abandoned` goes back to being a flag the timer writes',
  )
})

test('blocking the loop for LESS than the bound is not abandonment', async () => {
  // The control. Without it the test above passes for a `get abandoned() { return true }`, and
  // an always-abandoned token would silently disable the whole transcript re-check.
  const time = manualTime()
  const flight = new BoundedSingleFlight(400, time)
  let abandonedInsideJob: boolean | undefined
  await flight.run(async (token) => {
    time.block(60)
    abandonedInsideJob = token.abandoned
  })
  assert.equal(abandonedInsideJob, false, 'a job that came in under its bound may act on what it found')
})
