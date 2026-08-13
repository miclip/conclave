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
  SessionRecorder,
  sessionDir,
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
  rotation?: RotationConfig | undefined
  seats?: string[]
  /** A reviewer seat: rank `implementer`, role `reviewer` (D5, #72). */
  reviewer?: boolean
}): RecordableRelay & {
  stream: RelayEventStream
  pending: { id: string; tool: string }[]
  messages: unknown[]
  transcripts: Record<string, ReturnType<typeof fakeSeat>['state']>
} {
  const stream = new RelayEventStream()
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
    observe: (o) => stream.observe(o),
  }
}

/** Let the detached follow loop run. It is deliberately not on the caller's critical path. */
const settle = () => new Promise((r) => setTimeout(r, 30))

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
