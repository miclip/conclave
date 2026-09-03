/**
 * `conclave guard` at the CLI boundary.
 *
 * `sessionLock.test.ts` already covers the guard *function* thoroughly. What it cannot
 * see is the thing a caller actually gates on: the exit code the command hands back, and
 * whether the reasons reach stdout where an operator will read them. The whole point of
 * the subcommand is to be usable as `conclave guard && git add -A`, so the exit code is
 * the contract -- a guard that reported perfectly and always exited 0 would be silently
 * useless.
 *
 * These spawn the real entry point. `guard` resolves the repository from `process.cwd()`,
 * so a fixture can only be targeted via a spawned child's `cwd`.
 *
 *   node --test src/workspace/guardCli.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'
import { resolveRepoRoot } from '../config/install.ts'
import { acquire, lockPath, release } from './sessionLock.ts'

const CLI = join(resolveRepoRoot(import.meta.dirname), 'bin', 'conclave.ts')

const PARTICIPANTS = [
  { id: 'advisor', agent: 'codex' },
  { id: 'implementer', agent: 'claude' },
]

function repo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-guard-cli')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'tracked.txt'), 'original\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
    cwd: dir,
  })
  return dir
}

function runGuard(cwd: string, ...flags: string[]) {
  const r = spawnSync(process.execPath, [CLI, 'guard', ...flags], { cwd, encoding: 'utf8' })
  if (r.error) throw r.error
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

/** Rewrite the lock's pid to one that cannot be running, i.e. simulate a crashed run. */
function orphan(dir: string) {
  const raw = JSON.parse(readFileSync(lockPath(dir), 'utf8'))
  writeFileSync(lockPath(dir), JSON.stringify({ ...raw, pid: 2147483647 }))
}

test('guard exits non-zero while a participant session is live', (t) => {
  const dir = repo(t)
  // `acquire` stamps this test process's pid, which is by definition alive when the child
  // checks it -- so the child sees a genuinely live session, not a mocked one.
  acquire(dir, PARTICIPANTS)

  const { status, stdout } = runGuard(dir)

  assert.equal(status, 1, 'a live session must fail the command so it can gate a commit helper')
  assert.ok(
    stdout.includes('participants are live'),
    `the reason must reach stdout, got: ${stdout}`,
  )
  // Naming them matters: an operator who cannot see who is live will override the guard
  // without knowing whose work is at stake.
  assert.ok(stdout.includes('implementer'))
  assert.ok(stdout.includes('advisor'))
})

test('guard names the paths that appeared after the session started', (t) => {
  const dir = repo(t)
  writeFileSync(join(dir, 'mine.txt'), 'operator edit before the session\n')
  acquire(dir, PARTICIPANTS)
  writeFileSync(join(dir, 'theirs.txt'), 'implementer work in progress\n')

  const { status, stdout } = runGuard(dir)

  assert.equal(status, 1)
  assert.ok(stdout.includes('theirs.txt'), 'work in progress must be listed, not just counted')
  assert.ok(
    !stdout.includes('mine.txt'),
    'a file already dirty at session start is the operator\'s own, not a participant\'s',
  )
})

test('guard exits zero when no session is live', (t) => {
  const dir = repo(t)
  const { status, stdout } = runGuard(dir)

  assert.equal(status, 0)
  assert.ok(stdout.includes('no participant sessions are live'))
})

test('a crashed session is reported but does not fail the command', (t) => {
  // The deliberate asymmetry in the subcommand: live exits 1, stale exits 0. A guard that
  // refused forever after a crash would be deleted within a day, so the crash is surfaced
  // for accounting rather than made binding.
  const dir = repo(t)
  acquire(dir, PARTICIPANTS)
  writeFileSync(join(dir, 'orphaned.txt'), 'left behind by the crashed run\n')
  orphan(dir)

  const { status, stdout } = runGuard(dir)

  assert.equal(status, 0, 'a stale lock must not block the repository forever')
  assert.ok(stdout.includes('crashed run'))
  assert.ok(stdout.includes('orphaned.txt'), 'the orphaned files must still be accounted for')
})

test('--json prints the report as JSON and nothing else', (t) => {
  const dir = repo(t)
  acquire(dir, PARTICIPANTS)
  writeFileSync(join(dir, 'theirs.txt'), 'implementer work in progress\n')

  const { status, stdout } = runGuard(dir, '--json')

  // Parse the whole stream, not a substring: a stray prose line alongside valid JSON is
  // exactly the failure that makes a machine-readable mode useless.
  const report = JSON.parse(stdout)

  assert.equal(report.live, true)
  assert.equal(report.stale, false)
  assert.deepEqual(report.changedSinceStart, ['theirs.txt'])
  // Who is live is the part an operator acts on, so it must survive the format change.
  assert.deepEqual(
    report.session.participants.map((p: { id: string }) => p.id).sort(),
    ['advisor', 'implementer'],
  )
  assert.ok(report.messages.some((m: string) => m.includes('participants are live')))
  assert.equal(status, 1, 'a live session must still exit non-zero under --json')
})

test('--json reports a quiet repository without prose', (t) => {
  const dir = repo(t)
  const { status, stdout } = runGuard(dir, '--json')
  const report = JSON.parse(stdout)

  assert.equal(report.live, false)
  assert.equal(report.stale, false)
  assert.deepEqual(report.changedSinceStart, [])
  // `live: false, stale: false` IS the "no participant sessions are live" sentence. There
  // is deliberately no synthesised message, so a consumer branches on the booleans rather
  // than matching prose.
  assert.deepEqual(report.messages, [])
  assert.equal(status, 0)
})

test('--json carries the crashed-run asymmetry', (t) => {
  const dir = repo(t)
  acquire(dir, PARTICIPANTS)
  writeFileSync(join(dir, 'orphaned.txt'), 'left behind by the crashed run\n')
  orphan(dir)

  const { status, stdout } = runGuard(dir, '--json')
  const report = JSON.parse(stdout)

  assert.equal(report.stale, true)
  assert.equal(report.live, false)
  assert.deepEqual(report.changedSinceStart, ['orphaned.txt'])
  assert.ok(report.messages.some((m: string) => m.includes('crashed run')))
  assert.equal(status, 0, 'a stale lock must not block the repository under --json either')
})

test('the exit code is the same with and without --json', (t) => {
  const live = repo(t)
  acquire(live, PARTICIPANTS)
  assert.equal(runGuard(live).status, 1)
  assert.equal(runGuard(live, '--json').status, 1)

  const quiet = repo(t)
  assert.equal(runGuard(quiet).status, 0)
  assert.equal(runGuard(quiet, '--json').status, 0)
})

test('prose remains the default output', (t) => {
  const dir = repo(t)
  acquire(dir, PARTICIPANTS)

  const { status, stdout } = runGuard(dir)

  assert.throws(() => JSON.parse(stdout), 'the default output must not have become JSON')
  assert.ok(stdout.includes('participants are live'))
  assert.equal(status, 1)
})

test('a released session stops failing the command', (t) => {
  const dir = repo(t)
  acquire(dir, PARTICIPANTS)
  assert.equal(runGuard(dir).status, 1)

  release(dir)
  assert.equal(runGuard(dir).status, 0, 'the gate must reopen once the session ends')
})
