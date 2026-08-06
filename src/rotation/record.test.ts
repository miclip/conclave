/**
 * The mechanical half of a handoff, and the grading of what changed.
 *
 *   node --test src/rotation/record.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { blocking, capture, compare, runCheck } from './record.ts'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-record-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'work.ts'), 'export const answer = 42\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

const OPTS = (root: string) => ({ root, files: ['work.ts'], checks: ['exit 0'], checkTimeoutMs: 30_000 })

test('a capture records HEAD, the named files and the check results', () => {
  const dir = repo()
  const r = capture(OPTS(dir))
  assert.equal(r.head?.length, 40)
  assert.equal(r.files.length, 1)
  assert.ok(r.files[0]!.digest, 'an existing file must have a digest')
  assert.equal(r.checks[0]!.exitCode, 0)
})

test('an absent file is recorded as absent rather than skipped', () => {
  // The distinction matters at compare time: a file appearing between handoff and
  // acceptance is a divergence, and it can only be seen if absence was recorded.
  const dir = repo()
  const r = capture({ ...OPTS(dir), files: ['nope.ts'] })
  assert.deepEqual(r.files, [{ path: 'nope.ts', digest: null }])
})

test('a record compared against itself diverges in nothing', () => {
  const dir = repo()
  const r = capture(OPTS(dir))
  assert.deepEqual(compare(r, r), [])
})

test('a moved HEAD blocks the transfer', () => {
  const dir = repo()
  const before = capture(OPTS(dir))
  writeFileSync(join(dir, 'work.ts'), 'export const answer = 43\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'more'], { cwd: dir })

  const ds = compare(before, capture(OPTS(dir)))
  assert.ok(ds.some((d) => d.kind === 'head_moved' && d.severity === 'blocking'))
  assert.ok(ds.some((d) => d.kind === 'file_changed' && d.severity === 'blocking'))
})

test('a changed file named by the handoff blocks the transfer', () => {
  const dir = repo()
  const before = capture(OPTS(dir))
  writeFileSync(join(dir, 'work.ts'), 'export const answer = 0\n')

  const ds = compare(before, capture(OPTS(dir)))
  const changed = ds.find((d) => d.kind === 'file_changed')
  assert.ok(changed)
  assert.equal(changed.severity, 'blocking')
  assert.ok(changed.detail.includes('work.ts'))
})

test('a file appearing or vanishing is distinguished from one merely edited', () => {
  const dir = repo()
  const before = capture({ ...OPTS(dir), files: ['later.ts'] })
  writeFileSync(join(dir, 'later.ts'), 'export const x = 1\n')

  const ds = compare(before, capture({ ...OPTS(dir), files: ['later.ts'] }))
  assert.equal(ds.find((d) => d.kind === 'file_appeared')?.severity, 'blocking')
})

test('an unrelated dirty path is advisory, because the human shares this tree', () => {
  // Blocking here would make rotation depend on the operator sitting still, which is not
  // a property the design is willing to require.
  const dir = repo()
  const before = capture(OPTS(dir))
  writeFileSync(join(dir, 'operator-notes.md'), 'thinking out loud\n')

  const ds = compare(before, capture(OPTS(dir)))
  assert.deepEqual(blocking(ds), [])
  const tree = ds.find((d) => d.kind === 'tree_changed')
  assert.ok(tree)
  assert.ok(tree.detail.includes('operator-notes.md'))
})

test('a check whose exit code changed blocks; output alone is advisory', () => {
  const dir = repo()
  const before = capture({ ...OPTS(dir), checks: ['exit 0'] })

  // Same command string, different result. Simulated by rewriting the recorded exit code,
  // because the point under test is the comparison, not the shell.
  const flipped = { ...before, checks: [{ ...before.checks[0]!, exitCode: 1 }] }
  const ds = compare(flipped, before)
  assert.equal(ds.find((d) => d.kind === 'check_exit_changed')?.severity, 'blocking')

  const noisy = { ...before, checks: [{ ...before.checks[0]!, outputDigest: 'different' }] }
  const soft = compare(noisy, before)
  assert.deepEqual(blocking(soft), [])
  assert.equal(soft.find((d) => d.kind === 'check_output_changed')?.severity, 'advisory')
})

test('a recorded check that was not re-run blocks rather than passing by omission', () => {
  const dir = repo()
  const before = capture({ ...OPTS(dir), checks: ['exit 0'] })
  const observed = { ...before, checks: [] }
  const ds = compare(before, observed)
  assert.equal(ds.find((d) => d.kind === 'check_missing')?.severity, 'blocking')
})

test('output digests ignore durations, so a slower run is not a divergence', () => {
  const dir = repo()
  const fast = runCheck(dir, 'echo "ok in 12ms"', 30_000)
  const slow = runCheck(dir, 'echo "ok in 4823ms"', 30_000)
  assert.equal(fast.outputDigest, slow.outputDigest)
})

test('a command that cannot run has no exit code, rather than a plausible one', () => {
  // Recording 0 or 1 for an unrunnable check would let it compare equal to a pass or a
  // fail, which is the one thing a verification record must never do.
  const dir = repo()
  const r = runCheck(dir, 'sleep 5', 150)
  assert.equal(r.exitCode, null)
})
