/**
 * The gate on `rm -rf`, and the promise that cleanup happens even when the test does not.
 *
 * Nothing in here creates a directory outside the temp root, and nothing shells out to `rm`.
 * A test suite for a deletion gate that itself deletes by hand in `$HOME` would be proving
 * one thing while doing the opposite: every fixture below lives inside a directory the
 * helper issued, and dies with it. Where a rule needs a temp root to be judged against, the
 * test supplies a FAKE root -- another issued directory -- rather than the real one.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, realpathSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import * as tempDirModule from './tempDir.ts'
import { TEMP_DIR_PREFIX, canonicalTempTarget, tempDir, tempDirAsync } from './tempDir.ts'

const ROOT = realpathSync(tmpdir())
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The shape of the module IS the safety property. A deletion function reachable from a test
 * takes its path from a caller, and a caller can be wrong; the point of this module is that
 * there is no such argument to get wrong. If an export ever appears here that removes
 * something, that reasoning is void and this test is where it says so.
 */
test('nothing exported can delete a caller-supplied path', () => {
  assert.deepEqual(Object.keys(tempDirModule).sort(), [
    'TEMP_DIR_PREFIX',
    'canonicalTempTarget',
    'suiteTempDir',
    'tempDir',
    'tempDirAsync',
  ])
})

test('the directory is deleted when the test that took it finishes', async (t) => {
  let taken = ''
  await t.test('inner', (inner) => {
    taken = tempDir(inner, 'ok')
    writeFileSync(join(taken, 'file.txt'), 'contents')
    assert.ok(existsSync(taken), 'the directory should exist while the test is running')
  })
  assert.equal(existsSync(taken), false, `${taken} should be gone once its test finished`)
})

test('the async twin cleans up the same way', async (t) => {
  let taken = ''
  await t.test('inner', async (inner) => {
    taken = await tempDirAsync(inner, 'ok-async')
    assert.ok(existsSync(taken))
  })
  assert.equal(existsSync(taken), false, `${taken} should be gone once its test finished`)
})

test('the name carries the prefix and the label, under the canonical temp root', (t) => {
  const dir = tempDir(t, 'Some Label!')
  assert.equal(dirname(realpathSync(dir)), ROOT)
  assert.match(realpathSync(dir).slice(ROOT.length + 1), new RegExp(`^${TEMP_DIR_PREFIX}some-label-`))
})

/**
 * The one that matters. Registering cleanup at the end of the test body would leak exactly
 * here, on the runs where a test blew up and left the most behind.
 */
test('a test that throws still loses its directory', () => {
  const fixture = join(HERE, 'throwingCleanup.fixture.ts')
  let stdout = ''
  let failed = false
  // `node --test` marks its children with NODE_TEST_CONTEXT, and a grandchild that inherits
  // it reports upward instead of to stdout and exits 0. Stripping it is what makes this a
  // plain run whose stdout and exit status mean what they say.
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  try {
    execFileSync(process.execPath, ['--test', fixture], { encoding: 'utf8', stdio: 'pipe', env })
  } catch (err) {
    failed = true
    stdout = (err as { stdout?: string }).stdout ?? ''
  }
  assert.ok(failed, 'the fixture is supposed to fail; if it passed, it is no longer the case under test')

  const match = /FIXTURE_TEMP_DIR=(.+)/.exec(stdout)
  assert.ok(match?.[1], `the fixture did not report its directory. stdout was:\n${stdout}`)
  const dir = match[1].trim()
  assert.equal(existsSync(dir), false, `${dir} survived a throwing test`)
})

/**
 * The module-scope twin of the throwing fixture. A `const` initialised at import time has no
 * `TestContext` to hang cleanup on, so the claim being checked is node's: a top-level `after`
 * runs once the file's tests are done.
 */
test('a directory taken at import time is gone when the file is done', () => {
  const fixture = join(HERE, 'suiteCleanup.fixture.ts')
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const stdout = execFileSync(process.execPath, ['--test', fixture], {
    encoding: 'utf8',
    stdio: 'pipe',
    env,
  })

  const match = /FIXTURE_SUITE_DIR=(.+)/.exec(stdout)
  assert.ok(match?.[1], `the fixture did not report its directory. stdout was:\n${stdout}`)
  const dir = match[1].trim()
  assert.equal(existsSync(dir), false, `${dir} survived the file that took it`)
})

test('a test that deleted its own directory is not an error', async (t) => {
  await t.test('inner', (inner) => {
    rmdirSync(tempDir(inner, 'self-cleaned'))
  })
})

/**
 * The swap. If cleanup resolved the issued path and removed what it found, a symlink left in
 * its place would aim `rm -rf` at the link's target. Unlinking removes the link and cannot
 * reach past it, so the target survives -- and `keep` is deliberately a directory the gate
 * would have ACCEPTED, so a resolving cleanup really would destroy it.
 */
test('an issued path replaced by a symlink is unlinked, and its target survives', async (t) => {
  const keep = tempDir(t, 'keep')
  writeFileSync(join(keep, 'evidence.txt'), 'still here')

  let issued = ''
  await t.test('inner', (inner) => {
    issued = tempDir(inner, 'swapped')
    rmdirSync(issued)
    symlinkSync(keep, issued)
  })

  assert.ok(existsSync(join(keep, 'evidence.txt')), 'the link target must not have been followed')
  assert.throws(() => lstatSync(issued), { code: 'ENOENT' }, 'the link itself should be gone')
})

test('an issued path replaced by a dangling symlink does not leak', async (t) => {
  let issued = ''
  await t.test('inner', (inner) => {
    issued = tempDir(inner, 'dangling')
    rmdirSync(issued)
    symlinkSync(join(issued, 'never-existed'), issued)
  })

  assert.throws(() => lstatSync(issued), { code: 'ENOENT' }, 'the dangling link should be gone')
})

test('the gate refuses anything that is not under the root it is given', (t) => {
  const fakeRoot = realpathSync(tempDir(t, 'fake-root'))
  const elsewhere = tempDir(t, 'elsewhere')

  assert.throws(() => canonicalTempTarget(elsewhere, fakeRoot), /not a direct child of the temp root/)
  assert.ok(existsSync(elsewhere), 'refusing means refusing, and the validator deletes nothing anyway')
})

test('the gate refuses the filesystem root and the root it is given', (t) => {
  const fakeRoot = realpathSync(tempDir(t, 'fake-root'))

  assert.throws(() => canonicalTempTarget('/', fakeRoot), /refusing to remove/)
  assert.throws(() => canonicalTempTarget(fakeRoot, fakeRoot), /refusing to remove/)
})

/**
 * A lookalike is a path that passes the check a careless implementation would write. Each of
 * these defeats one, and each has its own test so that a rule going missing names itself.
 */
test('the gate refuses a grandchild of the root, prefix or no prefix', (t) => {
  const fakeRoot = realpathSync(tempDir(t, 'fake-root'))
  const child = join(fakeRoot, `${TEMP_DIR_PREFIX}child`)
  const grandchild = join(child, `${TEMP_DIR_PREFIX}nested`)
  mkdirSync(grandchild, { recursive: true })

  assert.throws(() => canonicalTempTarget(grandchild, fakeRoot), /not a direct child/)
})

test('the gate refuses a direct child whose name does not carry the prefix', (t) => {
  const fakeRoot = realpathSync(tempDir(t, 'fake-root'))
  // A fixed name is unique enough: `fakeRoot` is itself a fresh directory owned by this
  // test, so nothing else can be writing into it.
  const unprefixed = join(fakeRoot, 'notours-child')
  mkdirSync(unprefixed)

  assert.throws(() => canonicalTempTarget(unprefixed, fakeRoot), /does not carry the/)
})

test('the gate refuses a name that merely contains the prefix', (t) => {
  const fakeRoot = realpathSync(tempDir(t, 'fake-root'))
  const inside = join(fakeRoot, `x-${TEMP_DIR_PREFIX}child`)
  mkdirSync(inside)

  assert.throws(() => canonicalTempTarget(inside, fakeRoot), /does not carry the/)
})

test('the gate refuses a path that leaves the root through a symlink', (t) => {
  const fakeRoot = realpathSync(tempDir(t, 'fake-root'))
  const beyond = tempDir(t, 'beyond')
  // Correctly placed and correctly named, and yet a step outside the root once resolved.
  const link = join(fakeRoot, `${TEMP_DIR_PREFIX}escape`)
  symlinkSync(beyond, link)

  assert.throws(() => canonicalTempTarget(link, fakeRoot), /not a direct child/)
  assert.ok(existsSync(beyond))
})

/**
 * `tmpdir()` is read from TMPDIR on every call, so a test that moves TMPDIR would otherwise
 * make its own cleanup unrecognisable to the gate. The root is captured when the directory
 * is made, and that is what the deletion is judged against.
 */
test('the temp root is pinned at creation, so a test may move TMPDIR', async (t) => {
  const before = process.env.TMPDIR
  t.after(() => {
    if (before === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = before
  })

  let taken = ''
  await t.test('inner', (inner) => {
    taken = tempDir(inner, 'pinned')
    const elsewhere = join(taken, 'nested')
    mkdirSync(elsewhere)
    process.env.TMPDIR = elsewhere
    assert.notEqual(realpathSync(tmpdir()), ROOT, 'the move should have taken effect')
  })

  assert.equal(existsSync(taken), false, `${taken} should be gone despite TMPDIR having moved`)
})
