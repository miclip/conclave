/**
 * The guard that would have prevented the operator sweeping a live participant's work
 * into an unrelated commit.
 *
 *   node --test src/workspace/sessionLock.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acquire, assertSafeToStage, guard, lockPath, read, release } from './sessionLock.ts'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-lock-'))
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

test('a clean repo with no session reports nothing to guard against', () => {
  const dir = repo()
  const report = guard(dir)
  assert.equal(report.live, false)
  assert.equal(report.stale, false)
  assert.deepEqual(report.changedSinceStart, [])
  assert.doesNotThrow(() => assertSafeToStage(dir))
})

test('acquiring records who is live and what was already dirty', () => {
  const dir = repo()
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

test('changes made after the session started are surfaced as possible participant work', () => {
  const dir = repo()
  acquire(dir, PARTICIPANTS)
  writeFileSync(join(dir, 'theirs.txt'), 'implementer work in progress\n')

  const report = guard(dir)
  assert.deepEqual(report.changedSinceStart, ['theirs.txt'])
  assert.ok(report.messages.some((m) => m.includes('theirs.txt')))
})

test('staging broadly is refused while participants are live, and says why', () => {
  const dir = repo()
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

test('releasing lets staging proceed again', () => {
  const dir = repo()
  acquire(dir, PARTICIPANTS)
  assert.throws(() => assertSafeToStage(dir))
  release(dir)
  assert.equal(existsSync(lockPath(dir)), false)
  assert.doesNotThrow(() => assertSafeToStage(dir))
})

test('a lock from a dead process is stale, not binding', () => {
  // The run that motivated this guard ended by crashing. A guard that refuses forever
  // after a crash gets deleted within a day, so a stale lock is reported and not obeyed.
  const dir = repo()
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

test('a stale lock still reports the files, so they are accounted for rather than absorbed', () => {
  const dir = repo()
  acquire(dir, PARTICIPANTS)
  writeFileSync(join(dir, 'orphaned.txt'), 'left behind by the crashed run\n')
  const raw = JSON.parse(readFileSync(lockPath(dir), 'utf8'))
  writeFileSync(lockPath(dir), JSON.stringify({ ...raw, pid: 2147483647 }))

  const report = guard(dir)
  assert.deepEqual(report.changedSinceStart, ['orphaned.txt'])
})

test('a corrupt lock is ignored rather than crashing the guard', () => {
  const dir = repo()
  writeFileSync(join(dir, '.conclave-tmp'), '')
  acquire(dir, PARTICIPANTS)
  writeFileSync(lockPath(dir), 'not json at all')
  assert.equal(read(dir), undefined)
  assert.doesNotThrow(() => assertSafeToStage(dir))
})
