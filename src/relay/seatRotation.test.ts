/**
 * Rotation that names a seat, and the policy that seat is under (#78, #76).
 *
 * `rotation/rotate.test.ts` proves the transaction and `relay/rotation.test.ts` proves the seam
 * it is stitched into. What neither can show is what this issue is actually about:
 *
 *   scoped     a rotation reads, verifies and replaces ONE seat -- its session, its worktree,
 *              its record -- and the seats beside it are untouched. That is asserted against a
 *              real two-seat run with real worktrees, because the failure mode is a transfer
 *              measured in the wrong directory and every in-memory double would pass either way.
 *   policy     the run's `RotationConfig` is a DEFAULT, and a seat may amend it (D7). A seat can
 *              be set to act while the run records candidates, and a seat can be disarmed while
 *              the run stays armed.
 *   stopped    acceptance that produces nothing observable is not "this replacement failed" but
 *              "no replacement can pass" (#76). The run says so, in those terms, and stops
 *              trying -- which is the half a rollback alone never carried.
 *
 *   node --test src/relay/seatRotation.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { AgentRegistry } from '../registry/registry.ts'
import type { CreateParticipantContext, ResolvedParticipant } from '../registry/types.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { tempDir } from '../testkit/tempDir.ts'
import { Relay, rotationFor, type RelayOptions } from './relay.ts'

const HANDOFF = `## BRIEF
Keep the work moving.

## STATE
Half done.

## DECISIONS
- none

## EVIDENCE
The implementer says the check passes.

## FILES
- work.ts

## DISAGREEMENT
- none

## NEXT
Carry on.`

/** A replacement that ran the check and reports the exit code the arbiter will observe. */
const ACCEPTED = 'CHECK 1: exit 0\n\nRead work.ts and ran the check. It matches.'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function tempRepo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-seat-rot')
  git(dir, 'init', '--quiet')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'work.ts'), 'export const answer = 42\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'init', '--quiet')
  return dir
}

interface CreateRecord {
  id: string
  cwd: string
}

/** One queue of sessions per agent, and where each was created. See `implementerSeats.test.ts`. */
function registryOf(
  queues: Record<string, FakeRotationSession[]>,
  records: CreateRecord[] = [],
): AgentRegistry {
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
      async create(resolved: ResolvedParticipant, ctx: CreateParticipantContext) {
        const next = remaining.shift()
        if (!next) throw new Error(`no session left for ${agent}`)
        records.push({ id: resolved.spec.id, cwd: ctx.cwd })
        return next
      },
    })
  }
  return r
}

const SEATS = [
  { id: 'implementer', agent: 'claude', role: 'implementer' as const },
  { id: 'implementer-2', agent: 'claude', role: 'implementer' as const },
]

async function twoSeatRelay(
  repo: string,
  advisor: FakeRotationSession,
  implementers: FakeRotationSession[],
  rotation: RelayOptions['rotation'],
  records: CreateRecord[] = [],
): Promise<Relay> {
  return Relay.start({
    registry: registryOf({ codex: [advisor], claude: implementers }, records),
    cwd: repo,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: SEATS[0]!,
    implementers: SEATS,
    maxAdvisorTurns: 2,
    ...(rotation === undefined ? {} : { rotation }),
  })
}

test('rotationFor: the run policy is the default, and a seat amends it field by field', () => {
  // Pure, so it is asserted directly rather than inferred from a run. The rule it encodes is
  // the whole of the compatibility promise between one global policy and several seats, and a
  // rule that is only observable through a two-seat run is a rule nobody can check.
  const cfg = {
    checks: ['npm test'],
    onDegradation: 'candidate' as const,
    files: ['a.ts'],
    checkTimeoutMs: 1000,
    seats: {
      'implementer-2': { checks: ['make check'], onDegradation: 'automatic' as const },
    },
  }

  const lead = rotationFor(cfg, 'implementer')
  assert.deepEqual(lead?.checks, ['npm test'], 'a seat that names nothing is under the run policy')
  assert.equal(lead?.onDegradation, 'candidate')
  assert.deepEqual(lead?.files, ['a.ts'])
  assert.equal(lead?.checkTimeoutMs, 1000)

  const second = rotationFor(cfg, 'implementer-2')
  assert.deepEqual(
    second?.checks,
    ['make check'],
    'an overriding seat REPLACES the commands rather than adding to them: concatenating would ' +
      'silently reimpose the checks the operator just overrode',
  )
  assert.equal(second?.onDegradation, 'automatic')
  // Fields it did not mention still come from the run. An override is an amendment, not a
  // replacement of the whole policy -- a seat naming its own checks must not silently lose the
  // run's timeout and files.
  assert.deepEqual(second?.files, ['a.ts'])
  assert.equal(second?.checkTimeoutMs, 1000)

  // The default lives in exactly one place, and this is it.
  assert.equal(rotationFor({ checks: ['x'] }, 'implementer')?.onDegradation, 'candidate')
  // Two distinct facts that both refuse to rotate: no policy at all, and a policy that says
  // this seat is not rotatable.
  assert.equal(rotationFor(undefined, 'implementer'), undefined)
  assert.deepEqual(rotationFor({ checks: ['x'], seats: { implementer: { checks: [] } } }, 'implementer')?.checks, [])
})

test('a per-seat policy for a seat that does not exist is refused at start', async (t) => {
  // Ignoring it would leave the seat it was meant for on the run default -- which is the
  // configuration the operator was overriding -- and nothing would say so.
  const repo = tempRepo(t)
  {
    await assert.rejects(
      () =>
        twoSeatRelay(
          repo,
          new FakeRotationSession('advisor', 'codex'),
          [new FakeRotationSession('one', 'claude'), new FakeRotationSession('two', 'claude')],
          { checks: ['exit 0'], seats: { 'implementer-3': { checks: ['exit 1'] } } },
        ),
      /rotation\.seats names 'implementer-3'.*implementer, implementer-2/s,
    )
  }
})

test('rotating one seat replaces that seat’s session and verifies it in that seat’s worktree', async (t) => {
  const repo = tempRepo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', [HANDOFF])
  const one = new FakeRotationSession('one', 'claude')
  const two = new FakeRotationSession('two', 'claude')
  const fresh = new FakeRotationSession('two-fresh', 'claude', [ACCEPTED])
  const creates: CreateRecord[] = []
  {
    const relay = await twoSeatRelay(
      repo,
      advisor,
      [one, two, fresh],
      // The check is the load-bearing part of this test. `seat-only.txt` exists ONLY in
      // implementer-2's worktree, so this command exits 0 there and non-zero anywhere else.
      // The replacement claims `exit 0`; the arbiter runs the command itself and compares. If
      // the transaction were reading the integration checkout, the arbiter would observe 1
      // against a claimed 0 and roll the rotation back -- so `rotated` IS the assertion that
      // the whole transfer was measured in the seat's own tree.
      { checks: ['test -f seat-only.txt'], checkTimeoutMs: 30_000 },
      creates,
    )
    try {
      const tree = relay.worktrees!.seats.find((s) => s.seatId === 'implementer-2')!.worktreePath
      writeFileSync(join(tree, 'seat-only.txt'), 'only in this seat\n')

      const r = await relay.rotateSeat('implementer-2', 'the second seat went stale')

      assert.equal(r.status, 'rotated', 'the transfer must be accepted, in the seat’s own tree')
      if (r.status !== 'rotated') return
      assert.equal(r.handoff.record.root, tree, 'the record is the seat’s tree, not the run’s')
      // Two sessions created for this seat -- the original and the replacement -- and both in
      // the seat's own tree. Keyed on the SPEC's id, which is what the registry sees: the
      // audition wears `implementer-2~replacement` inside the relay, and the replacement is
      // composed from the same spec precisely so it cannot be launched as something else.
      const forSeat = creates.filter((c) => c.id === 'implementer-2')
      assert.equal(forSeat.length, 2, 'the seat’s original and its replacement')
      assert.deepEqual(
        forSeat.map((c) => c.cwd),
        [tree, tree],
        'and the replacement was started in the same tree as the session it replaces',
      )

      // The seat, replaced in place: same id, new session.
      const seat = relay.participants.find((p) => p.id === 'implementer-2')!
      assert.equal(seat.session, fresh)
      assert.equal(two.state, 'terminated')
      assert.equal(fresh.state, 'running')

      // The sibling: not quiesced, not spoken to, not counted. This is the whole difference
      // between a seat-local rotation and a run-wide one.
      assert.equal(relay.participants.find((p) => p.id === 'implementer')!.session, one)
      assert.equal(one.state, 'running')
      assert.deepEqual(one.transitions, [])
      assert.equal(one.received.filter((m) => m.includes('CHECK 1')).length, 0)

      // The lane was taken once, by the seat that rotated, and named as the rotation station.
      assert.deepEqual(
        relay.checkLane.history().map((h) => [h.seat, h.station]),
        [['implementer-2', 'rotation']],
      )
      assert.equal(relay.checkLane.held(), undefined, 'and released')
    } finally {
      await relay.stop()
    }
  }
})

test('rotateSeat refuses a seat this run does not have, and a seat whose policy disarms it', async (t) => {
  const repo = tempRepo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', [HANDOFF])
  const one = new FakeRotationSession('one', 'claude')
  const two = new FakeRotationSession('two', 'claude')
  {
    const relay = await twoSeatRelay(repo, advisor, [one, two], {
      checks: ['exit 0'],
      checkTimeoutMs: 30_000,
      // Disarmed by its own policy: the run says what "working" means and this seat says that
      // nothing here can demonstrate it.
      seats: { 'implementer-2': { checks: [] } },
    })
    try {
      await assert.rejects(() => relay.rotateSeat('advisor', 'wrong rank'), /not an implementer seat/)
      await assert.rejects(() => relay.rotateSeat('implementer-9', 'no such seat'), /not an implementer seat/)
      await assert.rejects(
        () => relay.rotateSeat('implementer-2', 'disarmed by its own policy'),
        /own policy configures none/,
      )
      // Refused with nothing spent: no session quiesced, none started, none retired.
      assert.equal(two.state, 'running')
      assert.deepEqual(two.transitions, [])
      assert.equal(relay.rotationWatch.rotations, 0)

      // And the unnamed form still refuses to guess at N>1 -- it now says where to go instead.
      await assert.rejects(() => relay.rotateImplementer('which seat?'), /call rotateSeat\(seatId, reason\)/)
    } finally {
      await relay.stop()
    }
  }
})

test('a seat set to act rotates on degradation while the run’s other seats only record candidates', async (t) => {
  // D7 as behaviour rather than as a resolved object: one policy, two seats, two different
  // responses to the same evidence. Both seats compact; only the one whose own policy says
  // `automatic` is replaced, and the other is recorded as a candidate and left alone.
  const repo = tempRepo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', [
    '@seat implementer-2: Do the second thing.',
    HANDOFF,
    'DONE',
    'DONE',
  ])
  const one = new FakeRotationSession('one', 'claude', ['ack', 'Did it.', 'NONE', 'NONE'])
  const two = new FakeRotationSession('two', 'claude', ['ack', 'Did the second thing.', 'NONE'])
  const fresh = new FakeRotationSession('two-fresh', 'claude', [ACCEPTED, 'NONE', 'NONE'])
  /** The seat table as it stood INSIDE the transaction, which is the only place it can be read. */
  let during: { state: string; graded: boolean } | undefined
  /** A same-seat rotation attempted from outside while the LOOP's own one is in progress. */
  let concurrent: Promise<unknown> | undefined
  {
    const relay = await twoSeatRelay(repo, advisor, [one, two, fresh], {
      checks: ['exit 0'],
      checkTimeoutMs: 30_000,
      // The RUN records candidates, which is the project default and the unearned-policy
      // position. One seat opts into being acted on.
      onDegradation: 'candidate',
      seats: { 'implementer-2': { onDegradation: 'automatic' } },
      // The transaction's own test barrier, used here to read the dispatcher rather than to
      // inject a divergence. It is the only vantage point from which "what state was the seat in
      // while it was being replaced" is observable at all -- afterwards the boundary has
      // released the seat and the answer is gone.
      hooks: {
        afterCapture: async () => {
          const seat = relay.seats().find((s) => s.seat === 'implementer-2')!
          const task = relay.tasks().find(({ task: q }) => q.id === seat.current)
          during = { state: seat.state, graded: task?.runtime.grade !== undefined }
          // The same-seat guard against a SCHEDULED seat: this one has a seat-table entry, a
          // task and a graded verdict, and the rotation in progress is the loop's own. An
          // operator reaching in here is the reachable version of the collision.
          concurrent ??= relay.rotateSeat('implementer-2', 'an operator reaching in mid-rotation').then(
            (r) => r.status,
            (e: Error) => e,
          )
          await new Promise((r) => setImmediate(r))
        },
      },
    })
    try {
      two.compactOnTurn = 1
      const outcome = await relay.run('Keep the work moving.')

      assert.notEqual(outcome.reason, 'transport_failed')
      assert.equal(relay.rotationWatch.rotations, 1, 'the seat that opted in was replaced')
      assert.equal(two.state, 'terminated')
      assert.equal(relay.participants.find((p) => p.id === 'implementer-2')!.session, fresh)
      // The run's own default is untouched by the override: the other seat is still under
      // `candidate`, so nothing is spent on it.
      assert.equal(one.state, 'running')
      assert.ok(
        relay.log.some((m) => /^rotating implementer-2/.test(m.text)),
        'and the log names the seat that rotated, not "the implementer"',
      )

      // The loop's rotation point, measured from inside the transaction. Both halves matter and
      // both are claims a later reordering could falsify silently:
      //
      //   graded    the turn was observed and its verdict resolved BEFORE the session was
      //             quiesced. This is what makes the loop's own rotation legal under the
      //             mid-turn refusal in `rotateSeat` -- if this stopped holding, the loop would
      //             start throwing at itself rather than rotating.
      //   state     the seat is out of `running` before this and reports `rotation_pending`
      //             while it happens, so nothing dispatches to a seat whose session is being
      //             replaced and an operator polling the status is not told it is `integrating`
      //             for the length of two agent turns.
      assert.deepEqual(during, { state: 'rotation_pending', graded: true })

      // And the same-seat guard holds for a scheduled seat, against the loop's own transaction:
      // refused outright, so the loop's rotation is the one that completed and the operator's
      // second request left no trace in the record.
      const refusal = await concurrent
      assert.ok(refusal instanceof Error, 'a second rotation of a seat already rotating must be refused')
      assert.match(refusal.message, /implementer-2 is already being rotated/)
      assert.equal(
        relay.log.filter((m) => /^rotating implementer-2:/.test(m.text)).length,
        1,
        'one transaction announced, because one transaction happened',
      )
      assert.ok(!relay.log.some((m) => m.text.includes('reaching in mid-rotation')))
    } finally {
      // Awaited HERE rather than from `t.after`, and that is not a style choice. `stop()`
      // rewrites the worktree manifest, `repo(t)` registered the scratch directory's cleanup
      // before this test ran, and node:test runs `after` hooks in registration order -- so a
      // `t.after` stop would fire after the directory was deleted and write it back into
      // existence. A `finally` in the body finishes before any hook starts.
      await relay.stop()
    }
  }
})

test('a seat with a turn in flight is refused, and the run it was working on is undisturbed', async (t) => {
  // The race, driven through the production path rather than by poking the seat table: the
  // rotation is requested from OUTSIDE the loop, while the seat is genuinely mid-turn, which is
  // reachable because `rotateSeat` is public and does not require a paused run.
  //
  // Left unrefused this is not a scheduling nicety. `rotate()` quiesces the outgoing session and
  // then terminates it, and `quiesce()` drains input without waiting for the turn already
  // running -- so the seat's work would be in flight while its session was retired: no verdict,
  // no report, and a handoff record captured from a tree that turn was still writing to.
  const repo = tempRepo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', [
    '@seat implementer-2: Do the second thing.',
    'DONE',
    'DONE',
  ])
  const one = new FakeRotationSession('one', 'claude', ['ack', 'NONE', 'NONE'])
  const two = new FakeRotationSession('two', 'claude', ['ack', 'Did the second thing.', 'NONE'])
  const spare = new FakeRotationSession('two-fresh', 'claude', [ACCEPTED])
  const creates: CreateRecord[] = []
  {
    const relay = await twoSeatRelay(
      repo,
      advisor,
      [one, two, spare],
      { checks: ['exit 0'], checkTimeoutMs: 30_000 },
      creates,
    )
    try {
      // A turn that actually spans time, so the attempt lands in the middle of one rather than in
      // a gap between two. The request is made from the seat's own send, which is the instant the
      // dispatcher has marked it `running` with an ungraded task.
      two.delayMs = 80
      let attempt: Promise<unknown> | undefined
      two.onSend = (message: string) => {
        if (!message.includes('Do the second thing')) return
        // Settled to a value rather than left rejecting: an unhandled rejection would take the
        // process down before the assertion below could read it.
        attempt ??= relay.rotateSeat('implementer-2', 'an operator got impatient').then(
          () => 'rotated',
          (e: Error) => e,
        )
      }

      const outcome = await relay.run('Keep the work moving.')

      const refusal = await attempt
      assert.ok(refusal instanceof Error, 'a rotation over a live turn must be refused, not performed')
      assert.match(refusal.message, /still working on/)
      assert.match(refusal.message, /has not been observed and graded/)
      // The refusal names what a caller has to do differently, not just that it said no.
      assert.match(refusal.message, /does not wait for the turn already running/)

      // Nothing was touched: the session was never quiesced, never retired, and no replacement was
      // started for it.
      assert.deepEqual(two.transitions, [], 'the live session must not have been put through a single transition')
      assert.equal(relay.participants.find((p) => p.id === 'implementer-2')!.session, two)
      assert.equal(relay.rotationWatch.rotations, 0)
      assert.equal(creates.filter((c) => c.id === 'implementer-2').length, 1, 'no replacement was created')
      assert.equal(spare.state, 'running')
      assert.deepEqual(spare.received, [])

      // And the run carried on through it. A refusal from an out-of-band caller is that caller's
      // problem: the turn finished, was graded, and its report reached the advisor.
      assert.equal(outcome.reason, 'done')
      assert.ok(
        advisor.received.some((m) => m.includes('Did the second thing')),
        'the turn the rotation would have destroyed completed and was routed',
      )
    } finally {
      // Awaited HERE rather than from `t.after`, and that is not a style choice. `stop()`
      // rewrites the worktree manifest, `repo(t)` registered the scratch directory's cleanup
      // before this test ran, and node:test runs `after` hooks in registration order -- so a
      // `t.after` stop would fire after the directory was deleted and write it back into
      // existence. A `finally` in the body finishes before any hook starts.
      await relay.stop()
    }
  }
})

test('a rotation requested while the ADVISOR is mid-turn is refused, and touches neither session', async (t) => {
  // The other half of the same race, and the one no seat-shaped guard can see. Rotation's second
  // step asks the advisor to write the handoff -- on the advisor's own session. Issued while the
  // relay is already mid-exchange with it, that is a second concurrent send: two prompts
  // interleave on one transcript, `#exchange` slices events from a mark the other reader has
  // passed, and the handoff the replacement is measured against would be assembled from an
  // advisor turn answering a different question.
  //
  // The target seat here is IDLE and its own guards would all pass -- which is the point of
  // driving it this way. Only the advisor's state makes this unsafe.
  const repo = tempRepo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', ['@seat implementer: Do the thing.', 'DONE', 'DONE'])
  const one = new FakeRotationSession('one', 'claude', ['ack', 'Did it.', 'NONE'])
  const two = new FakeRotationSession('two', 'claude', ['ack', 'NONE', 'NONE'])
  const spare = new FakeRotationSession('spare', 'claude', [ACCEPTED])
  const creates: CreateRecord[] = []
  {
    const relay = await twoSeatRelay(
      repo,
      advisor,
      [one, two, spare],
      { checks: ['exit 0'], checkTimeoutMs: 30_000 },
      creates,
    )
    try {
      // An advisor turn that spans time, so the request lands inside one rather than between two.
      advisor.delayMs = 80
      let attempt: Promise<unknown> | undefined
      advisor.onSend = (message: string) => {
        // The first advisor turn is its briefing; this fires on the turn that routes the seat's
        // report, which is an ordinary mid-run advisor exchange.
        if (!message.includes('Did it.')) return
        attempt ??= relay.rotateSeat('implementer-2', 'an operator got impatient').then(
          () => 'rotated',
          (e: Error) => e,
        )
      }

      const outcome = await relay.run('Keep the work moving.')

      const refusal = await attempt
      assert.ok(refusal instanceof Error, 'a rotation over a live advisor turn must be refused')
      assert.match(refusal.message, /the advisor \(advisor\) has a turn in flight/)
      assert.match(refusal.message, /second concurrent send/)
      // Named the seat it declined to rotate, so the caller is not left guessing which request
      // this answers when several are in flight.
      assert.match(refusal.message, /rotating implementer-2/)

      // NEITHER session was touched. The advisor's turn is the one that would have been corrupted,
      // and the seat's is the one that would have been retired for it.
      assert.deepEqual(two.transitions, [], 'the target seat was never quiesced')
      assert.equal(relay.participants.find((p) => p.id === 'implementer-2')!.session, two)
      assert.equal(relay.participants.find((p) => p.rank === 'advisor')!.session, advisor)
      assert.equal(advisor.state, 'running')
      assert.equal(relay.rotationWatch.rotations, 0)
      assert.equal(creates.filter((c) => c.id === 'implementer-2').length, 1, 'no replacement was created')
      assert.deepEqual(spare.received, [], 'and none was spoken to')
      // The advisor was never asked for a handoff, which is the send that would have collided.
      assert.ok(!advisor.received.some((m) => /## BRIEF|handoff/i.test(m)))

      // And the run finished normally: the refusal belongs to the caller that made it, not to the
      // run it was made against.
      assert.equal(outcome.reason, 'done')
      assert.ok(advisor.received.some((m) => m.includes('Did it.')), 'the advisor turn completed and was read')
    } finally {
      // Awaited HERE rather than from `t.after`, and that is not a style choice. `stop()`
      // rewrites the worktree manifest, `repo(t)` registered the scratch directory's cleanup
      // before this test ran, and node:test runs `after` hooks in registration order -- so a
      // `t.after` stop would fire after the directory was deleted and write it back into
      // existence. A `finally` in the body finishes before any hook starts.
      await relay.stop()
    }
  }
})

test('a second rotation of the SAME seat is refused before anything happens, and the first completes', async (t) => {
  // N=1, outside any run: no seat table, no task, no dispatcher — which is the configuration the
  // guard has to hold in, because it is where an operator rotates by hand and where every
  // dispatcher-shaped check has nothing to read.
  //
  // The check lane does eventually refuse this pair, and that is not sufficient. By the time the
  // lane is reached the second transaction has written its `rotating` note, quiesced a session
  // the first is already replacing, and asked the advisor for a second handoff describing a state
  // that is being handed over as it reads it. What the lane then says — "its rotation section
  // would wait for itself" — describes a mutex to an operator who asked to replace a seat twice.
  const repo = tempRepo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', [HANDOFF, HANDOFF])
  const impl = new FakeRotationSession('impl', 'claude')
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED])
  const spare = new FakeRotationSession('spare', 'claude', [ACCEPTED])
  const creates: CreateRecord[] = []
  let second: Promise<unknown> | undefined
  {
    const relay = await Relay.start({
      registry: registryOf({ codex: [advisor], claude: [impl, fresh, spare] }, creates),
      cwd: repo,
      lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
      implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
      maxAdvisorTurns: 2,
      rotation: {
        checks: ['exit 0'],
        checkTimeoutMs: 30_000,
        // Fired from inside the first transaction: the lane is held, the note is written, the
        // handoff has been taken and the record captured. Anything the second call touched would
        // be touching a transfer already in progress.
        hooks: {
          afterCapture: async () => {
            second ??= relay.rotateSeat('implementer', 'a second operator, or the same one twice').then(
              (r) => r.status,
              (e: Error) => e,
            )
            await new Promise((r) => setImmediate(r))
          },
        },
      },
    })
    t.after(() => relay.stop())

    const first = await relay.rotateSeat('implementer', 'the first transaction')
    const refusal = await second

    assert.ok(refusal instanceof Error, 'the second call must be refused, not queued behind the first')
    assert.match(refusal.message, /implementer is already being rotated \(the first transaction\)/)
    // It names what the caller should do about it, and carries the first caller's reason so a
    // second operator can see what they are waiting for rather than only that they may not go.
    assert.match(refusal.message, /Wait for the rotation in progress/)
    // NOT the lane's re-entrancy error, which is the mechanism talking rather than the request
    // being answered.
    assert.doesNotMatch(refusal.message, /wait for itself|check lane/)

    // The first transaction completed, undisturbed.
    assert.equal(first.status, 'rotated')
    assert.equal(relay.participants.find((p) => p.rank === 'implementer')!.session, fresh)
    assert.equal(impl.state, 'terminated')

    // And the second had NO effects: nothing was recorded for it, no session was created or
    // spoken to for it, and it never reached the lane.
    assert.equal(
      relay.log.filter((m) => /^rotating implementer:/.test(m.text)).length,
      1,
      'a refused rotation must not announce itself',
    )
    assert.ok(
      !relay.log.some((m) => m.text.includes('a second operator')),
      'and its reason must appear nowhere in the record',
    )
    assert.equal(creates.filter((c) => c.id === 'implementer').length, 2, 'the seat and ONE replacement')
    assert.equal(spare.state, 'running')
    assert.deepEqual(spare.received, [])
    assert.equal(advisor.received.filter((m) => m.includes('HANDOFF')).length, 0)
    assert.deepEqual(
      relay.checkLane.history().map((h) => `${h.seat}/${h.station}`),
      ['implementer/rotation'],
      'one section, so the second never acquired the lane at all',
    )
    assert.equal(relay.rotationWatch.rotations, 1)
  }
})

test('a rotation that fails releases the seat, so the next one is not refused by a stale claim', async (t) => {
  // The other half of the same-seat guard, and the half that fails SILENTLY if it is wrong: a
  // claim that outlived its transaction would make the seat permanently unrotatable, and the
  // refusal would go on describing a rotation that ended long ago. That is worse than the race
  // the guard prevents, because the race needs two callers and this needs only one unlucky one.
  //
  // Both ways out of the transaction are exercised, because they leave by different doors: a
  // throw from `rotate()` before anything is negotiated, and an ordinary rolled-back result.
  // Each step passing IS the assertion that the step before it released the seat.
  const repo = tempRepo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', ['this is not a handoff', HANDOFF])
  const impl = new FakeRotationSession('impl', 'claude')
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED])
  {
    const relay = await Relay.start({
      registry: registryOf({ codex: [advisor], claude: [impl, fresh] }),
      cwd: repo,
      lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
      implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
      maxAdvisorTurns: 2,
      rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000 },
    })
    t.after(() => relay.stop())

    // 1. A THROW out of the transaction. Rotation refuses a session that is not running, which
    //    happens after the seat has been claimed and inside the lane.
    await impl.quiesce()
    await assert.rejects(
      () => relay.rotateSeat('implementer', 'while quiesced'),
      /cannot rotate a session in state 'quiesced'/,
      'the throw must be the transaction’s own, not a stale claim from an earlier call',
    )
    await impl.unquiesce()

    // 2. A ROLLBACK. The advisor cannot produce a handoff, so nothing is started and the
    //    original is restored — the ordinary failure, and the seat must survive it rotatable.
    const rolled = await relay.rotateSeat('implementer', 'with an unusable handoff')
    assert.equal(rolled.status, 'rolled_back')
    if (rolled.status !== 'rolled_back') return
    assert.equal(rolled.reason, 'handoff_incomplete')
    assert.equal(impl.state, 'running', 'restored')

    // 3. And the seat is still rotatable, which is only true if both failures released it. A
    //    stale claim would refuse this with `is already being rotated` naming a reason from a
    //    transaction that ended two steps ago.
    const rotated = await relay.rotateSeat('implementer', 'and now for the real one')
    assert.equal(rotated.status, 'rotated', 'a failed rotation must not strand the seat')
    assert.equal(relay.participants.find((p) => p.rank === 'implementer')!.session, fresh)
    assert.equal(relay.rotationWatch.rotations, 1)
    // The lane is likewise clear: every section released, including the one that threw.
    assert.equal(relay.checkLane.held(), undefined)
    assert.deepEqual(
      relay.checkLane.history().map((h) => `${h.seat}/${h.station}`),
      ['implementer/rotation', 'implementer/rotation', 'implementer/rotation'],
      'three sections reached the lane and three released it',
    )
  }
})

test('a rotation that only CONTENDS for the check lane still runs — it queues, it is not refused', async (t) => {
  // The line the two refusals must not cross. They are about live turns; the check lane is about
  // a verification window, and a section waiting for it is queued rather than unsafe. A guard
  // that refused on contention would take away the one case the lane was kept for.
  //
  // Constructed through the transaction's own barrier: inside `implementer`'s rotation, with the
  // lane held and the advisor idle (its handoff turn is already done), a second rotation is
  // started for the other seat. It must be admitted, wait, and then complete.
  const repo = tempRepo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', [HANDOFF, HANDOFF])
  const one = new FakeRotationSession('one', 'claude')
  const two = new FakeRotationSession('two', 'claude')
  const oneFresh = new FakeRotationSession('one-fresh', 'claude', [ACCEPTED])
  const twoFresh = new FakeRotationSession('two-fresh', 'claude', [ACCEPTED])
  let second: Promise<unknown> | undefined
  let heldDuring: string | undefined
  {
    const relay = await twoSeatRelay(repo, advisor, [one, two, oneFresh, twoFresh], {
      checks: ['exit 0'],
      checkTimeoutMs: 30_000,
      // Only the first seat gets the barrier, so the second rotation does not re-enter it. That
      // this is expressible at all is the per-seat policy doing its job.
      seats: {
        implementer: {
          hooks: {
            afterCapture: async () => {
              heldDuring = `${relay.checkLane.held()?.seat}/${relay.checkLane.held()?.station}`
              second ??= relay.rotateSeat('implementer-2', 'the second seat too').then(
                (r) => r.status,
                (e: Error) => e,
              )
              // Let the second call reach the lane and queue before this section continues, so
              // the wait is a real one rather than an ordering this test asserted into being.
              await new Promise((r) => setImmediate(r))
            },
          },
        },
      },
    })
    try {
      const first = await relay.rotateSeat('implementer', 'the first seat')
      const secondResult = await second

      assert.equal(heldDuring, 'implementer/rotation', 'the barrier really did run with the lane held')
      assert.equal(first.status, 'rotated')
      assert.equal(
        secondResult,
        'rotated',
        'a rotation that merely contends for the lane must be admitted and queued, never refused',
      )
      // Serialised, and in the order they asked. Overlapping them is what would let a merge move
      // the tree between a rotation's two captures.
      assert.deepEqual(
        relay.checkLane.history().map((h) => `${h.seat}/${h.station}`),
        ['implementer/rotation', 'implementer-2/rotation'],
      )
      // The wait was narrated where an operator would otherwise see an unexplained gap.
      assert.ok(
        relay.log.some((m) => /implementer-2's rotation section is waiting for the check lane/.test(m.text)),
        'a wait of this length that says nothing is the silence the note exists to fill',
      )
      assert.ok(relay.log.some((m) => /queued, not blocked/.test(m.text)))
      // Both seats really were replaced, in their own trees.
      assert.equal(relay.participants.find((p) => p.id === 'implementer')!.session, oneFresh)
      assert.equal(relay.participants.find((p) => p.id === 'implementer-2')!.session, twoFresh)
      assert.equal(relay.rotationWatch.rotations, 2)
    } finally {
      // Awaited HERE rather than from `t.after`, and that is not a style choice. `stop()`
      // rewrites the worktree manifest, `repo(t)` registered the scratch directory's cleanup
      // before this test ran, and node:test runs `after` hooks in registration order -- so a
      // `t.after` stop would fire after the directory was deleted and write it back into
      // existence. A `finally` in the body finishes before any hook starts.
      await relay.stop()
    }
  }
})

test('rotate at a pause replaces the seat the pause is ABOUT, not "the implementer"', async (t) => {
  // The operator's half of #78, and the half a menu can get wrong invisibly. The pause option
  // used to be withheld at N>1 because rotation named no seat; now it is offered and it has to
  // act on the seat the operator is looking at. A `rotate` that quietly replaced the lead
  // instead would retire a healthy session and leave the degraded one in place -- and both
  // sessions are alive afterwards either way, so nothing but this assertion would notice.
  const repo = tempRepo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', [
    '@seat implementer-2: Do the second thing.',
    HANDOFF,
    'DONE',
    'DONE',
  ])
  const one = new FakeRotationSession('one', 'claude', ['ack', 'NONE', 'NONE'])
  const two = new FakeRotationSession('two', 'claude', ['ack', 'Did the second thing.', 'NONE'])
  const fresh = new FakeRotationSession('two-fresh', 'claude', [ACCEPTED, 'NONE'])
  {
    // The run default, which is what makes this a pause rather than an automatic rotation: the
    // policy to act unattended is not earned, so degradation raises a candidate and asks.
    const relay = await twoSeatRelay(repo, advisor, [one, two, fresh], {
      checks: ['exit 0'],
      checkTimeoutMs: 30_000,
    })
    try {
      two.compactOnTurn = 1
      const run = relay.start('Keep the work moving.')
      const pause = await run.untilPause()

      assert.ok(pause, 'a rotation candidate must reach the operator')
      assert.equal(pause.reason, 'rotation_candidate')
      assert.deepEqual(pause.resolution.scope, { kind: 'participant', participantId: 'implementer-2' })
      assert.ok(
        pause.options.includes('rotate'),
        'the option must be offered at N>1 now that rotation can name the seat this pause is about',
      )

      const result = await run.rotateImplementer('the operator chose to replace it')
      assert.equal(result.status, 'rotated')
      assert.equal(relay.participants.find((p) => p.id === 'implementer-2')!.session, fresh)
      assert.equal(two.state, 'terminated')
      // The seat nobody asked about.
      assert.equal(relay.participants.find((p) => p.id === 'implementer')!.session, one)
      assert.equal(one.state, 'running')

      await run.abort()
    } finally {
      // Awaited HERE rather than from `t.after`, and that is not a style choice. `stop()`
      // rewrites the worktree manifest, `repo(t)` registered the scratch directory's cleanup
      // before this test ran, and node:test runs `after` hooks in registration order -- so a
      // `t.after` stop would fire after the directory was deleted and write it back into
      // existence. A `finally` in the body finishes before any hook starts.
      await relay.stop()
    }
  }
})

test('acceptance with no observable output is reported as unobservable, not as a bad replacement (#76)', async (t) => {
  // The distinction the issue is about. Both cases roll back and the rollback is right in both;
  // what was missing is that the operator could not tell "this replacement did not meet the bar"
  // from "nothing can meet it while this holds", and the first invites a retry that the second
  // turns into a loop.
  const repo = tempRepo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', [HANDOFF, HANDOFF])
  const impl = new FakeRotationSession('impl', 'claude')
  // A replacement that starts, takes the send, ends its turn -- and produces no prose at all,
  // which is what a wedged transport looks like from here.
  const silent = new FakeRotationSession('silent', 'claude', [])
  const spare = new FakeRotationSession('spare', 'claude', [ACCEPTED])
  {
    const relay = await Relay.start({
      registry: registryOf({ codex: [advisor], claude: [impl, silent, spare] }),
      cwd: repo,
      lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
      implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
      maxAdvisorTurns: 3,
      rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000, onDegradation: 'automatic' },
    })
    t.after(() => relay.stop())

    const r = await relay.rotateImplementer('the session is wedged')

    assert.equal(r.status, 'rolled_back')
    if (r.status !== 'rolled_back') return
    assert.equal(
      r.reason,
      'acceptance_unobservable',
      'reporting this as `replacement_could_not_reproduce` is the coupling #76 is about',
    )
    assert.match(r.detail, /no observable output/)
    assert.match(r.detail, /NO replacement can pass/)
    assert.match(r.detail, /upstream of rotation/)
    // The evidence it DOES have, so the claim is inspectable after the session is gone.
    assert.ok(r.evidence?.some((e) => /emitted \d+ event/.test(e)), 'the transport evidence must travel with it')

    // The gate itself is untouched: the original is back in service and nothing was swapped.
    assert.equal(impl.state, 'running')
    assert.equal(relay.participants.find((p) => p.rank === 'implementer')!.session, impl)
    assert.equal(relay.rotationWatch.rotations, 0)
    assert.ok(relay.log.some((m) => /rotation rolled back \(acceptance_unobservable\)/.test(m.text)))
    assert.ok(relay.log.some((m) => /rotation transport evidence:/.test(m.text)))

    // And the run says so where an operator reads it, rather than only in the middle of the log.
    assert.match(relay.rotationSummary(), /rotation STOPPED after implementer/)

    // The stop. A second degradation does NOT spend another transaction: the spare replacement
    // is never created, never spoken to, and the log says the attempt was declined and why.
    impl.compact()
    await relay.run('Keep the work moving.')

    assert.equal(spare.state, 'running', 'no second replacement may be started')
    assert.deepEqual(spare.received, [], 'nor spoken to')
    assert.ok(
      relay.log.some((m) => /Rotation was NOT attempted/.test(m.text)),
      'and the operator is told that the decline was a decision, with the reason that decided it',
    )
    assert.ok(relay.log.some((m) => /no replacement can pass while that holds/.test(m.text)))
    assert.equal(relay.rotationWatch.rotations, 0)
  }
})
