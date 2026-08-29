/**
 * The release script's refusals.
 *
 * Only the refusals, deliberately. The half that cuts a tag pushes to a remote, so exercising
 * it would mean either a fake remote elaborate enough to stop testing the thing, or a real
 * push. What IS worth pinning is every path that decides NOT to act -- because #182 is a
 * release step that reported success and did nothing, and a guard that silently passes is the
 * same defect wearing the opposite sign.
 *
 *   node --test src/release.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const REPO = realpathSync(join(import.meta.dirname, '..'))
const SCRIPT = join(REPO, 'scripts', 'release.sh')

function run(args: string[], cwd: string = REPO): { code: number; out: string } {
  const r = spawnSync('sh', [SCRIPT, ...args], { cwd, encoding: 'utf8' })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}

/**
 * A checkout that looks enough like the repo for the script to reach its own checks.
 *
 * `origin` is a real bare repository rather than omitted, because the preconditions run in
 * order and `git fetch origin` sits above the ones worth testing. Without a remote the script
 * dies at the fetch and every later refusal is unreachable -- which is how the tag test first
 * failed, reporting the dirty-tree refusal from the checkout the test was launched in.
 */
function fakeRepo(version = '9.9.9'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'conclave-release-')))
  const origin = realpathSync(mkdtempSync(join(tmpdir(), 'conclave-release-origin-')))
  execFileSync('git', ['init', '-q', '--bare', origin])
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }, null, 2))
  git('add', '.')
  git('commit', '-qm', 'init')
  git('remote', 'add', 'origin', origin)
  git('push', '-q', '-u', 'origin', 'main')
  return dir
}

test('#182 a version is required, and an unknown flag is refused rather than ignored', () => {
  // Exit 2 for usage, distinct from 1 for a refusal: a caller scripting this must be able to
  // tell "you asked wrongly" from "the tree is not ready".
  assert.equal(run([]).code, 2, 'no version is a usage error')
  assert.equal(run(['0.9.99', '--bogus']).code, 2, 'an unknown flag is a usage error')
  // Silently ignoring a misspelled --dry-run would cut a real release.
  assert.match(run(['0.9.99', '--bogus']).out, /unknown flag/)
})

test('#182 a tag that already exists is refused', () => {
  // In a fixture, not in this checkout: the preconditions run in order, and a working tree
  // with anything uncommitted in it refuses first. Asserting this against the live repo tests
  // whether the author happened to be mid-edit.
  const dir = fakeRepo('9.9.9')
  execFileSync('git', ['tag', 'v9.9.10'], { cwd: dir })
  const r = run(['9.9.10', '--dry-run'], dir)
  assert.equal(r.code, 1, 'cutting a tag that exists must be refused')
  assert.match(r.out, /already exists/)

  // And a version that does NOT exist gets past this guard, or the check would be a wall.
  assert.doesNotMatch(run(['9.9.11', '--dry-run'], dir).out, /already exists/)
})

test('#182 a dirty tree and a branch that is not main are both refused', () => {
  const dir = fakeRepo()
  writeFileSync(join(dir, 'scratch.txt'), 'uncommitted\n')
  const dirty = run(['0.9.99', '--dry-run'], dir)
  assert.equal(dirty.code, 1)
  assert.match(dirty.out, /uncommitted changes/)

  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'checkout', '-q', '-b', 'side'], { cwd: dir })
  execFileSync('git', ['checkout', '--', '.'], { cwd: dir })
  execFileSync('rm', ['-f', join(dir, 'scratch.txt')])
  const branch = run(['0.9.99', '--dry-run'], dir)
  assert.equal(branch.code, 1)
  assert.match(branch.out, /not on main/)
})

test('#182 the install checkout is not updated while a process is running from it', async () => {
  // THE refusal, and the reason the script exists in this shape. The symlink points at SOURCE,
  // and Node imports lazily -- so a checkout under a live run swaps the modules that run has
  // not reached yet, producing a process that is half one version and half another.
  //
  // Driven through the SCRIPT, with a `conclave` on PATH that resolves into the fixture. A
  // first version of this test ran `pgrep` itself in a subshell and asserted on that: it
  // passed, and went on passing with the script's guard deleted, because it never invoked it.
  // That is the defect this repo keeps finding -- a check verified by something that exercises
  // the path beside it.
  const dir = fakeRepo('9.9.9')
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(join(dir, 'bin', 'conclave.ts'), '// fixture\n')
  // Executable, or `command -v` skips it and the script resolves the REAL install instead --
  // which is how the first run of this test refused against the author's own checkout.
  chmodSync(join(dir, 'bin', 'conclave.ts'), 0o755)
  // Committed before the run: an untracked file is uncommitted work, and the script refuses
  // on that first. The fixture has to be a clean checkout to reach the guard under test.
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'bin'], { cwd: dir })
  execFileSync('git', ['tag', 'v9.9.9'], { cwd: dir })
  const binDir = realpathSync(mkdtempSync(join(tmpdir(), 'conclave-release-bin-')))
  symlinkSync(join(dir, 'bin', 'conclave.ts'), join(binDir, 'conclave'))
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` }

  const child = spawn('node', ['-e', 'setTimeout(() => {}, 10_000)', join(dir, 'bin', 'conclave.ts')], {
    stdio: 'ignore',
  })
  try {
    await new Promise((r) => setTimeout(r, 400))
    const busy = spawnSync('sh', [SCRIPT, '--install-only'], { cwd: dir, env, encoding: 'utf8' })
    assert.equal(busy.status, 1, 'a live process must stop the update')
    assert.match(`${busy.stdout}${busy.stderr}`, /refusing to update/)
    // Naming what is live is half the point: a refusal the operator cannot act on is a wall.
    assert.match(`${busy.stdout}${busy.stderr}`, new RegExp(`pid ${child.pid}\\b`), 'the pid is named')

    // --force is the escape hatch, and it must actually reach the update.
    const forced = spawnSync('sh', [SCRIPT, '--install-only', '--force'], { cwd: dir, env, encoding: 'utf8' })
    assert.match(`${forced.stdout}${forced.stderr}`, /--force was given/)
  } finally {
    child.kill()
  }

  // And it goes clear once the process is gone, or the guard would be a permanent refusal.
  await new Promise((r) => setTimeout(r, 700))
  const after = spawnSync('sh', [SCRIPT, '--install-only'], { cwd: dir, env, encoding: 'utf8' })
  assert.doesNotMatch(`${after.stdout}${after.stderr}`, /refusing to update/, 'a finished process must not block forever')
})

test('#182 a dry run executes nothing, and says what it would have done', () => {
  const state = () => ({
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
    tree: execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).trim(),
  })
  // Compared before and against after, NOT against clean. The repo this runs in usually has
  // the author's own work in it, and asserting a clean tree tests the author's habits rather
  // than the script -- it failed exactly that way when first written.
  const before = state()
  const r = run(['0.9.99', '--dry-run'])
  const after = state()
  assert.equal(after.head, before.head, 'a dry run must not commit')
  assert.equal(after.tree, before.tree, 'a dry run must not change what is modified')
  assert.ok(r.out.length > 0, 'and it must say something')
})

test('#182 a pure version bump is not a dependency move', () => {
  // Measured on the v0.5.12 release, which reported "the release moved a dependency" and ran a
  // needless `npm ci`. The first version counted changed lines and treated more than two as a
  // move, reasoning that two lines is the version string on both sides -- but package-lock.json
  // carries the version TWICE, at the root and under `packages[""]`, so a pure bump is four
  // lines and every release reinstalled for nothing.
  //
  // Asserted against the real diff between the last two tags, because that is the case that was
  // wrong and the one that recurs every release.
  const diff = execFileSync('git', ['diff', 'v0.5.11', 'v0.5.12', '--', 'package-lock.json'], {
    cwd: REPO,
    encoding: 'utf8',
  })
  const changed = diff.split('\n').filter((l) => /^[-+][^-+]/.test(l))
  assert.ok(changed.length > 2, `the bump must actually change lines, found ${changed.length}`)

  // The rule the script now uses: strip the version lines, and if anything is left, something
  // really moved. Nothing is left here, which is why this release needed no reinstall.
  const other = changed.filter((l) => !/^[-+]\s*"version":/.test(l))
  assert.deepEqual(other, [], 'a version bump alone must not read as a dependency move')
})
