/**
 * The guard that would have prevented the operator sweeping a live participant's work
 * into an unrelated commit.
 *
 *   node --test src/workspace/sessionLock.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'
import { sessionDir } from './sessionRecord.ts'
import {
  acquire,
  appendParticipant,
  assertSafeToStage,
  guard,
  lockPath,
  read,
  release,
} from './sessionLock.ts'

function repo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-lock')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'tracked.txt'), 'original\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
    cwd: dir,
  })
  return dir
}

const PARTICIPANTS = [
  { id: 'advisor', agent: 'codex' },
  { id: 'implementer', agent: 'claude' },
]

test('a clean repo with no session reports nothing to guard against', (t) => {
  const dir = repo(t)
  const report = guard(dir)
  assert.equal(report.live, false)
  assert.equal(report.stale, false)
  assert.deepEqual(report.changedSinceStart, [])
  assert.doesNotThrow(() => assertSafeToStage(dir))
})

test('acquiring records who is live and what was already dirty', (t) => {
  const dir = repo(t)
  // Dirty before the session starts: this is the operator's own work, not a participant's.
  writeFileSync(join(dir, 'mine.txt'), 'operator edit\n')

  const lock = acquire(dir, PARTICIPANTS)
  assert.ok(existsSync(lockPath(dir)))
  assert.deepEqual(lock.participants, PARTICIPANTS)
  assert.ok(lock.treeAtStart.some((l) => l.includes('mine.txt')))

  const report = guard(dir)
  assert.equal(report.live, true)
  assert.deepEqual(
    report.changedSinceStart,
    [],
    'a file already dirty at session start is not a participant edit',
  )
})

test('changes made after the session started are surfaced as possible participant work', (t) => {
  const dir = repo(t)
  acquire(dir, PARTICIPANTS)
  writeFileSync(join(dir, 'theirs.txt'), 'implementer work in progress\n')

  const report = guard(dir)
  assert.deepEqual(report.changedSinceStart, ['theirs.txt'])
  assert.ok(report.messages.some((m) => m.includes('theirs.txt')))
})

test('staging broadly is refused while participants are live, and says why', (t) => {
  const dir = repo(t)
  acquire(dir, PARTICIPANTS)
  writeFileSync(join(dir, 'theirs.txt'), 'work in progress\n')

  assert.throws(() => assertSafeToStage(dir), (err: Error) => {
    // The message has to name the participants and the files, or the operator will
    // override it without knowing what they are overriding.
    assert.ok(/refusing a broad workspace mutation/.test(err.message))
    assert.ok(err.message.includes('implementer'))
    assert.ok(err.message.includes('theirs.txt'))
    return true
  })
})

test('releasing lets staging proceed again', (t) => {
  const dir = repo(t)
  acquire(dir, PARTICIPANTS)
  assert.throws(() => assertSafeToStage(dir))
  release(dir)
  assert.equal(existsSync(lockPath(dir)), false)
  assert.doesNotThrow(() => assertSafeToStage(dir))
})

test('a lock from a dead process is stale, not binding', (t) => {
  // The run that motivated this guard ended by crashing. A guard that refuses forever
  // after a crash gets deleted within a day, so a stale lock is reported and not obeyed.
  const dir = repo(t)
  acquire(dir, PARTICIPANTS)
  const raw = JSON.parse(readFileSync(lockPath(dir), 'utf8'))
  // A pid that cannot be running: process 0 is not addressable by kill(pid, 0) as a
  // normal process, and 2^31-1 is beyond any real pid.
  writeFileSync(lockPath(dir), JSON.stringify({ ...raw, pid: 2147483647 }))

  const found = read(dir)!
  assert.equal(found.stale, true)

  const report = guard(dir)
  assert.equal(report.live, false)
  assert.equal(report.stale, true)
  assert.ok(report.messages.some((m) => m.includes('crashed run')))
  assert.doesNotThrow(() => assertSafeToStage(dir), 'a crash must not block the repo forever')
})

test('a stale lock still reports the files, so they are accounted for rather than absorbed', (t) => {
  const dir = repo(t)
  acquire(dir, PARTICIPANTS)
  writeFileSync(join(dir, 'orphaned.txt'), 'left behind by the crashed run\n')
  const raw = JSON.parse(readFileSync(lockPath(dir), 'utf8'))
  writeFileSync(lockPath(dir), JSON.stringify({ ...raw, pid: 2147483647 }))

  const report = guard(dir)
  assert.deepEqual(report.changedSinceStart, ['orphaned.txt'])
})

test('a corrupt lock is ignored rather than crashing the guard', (t) => {
  const dir = repo(t)
  writeFileSync(join(dir, '.conclave-tmp'), '')
  acquire(dir, PARTICIPANTS)
  writeFileSync(lockPath(dir), 'not json at all')
  assert.equal(read(dir), undefined)
  assert.doesNotThrow(() => assertSafeToStage(dir))
})

const LATE = { id: 'reviewer', agent: 'codex' }

/** Rewrite the lock's pid, leaving every other field as `acquire` wrote it. */
function repoint(dir: string, pid: number): void {
  const raw = JSON.parse(readFileSync(lockPath(dir), 'utf8'))
  writeFileSync(lockPath(dir), JSON.stringify({ ...raw, pid }, null, 2))
}

test('a seat added mid-run joins the lock without disturbing what it already recorded', (t) => {
  const dir = repo(t)
  writeFileSync(join(dir, 'mine.txt'), 'operator edit\n')
  const before = acquire(dir, PARTICIPANTS)
  // Dirtied AFTER the session began, so a `treeAtStart` recomputed during the append would
  // differ from the one recorded. Without this the preservation check below passes against
  // an implementation that recomputes, because nothing has moved.
  writeFileSync(join(dir, 'theirs.txt'), 'implementer work in progress\n')

  const after = appendParticipant(dir, LATE)

  assert.deepEqual(after.participants, [...PARTICIPANTS, LATE])
  // The fields that make the guard's report mean anything. `treeAtStart` in particular:
  // rewriting it here would reclassify every path dirtied since the session began as
  // "already dirty", and `changedSinceStart` would go empty for the rest of the run.
  assert.equal(after.pid, before.pid)
  assert.equal(after.startedAt, before.startedAt)
  assert.deepEqual(after.treeAtStart, before.treeAtStart)
  assert.deepEqual(JSON.parse(readFileSync(lockPath(dir), 'utf8')), after)

  // The point of appending at all: the refusal now names the seat that arrived late.
  assert.throws(() => assertSafeToStage(dir), (err: Error) => {
    assert.ok(err.message.includes('reviewer'), 'a late seat must appear in the refusal')
    return true
  })
})

test('a lock owned by another live process is not ours to append to', (t) => {
  const dir = repo(t)
  acquire(dir, PARTICIPANTS)
  // `process.ppid` is a real, running process that is not us -- a second orchestrator, as
  // far as this file can tell. A fabricated pid would be caught by the staleness check
  // first and prove nothing about ownership.
  repoint(dir, process.ppid)
  const raw = readFileSync(lockPath(dir), 'utf8')

  assert.throws(() => appendParticipant(dir, LATE), (err: Error) => {
    assert.ok(/owned by pid/.test(err.message))
    assert.ok(err.message.includes(String(process.ppid)))
    return true
  })
  assert.equal(readFileSync(lockPath(dir), 'utf8'), raw, 'a refused append writes nothing')
})

test('a lock left by a crashed run is not resurrected by appending to it', (t) => {
  const dir = repo(t)
  acquire(dir, PARTICIPANTS)
  repoint(dir, 2147483647)
  const raw = readFileSync(lockPath(dir), 'utf8')

  assert.throws(() => appendParticipant(dir, LATE), (err: Error) => {
    // Diagnosed as stale, not as someone else's. A dead pid is also not ours, and
    // reporting it that way sends the operator hunting for a process that is gone.
    assert.ok(/stale session lock/.test(err.message))
    return true
  })
  assert.equal(readFileSync(lockPath(dir), 'utf8'), raw)
})

test('with no lock there is no session to join, and none is invented', (t) => {
  const dir = repo(t)
  assert.throws(() => appendParticipant(dir, LATE), (err: Error) => {
    assert.ok(/no session lock/.test(err.message))
    return true
  })
  assert.equal(existsSync(lockPath(dir)), false, 'the refusal must not leave a forged lock')
})

test('the lock is replaced by rename, so a reader gets the old file or the new one', (t) => {
  const dir = repo(t)
  acquire(dir, PARTICIPANTS)
  const p = lockPath(dir)
  const inodeBefore = statSync(p).ino

  appendParticipant(dir, LATE)

  // Truncate-then-write reuses the inode and leaves a window where the file on disk is
  // neither the old lock nor the new one. A rename into place cannot: the destination is a
  // different inode, and the name switches between two complete files in one step.
  assert.notEqual(statSync(p).ino, inodeBefore, 'the lock must be renamed into place')
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')).participants, [...PARTICIPANTS, LATE])
  assert.deepEqual(
    readdirSync(dirname(p)).filter((f) => f !== 'session.lock'),
    [],
    'no temporary file may be left beside the lock',
  )
})

/** A minimal status record on disk, which is where guard reads pause state from (#228). */
function writeStatus(dir: string, id: string, pid: number, pause?: { reason: string; at: number }): void {
  const d = sessionDir(dir, id)
  mkdirSync(d, { recursive: true })
  writeFileSync(
    join(d, 'status.json'),
    JSON.stringify({
      schema: 1,
      id,
      pid,
      cwd: dir,
      goal: 'Keep the work moving.',
      front: 'session',
      operator: 'agent',
      state: pause ? 'paused' : 'running',
      startedAt: Date.now() - 600_000,
      updatedAt: Date.now(),
      messages: 0,
      participants: [],
      ...(pause ? { pause: { reason: pause.reason, at: pause.at, detail: '', evidence: [], options: [], atSeq: 1 } } : {}),
    }),
  )
}

test('#228 guard says a run is PAUSED, not merely that its participants are live', (t) => {
  // "participants are live" was true of a run parked at a pause and true of one doing the work,
  // which made it useless to the reader who most needs it. Two sessions sat at
  // `implementer_unanswered` for hours -- one unnoticed, with four operator messages queued
  // behind it -- while guard reported them healthy the whole time.
  const dir = repo(t)
  const lock = acquire(dir, PARTICIPANTS)
  writeStatus(dir, '20260904-000000-1', lock.pid, { reason: 'implementer_unanswered', at: Date.now() - 125 * 60_000 })

  const report = guard(dir)
  assert.equal(report.live, true)
  const said = report.messages.join('\n')
  assert.match(said, /PAUSED, not working/)
  assert.match(said, /125 minutes/, 'how long it has been waiting, which is the actionable part')
  assert.match(said, /implementer_unanswered/, 'and what it is waiting on')
  // The advice that would have saved 3.5 hours: a bare message does not resolve a pause.
  assert.match(said, /a message on its own is queued/)
})

test('#228 a working run is not described as paused', (t) => {
  // The quiet default. A guard line on every healthy run is a line nobody reads.
  const dir = repo(t)
  const lock = acquire(dir, PARTICIPANTS)
  writeStatus(dir, '20260904-000000-2', lock.pid)
  const report = guard(dir)
  assert.equal(report.live, true)
  assert.doesNotMatch(report.messages.join('\n'), /PAUSED/)
})

test('#228 a pause belonging to an EARLIER run is not attributed to this one', (t) => {
  // `listSessions` orders by recency, so without the pid check a stale record from a previous
  // run would be read as the live run's state -- a false alarm is as bad as the silence.
  const dir = repo(t)
  const lock = acquire(dir, PARTICIPANTS)
  writeStatus(dir, '20260904-000000-3', lock.pid + 99_000, { reason: 'implementer_unanswered', at: Date.now() })
  const report = guard(dir)
  assert.doesNotMatch(report.messages.join('\n'), /PAUSED/)
})
