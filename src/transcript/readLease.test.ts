/**
 * A transcript read that never comes back must not take the view down with it -- and must not
 * be answered by asking the filesystem again.
 *
 * `TranscriptSessionView` serialises its reads, and it has to: the poll body mutates `#records`,
 * `#view`, `#emitted` and `#seq` after the tail returns, and two bodies interleaved duplicate or
 * skip records -- which `reconcile.test.ts` covers from the outside.
 *
 * Make the head's completion a precondition for everything behind it and a read that never
 * settles is a permanent wedge on the whole view, so every mechanism built on top inherits it:
 *
 *   the deadline re-check   `BoundedSingleFlight` frees its slot at its bound SO THAT a later
 *                           deadline can retry, and the retry queued behind the read the bound
 *                           had already written off
 *   `close()`              reconciles with no bound of its own, so a shutdown parked forever
 *   Codex's cancel wait     polls the transcript for `turn_aborted` inside a budget, and the
 *                           first iteration never returned, so the budget was never consulted
 *
 * The fix for that is to answer those CALLERS. The fix it must not be is to start another read.
 * Nothing at this layer can cancel a filesystem operation, so releasing the queue for a detached
 * read put a second operation against the same file in flight beside the first, and under a
 * wedge that compounded once per lease interval without bound. A process meeting an unresponsive
 * filesystem must not answer by asking it for more.
 *
 * So a waiter and a read are separate things, and only the waiter can be given up on:
 *
 *   a waiter expires        its caller is told it got no answer, and it leaves. That is all.
 *   the read carries on     it was never that caller's to abandon
 *   the next caller ATTACHES to the same operation rather than starting a rival
 *   the operation COMMITS   whenever it lands, whether or not anyone is still listening --
 *                           there is no second reader to conflict with, and the events those
 *                           records produced are banked for the next `poll()` rather than
 *                           dropped with the caller that went
 *
 * So the number of underlying operations across an arbitrarily long wedge is one, and it is one
 * whether nobody is waiting or a dozen callers are. These tests count that number.
 *
 * They wedge the REAL tail -- the hold is taken inside the read, where a hung filesystem call
 * would take it -- and check every part of it: that no caller is parked, that nothing else
 * reads while the wedge holds, and that the read loses nothing and duplicates nothing when it
 * is finally released.
 *
 *   node --test src/transcript/readLease.test.ts
 */

import { strict as assert } from 'node:assert'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { suiteTempDir } from '../testkit/tempDir.ts'
import { TranscriptReadAbandoned, TranscriptSessionView } from './reconcile.ts'
import { RewriteAwareTail, parseJsonLine, type ReadLease } from './tail.ts'
import { wedgeOneTailPoll, type TailWedge } from './tailWedge.ts'
import { guaranteesFor } from '../contract/session.ts'
import type { AgentEvent } from '../contract/session.ts'

const SCRATCH = suiteTempDir('read-lease')

/**
 * Short enough to run, long enough that no ordinary read in this file trips it.
 *
 * The production default is `READ_LEASE_MS`, three orders of magnitude larger, because there it
 * has to sit far above any read that is merely slow. Nothing here is testing the VALUE.
 */
const LEASE_MS = 60

const userRecord = (text: string): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'

const finishedRecord = (text: string): string =>
  JSON.stringify({
    type: 'assistant',
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] },
  }) + '\n'

const turn = (prompt: string, answer: string): string => userRecord(prompt) + finishedRecord(answer)

function view(path: string, leaseMs: number = LEASE_MS): TranscriptSessionView {
  return new TranscriptSessionView({
    path,
    agent: 'claude',
    sessionId: 'test-session',
    cwd: '/tmp',
    guarantees: guaranteesFor('mediated'),
    readLeaseMs: leaseMs,
  })
}

/**
 * Long enough that no lease expires while a test is arranging things.
 *
 * For the cases about what happens BEFORE the lease is spent -- a caller answered by
 * `abandonReads()`, a read released while somebody is still waiting on it. `LEASE_MS` is 60ms,
 * which is short enough that the stall could fire between two lines of a test and turn a real
 * assertion into a coin toss.
 */
const PATIENT_MS = 5_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Wait until the view will take a caller again, and say so out loud if it never will.
 *
 * Releasing the wedge lets the held poll RESUME; the view is still holding it until that poll
 * returns and `#read`'s `finally` runs. Until then a view somebody has called `abandonReads()`
 * on refuses arrivals with `TranscriptReadAbandoned` -- correctly, since it can neither cancel
 * the operation nor duplicate it -- and a test that reads on the next line is measuring that
 * window rather than the recovery it meant to check. A real caller retries; a test waits.
 *
 * This waited 25ms. 25ms is a guess about how long a filesystem takes, and #176 is what a guess
 * costs: one failure in ten platform-attempts on the slowest runner in the matrix, at
 * `abandonReads() answers everyone at once`, where the sleep ended before the flag cleared and
 * the snapshot behind it was refused. `readsStalled` is that flag, and it is public because
 * `cancel()` reads it for exactly this question -- "is there any point asking yet". So the test
 * asks the same thing the production caller asks, and stops when it has an answer rather than
 * when a number of milliseconds chosen in 2025 has gone by.
 *
 * TO REPRODUCE #176 DETERMINISTICALLY: put `await Promise.resolve()` in place of a call to this
 * helper. One microtask is not enough for a released read to finish real filesystem work, so the
 * flag is still set, and the failure is the same one every run instead of one run in ten. See
 * the call site in `abandonReads() answers everyone at once` for the recorded output.
 *
 * ON THE THREE SITES WHERE NOBODY ABANDONED ANYTHING this returns on the first check, and that
 * is the correct answer rather than a hole: `#stalled` is set only by `abandonReads()`, and a
 * view that has not been told to give up does not refuse arrivals at all -- the next caller
 * ATTACHES to the outstanding read and is answered by it. There is nothing to wait for, so it
 * does not wait. What the helper guarantees everywhere is the precondition each of those call
 * sites actually needs: the view is not going to turn the next line away.
 *
 * It THROWS on expiry rather than returning. A wait that gives up quietly and lets the next line
 * run turns "the flag never cleared" into whatever that line happens to assert -- which for #176
 * was a `TranscriptReadAbandoned` naming a 5000ms lease the caller had not waited any of, three
 * frames from anything that would tell a reader what went wrong.
 */
const SETTLE_BUDGET_MS = 2_000
const settled = async (v: TranscriptSessionView, within: number = SETTLE_BUDGET_MS): Promise<void> => {
  const deadline = Date.now() + within
  while (v.readsStalled) {
    if (Date.now() >= deadline) {
      throw new Error(
        `the view was still refusing callers ${within}ms after the read was released: ` +
          `readsStalled is true, so \`#read\`'s \`finally\` has not run and the operation has not ` +
          `come back. ${v.abandonedReads} read(s) abandoned so far. Either the wedge was not ` +
          `released, or the release stopped clearing the flag. A machine merely being slow does not ` +
          `reach here: the default budget is ${SETTLE_BUDGET_MS}ms for work that takes single digits.`,
      )
    }
    await sleep(1)
  }
}

const promptsOf = (events: AgentEvent[]): string[] =>
  events.filter((e) => e.type === 'turn_start').map((e) => String(e.prompt))

/**
 * Run one of the test below's ordinary reads to an ANSWER, and name the stage if it never gets
 * one.
 *
 * These three reads are not the subject of anything. They set the file up, they drain what a
 * released read banked, and they check the final projection; every assertion about the
 * invariant is somewhere else. What they were nonetheless asserting, silently, is that a cold
 * filesystem read answers inside `LEASE_MS` -- 60ms -- on whatever machine happens to be
 * running them. That is not a property of this code. It is a property of the disk, and it is
 * the one this test kept losing:
 *
 *   ✖ a wedged read is never joined by a second one, however long it lasts
 *     Error: the "precondition poll" read lost its 60ms lease. readsStalled=false,
 *     abandonedReads=1, wedge.calls=n/a -- no wedge installed at this stage.
 *     [cause]: TranscriptReadAbandoned: transcript read abandoned after 60ms ...
 *         at Timeout.expire (src/transcript/reconcile.ts)
 *
 * `readsStalled=false` and no wedge: nothing had been abandoned and nothing was being held.
 * An ordinary read was simply late, and a caller with a 60ms lease was told so -- which is the
 * lease doing its job, correctly, at a test that had no business asking for that guarantee.
 *
 * SO IT RETRIES, because that is what the lease is FOR. `TranscriptReadAbandoned` is not a
 * failure; it is "no answer yet, ask again if you still care" -- the contract `BoundedSingleFlight`
 * is built on, and the same answer a real deadline re-check gets. A caller that still cares
 * asks again, attaches to the same operation, and is answered when it lands. Nothing here
 * duplicates a read: `#inflight` guarantees one operation and this loop just keeps a waiter on
 * it.
 *
 * WHAT IT DELIBERATELY IS NOT. Not a longer lease -- `LEASE_MS` is unchanged, and raising it
 * would only move the machine at which this breaks. Not a sleep -- there is no interval here to
 * guess, and guessing one is the mistake this whole issue exists to remove. The bound is
 * `PATIENT_MS`, and what it buys is a diagnostic rather than a hang: a read that never answers
 * in five seconds is a real defect and says so, with the stage, the counters and the attempt
 * count.
 *
 * Only `TranscriptReadAbandoned` is retried. Anything else -- an unreadable file, a parse that
 * threw -- is a real failure of a real read and goes straight up.
 */
async function readStage<T>(
  name: string,
  v: TranscriptSessionView,
  wedge: TailWedge | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + PATIENT_MS
  let attempts = 0
  let abandoned = 0
  for (;;) {
    attempts++
    try {
      return await run()
    } catch (err) {
      if (!(err instanceof TranscriptReadAbandoned)) throw err
      abandoned++
      if (Date.now() >= deadline) {
        throw new Error(
          `the "${name}" read never answered inside ${PATIENT_MS}ms: ${attempts} attempt(s), ` +
            `${abandoned} of them told the read had not come back. readsStalled=${v.readsStalled}, ` +
            `abandonedReads=${v.abandonedReads}, ` +
            `wedge.calls=${wedge ? wedge.calls : 'n/a -- no wedge installed at this stage'}. ` +
            `A single lost ${LEASE_MS}ms lease is ordinary and is retried; ${PATIENT_MS}ms of them ` +
            `is a read that is not coming back, which is a defect rather than a slow disk.`,
          { cause: err },
        )
      }
      // A turn of the macrotask queue before asking again. Not a delay -- there is nothing to
      // wait out, and no number is being guessed. A rejection that arrives without ever
      // reaching the filesystem settles on the microtask queue, and a loop that never leaves it
      // would starve the very timers that let the read finish.
      await new Promise((r) => setImmediate(r))
    }
  }
}

test('a wedged read is never joined by a second one, however long it lasts', async () => {
  // The invariant, counted rather than inferred. Everything that used to be let past the head
  // -- a retry, an unbounded reader, a budget loop going round and round -- is answered here,
  // and the number of filesystem operations against this transcript stays at one throughout.
  const path = join(SCRATCH, 'wedged-queue.jsonl')
  writeFileSync(path, turn('one', 'first'))
  const v = view(path)

  // THE GATE STAYS ON. It was the reproduction; it is now the guard, and it runs every time.
  //
  // This read has nothing to do with the invariant below it. No wedge exists yet, `#stalled`
  // was never set, and the file is two lines that `writeFileSync` has just finished writing.
  // It is an ORDINARY read, and the only thing it was ever racing is whether the filesystem
  // answers inside `LEASE_MS`. On a loaded machine it does not, and the test used to fail:
  //
  //   ✖ a wedged read is never joined by a second one, however long it lasts
  //     Error: the "precondition poll" read lost its 60ms lease. readsStalled=false,
  //     abandonedReads=1, wedge.calls=n/a -- no wedge installed at this stage.
  //
  // The gate below is that machine, made portable: it holds this one tail poll past the lease
  // and then lets it go, which is what a loaded runner does by accident. The read is guaranteed
  // to lose its first lease, every run, on every machine. It is not guaranteed to lose the
  // second, because by then the gate has lifted -- which is the whole point. `readStage` asks
  // again, attaches to the same operation, and is answered when it lands.
  //
  // IT IS A SEPARATE GATE FROM THE WEDGE BELOW, deliberately, and torn down before the test's
  // real subject begins. That one is armed to count operations across a wedge that never lifts;
  // sharing it would make the call counts the invariant is measured with unreadable.
  //
  // STILL OPEN, NOT TOUCHED HERE. `rounds >= 3` further down is a second wall-clock assumption
  // in this same test -- that a budget loop gets three iterations inside three lease intervals
  // -- and the operator saw it fail once with `rounds === 2`. It is a different question from
  // this one and is left alone.
  const slow = wedgeOneTailPoll()
  slow.arm()
  // Comfortably past the lease rather than a whisker past it: the point is that the read is
  // late, and a margin that is itself a race would be the same mistake one layer down.
  const lift = setTimeout(() => slow.release(), LEASE_MS + 40)
  lift.unref?.()

  const lostLeasesBefore = v.abandonedReads
  const seen: AgentEvent[] = []
  try {
    seen.push(...(await readStage('precondition poll', v, undefined, () => v.poll())))
  } finally {
    // The held read is let go and the prototype put back whatever happened, so a failure here
    // cannot leave a patch installed for the tests behind it.
    clearTimeout(lift)
    slow.release()
    slow.restore()
  }
  // The guard proving the guard. Without this the gate could stop holding anything -- an
  // `arm()` that no longer catches, a lease that quietly grew -- and the retry would go on
  // passing while testing nothing at all.
  assert.ok(
    v.abandonedReads > lostLeasesBefore,
    `the gate must actually cost this read a lease, or the retry below it is proving nothing: ` +
      `abandonedReads went ${lostLeasesBefore} -> ${v.abandonedReads}`,
  )
  assert.deepEqual(promptsOf(seen), ['one'], 'precondition: an ordinary read works')

  const wedge = wedgeOneTailPoll()
  try {
    // EVERY poll, not just the next: a second read must be caught here rather than slipping
    // past an unarmed patch and looking, in the count below, like a read that never happened.
    wedge.armAll()
    const before = wedge.calls
    // Its outcome is captured at the moment the read starts, exactly as a real caller's `await`
    // would. Holding the bare promise and awaiting it several assertions later would make the
    // eventual rejection an UNHANDLED one -- an artefact of the test's shape, not of the code.
    const wedged = v.poll().then(
      () => 'resolved' as const,
      (e: unknown) => e,
    )
    while (!wedge.taken) await sleep(5)
    assert.equal(wedge.calls - before, 1, 'precondition: exactly one read is outstanding, and it is held')

    // On the file but never read, because nothing is going to read it until the wedge lifts.
    appendFileSync(path, turn('two', 'second'))

    // THE RETRY. This is what a later deadline does after `BoundedSingleFlight` frees its slot.
    // It is told it got no answer -- which is the truth, and is what frees the slot again --
    // rather than being handed a second file descriptor into a filesystem that is not answering.
    await assert.rejects(() => v.poll(), TranscriptReadAbandoned, 'a retry is answered, not queued forever')
    await assert.rejects(() => v.snapshot(), TranscriptReadAbandoned)

    // The shape Codex's post-cancel wait uses: reconcile repeatedly inside a budget. Before any
    // of this existed, iteration one never returned and the budget was never consulted again.
    // Now every iteration comes back -- and none of them reads.
    // The shape Codex's post-cancel wait uses, counted rather than clocked.
    //
    // WHAT THIS IS FOR. Before any of this existed, iteration one never returned and the budget
    // was never consulted again -- one call into a wedged filesystem took the whole loop with
    // it. What has to be true is that every iteration COMES BACK, and comes back with the truth:
    // no answer yet. Three callers, three non-answers, one read underneath them.
    //
    // IT USED TO BE CLOCKED, and that was the bug. The loop ran against a budget of three lease
    // intervals and asserted `rounds >= 3` -- but every iteration costs one whole lease, so it
    // was really asserting that the overhead BETWEEN iterations was nil:
    //
    //   [rounds] budget=180ms rounds=3 per-round=[62,61,61]
    //   [rounds] budget=180ms rounds=3 per-round=[61,60,61]
    //
    // Round three started at t≈122 against a deadline of 180. 58ms of slack across two
    // iterations, and on a machine that inserted ~29ms of scheduling lag apiece it never began:
    //
    //   ✖ AssertionError: a budget loop over snapshot() must keep going round: 2
    //
    // The operator saw that once in six isolated runs. The number was never the problem --
    // enlarging the budget would have left the same assertion one machine further from the
    // edge. The problem was counting elapsed time to prove a thing that is not about time.
    //
    // SO IT COUNTS CALLERS INSTEAD. Three attempts, written out, each one REQUIRED to come back
    // rejecting with `TranscriptReadAbandoned`. That is stronger than what the clock version
    // checked, which swallowed both outcomes with a bare `.then(undefined, undefined)` and so
    // could not tell a non-answer from an answer, or from an unrelated throw.
    //
    // THE 45ms LAG STAYS ON, and it now proves the opposite of what it used to. It was the
    // reproduction -- enough scheduling lag to cost the old loop its third round. Nothing here
    // reads a clock any more, so it costs this version nothing, and a future edit that
    // reintroduces a wall-clock bound fails on the machine that runs this file rather than on
    // the slowest runner in the matrix, weeks later.
    const ROUNDS = 3
    const ROUND_LAG_MS = 45
    for (let round = 1; round <= ROUNDS; round++) {
      await assert.rejects(
        () => v.snapshot(),
        TranscriptReadAbandoned,
        `round ${round} of ${ROUNDS} must come back, and must come back saying it got no answer`,
      )
      await sleep(ROUND_LAG_MS)
    }
    assert.equal(
      wedge.calls - before,
      1,
      `exactly one underlying read, across ${ROUNDS} callers and three lease intervals: ${wedge.calls - before}`,
    )

    assert.ok(
      (await wedged) instanceof TranscriptReadAbandoned,
      'and the caller of the wedged read is told it got no answer, not handed an empty poll',
    )

    // Something the wedged read has not seen, so that when it lands it has real records in hand
    // and has to throw them away rather than commit them.
    appendFileSync(path, turn('three', 'third'))

    wedge.release()
    const late = await wedge.landed
    // It COMMITS. There is no rival reader for it to conflict with -- that is the point of the
    // whole arrangement -- so throwing away a read that finally answered would only mean asking
    // the same filesystem for the same bytes again. The caller it was started for is long gone;
    // what it found is banked for whoever asks next.
    assert.notEqual(late.abandoned, true, 'a read with no rival has nothing to protect anyone from')
    assert.equal(late.appended.length, 4, 'and it hands back the two turns it was holding all along')
    await settled(v)
    assert.equal(wedge.calls - before, 1, 'and it landed without any other read ever having been started')

    const after = await readStage('post-release bank drain', v, wedge, () => v.poll())
    seen.push(...after)
    assert.deepEqual(
      promptsOf(after),
      ['two', 'three'],
      'delivered exactly once, from the read that committed them rather than from a second one',
    )

    assert.deepEqual(
      promptsOf(seen),
      ['one', 'two', 'three'],
      'and nothing was announced twice: a duplicated read shows up here as a repeated prompt',
    )
    const seqs = seen.map((e) => e.seq)
    assert.equal(new Set(seqs).size, seqs.length, 'no sequence number is issued twice')

    const snap = await readStage('final authoritative snapshot', v, wedge, () => v.snapshot())
    assert.deepEqual(
      snap.turns.map((t) => t.prompt),
      ['one', 'two', 'three'],
      'the canonical view is the file, once, in order',
    )
  } finally {
    wedge.release()
    wedge.restore()
  }
})

test('a retry attaches to the outstanding read and is answered by it, with no second call', async () => {
  // The invariant at its sharpest, and the one an "answer the waiter" fix gets wrong if the
  // waiter and the read are not really separated.
  //
  // A first read wedges. Its caller waits out its lease and is told it got no answer -- correct,
  // and the whole reason the lease exists. What must NOT have happened to the read is anything
  // at all: it was never that caller's to give up. So when a second caller arrives it attaches
  // to the same operation, and when the filesystem finally answers, that one read commits once
  // and satisfies the caller that is still there. One `tail.poll` for the pair.
  //
  // The way to get this wrong and still pass a shallower test is to mark the read abandoned when
  // its waiter expires: the operation then lands, commits nothing, and the attached caller has
  // to start a second read to get an answer. That is two calls, and the count is what catches it.
  const path = join(SCRATCH, 'attached-retry.jsonl')
  writeFileSync(path, turn('one', 'first'))
  const v = view(path)

  assert.equal(v.lastBuilt(), undefined, 'precondition: a FIRST read, so nothing can be answered from memory')

  const wedge = wedgeOneTailPoll()
  try {
    // Every poll, so a second one is caught here rather than slipping past an unarmed patch and
    // looking, in the count, like a read that never happened.
    wedge.armAll()

    const first = v.snapshot().then(
      () => 'resolved' as const,
      (e: unknown) => e,
    )
    while (!wedge.taken) await sleep(5)
    assert.equal(wedge.calls, 1, 'precondition: exactly one operation, and it is held')

    // The original waiter runs out of patience on its own lease. Nothing else is asked to.
    assert.ok((await first) instanceof TranscriptReadAbandoned, 'its caller is told it got no answer')
    assert.equal(wedge.calls, 1, 'and telling it changed nothing about the read')

    // THE RETRY. It attaches: there is an operation in flight, and it waits for that one.
    let landed = false
    const attached = v.snapshot().then((snap) => {
      landed = true
      return snap
    })
    await sleep(LEASE_MS / 2)
    assert.equal(wedge.calls, 1, 'attaching is not reading: still one operation')
    assert.equal(landed, false, 'and it is genuinely waiting on it, not answering from nothing')

    // The filesystem answers at last. The read that the first caller gave up on is the read that
    // satisfies the second one.
    wedge.release()
    const snap = await attached
    assert.equal(wedge.calls, 1, `answered by the sole tail call, not by a second one: ${wedge.calls}`)
    assert.deepEqual(
      snap.turns.map((t) => t.prompt),
      ['one'],
      'a real projection of a real file, built from what that read committed',
    )
    assert.equal(snap.containedFallback, undefined, 'and it is a read, not the last thing built')

    // Committed exactly once. The events those records produced were computed while the original
    // caller was already gone, so this is where they would have been lost -- they were banked
    // instead, and the next reader gets them, once.
    const events = await v.poll()
    assert.deepEqual(promptsOf(events), ['one'], 'the records are delivered, exactly once')
    assert.deepEqual(promptsOf(await v.poll()), [], 'and not again')
    assert.deepEqual(
      (await v.snapshot()).turns.map((t) => t.prompt),
      ['one'],
      'with the view holding the file once, in order: nothing doubled by the commit',
    )
  } finally {
    wedge.release()
    wedge.restore()
  }
})

test('events a read committed are deliverable even when the next read never comes back', async () => {
  // The other half of committing for a caller who has gone.
  //
  // A read that lands with nobody attached still commits, and the events it produced are banked
  // rather than dropped -- `#emitFor` is a watermark, so an event computed and discarded is gone
  // for good. Banking them is only half an answer: they have to be REACHABLE. Read first and
  // deliver second, and the delivery sits behind a filesystem call that may never return, so on
  // a wedged view the records are safe and unreachable at once -- which for an adapter emitting
  // from `events()` is a turn that has gone silent for reasons nothing in the transcript
  // explains.
  //
  // So `poll()` hands over what it already has before it goes anywhere near the file.
  const path = join(SCRATCH, 'banked-delivery.jsonl')
  writeFileSync(path, turn('one', 'first'))
  const v = view(path)

  const wedge = wedgeOneTailPoll()
  try {
    // A read with no `poll()` waiter on it: `snapshot()` runs the same body and wants the
    // projection, so the events it computes have nowhere to go but the bank.
    const snap = await v.snapshot()
    assert.deepEqual(snap.turns.map((t) => t.prompt), ['one'], 'precondition: the read committed')
    assert.equal(wedge.calls, 1, 'precondition: one read, and it is the only one this test allows')

    // From here the filesystem is gone for good, as far as this view is concerned.
    wedge.armAll()

    const delivered = await v.poll()
    assert.deepEqual(
      promptsOf(delivered),
      ['one'],
      'the banked events are handed over rather than held hostage by a read that cannot answer',
    )
    assert.equal(wedge.calls, 1, `delivered by the original sole tail call: ${wedge.calls}`)

    // Exactly once. The drain is destructive, so the next caller finds nothing banked and does
    // what it should: goes to the file, meets the wedge, and is told it got no answer.
    await assert.rejects(() => v.poll(), TranscriptReadAbandoned, 'and with nothing left it reads again')
    assert.equal(wedge.calls, 2, 'which is the read it was right to attempt, and the only extra one')
  } finally {
    wedge.release()
    wedge.restore()
  }
})

test('abandonReads() answers everyone at once, and starts nothing in their place', async () => {
  // What `close()` calls on both adapters, and Codex's cancel after the ESC. Neither can afford
  // to sit behind a read that may never answer, and neither has a bound of its own to be told at.
  //
  // So it spends the read's remaining lease on the spot: the caller waiting on it is answered,
  // and so is everyone behind it, immediately rather than a lease from now. What it deliberately
  // no longer does is admit the next read. The operation it gave up on is still running, and a
  // shutdown is the worst moment to double the number of reads a wedged filesystem is holding.
  const path = join(SCRATCH, 'abandon-reads.jsonl')
  writeFileSync(path, turn('one', 'first'))
  const v = view(path, PATIENT_MS)

  const wedge = wedgeOneTailPoll()
  try {
    wedge.arm()
    const wedged = v.poll().then(
      () => 'resolved' as const,
      (e: unknown) => e,
    )
    while (!wedge.taken) await sleep(5)
    const before = wedge.calls
    // Queued behind it before anything gives up, so this one is being answered by the abandon
    // rather than by a lease of its own -- its lease is `PATIENT_MS` away.
    const behind = v.snapshot().then(
      () => 'resolved' as const,
      (e: unknown) => e,
    )

    const started = Date.now()
    v.abandonReads()
    assert.ok((await wedged) instanceof TranscriptReadAbandoned, 'the caller of the read is told')
    assert.ok((await behind) instanceof TranscriptReadAbandoned, 'and so is the one waiting behind it')
    const waited = Date.now() - started
    assert.ok(waited < PATIENT_MS, `both at once, not on a clock: ${waited}ms`)
    assert.equal(wedge.calls, before, 'and nothing was authorised to read in their place')

    // A caller arriving afterwards is refused on arrival, for the same reason and without a wait:
    // the view has an operation it can neither cancel nor duplicate, and it already knows it.
    const asked = Date.now()
    await assert.rejects(() => v.poll(), TranscriptReadAbandoned)
    assert.ok(Date.now() - asked < PATIENT_MS, 'told on arrival rather than made to wait it out')
    assert.equal(wedge.calls, before, 'still nothing: the first operation has not settled yet')

    // And the moment it settles, the view reads again -- the same file from the same offset,
    // because the abandoned read committed nothing.
    //
    // #176 LIVED HERE, and this is how to bring it back. `release()` does not settle the read;
    // it lets it RESUME, and the view goes on refusing arrivals until `#read`'s `finally` runs.
    // What stood on the next line was `sleep(25)` -- a bet on how long a filesystem takes -- and
    // the `snapshot()` below is what loses that bet on a slow enough runner. Substitute
    // `await Promise.resolve()` for the `settled(v)` below and it loses it every time:
    //
    //   $ node --test src/transcript/readLease.test.ts
    //   ✖ abandonReads() answers everyone at once, and starts nothing in their place (0.951417ms)
    //     TranscriptReadAbandoned: transcript read abandoned after 5000ms without answering; this
    //     caller stopped waiting
    //         at #attach (src/transcript/reconcile.ts)
    //         at TranscriptSessionView.snapshot (src/transcript/reconcile.ts)
    //         at TestContext.<anonymous> (src/transcript/readLease.test.ts)   <- the snapshot below
    //   ℹ pass 12
    //   ℹ fail 1
    //
    // Five runs of that, five identical failures, where the 25ms version passed 13/13 five times
    // over on the same machine. The `line:column` are dropped from those three frames because
    // `citations.test.ts` reads a `path:line` as a citation it must then pin, and a stack trace
    // is not a claim about the tree; the frames name the functions, which is the identifying
    // part. `ca7393d` carries the trace whole.
    //
    // The message is the tell, and the reason a longer sleep was never the answer: `after 5000ms`
    // is `PATIENT_MS`, this view's entire lease, reported by a caller that waited none of it. It
    // was refused on arrival by a `#stalled` flag not yet cleared -- the same refusal a caller
    // gets from a read that genuinely has not come back. No wait can tell those two apart. Only
    // asking the flag can, which is what `settled()` now does.
    wedge.release()
    await settled(v)
    const snap = await v.snapshot()
    assert.deepEqual(snap.turns.map((t) => t.prompt), ['one'], 'a real read of a real file')
    assert.equal(wedge.calls, before + 1, 'exactly one further read, and only after the first settled')
  } finally {
    wedge.release()
    wedge.restore()
  }
})

test('readsStalled says when there is no point waiting, and only then', async () => {
  // The view's answer to "is there any point asking". It is not a diagnostic: `cancel()` reads
  // it to stop polling for evidence that provably cannot arrive, so it has to be false in every
  // case where a read could still happen and true only while one is outstanding and given up on.
  //
  // The distinction it must not blur is between a read that is merely IN FLIGHT -- ordinary,
  // recoverable, and worth waiting for -- and one the view has stopped waiting for itself.
  const path = join(SCRATCH, 'stalled-getter.jsonl')
  writeFileSync(path, turn('one', 'first'))
  const v = view(path, PATIENT_MS)

  assert.equal(v.readsStalled, false, 'an idle view can read')
  await v.poll()
  assert.equal(v.readsStalled, false, 'and so can one that just did')

  const wedge = wedgeOneTailPoll()
  try {
    wedge.arm()
    const wedged = v.poll().then(
      () => 'resolved' as const,
      (e: unknown) => e,
    )
    while (!wedge.taken) await sleep(5)
    assert.equal(
      v.readsStalled,
      false,
      'a read in flight and inside its lease is not a stall: waiting for it is exactly right',
    )

    v.abandonReads()
    assert.equal(v.readsStalled, true, 'once the view has given up on it, waiting achieves nothing')
    assert.ok((await wedged) instanceof TranscriptReadAbandoned)

    wedge.release()
    await settled(v)
    assert.equal(v.readsStalled, false, 'and it clears when the operation returns, not before')
    assert.deepEqual(promptsOf(await v.poll()), [], 'the view reads again, and the file is unchanged')
  } finally {
    wedge.release()
    wedge.restore()
  }
})

test('an abandoned tail read commits nothing, so its replacement still sees every record', async () => {
  // The other half of the invariant, at the layer that owns it. Once the queue can advance past
  // a read, that read and its replacement are in flight together -- which is exactly the
  // interleaving the queue exists to prevent -- so the abandoned one is barred from having any
  // effect: no offset advance, no fresh digest, no records.
  //
  // The lease here answers `false` the first time it is asked and `true` afterwards, which puts
  // the abandonment at the checkpoint immediately before the commit rather than at the one
  // right after the `stat`. If the tail ever grows another checkpoint the flip lands earlier
  // instead, and the assertions below are unchanged -- what is asserted is that NO checkpoint
  // lets a commit through.
  const path = join(SCRATCH, 'tail-commit.jsonl')
  writeFileSync(path, turn('one', 'first') + turn('two', 'second'))

  const tail = new RewriteAwareTail(path, parseJsonLine)
  let asks = 0
  const flips: ReadLease = {
    get abandoned(): boolean {
      return asks++ >= 1
    },
  }

  const abandoned = await tail.poll(flips)
  assert.equal(abandoned.abandoned, true, 'the read says it produced no answer')
  assert.deepEqual(abandoned.appended, [], 'and hands back nothing')
  assert.equal(abandoned.rewritten, false)
  assert.equal(tail.consumedBytes, 0, 'the offset did not move, so the records are still unread')
  assert.ok(asks > 1, 'precondition: the lease was consulted more than once, so the flip meant something')

  // The replacement. Same tail, same offset, and it must see the whole file.
  const replacement = await tail.poll()
  assert.equal(replacement.abandoned, undefined)
  assert.equal(replacement.appended.length, 4, 'both turns, both records each, and nothing doubled')
  assert.deepEqual(
    replacement.appended.filter((r) => r['type'] === 'user').map((r) => r['message'].content),
    ['one', 'two'],
    'every record the abandoned read passed over is still there, exactly once and in order',
  )
  assert.ok(tail.consumedBytes > 0, 'and this read is the one that consumed them')
})

test('a lease that is already spent stops the read before it touches anything', async () => {
  const path = join(SCRATCH, 'spent-lease.jsonl')
  writeFileSync(path, turn('one', 'first'))
  const tail = new RewriteAwareTail(path, parseJsonLine)

  const spent: ReadLease = { get abandoned(): boolean { return true } }
  const res = await tail.poll(spent)
  assert.equal(res.abandoned, true)
  assert.equal(tail.consumedBytes, 0)

  // The control, and it is load-bearing: without it every assertion above passes for a tail
  // whose `poll` does nothing at all.
  const live = await tail.poll()
  assert.equal(live.appended.length, 2, 'the same tail reads the same file fine when nobody has given up')
})

// --- containment: what an ordinary consumer gets when the read is abandoned -------------------

/**
 * The lease keeps the VIEW alive; on its own it does not keep the RUN alive.
 *
 * Everything above is about the queue recovering. What the queue hands its caller when it does
 * is a rejection, and that rejection travels: the report, the seat record, the relay's
 * compaction checks and rotation's record-at-quiesce all call `snapshot()` with no bound and no
 * handler, so a wedged read stopped being a stuck view and became a failed rotation -- one that
 * threw past its own rollback and left the original session quiesced.
 *
 * `snapshotOrLastBuilt()` is the contained entry point those consumers use. It is not a weaker
 * `snapshot()`: the primitive still rejects, because the callers that pass a bound in need it to.
 */

test('snapshotOrLastBuilt() answers with the last projection built rather than rejecting', async () => {
  const path = join(SCRATCH, 'contained-fallback.jsonl')
  writeFileSync(path, turn('one', 'first'))
  const v = view(path)

  assert.deepEqual(promptsOf(await v.poll()), ['one'], 'precondition: one good read')
  const built = v.lastBuilt()
  assert.ok(built, 'a view that has read has something to fall back on')
  assert.deepEqual(built.turns.map((t) => t.prompt), ['one'])

  // On the file but not yet consumed, so a fallback that quietly re-read would show it and a
  // fabricated one could not. What comes back must be the state as of the last real read.
  appendFileSync(path, turn('two', 'second'))

  const wedge = wedgeOneTailPoll()
  try {
    wedge.arm()
    const before = v.abandonedReads
    const snap = await v.snapshotOrLastBuilt()

    assert.equal(v.abandonedReads, before + 1, 'the abandonment is recorded rather than hidden')
    assert.deepEqual(
      snap.turns.map((t) => t.prompt),
      ['one'],
      'the last authoritative projection, not a re-read and not an empty session',
    )
    assert.equal(
      snap.builtAt,
      built.builtAt,
      'and it is stamped when it was actually built, so a consumer can see how stale it is',
    )
  } finally {
    wedge.release()
    wedge.restore()
  }

  // Not a cache that has replaced the file: the next read that lands is authoritative again.
  await settled(v)
  assert.deepEqual(promptsOf(await v.poll()), ['two'], 'containment did not consume or lose the append')
  assert.deepEqual(
    (await v.snapshot()).turns.map((t) => t.prompt),
    ['one', 'two'],
  )
})

test('a fallback says so, and a snapshot that was actually read does not', async () => {
  /**
   * Staleness alone does not tell a consumer what it needs to know.
   *
   * `builtAt` says how old the answer is, which is the right question for "should I ask again"
   * and the wrong one for "is this number evidence". A session nobody has prompted for a minute
   * has an old `builtAt` from a read that succeeded; a wedged one has an old `builtAt` from a
   * read that was given up on. Same field, same shape, and rotation records the compaction
   * generation off the second as though it had observed it.
   *
   * So the fallback is marked at the point it is BUILT. What the flag protects is downstream:
   * `rotate()` writes `UNKNOWN_GENERATION` into the handoff rather than a generation whose
   * transcript nobody read.
   */
  const path = join(SCRATCH, 'contained-flagged.jsonl')
  writeFileSync(path, turn('one', 'first'))
  const v = view(path)

  const fresh = await v.snapshot()
  assert.equal(
    fresh.containedFallback,
    undefined,
    'a read that answered is not marked: absence is the ordinary case, and it has to stay cheap',
  )
  assert.deepEqual(fresh.turns.map((t) => t.prompt), ['one'])

  const built = v.lastBuilt()
  assert.ok(built)
  assert.equal(built.containedFallback, true, 'stamped on the projection, not on one way of asking for it')

  const wedge = wedgeOneTailPoll()
  try {
    wedge.arm()
    const snap = await v.snapshotOrLastBuilt()
    assert.equal(snap.containedFallback, true, 'and it survives the path an ordinary consumer takes')
    // The number is still in there, unchanged and still stale -- which is the whole reason the
    // flag has to be, rather than the field being blanked here. A consumer that only wants to
    // describe the session is entitled to it; one recording evidence checks the flag first.
    assert.equal(snap.compactionGeneration, fresh.compactionGeneration)
  } finally {
    wedge.release()
    wedge.restore()
  }

  // And the mark does not stick to the view: the next read that lands answers unflagged.
  await settled(v)
  assert.equal((await v.snapshot()).containedFallback, undefined, 'not latched -- a good read is a good read')
})

test('a FIRST snapshot whose waiter is detached is answered by the read it was waiting on', async () => {
  // The hole the fallback alone does not cover. Before a view has read anything there is
  // nothing to fall back on, and the abandonment was reaching the caller -- an ordinary
  // `snapshot()` on the session contract, on a path with no handler, throwing a lifecycle
  // exception about somebody's lease at a consumer that only asked what the session looks like.
  //
  // So it waits. The question this test exists to pin down is what it waits FOR. Not a clock, and
  // not a fresh read of its own: the read its caller gave up on is still running, still the only
  // one this view will have, and still going to commit when it lands. A re-read issued in the
  // meantime would be a second operation against a file the first one cannot get an answer out
  // of -- under a wedge that never lifts, one more per attempt forever -- and a re-read issued
  // AFTER it lands would be asking again for what has just been committed. So it holds on to the
  // operation, and builds its answer from what that operation committed. One call, start to end.
  const path = join(SCRATCH, 'contained-first-read.jsonl')
  writeFileSync(path, turn('one', 'first'))
  const v = view(path)

  assert.equal(v.lastBuilt(), undefined, 'precondition: nothing to fall back on, so only a re-read can save this')

  const wedge = wedgeOneTailPoll()
  try {
    wedge.arm()
    let resolved = false
    const asked = v.snapshotOrLastBuilt().then((snap) => {
      resolved = true
      return snap
    })
    // It has to be HOLDING the read before anything detaches it; detaching an empty queue
    // would prove nothing.
    while (!wedge.taken) await sleep(5)
    assert.equal(wedge.calls, 1, 'precondition: one read, and it is the one being held')

    v.abandonReads()

    // Several lease intervals of a caller that is contractually forbidden to give up, against a
    // read that is never coming back. This is the shape that used to spawn one operation per
    // interval, and the one the count below is the whole point of.
    await sleep(LEASE_MS * 4)
    assert.equal(wedge.calls, 1, `no second read while the first is unresolved: ${wedge.calls}`)
    assert.equal(resolved, false, 'and it has not invented an answer to fill the wait')
    assert.ok(v.abandonedReads >= 1, 'the attempts it did make are visible from outside')

    wedge.release()
    const snap = await asked
    assert.deepEqual(
      snap.turns.map((t) => t.prompt),
      ['one'],
      'the re-read is a real read of a real file, not an invented empty session',
    )
    assert.ok(snap.builtAt > 0, 'and it is stamped when it was built')
    assert.equal(snap.containedFallback, undefined, 'a read answered it, so it is not the last thing built')
    assert.equal(wedge.calls, 1, `answered by the sole operation, with no read of its own: ${wedge.calls}`)
  } finally {
    wedge.release()
    wedge.restore()
  }
})

test('repeated abandonment across many lease intervals still leaves exactly one operation', async () => {
  // One abandonment could be survived by a single retry, so one proves the wrong thing. What is
  // being pinned here is that the retrying does not accumulate: `snapshotOrLastBuilt()` never
  // gives up, callers keep arriving, `abandonReads()` is called over and over -- and every one
  // of them is answered out of what the view already knows, without a second file operation.
  //
  // Under the old queue each of these would have been let through to the filesystem in turn.
  const path = join(SCRATCH, 'contained-never-read.jsonl')
  writeFileSync(path, turn('one', 'first'))
  const v = view(path)

  assert.equal(v.lastBuilt(), undefined, 'precondition: nothing to fall back on, ever, on any attempt')

  const wedge = wedgeOneTailPoll()
  try {
    wedge.armAll()
    const asked = v.snapshotOrLastBuilt()
    while (!wedge.taken) await sleep(5)
    assert.equal(wedge.calls, 1, 'precondition: the first attempt is the one holding the file')

    for (let round = 1; round <= 4; round++) {
      v.abandonReads()
      await assert.rejects(() => v.poll(), TranscriptReadAbandoned, `round ${round}: a caller is answered`)
      await sleep(LEASE_MS)
      assert.equal(wedge.calls, 1, `round ${round}: still one operation, not ${wedge.calls}`)
    }

    wedge.release()
    const snap = await asked
    assert.equal(wedge.calls, 1, `and the wedge lifting buys no read at all: the one that landed answers: ${wedge.calls}`)
    assert.deepEqual(
      snap.turns.map((t) => t.prompt),
      ['one'],
      'what comes back is the transcript, read on the attempt that landed',
    )
    assert.ok(snap.builtAt > 0, 'built, not invented')
    assert.ok(v.abandonedReads >= 4, 'and every caller that was turned away is counted')
  } finally {
    wedge.release()
    wedge.restore()
  }
})

test('an empty transcript that was read IS a fallback; an unread one is not', async () => {
  // `#builtAt` only moves when records are applied, so a view over a transcript the child has
  // not written to yet reads successfully every time and never builds. That view is entitled to
  // say "no turns" -- it has looked -- and the fallback has to distinguish it from one that has
  // never looked at all, which is why the flag is the last successful READ and not the build.
  const path = join(SCRATCH, 'contained-empty.jsonl')
  writeFileSync(path, '')
  const v = view(path)

  assert.deepEqual(await v.poll(), [], 'precondition: a real read of an empty file')
  const built = v.lastBuilt()
  assert.ok(built, 'having read an empty file is a position to speak from')
  assert.deepEqual(built.turns, [])
  assert.ok(built.builtAt > 0, 'and it is stamped when the read happened, not left at zero')

  const wedge = wedgeOneTailPoll()
  try {
    wedge.arm()
    const snap = await v.snapshotOrLastBuilt()
    assert.deepEqual(snap.turns, [])
    assert.equal(snap.builtAt, built.builtAt)
  } finally {
    wedge.release()
    wedge.restore()
  }
})

test('the bounded primitives still reject, because their callers need them to', async () => {
  // The containment above must not have been bought by weakening `snapshot()`. `poll()` must
  // never report a non-answer as "nothing changed", and the deadline re-check passes its own
  // bound into `snapshot(until)` precisely so the rejection frees its single-flight slot for
  // the next attempt. A stale snapshot there would be read as fresh evidence about a turn that
  // is being judged right now.
  const path = join(SCRATCH, 'contained-primitive.jsonl')
  writeFileSync(path, turn('one', 'first'))
  const v = view(path)
  assert.deepEqual(promptsOf(await v.poll()), ['one'], 'precondition: there IS something to fall back on')
  assert.ok(v.lastBuilt(), 'so a weakened primitive would resolve here rather than reject')

  const wedge = wedgeOneTailPoll()
  try {
    wedge.arm()
    await assert.rejects(() => v.snapshot(), TranscriptReadAbandoned)
  } finally {
    wedge.release()
    wedge.restore()
  }

  // A view of its own, here and below. The queue no longer advances past a read that has been
  // given up on, so a second wedge on the SAME view would be queued behind the first one's
  // outstanding operation rather than meeting the filesystem -- and the test would be measuring
  // the previous case rather than this one.
  const w2 = view(path)
  const second = wedgeOneTailPoll()
  try {
    second.arm()
    await assert.rejects(() => w2.poll(), TranscriptReadAbandoned)
  } finally {
    second.release()
    second.restore()
  }

  // The one that actually carries a bound: `snapshot(until)`, as the adapters' deadline
  // re-check calls it through `BoundedSingleFlight`. Its rejection is not a failure to be
  // contained -- it is the signal that frees the single-flight slot so the NEXT deadline can
  // make an attempt of its own, and it must arrive when the CALLER's bound is spent rather
  // than when the view's much longer lease is.
  const w3 = view(path, PATIENT_MS)
  const third = wedgeOneTailPoll()
  try {
    third.arm()
    let announce!: () => void
    const whenAbandoned = new Promise<void>((r) => {
      announce = r
    })
    let spent = false
    const until = {
      get abandoned(): boolean {
        return spent
      },
      whenAbandoned,
    }
    const asked = w3.snapshot(until).then(
      () => 'resolved' as const,
      (e: unknown) => e,
    )
    while (!third.taken) await new Promise((r) => setTimeout(r, 5))

    const started = Date.now()
    spent = true
    announce()
    const outcome = await asked
    const waited = Date.now() - started

    assert.ok(outcome instanceof TranscriptReadAbandoned, 'a bounded caller is told it got no answer')
    assert.ok(waited < PATIENT_MS, `and told at its OWN bound, not the view's lease: ${waited}ms`)
    // What it is NOT given is a read. Its bound frees its own single-flight slot; it does not
    // buy it a place in front of a filesystem operation that is still outstanding, and it no
    // longer takes the head away from whoever was waiting on that operation legitimately.
    assert.equal(third.calls, 1, 'a spent bound answers its caller and authorises nothing')
  } finally {
    third.release()
    third.restore()
  }
})
