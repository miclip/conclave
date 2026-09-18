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
import { execFileSync, spawn } from 'node:child_process'
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
    // #211. Takes a LABEL, not a path: it calls `suiteTempDir` for a directory this module
    // issued and points `TMPDIR` at it, so the only thing it can cause to be deleted is
    // something this module made. The safety argument above survives it.
    'containAdapterRunDirs',
    'suiteTempDir',
    'tempDir',
    'tempDirAsync',
  ])
})

/**
 * Every "gone once its test finished" claim below is made from the PARENT's `t.after`, not from
 * the line after `await t.test(...)`. Node 24.0.2 -- the floor CI runs -- made `t.test()` return
 * `undefined` (upstream #56664; later 24.x restored the promise), so on that runtime the await is
 * a no-op and the child's cleanup has not run yet when the next line executes. A parent's `after`
 * hooks run once its subtests have completed and run their own hooks, on both semantics, so that
 * is the one place the claim is true everywhere. The `await` stays because it is still right
 * where it means something; it is just not what the assertion rests on.
 *
 * Each hook also checks the child actually ran: with `taken` still `''`, `existsSync('')` is
 * `false` and the test would pass having tested nothing. That is exactly how the async twin
 * passed on 24.0.2 before this was written.
 */
test('the directory is deleted when the test that took it finishes', async (t) => {
  let taken = ''
  t.after(() => {
    assert.notEqual(taken, '', 'the child test ran')
    assert.equal(existsSync(taken), false, `${taken} should be gone once its test finished`)
  })
  await t.test('inner', (inner) => {
    taken = tempDir(inner, 'ok')
    writeFileSync(join(taken, 'file.txt'), 'contents')
    assert.ok(existsSync(taken), 'the directory should exist while the test is running')
  })
})

test('the async twin cleans up the same way', async (t) => {
  let taken = ''
  t.after(() => {
    assert.notEqual(taken, '', 'the child test ran')
    assert.equal(existsSync(taken), false, `${taken} should be gone once its test finished`)
  })
  await t.test('inner', async (inner) => {
    taken = await tempDirAsync(inner, 'ok-async')
    assert.ok(existsSync(taken))
  })
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
  let keep = ''
  let issued = ''
  // Registered BEFORE `keep` is taken. `after` hooks run in registration order, and `tempDir`
  // registers `keep`'s own deletion; this has to look at the evidence while it is still there.
  t.after(() => {
    assert.notEqual(issued, '', 'the child test ran')
    assert.ok(existsSync(join(keep, 'evidence.txt')), 'the link target must not have been followed')
    assert.throws(() => lstatSync(issued), { code: 'ENOENT' }, 'the link itself should be gone')
  })

  keep = tempDir(t, 'keep')
  writeFileSync(join(keep, 'evidence.txt'), 'still here')

  await t.test('inner', (inner) => {
    issued = tempDir(inner, 'swapped')
    rmdirSync(issued)
    symlinkSync(keep, issued)
  })
})

test('an issued path replaced by a dangling symlink does not leak', async (t) => {
  let issued = ''
  t.after(() => {
    assert.notEqual(issued, '', 'the child test ran')
    assert.throws(() => lstatSync(issued), { code: 'ENOENT' }, 'the dangling link should be gone')
  })
  await t.test('inner', (inner) => {
    issued = tempDir(inner, 'dangling')
    rmdirSync(issued)
    symlinkSync(join(issued, 'never-existed'), issued)
  })
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
  // After the restore above, in registration order; the claim does not depend on TMPDIR either way.
  t.after(() => {
    assert.notEqual(taken, '', 'the child test ran')
    assert.equal(existsSync(taken), false, `${taken} should be gone despite TMPDIR having moved`)
  })
  await t.test('inner', (inner) => {
    taken = tempDir(inner, 'pinned')
    const elsewhere = join(taken, 'nested')
    mkdirSync(elsewhere)
    process.env.TMPDIR = elsewhere
    assert.notEqual(realpathSync(tmpdir()), ROOT, 'the move should have taken effect')
  })
})

/**
 * The #222 race, staged (#327). Cleanup's recursive walk lists the directory, unlinks what it
 * found, and calls `rmdir`; a child that writes a file between the listing and the `rmdir`
 * earns an ENOTEMPTY, and `maxRetries: 0` would make that the end of it. The fixture arranges
 * to be that child on purpose -- how is documented at the top of it -- and this test only has
 * to line the two up.
 *
 * The lining up is the hook order. `tempDir` registers cleanup FIRST; the hook below, which
 * waits for the child, is registered second and so runs second, after cleanup has already
 * raced the still-live child. (A comment here once claimed the opposite, that `after` hooks
 * ran LIFO and the race was therefore unstageable. It was wrong, and the test two below pins
 * the order it actually is.)
 *
 * What passing proves: cleanup did not throw, so the retry covered the ENOTEMPTY -- with
 * `maxRetries` mutated to 0 this fails on both Node versions CI runs, every time. The `WROTE`
 * check is what keeps it from being vacuous: a child that wrote nothing before the directory
 * went never overlapped the walk, and a green from that would be a green for nothing -- so
 * that outcome is reported as a SKIP with the reason, not as a pass.
 *
 * What it does not prove: that the retry is well-timed. Node's `rmSync` on POSIX truncates
 * `retryDelay` to whole seconds (#328), so the five retries here run back-to-back; the test
 * passes because the child's burst is over before the walk reaches the top, which the chain's
 * depth arranges. A slower child on a loaded runner narrows that margin -- measured at
 * 25ms+ on APFS and 10ms+ on ext4 against a burst of about 1ms.
 */
test('#222 cleanup outlives a child still writing when the walk reaches the top', async (t) => {
  const dir = tempDir(t, 'late-writer')

  let stdout = ''
  let stderr = ''
  const child = spawn(process.execPath, [join(HERE, 'lateWriter.fixture.ts'), dir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk))
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk))
  const closed = new Promise<number | null>((resolve) => child.on('close', resolve))

  // Registered AFTER cleanup, so it runs after cleanup: by the time this looks, the walk and
  // the child have already met.
  t.after(async () => {
    const code = await closed
    const report = /^WROTE (\d+)( then (\w+))?$/m.exec(stdout)
    assert.ok(report, `the child never reported. exit ${code}; stdout:\n${stdout}\nstderr:\n${stderr}`)
    assert.equal(existsSync(dir), false, `${dir} survived cleanup`)
    const [line, written, , stoppedBy] = report
    if (written === '0' && stoppedBy) {
      // The walk finished before the child's first write landed. Nothing went wrong, and
      // nothing was proved either: a pass here would be a pass for a race that never ran.
      // Seen on tmpfs, where the unwind is a millisecond and one scheduling hiccup is enough.
      t.skip(`the walk finished first (${line.trim()}): the race was not staged this run`)
      return
    }
    assert.ok(Number(written) >= 1, `the child wrote nothing (${line.trim()}), so the race was not staged`)
  })

  await new Promise<void>((resolve, reject) => {
    const check = () => {
      if (stdout.includes('LISTENING\n')) resolve()
    }
    child.stdout.on('data', check)
    child.on('close', (code) => reject(new Error(`the fixture exited (${code}) before it was listening:\n${stderr}`)))
    check()
  })
})

/**
 * The part that WAS reachable before the race was, kept because it is cheap and independent:
 * the retry options do not break ordinary cleanup of a directory with something in it.
 */
test('#222 a populated directory is still removed, retries and all', (t) => {
  const dir = tempDir(t, 'populated')
  mkdirSync(join(dir, 'nested', 'deeper'), { recursive: true })
  writeFileSync(join(dir, 'nested', 'deeper', 'file.txt'), 'content')
  // Cleanup runs in t.after; a throw there fails this test, so passing IS the assertion.
  assert.ok(existsSync(join(dir, 'nested', 'deeper', 'file.txt')))
})

/**
 * What the symlink test, the TMPDIR test and the #222 test above all rest on, pinned where it
 * can fail (#327): `after` hooks run in the order they were registered. A comment in this file
 * said LIFO, and a test was written off on the strength of it. Node's `test.md` for 24.13.1
 * does not state the order either way, which is exactly why this is a test and not a comment.
 */
test('`after` hooks run in registration order', (t) => {
  const ran: string[] = []
  t.after(() => {
    ran.push('registered first')
  })
  t.after(() => {
    ran.push('registered second')
    assert.deepEqual(ran, ['registered first', 'registered second'])
  })
})
