/**
 * The session record: what an operator outside the process can learn about a run.
 *
 *   node --test src/workspace/sessionRecord.test.ts
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Confidence, Provenance } from '../contract/outcome.ts'
import type { RunCeilings } from '../relay/guardrails.ts'
import { RelayEventStream } from '../relay/observe.ts'
import { rotationFor, type RotationConfig } from '../relay/relay.ts'
import { resolutionFor } from '../relay/resolution.ts'
import {
  listSessions,
  newSessionId,
  prunableSessions,
  pruneSessions,
  readSession,
  recordSession,
  resolveSession,
  SESSION_HEARTBEAT_MS,
  SESSION_STALE_AFTER_MS,
  SessionRecorder,
  sessionDir,
  sessionStaleness,
  STATUS_WARN_EVERY_MS,
  type RecordableRelay,
  type SessionRunState,
  type SessionStatus,
} from './sessionRecord.ts'
import { formatSession, formatSessionJson } from './sessionView.ts'

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'conclave-record-'))
}

/** A turn as a scripted snapshot reports it. Graded, because the record's whole claim is. */
type FakeTurn = {
  key: string
  state: string
  confidence?: Confidence | undefined
  provenance?: Provenance[] | undefined
}

function graded(key: string): FakeTurn {
  return {
    key,
    state: 'completed',
    confidence: 'proven',
    provenance: [{ source: 'hook', detail: 'Stop' }],
  }
}

/**
 * A seat whose snapshot is scripted, including how LONG it takes to answer.
 *
 * The delay is not decoration: a snapshot is a read of a file still being written, and the
 * defect it exists to reproduce is a slow read of an early transcript landing after a fast
 * read of a later one.
 */
function fakeSeat(id: string, rank: string, agent: string, role: string = rank) {
  const state = {
    turns: [] as FakeTurn[],
    fail: false,
    snapshots: 0,
    /**
     * Per-CALL scripting: entry N answers the Nth snapshot, then it falls back to `turns`.
     *
     * Scripted by call rather than by mutating `turns` between refreshes, because a refresh
     * begins on a later microtask than the statement that asked for it — so a test that set
     * a delay and then cleared it would have cleared it before any snapshot started, and
     * would pass against an implementation with no ordering guard at all. It did.
     */
    script: [] as { turns: FakeTurn[]; delayMs?: number }[],
  }
  return {
    state,
    seat: {
      id,
      rank,
      role,
      // What the relay composes at join. A stand-in for a seat launched with no arguments,
      // which is what every seat in this file is: the recorder copies this through and does
      // not compose it, so the interesting cases live where the composing happens.
      launch: { args: [] as string[], model: null },
      session: {
        agent,
        async snapshot() {
          state.snapshots += 1
          const step = state.script.shift()
          // Captured before the wait: a slow read answers with the state it began from,
          // which is the whole shape of the defect.
          const taken = step ? [...step.turns] : [...state.turns]
          const wait = step?.delayMs ?? 0
          if (wait > 0) await new Promise((r) => setTimeout(r, wait))
          if (state.fail) throw new Error('transcript is gone')
          return { turns: taken }
        },
      },
    },
  }
}

/**
 * A relay-shaped stand-in. Structural typing is the point: no Relay is constructed.
 *
 * `opts.rotation` is resolved through the PRODUCTION `rotationFor`, not a hand-written answer.
 * The claim the rotation block makes is that what an observer reads is what the relay enforces,
 * and a stand-in that resolved the policy its own way would prove the opposite of that.
 * `opts.seats` names extra implementer ids, because a per-seat override needs a second seat to
 * be about.
 */
function fakeRelay(opts?: {
  /** A session that outlives its first run, as a console does. See `stopped` below (#189). */
  multiRun?: boolean
  rotation?: RotationConfig | undefined
  seats?: string[]
  /** A reviewer seat: rank `implementer`, role `reviewer` (D5, #72). */
  reviewer?: boolean
  /**
   * What bounds the run, as a real relay would resolve it. Absent by DEFAULT and left absent
   * on every existing case here, which is the half of the contract worth exercising: a
   * stand-in written before #119 must still satisfy `RecordableRelay` and still get the
   * document it got before.
   */
  ceilings?: RunCeilings
}): RecordableRelay & {
  /** Ends the SESSION, as distinct from a run within it ending (#189). */
  endSession: () => void
  stream: RelayEventStream
  pending: { id: string; tool: string }[]
  messages: unknown[]
  transcripts: Record<string, ReturnType<typeof fakeSeat>['state']>
} {
  const stream = new RelayEventStream()
  let sessionOver = false
  const pending: { id: string; tool: string }[] = []
  const messages: unknown[] = []
  const advisor = fakeSeat('advisor', 'advisor', 'codex')
  const implementer = fakeSeat('implementer', 'implementer', 'claude')
  const extra = (opts?.seats ?? []).map((id) => fakeSeat(id, 'implementer', 'claude'))
  // Rank `implementer`, role `reviewer`, exactly as `Relay` joins one: the rank/role split is
  // the whole reason this seat is worth constructing here.
  if (opts?.reviewer) extra.push(fakeSeat('reviewer', 'implementer', 'codex', 'reviewer'))
  return {
    stream,
    pending,
    messages,
    // The session/run split the record now depends on (#189).
    //
    // Most doubles here are ONE session with ONE run, so their session ends exactly when their
    // stream does and this reports it -- otherwise the follow loop parks waiting for a run
    // that is never going to start, and every test pays the two-second detach race.
    //
    // `multiRun` is for the cases that model what a console actually does: close a run, keep
    // the session, start another. There the two are not the same event, and saying so is the
    // whole point of the fix.
    get stopped() {
      return opts?.multiRun ? sessionOver : stream.closed
    },
    endSession() {
      sessionOver = true
      stream.close()
    },
    whenObservable: () => stream.whenReopened(),
    // Named `transcripts` rather than `seats`: `RecordableRelay.seats()` is the dispatcher's
    // per-seat state, and a stand-in whose `seats` was a map of scripted transcripts would
    // satisfy the structural type by accident and mean something else entirely.
    transcripts: {
      advisor: advisor.state,
      implementer: implementer.state,
      ...Object.fromEntries(extra.map((s) => [s.seat.id, s.state])),
    },
    cwd: '/tmp/project',
    operator: 'human',
    participants: [advisor.seat, implementer.seat, ...extra.map((s) => s.seat)],
    get log() {
      return messages
    },
    permissionsPending: () => pending,
    rotationOf: (seatId) => rotationFor(opts?.rotation, seatId),
    ...(opts?.ceilings ? { ceilings: opts.ceilings } : {}),
    observe: (o) => stream.observe(o),
  }
}

/** Let the detached follow loop run. It is deliberately not on the caller's critical path. */
const settle = () => new Promise((r) => setTimeout(r, 30))

/**
 * Wait for a fact rather than for a duration.
 *
 * A fixed sleep long enough to contain a beat on an idle machine is not long enough on a loaded
 * one, and lengthening it to be safe makes every green run pay for the worst case. Polling asks
 * the question the assertion is about, returns the moment it is true, and fails with the name of
 * what never happened rather than with whatever the assertion downstream would have said.
 */
async function until<T>(what: string, read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const seen = read()
    if (seen !== undefined) return seen
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/**
 * Divert stderr into an array until `restore` is called.
 *
 * Two callers with two reasons. The warning tests capture in order to ASSERT what the recorder
 * said; the failed-write test captures so the suite does not print a simulated production
 * failure, which would teach a reader to scroll past the real one.
 */
function captureStderr(): { said: string[]; restore: () => void } {
  const said: string[] = []
  const real = console.error
  console.error = (...args: unknown[]) => void said.push(args.map(String).join(' '))
  return {
    said,
    restore: () => {
      console.error = real
    },
  }
}

/** Run `fn` with stderr captured, and hand back every line the recorder wrote. */
async function whileWatchingStderr(fn: () => void | Promise<void>): Promise<string[]> {
  const held = captureStderr()
  try {
    await fn()
  } finally {
    held.restore()
  }
  return held.said
}

test('a status is written at construction, before anything has happened', () => {
  const root = dir()
  const rec = new SessionRecorder(root, {
    id: 'x',
    pid: process.pid,
    cwd: root,
    goal: 'g',
    front: 'relay',
    operator: 'human',
    state: 'starting',
    startedAt: 1,
    messages: 0,
    participants: [],
    build: 'test-build',
  })
  assert.ok(existsSync(rec.statusPath))
  // The window this closes is real: launching two CLIs takes seconds, and an operator
  // holding an id that resolves to nothing during it cannot tell a slow start from a
  // failed one.
  const read = readSession(root, 'x')
  assert.equal(read?.status.state, 'starting')
  assert.equal(read?.status.schema, 1)
})

test('liveness is reconciled against the pid, never read from the file', () => {
  const root = dir()
  new SessionRecorder(root, {
    id: 'mine',
    pid: process.pid,
    cwd: root,
    goal: 'g',
    front: 'relay',
    operator: 'human',
    state: 'running',
    startedAt: 1,
    messages: 0,
    participants: [],
    build: 'test-build',
  })
  const mine = readSession(root, 'mine')
  assert.equal(mine?.alive, true)
  assert.equal(mine?.abandoned, false)

  // A pid that cannot exist. The file still says `running`, and that claim is preserved
  // rather than rewritten -- `state` is what the session said, `alive` is what is true.
  const p = join(sessionDir(root, 'mine'), 'status.json')
  const status = JSON.parse(readFileSync(p, 'utf8'))
  writeFileSync(p, JSON.stringify({ ...status, id: 'dead', pid: 2 ** 30 }))
  const dead = readSession(root, 'mine')
  assert.equal(dead?.status.state, 'running', 'the claim is not rewritten')
  assert.equal(dead?.alive, false)
  assert.equal(dead?.abandoned, true, 'claimed to be going, nobody home')
})

test('a session is resolved by prefix, and an ambiguous one is refused', () => {
  const root = dir()
  const mk = (id: string, startedAt: number) =>
    new SessionRecorder(root, {
      id,
      pid: process.pid,
      cwd: root,
      goal: id,
      front: 'relay',
      operator: 'human',
      state: 'ended',
      startedAt,
      messages: 0,
      participants: [],
      build: 'test-build',
    })
  mk('20260101-000000-1', 1)
  mk('20260101-000000-2', 2)
  mk('20260202-000000-9', 3)

  assert.equal(listSessions(root).length, 3)
  // Newest first, so "no id" means the one the operator is almost certainly asking about.
  const latest = resolveSession(root)
  assert.ok('session' in latest && latest.session.status.id === '20260202-000000-9')

  const byPrefix = resolveSession(root, '20260202')
  assert.ok('session' in byPrefix, 'a unique prefix resolves')

  // Refused rather than resolved to the newest match: silently picking one is how a status
  // command ends up describing the wrong run.
  const ambiguous = resolveSession(root, '20260101')
  assert.ok('error' in ambiguous && /matches 2 sessions/.test(ambiguous.error))

  const missing = resolveSession(root, 'nope')
  assert.ok('error' in missing && /no session "nope"/.test(missing.error))
})

test('the event stream is written to disk, terminal event included', async () => {
  const root = dir()
  const relay = fakeRelay()
  const recording = recordSession(relay, {
    repoRoot: root,
    id: 'evt',
    goal: 'g',
    front: 'relay',
    startedAt: Date.now(),
    build: 'test-build',
  })
  relay.stream.emit({ type: 'activity', participant: 'implementer', rank: 'implementer', event: { type: 'turn_start', seq: 1, at: 1, prompt: 'do it' } as never })
  relay.stream.emit({ type: 'run_end', reason: 'done' })
  relay.stream.close()
  await recording.close()

  const lines = readFileSync(recording.recorder.eventsPath, 'utf8').trim().split('\n')
  const types = lines.map((l) => JSON.parse(l).type)
  // Both event kinds reach the file, terminal one included. This says nothing about WHEN
  // the front-end closes the recorder relative to stopping the relay -- that ordering is
  // what actually broke, and it is asserted where it lives, in `session.test.ts`.
  assert.deepEqual(types, ['activity', 'run_end'])
})

test('an outcome survives a later state change; a pause does not', async () => {
  const root = dir()
  const relay = fakeRelay()
  const recording = recordSession(relay, {
    repoRoot: root,
    id: 'out',
    goal: 'g',
    front: 'session',
    startedAt: Date.now(),
    build: 'test-build',
  })
  const pause = {
    reason: 'operator_requested' as const,
    resolution: resolutionFor({ reason: 'operator_requested' }, { rotationArmed: false }),
    detail: 'asked to stop',
    evidence: ['the operator typed /pause'],
    options: ['continue' as const],
    atSeq: 3,
    at: Date.now(),
  }
  recording.set('paused', { pause })
  assert.equal(readSession(root, 'out')?.status.pause?.reason, 'operator_requested')

  // A pause is a state the run is IN, so resuming must clear it: a status still carrying a
  // pause would tell a poller to intervene in a decision already made.
  recording.set('running')
  assert.equal(readSession(root, 'out')?.status.pause, undefined)

  recording.set('starting', { outcome: { reason: 'done', detail: 'DONE' } })
  // ...and an outcome is something that HAPPENED. The console reports `ended` on teardown,
  // which erased the very outcome the run had just produced -- caught in a live run.
  recording.set('ended')
  const final = readSession(root, 'out')
  assert.equal(final?.status.state, 'ended')
  assert.equal(final?.status.outcome?.reason, 'done', 'the outcome must survive teardown')

  relay.stream.close()
  await recording.close()
})

test('a seat stopped at a permission prompt says so in the status file', async () => {
  const root = dir()
  const relay = fakeRelay()
  const recording = recordSession(relay, {
    repoRoot: root,
    id: 'perm',
    goal: 'g',
    front: 'relay',
    startedAt: Date.now(),
    build: 'test-build',
  })
  relay.pending.push({ id: 'implementer', tool: 'Bash' })
  // Driven by an EVENT rather than by a lifecycle change, which is the whole point: a seat
  // stopped at a prompt produces no state transition, so a status refreshed only on those
  // would never mention it -- for exactly as long as the operator was needed.
  relay.stream.emit({ type: 'activity', participant: 'implementer', rank: 'implementer', event: { type: 'permission_requested', seq: 1, at: 1, tool: 'Bash', input: {} } as never })
  await settle()

  const seat = readSession(root, 'perm')?.status.participants.find((p) => p.id === 'implementer')
  assert.equal(seat?.awaitingPermission?.tool, 'Bash')
  assert.equal(seat?.activity?.kind, 'permission_requested')

  relay.stream.close()
  await recording.close()
})

/**
 * Whether rotation is armed, per seat, in the file and in the prose (#103).
 *
 * The reporter of #103 launched with `--checks`, could not confirm it from `status --json`, and
 * told their own operator rotation was off. It was on; the console said so and the structured
 * interface had no key to say it with. So the assertion here is not "a key exists" but that the
 * THREE states a seat can be in are told apart by a reader who never sees the console:
 *
 *   armed        the run's checks apply to this seat, and `rotate` is on its pauses
 *   unarmed      the run configured no rotation at all -- what a plain `conclave session` is
 *   not this one  a policy exists and names this seat with `checks: []`, which is a decision
 *                that this seat cannot be rotated, not an absent configuration
 *
 * Resolved through the production `rotationFor`, so the block reports the same policy the relay
 * enforces. Two seats are checked for ABSENCE, and the second is the interesting one: the
 * advisor, which holds no seat, and the REVIEWER, whose rank is `implementer` and whose role is
 * not (D5, #72). Rotation eligibility is the role -- `#implementers()` filters on it and the
 * pause gate offers `rotate` only for seats in that set -- so a rank-based projection would
 * report this seat as armed under a policy that can never be applied to it.
 */
test('each implementer seat reports whether rotation is armed, and tells an unarmed run from an unrotatable seat', async () => {
  const root = dir()
  // One run carries two of the three states, which is the point of resolving per seat: the run
  // is armed and one seat of it is not, and no run-wide answer is true of both.
  const armedRun = fakeRelay({
    seats: ['implementer-2'],
    reviewer: true,
    rotation: {
      checks: ['npm test', { command: 'npm run lint', relevance: 'informational' }],
      seats: { 'implementer-2': { checks: [] } },
    },
  })
  const armedRec = recordSession(armedRun, {
    repoRoot: root,
    id: 'rot-armed',
    goal: 'g',
    front: 'session',
    startedAt: Date.now(),
    build: 'test-build',
  })
  await armedRec.refresh()

  const armedSession = readSession(root, 'rot-armed')
  assert.ok(armedSession)
  const byId = (s: typeof armedSession, id: string) => s?.status.participants.find((p) => p.id === id)

  const lead = byId(armedSession, 'implementer')
  assert.deepEqual(
    lead?.rotation,
    {
      configured: true,
      armed: true,
      // Normalized: the bare string is `required`, which is what it has always meant. A
      // consumer must not have to re-implement that fork to read this field.
      checks: [
        { command: 'npm test', relevance: 'required' },
        { command: 'npm run lint', relevance: 'informational' },
      ],
      onDegradation: 'candidate',
    },
    'the lead seat is under the run policy, and says so with the commands themselves',
  )

  const second = byId(armedSession, 'implementer-2')
  assert.deepEqual(
    second?.rotation,
    { configured: true, armed: false, checks: [], onDegradation: 'candidate' },
    'a seat whose policy sets no checks is CONFIGURED and not armed -- the state a run-wide flag cannot express',
  )

  assert.equal(byId(armedSession, 'advisor')?.rotation, undefined, 'the advisor holds no seat to rotate')

  // The seat a RANK test would have got wrong. A reviewer's rank IS `implementer` (D5, #72),
  // and under an armed run policy a rank-based projection reports it as armed -- a policy that
  // cannot apply to it, because `rotate` is offered only for seats in `#implementers()`, which
  // filters on role, and no pause names the reviewer as its subject: `review_blocked` names
  // the seat whose work was rejected.
  const reviewer = byId(armedSession, 'reviewer')
  assert.equal(reviewer?.rank, 'implementer', 'the premise: a reviewer shares the implementer rank')
  assert.equal(reviewer?.role, 'reviewer')
  assert.equal(reviewer?.rotation, undefined, 'a reviewer is not a rotation subject and reports no policy')

  armedRun.stream.close()
  await armedRec.close()

  // The third state, and the one the reporter's probe could not tell from the second: a run
  // that never configured rotation at all.
  const plainRun = fakeRelay()
  const plainRec = recordSession(plainRun, {
    repoRoot: root,
    id: 'rot-plain',
    goal: 'g',
    front: 'session',
    startedAt: Date.now(),
    build: 'test-build',
  })
  await plainRec.refresh()
  const plainSession = readSession(root, 'rot-plain')
  assert.ok(plainSession)
  assert.deepEqual(
    byId(plainSession, 'implementer')?.rotation,
    { configured: false, armed: false, checks: [], onDegradation: null },
    'an unconfigured run reports the block anyway -- a missing key is what #103 read as false',
  )

  // Present rather than absent is the whole fix, said as its own assertion: the probe in #103
  // read a key that did not exist and could not tell that from a false one.
  assert.ok(
    JSON.parse(formatSessionJson(plainSession!)).participants.some(
      (p: { rotation?: unknown }) => p.rotation !== undefined,
    ),
    'status --json carries the rotation block on a default unarmed run',
  )

  // ...and the prose says the same three things, because an operator answering a pause at a
  // console is making the same decision as the poller.
  const armedProse = formatSession(armedSession!, Date.now())
  assert.match(armedProse, /rotation:\s+ARMED, on degradation: candidate — npm test, npm run lint \[informational\]/)
  assert.match(armedProse, /rotation:\s+not armed for this seat — its policy sets no checks/)
  assert.match(formatSession(plainSession!, Date.now()), /rotation:\s+not armed — no checks configured for this run/)

  plainRun.stream.close()
  await plainRec.close()
})

/**
 * The graded turns, in the file, for a reader who is not in the process.
 *
 * `activity` answers "what is it doing" and is explicitly provisional — the last adapter
 * event, revisable. It cannot answer "did the turn actually complete, and how do we know",
 * which is the question an operator confirming a run is asking. That answer only exists in
 * `snapshot()`, and until now it left the process only in the run report — which the console
 * front-end never writes.
 */
test('a turn reaches the status file with its grade, not just its state', async () => {
  const root = dir()
  const relay = fakeRelay()
  const recording = recordSession(relay, {
    repoRoot: root,
    id: 'turns',
    goal: 'g',
    front: 'session',
    startedAt: Date.now(),
    build: 'test-build',
  })
  // Empty rather than absent before anything has run: a reader must be able to tell "no
  // turns yet" from "this build does not report turns".
  const before = readSession(root, 'turns')?.status.participants ?? []
  assert.deepEqual(before.map((p) => p.turns), [[], []])

  relay.transcripts.implementer!.turns = [graded('impl-turn-0')]
  await recording.refresh()

  const seat = readSession(root, 'turns')?.status.participants.find((p) => p.id === 'implementer')
  assert.equal(seat?.turns.length, 1)
  assert.equal(seat?.turns[0]?.key, 'impl-turn-0')
  assert.equal(seat?.turns[0]?.state, 'completed')
  // The grade and its evidence, which is the entire difference between this record and the
  // prose summary it replaces. `completed/proven` and `completed/assumed` are not the same
  // claim, and a consumer that cannot tell them apart will report the weaker one as fact.
  assert.equal(seat?.turns[0]?.confidence, 'proven')
  assert.deepEqual(seat?.turns[0]?.provenance, [{ source: 'hook', detail: 'Stop' }])

  relay.stream.close()
  await recording.close()
})

test('a turn ending refreshes the record without waiting for a lifecycle change', async () => {
  const root = dir()
  const relay = fakeRelay()
  const recording = recordSession(relay, {
    repoRoot: root,
    id: 'live',
    goal: 'g',
    front: 'relay',
    startedAt: Date.now(),
    build: 'test-build',
  })
  relay.transcripts.implementer!.turns = [graded('impl-turn-0')]
  // A long run reports `running` once and then nothing until it is over. If turns were only
  // read at the end, the record would be empty for exactly as long as anyone wanted it.
  relay.stream.emit({
    type: 'activity',
    participant: 'implementer',
    rank: 'implementer',
    event: { type: 'turn_end', seq: 2, at: 2 } as never,
  })
  await settle()

  const seat = readSession(root, 'live')?.status.participants.find((p) => p.id === 'implementer')
  assert.equal(seat?.turns.length, 1, 'a turn_end must be enough to refresh the snapshot')
  assert.equal(seat?.turns[0]?.confidence, 'proven')

  relay.stream.close()
  await recording.close()
})

/**
 * The case that makes a polled file trustworthy: it must never move backwards.
 *
 * A snapshot is a read of a transcript still being written, so two of them can come back out
 * of order. A slow read of an EARLIER state returning after a fast read of a later one would
 * overwrite newer turns with older ones — and a reader polling the file would watch a run
 * lose a turn it had already reported.
 */
test('a slow snapshot cannot overwrite the turns a newer one already wrote', async () => {
  const root = dir()
  const relay = fakeRelay()
  const recording = recordSession(relay, {
    repoRoot: root,
    id: 'stale',
    goal: 'g',
    front: 'relay',
    startedAt: Date.now(),
    build: 'test-build',
  })
  // The first read sees one turn and takes 120ms to say so; the second sees two and is
  // instant. Run concurrently and unordered, the first would land last and the record would
  // lose a turn it had already reported.
  relay.transcripts.implementer!.script = [
    { turns: [graded('impl-turn-0')], delayMs: 120 },
    { turns: [graded('impl-turn-0'), graded('impl-turn-1')] },
  ]
  const slow = recording.refresh()
  const quick = recording.refresh()
  await Promise.all([slow, quick])
  assert.ok(relay.transcripts.implementer!.snapshots >= 2, 'both refreshes must actually have read')

  const seat = readSession(root, 'stale')?.status.participants.find((p) => p.id === 'implementer')
  assert.equal(seat?.turns.length, 2, 'the newer snapshot must win regardless of which returned first')
  assert.deepEqual(seat?.turns.map((t) => t.key), ['impl-turn-0', 'impl-turn-1'])

  relay.stream.close()
  await recording.close()
})

/**
 * The last turn of a run is graded at the very end, and both front-ends report `ended`
 * before they close the recorder. A recorder that detached without re-reading would leave
 * the final verdicts out of the only file that outlives the process.
 */
test('close() takes a last snapshot, so graded turns survive the ended state', async () => {
  const root = dir()
  const relay = fakeRelay()
  const recording = recordSession(relay, {
    repoRoot: root,
    id: 'final',
    goal: 'g',
    front: 'session',
    startedAt: Date.now(),
    build: 'test-build',
  })
  recording.set('ended', { outcome: { reason: 'done', detail: 'DONE' } })
  // Graded only after the front-end has already said `ended` — which is the real order:
  // the console reports the state on teardown and the verdict is in the transcript by then.
  relay.transcripts.advisor!.turns = [graded('advisor-turn-0')]
  relay.transcripts.implementer!.turns = [graded('impl-turn-0'), graded('impl-turn-1')]
  relay.stream.close()
  await recording.close()

  const status = readSession(root, 'final')?.status
  assert.equal(status?.state, 'ended', 'the state the front-end reported is not disturbed')
  assert.equal(status?.outcome?.reason, 'done')
  assert.deepEqual(
    status?.participants.map((p) => p.turns.length),
    [1, 2],
    'every seat must carry its turns after the record is closed',
  )
  assert.equal(status?.participants[1]?.turns[1]?.confidence, 'proven')
})

test('a snapshot that fails keeps the turns already recorded, rather than blanking them', async () => {
  const root = dir()
  const relay = fakeRelay()
  const recording = recordSession(relay, {
    repoRoot: root,
    id: 'gone',
    goal: 'g',
    front: 'relay',
    startedAt: Date.now(),
    build: 'test-build',
  })
  relay.transcripts.implementer!.turns = [graded('impl-turn-0')]
  await recording.refresh()
  // The final refresh runs after `relay.stop()`, when a session may already be terminated
  // and its transcript unreadable. Losing the turns there loses them when they matter most.
  relay.transcripts.implementer!.fail = true
  relay.stream.close()
  await recording.close()

  const seat = readSession(root, 'gone')?.status.participants.find((p) => p.id === 'implementer')
  assert.equal(seat?.turns.length, 1, 'the last snapshot that could be read is kept')
})

/**
 * A record written by hand, so a test can say what `updatedAt` and the pid are.
 *
 * `SessionRecorder` stamps `updatedAt` from the clock, which is exactly the field pruning
 * decides on -- a test that could only write "now" could not distinguish old from recent
 * without sleeping. The pid is the other half: `alive` is reconciled against it on every
 * read, so a dead session is one whose pid cannot exist.
 */
const DEAD_PID = 2 ** 30

function stale(
  root: string,
  id: string,
  s: { state: SessionRunState; pid: number; updatedAt: number },
): string {
  const dir = sessionDir(root, id)
  mkdirSync(dir, { recursive: true })
  const status: SessionStatus = {
    schema: 1,
    id,
    pid: s.pid,
    cwd: root,
    goal: id,
    front: 'relay',
    operator: 'human',
    state: s.state,
    startedAt: s.updatedAt,
    updatedAt: s.updatedAt,
    messages: 0,
    participants: [],
    eventsPath: join(dir, 'events.ndjson'),
    build: 'test-build',
  }
  writeFileSync(join(dir, 'status.json'), `${JSON.stringify(status, null, 2)}\n`)
  writeFileSync(status.eventsPath, '{"type":"run_end","reason":"done"}\n')
  return dir
}

/**
 * The three conditions are a conjunction, and each one is load-bearing on its own.
 *
 * `ended` alone would delete a finished run whose process is still exiting; `!alive` alone
 * would delete the abandoned run that #26 is about, which is the record an operator comes
 * looking for precisely because nobody was home; age alone would delete a session that is
 * running right now and has simply not changed state in a while.
 */
test('pruning removes only records that ended, died, and are past the cutoff', () => {
  const root = dir()
  const cutoff = 1_000_000
  const old = stale(root, 'ended-old', { state: 'ended', pid: DEAD_PID, updatedAt: cutoff - 1 })
  const recent = stale(root, 'ended-recent', { state: 'ended', pid: DEAD_PID, updatedAt: cutoff })
  const live = stale(root, 'ended-live', { state: 'ended', pid: process.pid, updatedAt: 1 })
  const gone = stale(root, 'abandoned', { state: 'running', pid: DEAD_PID, updatedAt: 1 })
  const busy = stale(root, 'running', { state: 'running', pid: process.pid, updatedAt: 1 })

  const result = pruneSessions(root, cutoff)
  assert.deepEqual(result.candidates, ['ended-old'])
  assert.deepEqual(result.removed, ['ended-old'])
  assert.deepEqual(result.skipped, [])
  assert.deepEqual(result.failed, [])

  // The whole directory, events stream included -- a status file removed on its own would
  // leave a record `listSessions` cannot see and an operator cannot delete.
  assert.equal(existsSync(old), false)
  assert.equal(existsSync(join(old, 'events.ndjson')), false)

  // At the cutoff, not past it. An operator who says "older than an hour" means it.
  assert.equal(existsSync(recent), true, 'a record exactly at the cutoff is inside it')
  assert.equal(existsSync(live), true, 'a pid that still answers means the run has not gone')
  assert.equal(existsSync(gone), true, 'an abandoned run is the evidence, not the litter')
  assert.equal(existsSync(busy), true)
  assert.deepEqual(listSessions(root).length, 4)
})

test('the candidates can be read without deleting anything, and match what a prune then removes', () => {
  const root = dir()
  const cutoff = 1_000_000
  stale(root, 'old-a', { state: 'ended', pid: DEAD_PID, updatedAt: 10 })
  stale(root, 'old-b', { state: 'ended', pid: DEAD_PID, updatedAt: 20 })
  stale(root, 'keep', { state: 'ended', pid: process.pid, updatedAt: 10 })

  // Selection has no side effects, which is what lets a CLI announce a plan and then be told
  // no. Asserted rather than assumed: this is the read half of a delete.
  const candidates = prunableSessions(root, cutoff).map((s) => s.status.id)
  assert.deepEqual(candidates.sort(), ['old-a', 'old-b'])
  assert.equal(listSessions(root).length, 3, 'reading the candidates must not remove them')

  const result = pruneSessions(root, cutoff)
  // Reported before the removals are attempted, so a partial failure reads as a partial
  // failure rather than as a shorter candidate list than there really was.
  assert.deepEqual([...result.candidates].sort(), candidates)
  assert.deepEqual([...result.removed].sort(), candidates)
  assert.deepEqual(listSessions(root).map((s) => s.status.id), ['keep'])
})

test('a directory with no readable status is left alone, however old the rest are', () => {
  const root = dir()
  stale(root, 'ended-old', { state: 'ended', pid: DEAD_PID, updatedAt: 1 })
  // Started and never described itself, which the CLI already treats as its own condition.
  // `readSession` cannot tell that from a run still launching, and a prune that guessed
  // would delete the record of a session two seconds before it wrote its first status.
  const bare = sessionDir(root, 'never-recorded')
  mkdirSync(bare, { recursive: true })
  const corrupt = sessionDir(root, 'corrupt')
  mkdirSync(corrupt, { recursive: true })
  writeFileSync(join(corrupt, 'status.json'), '{ not json')

  const result = pruneSessions(root, 2)
  assert.deepEqual(result.candidates, ['ended-old'])
  assert.equal(existsSync(bare), true)
  assert.equal(existsSync(corrupt), true)
})

test('pruning a project with no sessions directory is not an error', () => {
  const result = pruneSessions(dir(), Date.now())
  assert.deepEqual(result, { candidates: [], removed: [], skipped: [], failed: [] })
})

/**
 * The announcement is the only honest way to say "about to delete".
 *
 * The returned `candidates` cannot make that claim: by the time a synchronous return is in
 * the caller's hands every removal has already happened, so a CLI printing from it describes
 * the past in the future tense -- and a process that died partway would have shown the
 * operator nothing at all about the records that did go.
 */
test('every candidate is announced while all of them are still on disk', () => {
  const root = dir()
  for (const id of ['a', 'b', 'c']) {
    stale(root, id, { state: 'ended', pid: DEAD_PID, updatedAt: 1 })
  }
  stale(root, 'live', { state: 'ended', pid: process.pid, updatedAt: 1 })

  let announced: readonly string[] | undefined
  let presentAtAnnouncement: string[] = []
  const result = pruneSessions(root, 2, {
    announce: (ids) => {
      announced = [...ids]
      // The assertion that matters: nothing has been deleted yet. Checked INSIDE the
      // callback, because that is the only moment at which the claim can be false.
      presentAtAnnouncement = ids.filter((id) => existsSync(sessionDir(root, id)))
    },
  })

  assert.deepEqual([...(announced ?? [])].sort(), ['a', 'b', 'c'])
  assert.deepEqual(presentAtAnnouncement.sort(), ['a', 'b', 'c'], 'announced before any removal')
  assert.deepEqual([...result.removed].sort(), ['a', 'b', 'c'])
  assert.equal(existsSync(sessionDir(root, 'live')), true)
})

/**
 * A pid can come back between the scan and the delete, and the window is not small: an
 * announcement, an operator reading it, and however long the earlier removals took all sit
 * inside it. The directory about to be deleted is that process's only durable account of
 * itself.
 */
test('a session that is alive again by the time its turn comes is spared', () => {
  const root = dir()
  stale(root, 'goes', { state: 'ended', pid: DEAD_PID, updatedAt: 1 })
  stale(root, 'revived', { state: 'ended', pid: DEAD_PID, updatedAt: 1 })

  // Rewritten during the announcement -- after the scan chose it, before its removal. A
  // check done only at scan time passes this test's setup and deletes the directory anyway.
  const result = pruneSessions(root, 2, {
    announce: () => {
      const p = join(sessionDir(root, 'revived'), 'status.json')
      const status = JSON.parse(readFileSync(p, 'utf8'))
      writeFileSync(p, JSON.stringify({ ...status, pid: process.pid }))
    },
  })

  assert.deepEqual([...result.candidates].sort(), ['goes', 'revived'], 'both were chosen')
  assert.deepEqual(result.removed, ['goes'])
  assert.deepEqual(result.skipped, [{ id: 'revived', reason: 'its process is alive' }])
  assert.deepEqual(result.failed, [], 'a spared session is not a failure')
  assert.equal(existsSync(sessionDir(root, 'revived')), true, 'a live process keeps its record')
  assert.equal(existsSync(sessionDir(root, 'goes')), false)
})

test('a record that vanishes between the scan and its removal is reported, not invented', () => {
  const root = dir()
  stale(root, 'vanishes', { state: 'ended', pid: DEAD_PID, updatedAt: 1 })
  const result = pruneSessions(root, 2, {
    announce: () => rmSync(sessionDir(root, 'vanishes'), { recursive: true, force: true }),
  })
  assert.deepEqual(result.candidates, ['vanishes'])
  assert.deepEqual(result.removed, [], 'it was not this prune that removed it')
  assert.deepEqual(result.skipped, [{ id: 'vanishes', reason: 'its record could no longer be read' }])
})

/**
 * The id inside a status file is whatever the file says; the directory NAME is what locates
 * the record on disk. They agree in everything conclave writes, and a function whose job is
 * recursive deletion must not be the place that assumes it.
 */
test('a record whose file claims a different id still deletes its own directory', () => {
  const root = dir()
  const held = sessionDir(root, 'on-disk')
  stale(root, 'on-disk', { state: 'ended', pid: DEAD_PID, updatedAt: 1 })
  const p = join(held, 'status.json')
  const status = JSON.parse(readFileSync(p, 'utf8'))
  writeFileSync(p, JSON.stringify({ ...status, id: 'somewhere-else' }))
  const other = stale(root, 'somewhere-else', { state: 'running', pid: process.pid, updatedAt: 1 })

  const result = pruneSessions(root, 2)
  assert.deepEqual(result.candidates, ['on-disk'], 'reported by the name that was removed')
  assert.equal(existsSync(held), false)
  assert.equal(existsSync(other), true, 'the live session the file pointed at is untouched')
})

test('an id is chronological and survives two sessions in the same second', () => {
  const at = Date.parse('2026-08-07T21:15:23')
  assert.match(newSessionId(at, 123), /^20260807-211523-123$/)
  assert.notEqual(newSessionId(at, 123), newSessionId(at, 124))
  // Sorting by name sorts by time, which is what makes a directory listing readable.
  assert.ok(newSessionId(at, 1) < newSessionId(at + 60_000, 1))
})

/**
 * What bounds the run, in the record and in the prose (#119).
 *
 * The recorder's half of the fix. `ceilings.test.ts` drives both front-ends end to end and
 * proves the numbers are the run's own; this proves the two things only visible from here: the
 * document carries every limit including the unset ones, and a stand-in that cannot answer
 * gets no block rather than a block claiming the run is unbounded.
 */
test('the status record carries every ceiling, with null for the ones nobody set', async () => {
  const root = dir()
  const relay = fakeRelay({
    ceilings: { advisorTurns: 8, maxTurns: 40, maxDurationMs: null, maxQueueDepth: null, maxConcurrentSeats: null },
  })
  const rec = recordSession(relay, {
    repoRoot: root,
    id: 'ceil-set',
    goal: 'g',
    front: 'session',
    startedAt: Date.now(),
    build: 'test-build',
  })
  await rec.refresh()
  const session = readSession(root, 'ceil-set')
  assert.ok(session)

  // The record, not a rendering of it. The two numbers #119 is about are adjacent here for the
  // same reason they are adjacent on the banner: an operator confirming that the flag they
  // raised is the flag that bounds the advisor can only do it by seeing both.
  assert.deepEqual(session.status.ceilings, {
    advisorTurns: 8,
    maxTurns: 40,
    maxDurationMs: null,
    maxQueueDepth: null,
    maxConcurrentSeats: null,
  })
  // And in the JSON a poller actually reads, where `null` must survive rather than being
  // dropped as an absent key -- which is what #103's reporter mistook for a value.
  const doc = JSON.parse(formatSessionJson(session))
  assert.equal(doc.ceilings.advisorTurns, 8)
  assert.ok('maxDurationMs' in doc.ceilings, 'an unset limit is reported as null, never omitted')
  assert.equal(doc.ceilings.maxDurationMs, null)

  // The prose says the same thing, because `formatSession` promises every field the JSON has
  // and an operator at a console is asking the same question as the poller.
  assert.match(formatSession(session, Date.now()), /ceilings:\s+--rounds 8 · --max-turns 40 · --max-minutes none/)

  relay.stream.close()
  await rec.close()
})

/**
 * The record stopped moving and never started again (#126).
 *
 * An agent operator polled `status --json` for 73 minutes and was told `running`, `pause:
 * none`, while the run sat at a `turn_incomplete` pause waiting for the answer that reading
 * therefore never produced. The disk had filled around the time the record last changed, and
 * freeing it changed nothing: `SessionRecorder.write()` catches one failure, latches `#failed`,
 * and every later `write()` returns immediately. So the failure is not "one write was lost" --
 * the writer stops, permanently, and the last good copy is left behind looking current.
 *
 * The pause is the part that makes this worse than stale data. It is the one piece of state
 * whose whole purpose is to be answered by whoever is reading this file, and the reader has
 * been handed a document saying no action is needed.
 *
 * Failure is staged through `<status>.tmp`, so a directory in that path fails `writeFileSync`
 * exactly where ENOSPC did -- and leaves `status.json` intact, which is the shape of the
 * incident. Nothing in this test re-reports the pause and nothing calls `refresh()`: recovery
 * is the heartbeat's, and if the pause comes back it came from the state the recorder still
 * holds in memory. Nothing re-reported it in the incident either.
 *
 * The middle of the test is the other half of the fix, and it does not depend on the first:
 * while writes are still blocked, the record on disk is aged and `status --json` is asked what
 * it thinks. It must say `stale` — which proves the warning reaches the operator over a channel
 * that does not require the broken writer to work.
 */
test('a status write that failed once does not stop the writer for good, and the live pause is republished (#126)', async (t) => {
  // This test simulates a production failure, so it produces a real `conclave:` line on stderr.
  // Captured rather than printed: a suite that emitted it on every green run would train a
  // reader to scroll past the one that means something. WHAT the channel says is asserted in the
  // two tests below; here the capture only has to not become a mute button, which the check at
  // the end of the test is for. Restored through `t.after` so a failing assertion cannot leave
  // console.error swapped for the rest of the file.
  const stderr = captureStderr()
  t.after(stderr.restore)

  const root = dir()
  const relay = fakeRelay()
  const recording = recordSession(relay, {
    repoRoot: root,
    id: 'enospc',
    goal: 'g',
    front: 'relay',
    startedAt: Date.now(),
    build: 'test-build',
    // Thirty seconds in production. Injected here only so a beat can be watched to land.
    heartbeatMs: 20,
  })
  recording.set('running')
  const good = readSession(root, 'enospc')
  assert.equal(good?.status.state, 'running', 'the premise: the record was being written')

  const tmp = `${recording.recorder.statusPath}.tmp`
  mkdirSync(tmp, { recursive: true })

  const pause = {
    reason: 'turn_incomplete' as const,
    resolution: resolutionFor(
      { reason: 'turn_incomplete', participant: 'implementer' },
      { rotationArmed: false },
    ),
    detail: 'the child stopped mid-turn',
    evidence: ['pid 52661 is alive but not computing (cpu 0.0%)'],
    options: ['continue' as const, 'abort' as const],
    atSeq: 4,
    at: Date.now(),
  }
  recording.set('paused', { pause })
  // Let the detached refresh `set` queues run, and FAIL, while the disk is still full. Without
  // this the whole failure window is synchronous, so that refresh is still pending when the
  // disk recovers, lands immediately, and republishes the pause -- and the test would pass
  // against a build with no heartbeat at all. It did; a mutation caught it.
  await settle()

  const blind = readSession(root, 'enospc')
  assert.equal(blind?.status.state, 'running', 'the failed write leaves the last good copy in place')
  assert.equal(blind?.status.pause, undefined, 'and the pause never reached the file -- this is the incident')

  // Time passes with the disk still full. Aged by hand rather than waited for, and the file is
  // safe to rewrite precisely because the recorder cannot write it: every beat is failing.
  const p = join(sessionDir(root, 'enospc'), 'status.json')
  const aged = JSON.parse(readFileSync(p, 'utf8'))
  writeFileSync(p, `${JSON.stringify({ ...aged, updatedAt: Date.now() - 73 * 60_000 }, null, 2)}\n`)

  const stuck = readSession(root, 'enospc')
  assert.equal(stuck?.alive, true, 'the process is still there, so nothing existing flags this record')
  assert.equal(stuck?.abandoned, false)
  const warned = JSON.parse(formatSessionJson(stuck!))
  assert.equal(warned.state, 'running', 'still claiming what it claimed 73 minutes ago')
  assert.equal(warned.pause, undefined, 'still not carrying the pause the run is halted at')
  assert.ok(
    warned.stale,
    'the warning must reach the operator without a successful write -- it is derived at read time, from the clock',
  )
  assert.equal(warned.stale.thresholdMs, SESSION_STALE_AFTER_MS)
  assert.ok(warned.stale.ageMs >= 72 * 60_000)
  assert.match(formatSession(stuck!, Date.now()), /STALE:\s+nothing has written this record in/)

  // Space is freed. Nobody tells the recorder anything; the next beat is what finds out.
  rmSync(tmp, { recursive: true, force: true })
  const back = await until('the heartbeat to republish the pause', () => {
    // Polled rather than slept for: a fixed wait long enough for a beat on an idle machine is
    // not long enough on a loaded one, and a writer that gave up permanently never satisfies
    // this however long it is given.
    const now = readSession(root, 'enospc')
    return now?.status.state === 'paused' ? now : undefined
  })
  assert.equal(
    back.status.pause?.reason,
    'turn_incomplete',
    'the pause must be republished by the heartbeat, from the state the recorder still holds',
  )
  assert.ok(
    back.status.updatedAt > stuck!.status.updatedAt,
    'and the record is being written again',
  )
  assert.equal(
    sessionStaleness(back, Date.now()),
    undefined,
    'so the warning clears itself -- it is a reading, not a mark left on the record',
  )

  relay.stream.close()
  await recording.close()

  // The capture is a diversion, not a gag: everything on it came from the recorder, and the
  // whole outage cost at most the one warning and the one recovery the window allows.
  assert.ok(
    stderr.said.every((l) => l.startsWith('conclave: ')),
    `only the recorder's own lines belong here, got ${JSON.stringify(stderr.said)}`,
  )
  assert.ok(stderr.said.length <= 2, `one warning and one recovery at most, got ${stderr.said.length}`)
})

/**
 * A flickering volume must not make the recorder shout (#126).
 *
 * Retrying every write is the fix; announcing every retry would be a second defect wearing the
 * first one's clothes. Ordinary contention -- a sync, a snapshot, a busy volume -- fails one
 * write and lets the next through, and at one write per beat plus one per event that is a
 * warning and a recovery line per event, which buries the run's own output. An operator who
 * learns to scroll past `conclave:` lines has been trained to miss the one that matters.
 *
 * So the budget is on the CHANNEL, not the episode: the last-warning timestamp survives
 * recovering, and a recovery line is emitted only for an outage that was announced. Four
 * failures and four recoveries inside one second must therefore produce exactly one pair -- the
 * first -- and the pairing must hold, because a recovery line for an outage nobody was told
 * about announces the end of something the reader never knew had started.
 */
test('a volume that flickers gets one warning and one recovery, not one per failed write (#126)', async () => {
  const root = dir()
  const rec = new SessionRecorder(root, {
    id: 'flap',
    pid: process.pid,
    cwd: root,
    goal: 'g',
    front: 'relay',
    operator: 'human',
    state: 'running',
    startedAt: Date.now(),
    messages: 0,
    participants: [],
    build: 'test-build',
  })
  const tmp = `${rec.statusPath}.tmp`

  const said = await whileWatchingStderr(() => {
    for (let i = 0; i < 4; i += 1) {
      mkdirSync(tmp, { recursive: true })
      rec.update({ messages: i * 2 + 1 })
      rmSync(tmp, { recursive: true, force: true })
      rec.update({ messages: i * 2 + 2 })
    }
  })

  const failures = said.filter((l) => /could not write session status/.test(l))
  const recoveries = said.filter((l) => /is being written again/.test(l))
  assert.equal(failures.length, 1, 'the first failure is announced; the next three are inside the minute')
  assert.equal(recoveries.length, 1, 'and exactly the announced outage is closed off')
  assert.equal(said.length, 2, 'nothing else is said')

  // The recorder did not merely go quiet -- it kept writing throughout, which is the whole
  // reason the failures are survivable enough to be worth staying quiet about.
  assert.equal(readSession(root, 'flap')?.status.messages, 8, 'every recovered write landed')
})

/**
 * The window itself, on a clock the test owns (#126).
 *
 * The test above proves the budget holds at the fast end -- four outages inside a second produce
 * one pair. It cannot prove the other half, that the budget is a WINDOW rather than a one-shot:
 * an implementation that announced the first failure of a process and then never spoke again
 * would pass it identically, and would leave an operator whose disk has been full for an hour
 * with one line from an hour ago.
 *
 * So the clock is mocked and stepped, rather than waited on. Two claims that only a controlled
 * clock can separate:
 *
 *   inside the window     an entire outage -- failure and recovery -- passes in silence
 *   at the boundary       the operator is told again, whether the outage is a NEW one or the
 *                         same one still going
 *
 * And one that neither: however many times an outage is announced, recovering from it emits ONE
 * line. The recovery closes an outage, not a warning.
 *
 * `apis: ['Date']` only -- `setTimeout` is left real, because nothing here waits on one and a
 * mocked scheduler would silently change what `await` means in this file.
 */
test('the warning budget is a window, so a failure that outlasts it is announced again (#126)', async (t) => {
  // Deliberately not the epoch. `#statusWarnedAt` uses `undefined` for "never warned" precisely
  // so that 0 can be a real instant, and starting here is what would catch a regression to a
  // falsy sentinel.
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 })
  const root = dir()
  const rec = new SessionRecorder(root, {
    id: 'window',
    pid: process.pid,
    cwd: root,
    goal: 'g',
    front: 'relay',
    operator: 'human',
    state: 'running',
    startedAt: Date.now(),
    messages: 0,
    participants: [],
    build: 'test-build',
  })
  const tmp = `${rec.statusPath}.tmp`
  const block = () => mkdirSync(tmp, { recursive: true })
  const unblock = () => rmSync(tmp, { recursive: true, force: true })
  const failures = (said: string[]) => said.filter((l) => /could not write session status/.test(l))
  const recoveries = (said: string[]) => said.filter((l) => /is being written again/.test(l))

  // The first failure of a process is always announced, and its recovery closes it.
  const opening = await whileWatchingStderr(() => {
    block()
    rec.update({ messages: 1 })
    unblock()
    rec.update({ messages: 2 })
  })
  assert.equal(failures(opening).length, 1, 'a recorder that has never warned always warns')
  assert.equal(recoveries(opening).length, 1, 'and the outage it announced is closed off')

  // One millisecond short of the window: a whole outage comes and goes without a word.
  t.mock.timers.tick(STATUS_WARN_EVERY_MS - 1)
  const inside = await whileWatchingStderr(() => {
    block()
    rec.update({ messages: 3 })
    unblock()
    rec.update({ messages: 4 })
  })
  assert.deepEqual(inside, [], 'inside the window nothing is said, the recovery line included')

  // At the window exactly. A NEW outage is announced again.
  t.mock.timers.tick(1)
  const reopened = await whileWatchingStderr(() => {
    block()
    rec.update({ messages: 5 })
  })
  assert.equal(
    failures(reopened).length,
    1,
    'the window has elapsed, so the operator hears about it again rather than once per process',
  )

  // The same outage, still going, crossing the NEXT window without ever having recovered. This
  // is the case the fast test cannot see at all: nothing recovers, so nothing resets anything.
  t.mock.timers.tick(STATUS_WARN_EVERY_MS - 1)
  assert.deepEqual(
    await whileWatchingStderr(() => rec.update({ messages: 6 })),
    [],
    'a continuing outage is no louder inside the window than a flapping one',
  )
  t.mock.timers.tick(1)
  const persisted = await whileWatchingStderr(() => rec.update({ messages: 7 }))
  assert.equal(
    failures(persisted).length,
    1,
    'a disk that stays full is never silent -- it is announced once a window, for as long as it lasts',
  )

  // Twice announced, once closed. The recovery line is about the outage, not about the warnings.
  const closing = await whileWatchingStderr(() => {
    unblock()
    rec.update({ messages: 8 })
  })
  assert.equal(recoveries(closing).length, 1)
  assert.equal(closing.length, 1, 'and nothing else is said')

  // Throughout: every write that could land, landed. Quiet is not the same as stopped.
  assert.equal(readSession(root, 'window')?.status.messages, 8)
})

/**
 * The same latch, on the other file (#126).
 *
 * `#failed` is one flag for both writers, so the first failure of either stops both. An
 * appended stream that stops is at least visible in the stream itself, which is why `event()`
 * is quieter than `write()` -- but "visible" only holds if the stream resumes when the disk
 * does. Today the second half of that is not true: one failed append and nothing is ever
 * written to `events.ndjson` again.
 */
test('an events append that failed once does not stop the stream for good (#126)', async () => {
  const root = dir()
  const relay = fakeRelay()
  const recording = recordSession(relay, {
    repoRoot: root,
    id: 'evt-fail',
    goal: 'g',
    front: 'relay',
    startedAt: Date.now(),
    build: 'test-build',
  })
  // A directory where the stream goes: `appendFileSync` fails the way a full disk fails, and
  // does so before the first event rather than corrupting one already written.
  mkdirSync(recording.recorder.eventsPath, { recursive: true })
  relay.stream.emit({
    type: 'activity',
    participant: 'implementer',
    rank: 'implementer',
    event: { type: 'turn_start', seq: 1, at: 1, prompt: 'lost' } as never,
  })
  await settle()

  rmSync(recording.recorder.eventsPath, { recursive: true, force: true })
  relay.stream.emit({
    type: 'activity',
    participant: 'implementer',
    rank: 'implementer',
    event: { type: 'turn_end', seq: 2, at: 2 } as never,
  })
  await settle()

  assert.ok(
    existsSync(recording.recorder.eventsPath),
    'the stream must resume once appending is possible again',
  )
  const kinds = readFileSync(recording.recorder.eventsPath, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l).event.type)
  assert.deepEqual(kinds, ['turn_end'], 'the event lost to the full disk stays lost; the ones after it do not')

  relay.stream.close()
  await recording.close()
})

/**
 * Staleness is a fact the payload carries, not one the reader has to compute (#126).
 *
 * `alive` is honest -- the process does exist -- and `state` is documented as what the session
 * last SAID. Between them a reader still cannot tell "last said four seconds ago" from "last
 * said 73 minutes ago" without diffing `updatedAt` against its own clock, and nothing warns
 * when that gap becomes absurd. `abandoned` does not cover it: the pid is alive, so the one
 * existing flag for a record that cannot be trusted stays false throughout.
 *
 * Asserted on `formatSessionJson` alone, independently of whether the writer was fixed: a
 * reader polling a record that stopped moving for ANY reason is owed the same warning.
 *
 * The fresh document is pinned key-for-key and in order, which is the other half of the ask.
 * D1: the default document must not change, so the warning is a key that appears when there is
 * something to warn about and is APPENDED when it does -- an always-present `stale: false`
 * would change what every existing consumer reads, and an inserted key would move the rest.
 */
test('status --json says a live record has stopped moving, and leaves a fresh one untouched (#126)', async () => {
  const root = dir()
  const relay = fakeRelay()
  const recording = recordSession(relay, {
    repoRoot: root,
    id: 'stale-json',
    goal: 'g',
    front: 'relay',
    startedAt: Date.now(),
    build: 'test-build',
  })
  recording.set('running')
  relay.stream.close()
  // Closed before the file is rewritten below, so no detached refresh can land on top of it.
  await recording.close()

  const fresh = readSession(root, 'stale-json')
  assert.equal(fresh?.alive, true)
  const freshDoc = JSON.parse(formatSessionJson(fresh!))
  const FRESH_KEYS = [
    'id',
    'pid',
    'cwd',
    'goal',
    'front',
    'operator',
    'state',
    'startedAt',
    'messages',
    'participants',
    'build',
    'schema',
    'eventsPath',
    'updatedAt',
    'alive',
    'abandoned',
  ]
  assert.deepEqual(Object.keys(freshDoc), FRESH_KEYS, 'a record written seconds ago must read exactly as it does today')
  assert.equal('stale' in freshDoc, false, 'nothing to warn about, so no warning')

  // The same record, 73 minutes later, with the process still there. Rewritten rather than
  // waited for: `updatedAt` is the field the whole reading turns on, and a test that could
  // only write "now" could not tell an old record from a current one.
  const p = join(sessionDir(root, 'stale-json'), 'status.json')
  const onDisk = JSON.parse(readFileSync(p, 'utf8'))
  writeFileSync(p, `${JSON.stringify({ ...onDisk, updatedAt: Date.now() - 73 * 60_000 }, null, 2)}\n`)

  const old = readSession(root, 'stale-json')
  assert.equal(old?.alive, true, 'the pid answers, which is why nothing existing flags this record')
  assert.equal(old?.abandoned, false)
  assert.equal(old?.status.state, 'running', 'and the claim is unchanged: `running`, no pause')

  const doc = JSON.parse(formatSessionJson(old!))
  assert.ok(
    doc.stale,
    'a live run whose record has not moved in 73 minutes must say so in the payload, not leave it to be derived',
  )
  assert.deepEqual(
    Object.keys(doc),
    [...FRESH_KEYS, 'stale'],
    'appended, so every key an existing consumer reads is where it was',
  )
  // Both numbers, because one of them alone is another thing to look up: the age says how bad
  // it is and the threshold says what "bad" was measured against, so a reader can judge the
  // call rather than trust it.
  assert.deepEqual(Object.keys(doc.stale), ['ageMs', 'thresholdMs'])
  assert.equal(doc.stale.thresholdMs, SESSION_STALE_AFTER_MS)
  assert.equal(doc.stale.thresholdMs, SESSION_HEARTBEAT_MS * 3, 'three missed beats, said as its own claim')
  assert.ok(doc.stale.ageMs >= 72 * 60_000 && doc.stale.ageMs <= 74 * 60_000)

  // AT the threshold, not past it, which is the discipline the prune cutoff above is held to --
  // an operator who says "three beats" means it. Read against a computed instant rather than the
  // wall clock, so the boundary is the assertion rather than a race with it.
  const beat3 = old!.status.updatedAt + SESSION_STALE_AFTER_MS
  assert.equal(sessionStaleness(old!, beat3), undefined, 'exactly three beats old is not yet stale')
  assert.deepEqual(
    sessionStaleness(old!, beat3 + 1),
    { ageMs: SESSION_STALE_AFTER_MS + 1, thresholdMs: SESSION_STALE_AFTER_MS },
    'one millisecond past it is',
  )

  // And in the prose, where the operator at a console is asking the same question. Placed with
  // the `updated:` line it qualifies, above everything the record CLAIMS.
  const prose = formatSession(old!, Date.now()).split('\n')
  const at = prose.findIndex((l) => /STALE:/.test(l))
  assert.ok(at > 0, 'the prose warns too')
  assert.match(prose[at - 1]!, /updated:/, 'immediately after the number it qualifies')
  assert.ok(prose.slice(at).some((l) => /pid \d+ is still there/.test(l)))
})

/**
 * The two records that are old for a reason, and must not be warned about (#126).
 *
 * A staleness warning that fired on every archived session, or a second time on a record
 * `abandoned` already covers, would be trained out of a reader within a day -- and the reader
 * being trained is an agent operator polling on a loop.
 */
test('an ended run and an abandoned one are old on purpose, and get no staleness warning (#126)', () => {
  const root = dir()
  const long = Date.now() - 73 * 60_000
  // Finished, and its process still exiting: old because it stopped writing on purpose.
  stale(root, 'finished', { state: 'ended', pid: process.pid, updatedAt: long })
  // Claimed to be going, nobody home. `abandoned` is already the name for this.
  stale(root, 'gone', { state: 'running', pid: DEAD_PID, updatedAt: long })

  const finished = readSession(root, 'finished')
  assert.equal(finished?.alive, true, 'the premise: the pid answers, so only `ended` keeps it quiet')
  assert.equal(
    sessionStaleness(finished!, Date.now()),
    undefined,
    'a finished run stopped writing on purpose and is not stale, however old',
  )
  assert.equal(
    'stale' in JSON.parse(formatSessionJson(finished!)),
    false,
    'so no archived session anyone ever reads carries the warning',
  )

  const gone = readSession(root, 'gone')
  assert.equal(gone?.abandoned, true, 'the premise: this record is already flagged, by its own name')
  assert.equal(
    sessionStaleness(gone!, Date.now()),
    undefined,
    'a dead process is `abandoned`; `stale` must not become a second name for it',
  )
  assert.equal(
    'stale' in JSON.parse(formatSessionJson(gone!)),
    false,
    'one condition, one flag',
  )
})

test('a stand-in that cannot answer gets no targeting block, even on a run that would have had one', async () => {
  // The structural half of the contract, and TWO seats deliberately: a one-seat run emits no
  // `targeting` key either way (#79 keeps it off the default document entirely), so a stand-in
  // with one seat would pass this test without exercising anything. With two, the key WOULD be
  // written if the relay answered -- so what is pinned is that a stand-in predating #79 still
  // satisfies `RecordableRelay` and still gets the document it got before, rather than a
  // recorder inventing a block reporting that its advisor addressed nobody.
  const root = dir()
  const relay = fakeRelay({ seats: ['implementer-2'] })
  const rec = recordSession(relay, {
    repoRoot: root,
    id: 'targeting-absent',
    goal: 'g',
    front: 'session',
    startedAt: Date.now(),
    build: 'test-build',
  })
  await rec.refresh()
  const session = readSession(root, 'targeting-absent')
  assert.ok(session)
  assert.equal(session.status.targeting, undefined)
  assert.ok(!('targeting' in JSON.parse(formatSessionJson(session))), 'no key at all, not an empty one')
  assert.doesNotMatch(formatSession(session, Date.now()), /targeting:/)

  relay.stream.close()
  await rec.close()
})

test('a stand-in that cannot answer gets no ceilings block, rather than one claiming no limits', async () => {
  // The structural half of the contract, and the same rule `rotationOf` follows: absent means
  // "this relay was never asked", which is not the same fact as `null` meaning "no limit". A
  // recorder that defaulted here would write a document asserting a run is unbounded on the
  // evidence of a stand-in that has no opinion.
  const root = dir()
  const relay = fakeRelay()
  const rec = recordSession(relay, {
    repoRoot: root,
    id: 'ceil-absent',
    goal: 'g',
    front: 'session',
    startedAt: Date.now(),
    build: 'test-build',
  })
  await rec.refresh()
  const session = readSession(root, 'ceil-absent')
  assert.ok(session)
  assert.equal(session.status.ceilings, undefined)
  assert.ok(!('ceilings' in JSON.parse(formatSessionJson(session))), 'no key at all, not a null one')
  assert.doesNotMatch(formatSession(session, Date.now()), /ceilings:/)

  relay.stream.close()
  await rec.close()
})

/** Let the recorder's follow loop run. It is asynchronous; a synchronous test outruns it. */
const tick = () => new Promise((r) => setTimeout(r, 20))

test('#189 a second run reaches the record, and so does anything said between them', async () => {
  // The record is per SESSION; a subscription is per RUN. Those were the same thing until a
  // console could start a second run on the same relay -- which is what happens when you type
  // another goal. `#end` closed the stream, the follow loop returned, and everything after it
  // went unrecorded while `relay.log` kept collecting: two files describing one session and
  // disagreeing about it.
  //
  // Measured against a real pty before the fix: run 2 ran, the console drew all of it, and
  // `events.ndjson` stayed at the 8 messages of run 1.
  const root = dir()
  const relay = fakeRelay({ multiRun: true })
  const recording = recordSession(relay, {
    repoRoot: root,
    id: 'two-runs',
    goal: 'first',
    front: 'session',
    startedAt: Date.now(),
    build: 'test-build',
  })

  relay.stream.emit({ type: 'activity', participant: 'implementer', rank: 'implementer', event: { type: 'turn_start', seq: 1, at: 1, prompt: 'first' } as never })
  relay.stream.emit({ type: 'run_end', reason: 'done' })
  relay.stream.close()
  // The follow loop is asynchronous, and a real session puts time between its runs. Without a
  // yield here the entire session would happen before the recorder ran once, and the test would
  // be measuring the scheduler rather than the fix.
  await tick()

  // Between the runs: the operator asks a participant something. `Relay#ask` records both
  // halves, and before this they reached `relay.log` and nothing else -- the stream counted
  // them as dropped, because the RUN was over even though the session was not.
  relay.stream.emit({ type: 'message', message: { from: 'human', fromRank: 'human', to: ['advisor'], kind: 'constraint', text: 'between the runs', seq: 9, at: 9, visibility: 'normal', excluded: [] } as never })

  // A second goal. `Relay.start` reopens the stream for the new epoch.
  await tick()
  relay.stream.reopen()
  await tick()
  relay.stream.emit({ type: 'activity', participant: 'implementer', rank: 'implementer', event: { type: 'turn_start', seq: 2, at: 2, prompt: 'second' } as never })
  relay.stream.emit({ type: 'run_end', reason: 'done' })
  await tick()
  // The SESSION ends here, which is a different event from either run ending.
  relay.endSession()
  await recording.close()

  const events = readFileSync(recording.recorder.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const prompts = events.filter((e) => e.type === 'activity').map((e) => e.event.prompt)
  assert.deepEqual(prompts, ['first', 'second'], 'both runs must be in the one session record')

  assert.ok(
    events.some((e) => e.type === 'message' && e.message.text === 'between the runs'),
    'a question asked between runs belongs to the session, which has not ended',
  )

  // Nothing is written twice. The re-attach replays the retained history and skips what the
  // record already holds, so a naive re-subscribe duplicating run 1 would fail here.
  assert.equal(
    events.filter((e) => e.type === 'activity' && e.event.prompt === 'first').length,
    1,
    'run 1 must appear once, not again on every re-attach',
  )
})

test('#189 late child activity still never reaches the record', async () => {
  // The other half, and the reason this could not simply leave the stream open. A child does
  // not stop emitting because the relay decided the run was over, and those events must not
  // land in the record of the run they came after -- `relay.test.ts` holds the same rule for
  // subscribers. A MESSAGE is the relay's own account of the session and is kept; ACTIVITY is
  // a child talking about a turn that has ended and is not.
  const root = dir()
  const relay = fakeRelay()
  const recording = recordSession(relay, {
    repoRoot: root,
    id: 'late',
    goal: 'g',
    front: 'session',
    startedAt: Date.now(),
    build: 'test-build',
  })

  relay.stream.emit({ type: 'run_end', reason: 'done' })
  relay.stream.close()
  relay.stream.emit({ type: 'activity', participant: 'implementer', rank: 'implementer', event: { type: 'tool_use', seq: 3, at: 3, tool: 'LateWrite' } as never })
  await recording.close()

  const events = readFileSync(recording.recorder.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(
    events.filter((e) => e.type === 'activity').length,
    0,
    'a tool call emitted after the run ended must not be recorded against it',
  )
  assert.ok(relay.stream.droppedAfterClose >= 1, 'and it is counted as dropped rather than silently eaten')
})
