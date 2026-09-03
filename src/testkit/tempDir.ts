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

  rmSync(canonicalTempTarget(issued, root), { recursive: true, force: true })
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

/** The async twin, for the two call sites that already await their directory. */
export async function tempDirAsync(t: TestContext, label = ''): Promise<string> {
  const root = realpathSync(tmpdir())
  const dir = await mkdtemp(join(root, `${TEMP_DIR_PREFIX}${sanitize(label)}`))
  t.after(() => cleanup(dir, root))
  return dir
}
