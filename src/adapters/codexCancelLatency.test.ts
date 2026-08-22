/**
 * What a Codex cancellation actually costs, as opposed to what its budget reads like.
 *
 * `#awaitTranscriptEvidence` polls for `turn_aborted` on a 15s budget. The budget is checked
 * ONCE per iteration, before the sleep, and bounds nothing inside the iteration: the sleep runs
 * in full, and the reconcile that follows is called with no bound at all -- deliberately, since
 * a cancellation is exactly when the strongest available evidence is wanted. That reconcile's
 * read can hold the view's queue for a whole `READ_LEASE_MS` before the queue detaches it and
 * hands back nothing.
 *
 * So two facts about a cancellation were documented as one number, and both are pinned here:
 *
 *   the outer bound     budget + one poll interval + one lease, about 25.75s -- because the
 *                       last iteration can be admitted with a millisecond of budget left
 *   two leases, not one a read that costs a lease leaves the next check at ~10.75s, still
 *                       inside the budget, so a second iteration runs and can cost another. A
 *                       third cannot: 21.5s is past the budget.
 *
 * These are the two ENDS of the same control flow and cannot happen in one run -- the longest
 * cancellation spends its budget cheaply and meets the lease last, which is one lease-consuming
 * read; the two-lease run finishes sooner. So there are two tests.
 *
 * ## What is stood in for, and what is not
 *
 * The subject is `cancel()`'s arithmetic, not the view's read -- that has its own suite in
 * `transcript/readLease.test.ts`. So `TranscriptSessionView.snapshot` is replaced with a stand-in
 * that costs a whole lease and then rejects with a real `TranscriptReadAbandoned`, which is
 * precisely the view's documented contract for a read that did not answer in time.
 *
 * ## Scaled, not shortened
 *
 * The adapter takes all three of its timing numbers as overrides -- the read lease, the evidence
 * budget and the poll interval -- and both tests inject all three, scaled by one factor. That
 * distinction is the whole reason this file can be quick and still mean something.
 *
 * Shorten ONE of them and the arithmetic changes: "two lease-consuming reads and no more than
 * two" holds only while a poll interval plus a lease exceeds half the budget, so a small lease
 * against a shipped budget turns the loop over twenty times instead of twice. That is a
 * different claim, correctly reported, about numbers this project does not ship. Scale all three
 * together and every ratio is preserved exactly, so both tests pin the shipped behaviour while
 * spending a fraction of a second between them.
 *
 * The stand-in is a read that is SLOW, which is not the same as a view that has given up. A
 * real view whose read answers nothing after a whole lease reports `readsStalled`, and the wait
 * returns on the spot rather than turning over again -- so through a real view the two-lease
 * shape below needs reads that are slow and still answer. Both are real; they are different
 * runs. The stalled one is pinned against a genuinely wedged view in
 * `adapters/wedgedTranscriptRead.test.ts`, and what is pinned here is the loop's arithmetic
 * when nothing has declared itself unable to read.
 *
 * Patching there rather than wedging the tail is what makes this deterministic. The adapter's own
 * tailer polls every 400ms through `view.poll()`, and a wedge on the tail catches whichever of
 * the two arrives first -- so the number of reconciles inside one cancellation would depend on
 * how the tailer's polls interleaved with the loop's. `snapshot` is the reconcile's seam and the
 * tailer never touches it.
 *
 * Everything else is real: the real `cancel()`, the real ESC and input drain, the real budget
 * loop over the real sleep, the real swallow-and-continue in `#reconcileFromTranscript`, and a
 * real child.
 *
 *   node --test src/adapters/codexCancelLatency.test.ts
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AgentSession, SessionSnapshot } from '../contract/session.ts'
import {
  READ_LEASE_MS,
  TranscriptReadAbandoned,
  TranscriptSessionView,
  type AnnouncedReadLease,
} from '../transcript/reconcile.ts'
import { CANCEL_EVIDENCE_BUDGET_MS, CANCEL_EVIDENCE_POLL_MS, CodexPtyHookAdapter } from './codex.ts'
import { installFakeClis } from './fakeCli.ts'

const { dir: RUN } = installFakeClis()

/** Both clocks far out of reach: a deadline would put a reconcile of its own on the loop. */
const IDLE_MS = 120_000
const ABSOLUTE_MS = 300_000

/**
 * Everything this file spends, scaled from the shipped numbers by one factor.
 *
 * The three quantities a cancellation is made of -- the evidence budget, the poll interval and
 * the view's read lease -- are all injectable, and all injected here TOGETHER. That is the only
 * way this file can be quick and still mean anything: every claim it makes is about how the
 * three compare, so scaling them by one factor keeps each claim exactly as true as it is in
 * production, while scaling any of them alone would be a statement about a configuration nobody
 * runs. "Two lease-consuming reads and no more than two" is the sharpest example -- it holds
 * only while a poll interval plus a lease exceeds half the budget, which is a ratio.
 *
 * ## What sets the floor on the factor, and where it actually is
 *
 * Not the assertions -- they are ratios and hold at any scale -- but the machine. `SLACK_MS`
 * absorbs timer granularity and process scheduling, and that noise is ABSOLUTE: it does not
 * shrink with the numbers being measured. Scale far enough and the slack needed to survive a
 * scheduling hiccup is larger than the quantity under test, at which point the bounds stop
 * being able to fail and the file passes without checking anything.
 *
 * The factor is set so the lease lands on 60ms, the same one `containedSnapshot.test.ts` uses,
 * which leaves 15ms of slack. That is not a guess: measured over six concurrent runs of this
 * file, the first test came in 1-3ms off its expected 129ms and the second landed at 149-153ms
 * inside a 126-169.5ms window. The jitter these bounds have to absorb is about 3ms and they are
 * given 15 -- a real margin, and still tight enough that a regression in any of the three
 * quantities moves elapsed straight through it.
 */
const SCALE = 60 / READ_LEASE_MS

/** The view's read lease for these sessions. Production is `READ_LEASE_MS`. */
const LEASE_MS = READ_LEASE_MS * SCALE

/** The evidence budget for these sessions. Production is `CANCEL_EVIDENCE_BUDGET_MS`. */
const BUDGET_MS = CANCEL_EVIDENCE_BUDGET_MS * SCALE

/** The poll interval for these sessions. Production is `CANCEL_EVIDENCE_POLL_MS`. */
const POLL_MS = CANCEL_EVIDENCE_POLL_MS * SCALE

/**
 * The documented worst case, DERIVED rather than copied.
 *
 * A test that hardcoded a number would keep passing if any of the three changed, which is the
 * failure mode the wrong documentation had in the first place. It is derived from the injected
 * values for the same reason: the shape `budget + one poll interval + one lease` is what is
 * being pinned, not any particular arithmetic.
 */
const WORST_CASE_MS = BUDGET_MS + POLL_MS + LEASE_MS

/** Timers and process scheduling; nothing here is measuring to the millisecond. */
const SLACK_MS = 2_500 * SCALE

const codexEvent = (payload: Record<string, unknown>): string =>
  JSON.stringify({ type: 'event_msg', timestamp: new Date(0).toISOString(), payload })

const started = (turnId: string): string => codexEvent({ type: 'task_started', turn_id: turnId })
const prompted = (text: string): string => codexEvent({ type: 'user_message', message: text })

/**
 * Every reconcile's read costs a lease and answers nothing, for as long as `slow()` says so.
 *
 * The rejection is the view's own class at the view's own lease, because that is what the
 * reconcile's `catch` is written against: "no evidence arrived, so leave the evidence we already
 * have alone". Anything else here would be testing a different catch.
 */
function leaseConsumingReads(slow: () => boolean, leaseMs: number = LEASE_MS): {
  readonly slowReads: number
  restore: () => void
} {
  const original = TranscriptSessionView.prototype.snapshot
  let slowReads = 0
  TranscriptSessionView.prototype.snapshot = async function (
    this: TranscriptSessionView,
    until?: AnnouncedReadLease,
  ): Promise<SessionSnapshot> {
    if (!slow()) return original.call(this, until)
    slowReads++
    await new Promise((r) => setTimeout(r, leaseMs))
    throw new TranscriptReadAbandoned(leaseMs)
  }
  return {
    get slowReads(): number {
      return slowReads
    },
    restore: () => {
      TranscriptSessionView.prototype.snapshot = original
    },
  }
}

/**
 * A live turn with NO `turn_aborted` anywhere on the file.
 *
 * That absence is the precondition for both tests: the loop returns the moment the verdict stops
 * being `assumed`, so a transcript that proves the cancellation would end it on its first
 * iteration and neither bound would ever be reached.
 */
async function sessionOverUnprovableTurn(): Promise<{ session: AgentSession; path: string }> {
  const path = join(mkdtempSync(join(tmpdir(), 'orch-cancel-latency-')), 'rollout.jsonl')
  writeFileSync(path, [started('fake-turn-1'), prompted('keep going')].join('\n') + '\n')

  const previous = process.env['ORCH_FAKE_TRANSCRIPT']
  process.env['ORCH_FAKE_TRANSCRIPT'] = path
  try {
    const session = await CodexPtyHookAdapter.start({
      cwd: RUN,
      role: 'implementer',
      inputOwnership: 'mediated',
      watchdogMs: ABSOLUTE_MS,
      idleMs: IDLE_MS,
      readyTimeoutMs: 20_000,
      // All three together. Injecting one without the others would change the ratios, and the
      // ratios are what every assertion below is about.
      readLeaseMs: LEASE_MS,
      cancelEvidenceBudgetMs: BUDGET_MS,
      cancelEvidencePollMs: POLL_MS,
    })
    return { session, path }
  } finally {
    if (previous === undefined) delete process.env['ORCH_FAKE_TRANSCRIPT']
    else process.env['ORCH_FAKE_TRANSCRIPT'] = previous
  }
}

test('one cancellation can spend two full read leases, and no more than two', async () => {
  // Every read costs a lease. Check at 0 passes, sleep, read to ~10.75s; check at ~10.75s still
  // passes -- that is the whole point, the budget has not been spent, only most of it has gone
  // to a single read -- sleep, read to ~21.5s; check at ~21.5s fails. Two reads, and a third is
  // arithmetically unreachable.
  //
  // Those numbers are the shipped ones; what runs is the same ratio, scaled. "Exactly two" holds only
  // while a poll interval plus a lease exceeds half the budget, and that is a ratio -- untouched
  // by scaling all three together, and destroyed by scaling any one of them alone. See the
  // header.
  const { session } = await sessionOverUnprovableTurn()
  const reads = leaseConsumingReads(() => true)
  try {
    await session.send('keep going', { kind: 'orchestrator' })

    const at = Date.now()
    const key = await session.cancel()
    const elapsed = Date.now() - at

    assert.ok(key, 'precondition: there was a live turn to cancel, or the wait is never entered')
    assert.equal(reads.slowReads, 2, 'two iterations reached the filesystem, and each cost a lease')

    const expected = 2 * (POLL_MS + LEASE_MS)
    assert.ok(
      elapsed >= expected - SLACK_MS && elapsed <= expected + SLACK_MS,
      `two poll intervals and two leases is ~${expected}ms; cancel() took ${elapsed}ms`,
    )
    assert.ok(
      elapsed > BUDGET_MS,
      `and it already runs past the budget: ${elapsed}ms against a ${BUDGET_MS}ms budget`,
    )
    assert.ok(elapsed <= WORST_CASE_MS + SLACK_MS, `still inside the documented bound: ${elapsed}ms`)
  } finally {
    reads.restore()
    await session.close()
  }
})

test('a cancellation runs past its budget by a poll interval and a lease, and no further', async () => {
  // The other end. Reads are real and fast until the budget is nearly spent, so the loop turns
  // over every ~750ms and arrives at its LAST check with the budget almost gone. That check
  // passes, the sleep runs in full, and the read that follows costs a whole lease -- which is
  // the arithmetic the documentation used to state as 15 seconds.
  //
  // Every bound below is computed from the injected trio. What this end of the control flow
  // depends on is that ONE read costs a whole lease after the last check passes, which is true
  // at any scale.
  const { session } = await sessionOverUnprovableTurn()
  let slowFrom = Number.POSITIVE_INFINITY
  const reads = leaseConsumingReads(() => Date.now() >= slowFrom)
  try {
    await session.send('keep going', { kind: 'orchestrator' })

    // Between the second-to-last read and the last one, which is what makes it exactly one.
    //
    // Reads land a poll interval apart, so the last two are at about `budget - poll` and about
    // `budget`. Putting the switch half an interval before the budget leaves the first of those
    // fast and the second slow, and no check after it can pass. The old value here was two whole
    // intervals earlier, which worked only because a ten-second lease blew the budget on its
    // first slow read; with a lease shorter than the interval the loop simply keeps going, and
    // several reads are slow instead of one. Derived, so it stays right for either.
    slowFrom = Date.now() + BUDGET_MS - POLL_MS / 2
    const at = Date.now()
    const key = await session.cancel()
    const elapsed = Date.now() - at

    assert.ok(key, 'precondition: there was a live turn to cancel')
    assert.equal(reads.slowReads, 1, 'exactly one iteration met the lease: the last one')

    assert.ok(
      elapsed > BUDGET_MS,
      `the budget does not bound this: ${elapsed}ms against a ${BUDGET_MS}ms budget`,
    )
    assert.ok(
      elapsed >= BUDGET_MS + LEASE_MS - 2 * POLL_MS - SLACK_MS,
      `and it overruns by a whole lease, not a little: ${elapsed}ms`,
    )
    assert.ok(
      elapsed <= WORST_CASE_MS + SLACK_MS,
      `budget + one poll interval + one lease is the ceiling (~${WORST_CASE_MS}ms); ` +
        `cancel() took ${elapsed}ms`,
    )
  } finally {
    reads.restore()
    await session.close()
  }
})
