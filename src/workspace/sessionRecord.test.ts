/**
 * The session record: what an operator outside the process can learn about a run.
 *
 *   node --test src/workspace/sessionRecord.test.ts
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Confidence, Provenance } from '../contract/outcome.ts'
import { RelayEventStream } from '../relay/observe.ts'
import {
  listSessions,
  newSessionId,
  readSession,
  recordSession,
  resolveSession,
  SessionRecorder,
  sessionDir,
  type RecordableRelay,
} from './sessionRecord.ts'

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
function fakeSeat(id: string, rank: string, agent: string) {
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

/** A relay-shaped stand-in. Structural typing is the point: no Relay is constructed. */
function fakeRelay(): RecordableRelay & {
  stream: RelayEventStream
  pending: { id: string; tool: string }[]
  messages: unknown[]
  seats: Record<string, ReturnType<typeof fakeSeat>['state']>
} {
  const stream = new RelayEventStream()
  const pending: { id: string; tool: string }[] = []
  const messages: unknown[] = []
  const advisor = fakeSeat('advisor', 'advisor', 'codex')
  const implementer = fakeSeat('implementer', 'implementer', 'claude')
  return {
    stream,
    pending,
    messages,
    seats: { advisor: advisor.state, implementer: implementer.state },
    cwd: '/tmp/project',
    operator: 'human',
    participants: [advisor.seat, implementer.seat],
    get log() {
      return messages
    },
    permissionsPending: () => pending,
    observe: (opts) => stream.observe(opts),
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
  })
  const pause = {
    reason: 'operator_requested' as const,
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
  })
  // Empty rather than absent before anything has run: a reader must be able to tell "no
  // turns yet" from "this build does not report turns".
  const before = readSession(root, 'turns')?.status.participants ?? []
  assert.deepEqual(before.map((p) => p.turns), [[], []])

  relay.seats.implementer!.turns = [graded('impl-turn-0')]
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
  })
  relay.seats.implementer!.turns = [graded('impl-turn-0')]
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
  })
  // The first read sees one turn and takes 120ms to say so; the second sees two and is
  // instant. Run concurrently and unordered, the first would land last and the record would
  // lose a turn it had already reported.
  relay.seats.implementer!.script = [
    { turns: [graded('impl-turn-0')], delayMs: 120 },
    { turns: [graded('impl-turn-0'), graded('impl-turn-1')] },
  ]
  const slow = recording.refresh()
  const quick = recording.refresh()
  await Promise.all([slow, quick])
  assert.ok(relay.seats.implementer!.snapshots >= 2, 'both refreshes must actually have read')

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
  })
  recording.set('ended', { outcome: { reason: 'done', detail: 'DONE' } })
  // Graded only after the front-end has already said `ended` — which is the real order:
  // the console reports the state on teardown and the verdict is in the transcript by then.
  relay.seats.advisor!.turns = [graded('advisor-turn-0')]
  relay.seats.implementer!.turns = [graded('impl-turn-0'), graded('impl-turn-1')]
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
  })
  relay.seats.implementer!.turns = [graded('impl-turn-0')]
  await recording.refresh()
  // The final refresh runs after `relay.stop()`, when a session may already be terminated
  // and its transcript unreadable. Losing the turns there loses them when they matter most.
  relay.seats.implementer!.fail = true
  relay.stream.close()
  await recording.close()

  const seat = readSession(root, 'gone')?.status.participants.find((p) => p.id === 'implementer')
  assert.equal(seat?.turns.length, 1, 'the last snapshot that could be read is kept')
})

test('an id is chronological and survives two sessions in the same second', () => {
  const at = Date.parse('2026-08-07T21:15:23')
  assert.match(newSessionId(at, 123), /^20260807-211523-123$/)
  assert.notEqual(newSessionId(at, 123), newSessionId(at, 124))
  // Sorting by name sorts by time, which is what makes a directory listing readable.
  assert.ok(newSessionId(at, 1) < newSessionId(at + 60_000, 1))
})
