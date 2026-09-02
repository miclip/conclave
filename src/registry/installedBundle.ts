/**
 * Finding the program a claim is ABOUT, so the claim can be checked against it rather than
 * against a comment.
 *
 * Two guards in this tree assert that a name we hand another CLI is a name that CLI still
 * knows: the hook events an adapter registers (`src/adapters/hookEventNames.test.ts`) and the
 * slash commands a command policy declares (`./commandPolicy.test.ts`). Both need the same
 * thing first -- the bytes of the installed executable -- and neither can get it from
 * `findExecutable` alone, because what is on PATH is frequently a launcher rather than the
 * program. This is that lookup, extracted once, because a second copy of a resolver is how the
 * two copies stop agreeing.
 *
 * What it deliberately does NOT do is decide anything. It returns the bytes or it returns why
 * it has none, and the caller reports the second as a SKIP: "we could not locate the program"
 * and "the program lacks this name" must never arrive at the same answer.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { findExecutable } from './executables.ts'

/**
 * A wrapper script passes `findExecutable` by construction -- that is deliberate there, and
 * wrong here, because a 200-byte shim contains none of the strings we are looking for and would
 * report every name as missing. Anything this small is treated as not-the-bundle and skipped,
 * which is the honest answer: we did not find the program, so we are not claiming anything
 * about it.
 */
export const MIN_BUNDLE_BYTES = 1_000_000

/**
 * A literal no CLI ships. If this is ever "found", the search matches anything and every
 * assertion made through this module is vacuous, so each caller looks for it first.
 */
export const ABSENT_LITERAL_CANARY = 'ConclaveNoSuchLiteralInAnyBundle'

function safeReaddir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
}

function descend(dir: string, name: string, depth: number): string | undefined {
  if (depth < 0) return undefined
  const entries = safeReaddir(dir)
  if (!entries) return undefined
  for (const e of entries) {
    const at = join(dir, e.name)
    if (e.isFile() && e.name === name) {
      try {
        if (statSync(at).size >= MIN_BUNDLE_BYTES) return at
      } catch {
        /* raced or unreadable; keep looking */
      }
    }
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue
    const found = descend(join(dir, e.name), name, depth - 1)
    if (found) return found
  }
  return undefined
}

/** The directory of the package that shipped `file`, or its own directory when there is none. */
function packageRoot(file: string): string {
  let dir = dirname(file)
  for (let up = 0; up < 4; up++) {
    try {
      statSync(join(dir, 'package.json'))
      return dir
    } catch {
      dir = dirname(dir)
    }
  }
  return dirname(file)
}

/**
 * The bytes of the installed `command`, or why there are none.
 *
 * Where the resolved executable is a launcher rather than the program -- `codex` on npm is a
 * 7KB `codex.js` that execs a platform binary several directories away -- the real one is
 * looked for beneath the package that shipped the launcher. Best effort by construction: it
 * finds the Claude binary directly, finds the Codex binary through the descent, and finds
 * nothing for a Python tool like Kimi, whose names are not in its install tree in any form.
 */
export function installedBundle(command: string): { bytes: Buffer; at: string } | { why: string } {
  const on = findExecutable(command, { cwd: process.cwd() })
  if (!on) return { why: `${command} is not on PATH` }

  let real: string
  try {
    real = realpathSync(on)
  } catch (e) {
    return { why: `${on} could not be resolved: ${String(e)}` }
  }

  let at = real
  try {
    if (statSync(at).size < MIN_BUNDLE_BYTES) {
      const deeper = descend(packageRoot(real), command, 6)
      if (!deeper) return { why: `${real} is a shim and no bundle was found beneath its package` }
      at = deeper
    }
    return { bytes: readFileSync(at), at }
  } catch (e) {
    return { why: `${at} could not be read: ${String(e)}` }
  }
}
