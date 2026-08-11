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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgentRegistry } from '../registry/registry.ts'
import type { CreateParticipantContext, ResolvedParticipant } from '../registry/types.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
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

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-seat-rot-'))
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

test('a per-seat policy for a seat that does not exist is refused at start', async () => {
  // Ignoring it would leave the seat it was meant for on the run default -- which is the
  // configuration the operator was overriding -- and nothing would say so.
  const repo = tempRepo()
  try {
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
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('rotating one seat replaces that seat’s session and verifies it in that seat’s worktree', async () => {
  const repo = tempRepo()
  const advisor = new FakeRotationSession('advisor', 'codex', [HANDOFF])
  const one = new FakeRotationSession('one', 'claude')
  const two = new FakeRotationSession('two', 'claude')
  const fresh = new FakeRotationSession('two-fresh', 'claude', [ACCEPTED])
  const creates: CreateRecord[] = []
  try {
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
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('rotateSeat refuses a seat this run does not have, and a seat whose policy disarms it', async () => {
  const repo = tempRepo()
  const advisor = new FakeRotationSession('advisor', 'codex', [HANDOFF])
  const one = new FakeRotationSession('one', 'claude')
  const two = new FakeRotationSession('two', 'claude')
  try {
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
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a seat set to act rotates on degradation while the run’s other seats only record candidates', async (t) => {
  // D7 as behaviour rather than as a resolved object: one policy, two seats, two different
  // responses to the same evidence. Both seats compact; only the one whose own policy says
  // `automatic` is replaced, and the other is recorded as a candidate and left alone.
  const repo = tempRepo()
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
  try {
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
        },
      },
    })
    t.after(() => relay.stop())

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
  } finally {
    rmSync(repo, { recursive: true, force: true })
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
  const repo = tempRepo()
  const advisor = new FakeRotationSession('advisor', 'codex', [
    '@seat implementer-2: Do the second thing.',
    'DONE',
    'DONE',
  ])
  const one = new FakeRotationSession('one', 'claude', ['ack', 'NONE', 'NONE'])
  const two = new FakeRotationSession('two', 'claude', ['ack', 'Did the second thing.', 'NONE'])
  const spare = new FakeRotationSession('two-fresh', 'claude', [ACCEPTED])
  const creates: CreateRecord[] = []
  try {
    const relay = await twoSeatRelay(
      repo,
      advisor,
      [one, two, spare],
      { checks: ['exit 0'], checkTimeoutMs: 30_000 },
      creates,
    )
    t.after(() => relay.stop())

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
    rmSync(repo, { recursive: true, force: true })
  }
})

test('rotate at a pause replaces the seat the pause is ABOUT, not "the implementer"', async (t) => {
  // The operator's half of #78, and the half a menu can get wrong invisibly. The pause option
  // used to be withheld at N>1 because rotation named no seat; now it is offered and it has to
  // act on the seat the operator is looking at. A `rotate` that quietly replaced the lead
  // instead would retire a healthy session and leave the degraded one in place -- and both
  // sessions are alive afterwards either way, so nothing but this assertion would notice.
  const repo = tempRepo()
  const advisor = new FakeRotationSession('advisor', 'codex', [
    '@seat implementer-2: Do the second thing.',
    HANDOFF,
    'DONE',
    'DONE',
  ])
  const one = new FakeRotationSession('one', 'claude', ['ack', 'NONE', 'NONE'])
  const two = new FakeRotationSession('two', 'claude', ['ack', 'Did the second thing.', 'NONE'])
  const fresh = new FakeRotationSession('two-fresh', 'claude', [ACCEPTED, 'NONE'])
  try {
    // The run default, which is what makes this a pause rather than an automatic rotation: the
    // policy to act unattended is not earned, so degradation raises a candidate and asks.
    const relay = await twoSeatRelay(repo, advisor, [one, two, fresh], {
      checks: ['exit 0'],
      checkTimeoutMs: 30_000,
    })
    t.after(() => relay.stop())

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
    rmSync(repo, { recursive: true, force: true })
  }
})

test('acceptance with no observable output is reported as unobservable, not as a bad replacement (#76)', async (t) => {
  // The distinction the issue is about. Both cases roll back and the rollback is right in both;
  // what was missing is that the operator could not tell "this replacement did not meet the bar"
  // from "nothing can meet it while this holds", and the first invites a retry that the second
  // turns into a loop.
  const repo = tempRepo()
  const advisor = new FakeRotationSession('advisor', 'codex', [HANDOFF, HANDOFF])
  const impl = new FakeRotationSession('impl', 'claude')
  // A replacement that starts, takes the send, ends its turn -- and produces no prose at all,
  // which is what a wedged transport looks like from here.
  const silent = new FakeRotationSession('silent', 'claude', [])
  const spare = new FakeRotationSession('spare', 'claude', [ACCEPTED])
  try {
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
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
