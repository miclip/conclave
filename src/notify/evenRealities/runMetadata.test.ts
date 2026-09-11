/**
 * A run's record, as the glasses' session list reads it (#278).
 *
 * Driven through the real writer (`SessionRecorder`), so what is asserted is what a run leaves
 * on disk and not a fixture that happens to agree with the reader.
 *
 *   node --test src/notify/evenRealities/runMetadata.test.ts
 */

import { strict as assert } from 'node:assert'
import { appendFileSync, statSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import type { TestContext } from 'node:test'

import { tempDir } from '../../testkit/tempDir.ts'
import { SessionRecorder } from '../../workspace/sessionRecord.ts'
import { EvenRealitiesBridge } from './client.ts'
import { TAIL_CHUNK, describeRun, lastEventAt } from './runMetadata.ts'

function recorder(t: TestContext, goal = 'fix the thing'): { root: string; rec: SessionRecorder } {
  const root = tempDir(t, 'conclave-run-meta')
  const rec = new SessionRecorder(root, {
    id: 'run-1',
    pid: process.pid,
    cwd: root,
    goal,
    front: 'session',
    operator: 'agent',
    state: 'running',
    startedAt: 1_700_000_000_000,
    messages: 0,
    participants: [],
    build: 'test-build',
  })
  return { root, rec }
}

const iso = (ms: number): string => new Date(ms).toISOString()

test('#278 the title is the goal, and a long one is cut to what the vendor carries', (t) => {
  // The goal is what an operator choosing a run on the glasses needs -- two runs from one
  // directory have the same name and different goals. The cut is the vendor's `.slice(0, 64)`,
  // applied on the wire by the bridge, so the record keeps the whole goal.
  const long = 'x'.repeat(100)
  const { root } = recorder(t, long)
  const meta = describeRun(root, 'run-1')
  assert.equal(meta?.title, long, 'the record-level title is the whole goal')
  assert.equal(EvenRealitiesBridge.TITLE_CHARS, 64)
})

test('#278 cwd is the run\'s working directory from its record', (t) => {
  const { root } = recorder(t)
  assert.equal(describeRun(root, 'run-1')?.cwd, root)
})

test('#278 with no events yet, the timestamp is startedAt', (t) => {
  // True, sorts correctly, and claims no activity that did not happen. The record is beaten
  // first so `updatedAt` has moved off `startedAt`: at construction they are equal, and a
  // reader of the wrong one would pass by coincidence.
  const { root, rec } = recorder(t)
  rec.beat()
  assert.notEqual(rec.status.updatedAt, rec.status.startedAt, 'precondition')
  assert.equal(describeRun(root, 'run-1')?.timestamp, iso(rec.status.startedAt))
})

test('#278 the newest event is found in a stream larger than the window read from its tail', (t) => {
  // The app polls every few seconds and a long run's stream is megabytes, so only the tail is
  // read. The offset arithmetic is the thing that goes wrong silently: a read from the wrong
  // end finds a real event and a stale timestamp.
  const { root, rec } = recorder(t)
  for (let i = 0; i < 2000; i++) rec.event({ type: 'message', at: 1_700_000_000_000 + i, pad: 'p'.repeat(60) } as never)
  assert.ok(statSync(rec.eventsPath).size > 64 * 1024, 'precondition: bigger than the tail window')
  assert.equal(describeRun(root, 'run-1')?.timestamp, iso(1_700_000_001_999))
})

test('#278 a newly appended valid event advances the timestamp', (t) => {
  const { root, rec } = recorder(t)
  rec.event({ type: 'message', at: 1_700_000_050_000 } as never)
  assert.equal(describeRun(root, 'run-1')?.timestamp, iso(1_700_000_050_000))
  rec.event({ type: 'message', at: 1_700_000_090_000 } as never)
  assert.equal(describeRun(root, 'run-1')?.timestamp, iso(1_700_000_090_000), 'read again, not cached')
})

test('#278 malformed trailing lines are skipped for the newest event that parses', (t) => {
  // A reader can arrive between the write and its newline, and a disk that filled can leave a
  // torn line. Neither is an event; the one before is.
  const { root, rec } = recorder(t)
  rec.event({ type: 'message', at: 1_700_000_050_000 } as never)
  appendFileSync(rec.eventsPath, '{"type":"message","at":1700000099')
  assert.equal(describeRun(root, 'run-1')?.timestamp, iso(1_700_000_050_000))
  appendFileSync(rec.eventsPath, '\n{"type":"message","at":"not a number"}\nnot json at all\n')
  assert.equal(describeRun(root, 'run-1')?.timestamp, iso(1_700_000_050_000), 'a non-numeric `at` is not an event either')
  writeFileSync(rec.eventsPath, 'garbage\n')
  assert.equal(describeRun(root, 'run-1')?.timestamp, iso(rec.status.startedAt), 'nothing valid falls back to startedAt')
  assert.equal(lastEventAt(`${root}/nope.ndjson`), undefined, 'and no file at all is no event')
})

test('#278 the heartbeat does not move the timestamp', (t) => {
  // `updatedAt` is rewritten every `SESSION_HEARTBEAT_MS` whether anything happened or not. If
  // it fed this field every live run would sort to the top together, and a run stuck for two
  // hours would read as though it had just done something.
  const { root, rec } = recorder(t)
  rec.event({ type: 'message', at: 1_700_000_050_000 } as never)
  const before = describeRun(root, 'run-1')?.timestamp
  rec.beat()
  rec.update({ messages: 3 })
  assert.notEqual(rec.status.updatedAt, rec.status.startedAt, 'precondition: the record was rewritten')
  assert.equal(describeRun(root, 'run-1')?.timestamp, before)
  assert.equal(before, iso(1_700_000_050_000))
})

test('#278 a malformed tail longer than a chunk does not hide the newest valid event', (t) => {
  // A single fixed slice of the tail would be all garbage here and say "no event" of a stream
  // that has one. The walk goes back chunk by chunk until something parses.
  const { root, rec } = recorder(t)
  rec.event({ type: 'message', at: 1_700_000_050_000 } as never)
  appendFileSync(rec.eventsPath, `{"type":"message","at":17000000${'9'.repeat(TAIL_CHUNK + 4096)}`)
  assert.ok(statSync(rec.eventsPath).size > TAIL_CHUNK, 'precondition: the torn line alone exceeds a chunk')
  assert.equal(describeRun(root, 'run-1')?.timestamp, iso(1_700_000_050_000))
})

test('#278 a valid event line that straddles a chunk boundary is read whole', (t) => {
  // The newest chunk begins in the middle of the event line. The fragment at the top of that
  // chunk is not a line yet; it is carried into the chunk before it, and only the joined line
  // is parsed. Split on the byte, and the file is arranged so the boundary falls inside it.
  const { root, rec } = recorder(t)
  const line = JSON.stringify({ type: 'message', at: 1_700_000_050_000, pad: 'p'.repeat(200) })
  writeFileSync(rec.eventsPath, `${line}\n`)
  // Garbage after it sized so the last TAIL_CHUNK bytes start inside `line`.
  const garbage = 'g'.repeat(TAIL_CHUNK - Math.floor(line.length / 2))
  appendFileSync(rec.eventsPath, garbage)
  const size = statSync(rec.eventsPath).size
  const boundary = size - TAIL_CHUNK
  assert.ok(boundary > 0 && boundary < line.length, `precondition: the boundary at ${boundary} is inside the ${line.length}-byte line`)
  assert.equal(describeRun(root, 'run-1')?.timestamp, iso(1_700_000_050_000))
})

test('#278 status is read from recorded progress, and is null where nothing is known', (t) => {
  // Not "the process exists, so busy": a live run idling between turns is not busy, and a
  // status that said so of every live run would tell the operator nothing.
  const { root, rec } = recorder(t)
  assert.equal(describeRun(root, 'run-1')?.status, null, 'live, but no progress recorded yet')
  rec.update({ progress: { state: 'in_turn', since: 1 } })
  assert.equal(describeRun(root, 'run-1')?.status, 'busy', 'a seat is inside a turn')
  rec.update({ progress: { state: 'paused', since: 1 } })
  assert.equal(describeRun(root, 'run-1')?.status, 'awaiting', 'paused is waiting on a human')
  rec.update({ progress: { state: 'idle', since: 1 } })
  assert.equal(describeRun(root, 'run-1')?.status, 'idle', 'live, nothing in flight')
  rec.update({ state: 'ended' })
  assert.equal(describeRun(root, 'run-1')?.status, 'idle', 'ended cleanly: drained and stopped')
  rec.update({ progress: { state: 'abandoned', since: 1 } })
  assert.equal(describeRun(root, 'run-1')?.status, null, 'ended with a turn cut off is not idle')
  rec.update({ progress: { state: 'in_turn', since: 1 } })
  assert.equal(describeRun(root, 'run-1')?.status, null, 'an ended run cannot be busy')
  // Running, but the process is gone: nobody knows what it is doing, whatever progress says.
  rec.update({ state: 'running', pid: 2 ** 22 - 1, progress: { state: 'in_turn', since: 1 } })
  assert.equal(describeRun(root, 'run-1')?.status, null)
})

test('#278 a run with no readable record describes as nothing, never as blanks', (t) => {
  const root = tempDir(t, 'conclave-run-meta')
  assert.equal(describeRun(root, 'run-9'), undefined)
})
