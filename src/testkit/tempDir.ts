/**
 * One place where a test asks for a scratch directory, and one place where one is deleted.
 *
 * The suite creates 154 temp directories across 91 files and deletes barely half of them,
 * so the leak is real. But the fix carries a worse hazard than the leak: cleanup is `rm -rf`,
 * and an `rm -rf` pointed at a path that came out wrong deletes something that was not
 * scratch. So the module is shaped to make that impossible rather than merely unlikely:
 *
 *   NOTHING EXPORTED HERE DELETES ANYTHING. The only code that removes a directory is
 *   private, and both of its inputs -- the path and the temp root it is judged against --
 *   are captured by this module at creation. Neither can be supplied by a caller, so there
 *   is no argument a caller can get wrong.
 *
 * `canonicalTempTarget` is exported because the rules are worth testing directly, but it is
 * a validator: it returns a path or throws, and it never touches the filesystem except to
 * resolve. Resolving is the point -- a symlink named like ours, sitting in the right place,
 * pointing at a home directory, passes every check that works on strings.
 */

import { lstatSync, mkdtempSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { after } from 'node:test'
import type { TestContext } from 'node:test'

/**
 * The mark of a directory this module made. Deletion requires it, so a name without it is
 * something somebody else owns and is not ours to remove.
 */
export const TEMP_DIR_PREFIX = 'conclave-t-'

/** Labels become part of a filesystem name, so only what is safe there survives. */
function sanitize(label: string): string {
  const safe = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return safe ? `${safe}-` : ''
}

/**
 * The gate: the canonical path that may be removed, or a throw saying why it may not.
 *
 * Read-only. It is exported so the two rules can be put under test one at a time, and it is
 * safe to export precisely because it deletes nothing -- the worst a wrong argument earns is
 * a wrong answer to a question.
 */
export function canonicalTempTarget(dir: string, root: string): string {
  // Resolving first means every later question is asked about the real directory, not about
  // whatever a symlink, `..`, or a duplicated separator made the string look like.
  const target = realpathSync(dir)

  if (dirname(target) !== root) {
    throw new Error(
      `refusing to remove ${target}: not a direct child of the temp root ${root} (from ${dir})`,
    )
  }
  if (!basename(target).startsWith(TEMP_DIR_PREFIX)) {
    throw new Error(
      `refusing to remove ${target}: basename does not carry the ${TEMP_DIR_PREFIX} prefix`,
    )
  }
  return target
}

/**
 * How hard cleanup tries before a failure is real (#222).
 *
 * Five linear-backoff retries is roughly a second in total, which is far longer than a process
 * takes to finish flushing and far shorter than anyone waits for a suite. The number is not
 * load-bearing: what matters is that the first ENOTEMPTY is not the answer.
 */
const CLEANUP_RETRIES = 5
const CLEANUP_RETRY_MS = 20

/**
 * Remove a directory this module issued. Private, and both arguments come from the closure
 * built at creation, so there is no call site that can point it somewhere else.
 *
 * A path that is already gone is not an error: a test is allowed to clean up after itself,
 * and the hook still runs. Anything that survives to the gate and fails it throws, which
 * inside `t.after` fails the test loudly. That is the intended outcome -- a cleanup pointed
 * at the wrong place should be a red suite, not a quiet deletion.
 */
function cleanup(issued: string, root: string): void {
  let entry
  try {
    entry = lstatSync(issued)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }

  // A symlink is never what this module issued, so a test has put one here. Unlinking it
  // removes the link and cannot reach what it points at, which makes this both the safe
  // answer and the only possible one: a dangling link has no canonical form to check.
  if (entry.isSymbolicLink()) {
    unlinkSync(issued)
    return
  }

  const target = canonicalTempTarget(issued, root)
  try {
    rmSync(target, {
      recursive: true,
      force: true,
      // RETRIED, because `force` does not cover this and cannot (#222). It suppresses ENOENT;
      // ENOTEMPTY means the directory gained an entry BETWEEN the walk that listed it and the
      // rmdir that removed it, which is a child still writing on its way out. Node retries
      // exactly this set -- EBUSY, EMFILE, ENFILE, ENOTEMPTY, EPERM -- with a linear backoff,
      // so the standard mechanism is the whole fix and a hand-rolled loop would only be a
      // second thing to get wrong.
      maxRetries: CLEANUP_RETRIES,
      retryDelay: CLEANUP_RETRY_MS,
    })
  } catch (err) {
    // NAMED AS CLEANUP. Thrown bare from inside `t.after`, an ENOTEMPTY is attributed to the
    // test that owned the directory: on CI it read as "a one-seat console reserves the four rows
    // it always did" failing, which is a claim about the product and sent a reader to console
    // code that had nothing to do with it. The rethrow keeps the failure -- a cleanup pointed at
    // the wrong place must still be a red suite -- and only says whose failure it is.
    const e = err as NodeJS.ErrnoException
    throw new Error(
      `temp-dir cleanup failed for ${target} (${e.code ?? 'unknown'}) after ${CLEANUP_RETRIES} retries. ` +
        `This is the SUITE's scratch directory, not the code under test: a child of this test was ` +
        `probably still writing as it exited. The assertions in the test itself passed or failed ` +
        `before this ran.`,
      { cause: err },
    )
  }
}

/**
 * A scratch directory that is deleted when `t` finishes, whether it passed, failed, or threw.
 *
 * `label` is a hint for a human reading `/tmp` during a wedged run; it is not an identity.
 */
export function tempDir(t: TestContext, label = ''): string {
  // Captured, not read again at cleanup: `tmpdir()` re-reads TMPDIR on every call, and a
  // test that moves TMPDIR would otherwise make its own directory unrecognisable.
  const root = realpathSync(tmpdir())
  const dir = mkdtempSync(join(root, `${TEMP_DIR_PREFIX}${sanitize(label)}`))
  t.after(() => cleanup(dir, root))
  return dir
}

/**
 * The same directory, for a fixture a file builds once at import time rather than per test.
 *
 * `after` from `node:test` is the only cleanup point a module-scope `const` can reach: there
 * is no test running when it is initialised, so there is no `TestContext` to hang it on.
 *
 * Prefer `tempDir`. This one holds its directory for the length of the file, so two tests
 * sharing it are not isolated from each other's mess -- which is the right trade only when
 * the fixture is genuinely built once, and the wrong one everywhere else.
 */
export function suiteTempDir(label = ''): string {
  const root = realpathSync(tmpdir())
  const dir = mkdtempSync(join(root, `${TEMP_DIR_PREFIX}${sanitize(label)}`))
  after(() => cleanup(dir, root))
  return dir
}

/**
 * Contain every run directory the adapters booted by THIS FILE make for themselves (#211).
 *
 * An adapter takes a `mkdtemp` under `os.tmpdir()` at boot. Since #203 it gives that back on
 * close, so this is no longer the only thing standing between the suite and a scattered
 * `$TMPDIR` -- but it is still what covers the cases close does not: a boot that throws before
 * anything can call close, and the one run that deliberately KEEPS its directory because its
 * attempts journal was named to the operator.
 *
 * `tmpdir()` re-reads `TMPDIR` on every call, so pointing it at a directory the testkit issued
 * puts everything booted here inside something whose lifetime the helper already owns.
 *
 * PER FILE, which is what makes it safe rather than a shared global: every test file runs in its
 * own process under `node --test`, so this reaches no other suite, and tests within the file
 * stay isolated exactly as before -- `tempDir` still hands each its own uniquely named child.
 *
 * It was two lines copied into fourteen files, and a fifteenth file that booted an adapter and
 * forgot them would have leaked with nothing failing. `adapterContainment.test.ts` is the half
 * that catches the forgetting; this is the half that makes it one call to remember.
 */
export function containAdapterRunDirs(label = 'adapter-run-root'): string {
  const root = suiteTempDir(label)
  process.env['TMPDIR'] = root
  return root
}

/** The async twin, for the two call sites that already await their directory. */
export async function tempDirAsync(t: TestContext, label = ''): Promise<string> {
  const root = realpathSync(tmpdir())
  const dir = await mkdtemp(join(root, `${TEMP_DIR_PREFIX}${sanitize(label)}`))
  t.after(() => cleanup(dir, root))
  return dir
}
