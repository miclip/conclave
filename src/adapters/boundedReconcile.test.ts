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
 *   node --test src/adapters/boundedReconcile.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { BoundedSingleFlight } from './boundedReconcile.ts'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

test('a second caller joins the run in flight rather than starting its own', async () => {
  const flight = new BoundedSingleFlight(1_000)
  let runs = 0
  const job = async () => {
    runs++
    await sleep(20)
  }

  await Promise.all([flight.run(job), flight.run(job), flight.run(job)])
  assert.equal(runs, 1, 'three clocks firing at once must not read the file three times')
  assert.equal(flight.busy, false, 'and the slot is free once it finishes')
})

test('a run that beats its bound is never marked abandoned', async () => {
  const flight = new BoundedSingleFlight(500)
  let sawAbandoned: boolean | undefined
  await flight.run(async (token) => {
    await sleep(10)
    sawAbandoned = token.abandoned
  })
  assert.equal(sawAbandoned, false, 'the ordinary case must be able to act on what it read')
})

test('a run that exceeds the bound releases the caller, is told, and frees the slot', async () => {
  const flight = new BoundedSingleFlight(60)

  let told: boolean | undefined
  let finished = false
  const slow = flight.run(async (token) => {
    await sleep(400)
    // The read has landed. This is the moment the adapter checks before closing a transport or
    // superseding a verdict, and the answer must be that nobody is listening any more.
    told = token.abandoned
    finished = true
  })

  const started = Date.now()
  await slow
  const waited = Date.now() - started
  assert.ok(waited < 300, `the caller must return at the bound, not at completion (waited ${waited}ms)`)
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

  await sleep(500)
  assert.equal(finished, true, 'the abandoned run still finished; there is no cancellation here')
  assert.equal(told, true, 'and it was told, so everything it would have done is skipped')
})

test('an abandoned run does not evict the run that replaced it when it finally lands', async () => {
  // Gated rather than timed: the point is WHEN the first run lands relative to the second one's
  // bound, and a sleep long enough to be reliable would have to be long enough to be flaky.
  const flight = new BoundedSingleFlight(300)
  let landFirst!: () => void
  let landSecond!: () => void
  const first = new Promise<void>((r) => {
    landFirst = r
  })
  const second = new Promise<void>((r) => {
    landSecond = r
  })

  void flight.run(() => first)
  await sleep(400) // past the first run's bound; it is abandoned and still running

  let secondSawAbandoned: boolean | undefined
  const joined = flight.run(async (token) => {
    await second
    secondSawAbandoned = token.abandoned
  })
  assert.equal(flight.busy, true, 'the replacement took the freed slot')

  // The first run lands here, inside its successor's bound. Releasing the slot unconditionally
  // would free the SUCCESSOR's, and the next deadline would start a third concurrent read while
  // the second was still going.
  landFirst()
  await sleep(20)
  assert.equal(flight.busy, true, 'a landing corpse does not release a slot it no longer owns')

  landSecond()
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
  // Deterministic on purpose: a busy-wait, not a sleep. Nothing here yields, so no timer can
  // have run, and the answer the token gives can only have come from the clock.
  const flight = new BoundedSingleFlight(50)

  let abandonedInsideJob: boolean | undefined
  let slotStillHeld: boolean | undefined
  await flight.run(async (token) => {
    const until = Date.now() + 250
    while (Date.now() < until) {
      // Spin. The event loop belongs to this job for the whole quarter second.
    }
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
  const flight = new BoundedSingleFlight(400)
  let abandonedInsideJob: boolean | undefined
  await flight.run(async (token) => {
    const until = Date.now() + 60
    while (Date.now() < until) {
      // Spin, briefly.
    }
    abandonedInsideJob = token.abandoned
  })
  assert.equal(abandonedInsideJob, false, 'a job that came in under its bound may act on what it found')
})
