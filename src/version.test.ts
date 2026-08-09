/**
 * Build identity: what `conclave version` reports.
 *
 * The function under test is the one shared between the CLI and the console banner. It must
 * be exact enough to identify a checkout, but it must not fail or hallucinate a commit when the
 * tree is a release archive with no `.git`.
 *
 * Each case runs the function in a fresh directory, not in the workspace import, because the
 * module resolves its own package.json and git state relative to `import.meta.dirname`. A test
 * that called the imported function directly would always test the workspace, not the case it
 * claims to be testing.
 *
 *   node --test src/version.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const REPO = realpathSync(join(import.meta.dirname, '..'))

/** A temp directory with the same package.json + version.ts layout, and no git. */
function releaseTree(version: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'conclave-version-release-')))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }))
  // Copy the module itself so its `import.meta.dirname` points inside the temp tree.
  writeFileSync(join(dir, 'src', 'version.ts'), readFileSync(join(REPO, 'src', 'version.ts')))
  return dir
}

/** A temp directory with the same layout, initialised as a git checkout. */
function checkout(version: string): string {
  const dir = releaseTree(version)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

/** Run the function in a fresh process so it resolves paths relative to the given directory. */
function versionIn(dir: string): string {
  const script = `
import { version } from './src/version.ts'
console.log(version())
`
  const r = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: dir,
    encoding: 'utf8',
  })
  if (r.error) throw r.error
  assert.equal(r.status, 0, `version() must not throw in ${dir}:\n${r.stderr}`)
  return r.stdout.trim()
}

/**
 * A clean checkout: the exact commit is knowable, so it is reported alongside the package
 * version. A plain version number alone is not enough for a working tree that can move after
 * the release tag.
 */
test('a checkout reports its package version and short commit', () => {
  const dir = checkout('9.9.9')
  const v = versionIn(dir)
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()

  assert.match(v, /^9\.9\.9 \([0-9a-f]+\)$/, `checkout version must be "version (commit)", got: ${v}`)
  assert.ok(v.includes(commit), `version must include the exact short commit ${commit}: ${v}`)
  assert.ok(!v.includes('-dirty'), `a clean checkout must not report dirty: ${v}`)
})

/**
 * A dirty checkout: the commit is still the nearest recorded point, but the tree has
 * uncommitted changes. Reporting the commit alone would claim the checkout is exactly that
 * commit, which is false; the `-dirty` suffix is the difference between exact and close.
 */
test('a dirty checkout appends -dirty to the reported identity', () => {
  const dir = checkout('9.9.9')
  writeFileSync(join(dir, 'marker.txt'), 'changed')

  const v = versionIn(dir)
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()

  assert.match(v, /^9\.9\.9 \([0-9a-f]+-dirty\)$/, `dirty version must be "version (commit-dirty)", got: ${v}`)
  assert.ok(v.includes(`${commit}-dirty`), `version must include the dirty commit identity: ${v}`)
})

/**
 * A release tree: there is no git history at all. The package version is the whole truth, so
 * the function must return it and must not fail or invent a commit hash. The previous bug
 * here was a working tree that reported only the tag; the release case is the inverse: it
 * must not try to report what it does not have.
 */
test('a release tree with no git returns only the package version', () => {
  const dir = releaseTree('1.2.3')
  const v = versionIn(dir)

  assert.equal(v, '1.2.3', `release tree must return only the package version, got: ${v}`)
  assert.ok(!/\([0-9a-f]/.test(v), `release tree must not include a commit: ${v}`)
  assert.ok(!v.includes('-dirty'), `release tree must not report dirty: ${v}`)
})

/**
 * A tree that happens to live inside some other repository, but is not the top-level of its
 * own. The old implementation used `git rev-parse HEAD` and would borrow the containing repo's
 * identity; the current one guards against that by comparing `--show-toplevel` to the install
 * root.
 */
test('a non-checkout inside another git repo returns only the package version', () => {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'conclave-version-outer-')))
  execFileSync('git', ['init', '-q'], { cwd: outer })
  // Put the release tree INSIDE the outer repo so git is reachable from the install root.
  const dir = join(outer, 'nested', 'conclave')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '4.5.6' }))
  writeFileSync(join(dir, 'src', 'version.ts'), readFileSync(join(REPO, 'src', 'version.ts')))
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: outer })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'outer'], { cwd: outer })

  const v = versionIn(dir)
  assert.equal(v, '4.5.6', `a non-checkout inside another repo must not borrow that repo's commit: ${v}`)
})

/**
 * A checkout whose top-level does not match the realpath of the install root: the install is
 * reached through a symlink, and the repository root resolves elsewhere. The function must not
 * misidentify the working tree.
 */
test('a checkout reached through a symlink still reports its own commit', () => {
  const dir = checkout('7.8.9')
  const link = join(tmpdir(), `conclave-version-link-${Date.now()}`)
  symlinkSync(dir, link)
  const v = versionIn(link)

  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  assert.match(v, /^7\.8\.9 \([0-9a-f]+\)$/, `symlinked checkout version must be "version (commit)", got: ${v}`)
  assert.ok(v.includes(commit), `symlinked checkout must include the real commit ${commit}: ${v}`)
})
