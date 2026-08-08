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

/** A relay-shaped stand-in. Structural typing is the point: no Relay is constructed. */
function fakeRelay(): RecordableRelay & {
  stream: RelayEventStream
  pending: { id: string; tool: string }[]
  messages: unknown[]
} {
  const stream = new RelayEventStream()
  const pending: { id: string; tool: string }[] = []
  const messages: unknown[] = []
  return {
    stream,
    pending,
    messages,
    cwd: '/tmp/project',
    operator: 'human',
    participants: [
      { id: 'advisor', rank: 'advisor', session: { agent: 'codex' } },
      { id: 'implementer', rank: 'implementer', session: { agent: 'claude' } },
    ],
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

test('an id is chronological and survives two sessions in the same second', () => {
  const at = Date.parse('2026-08-07T21:15:23')
  assert.match(newSessionId(at, 123), /^20260807-211523-123$/)
  assert.notEqual(newSessionId(at, 123), newSessionId(at, 124))
  // Sorting by name sorts by time, which is what makes a directory listing readable.
  assert.ok(newSessionId(at, 1) < newSessionId(at + 60_000, 1))
})
