/**
 * Whether the CLI a seat is launched with is actually on the machine -- answered without
 * running it.
 *
 * #51: an implementer was seated on OpenCode before OpenCode was installed. `resolve()` reported
 * the agent as available, the run started, both seats were registered, hooks were written, Codex
 * trust was checked, the banner printed and the goal was routed -- and the first turn died as
 * `unknown_abnormal_end`, because the binary was never there. The adapter classified that
 * correctly and the capabilities table already documents the grade. The objection is not that the
 * failure is mishandled; it is that everything before it was work done on the operator's behalf in
 * a configuration that could never have run.
 *
 * This is the same rule `relay` already applies to being outside a git repository, and the comment
 * on that guard says what it is for: "before anything is spawned, registered or written". A missing
 * CLI is the same shape and cheaper to detect -- the launch command is known at resolve time, and
 * finding it is a handful of `stat` calls.
 *
 * NOTHING IS SPAWNED HERE, and that is deliberate rather than an optimisation. Running the command
 * to see whether it exists would start a child CLI that may open a terminal UI, print a first-run
 * dialog, or -- as `codex` did during spike 1 -- act on a default selection nobody chose. The
 * question is "is there a file the OS would execute", and PATH resolution answers it directly: the
 * same walk `execvp` does, in the same order, without the exec.
 *
 * WHAT IS NOT CLAIMED: that the file found will run. It may be built for another architecture, be
 * a broken symlink's target, or exit non-zero on every invocation. Absence is a fact; presence is
 * only the removal of one reason to fail, which is why a found command produces no output at all
 * and only a missing one produces a refusal.
 */

import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { AgentDefinition } from './types.ts'

/**
 * That `launch.command` names a real executable, and how an operator would obtain it.
 *
 * OPTIONAL on `LaunchSpec`, and the asymmetry with `deadlines` is the one `ModelSupport` already
 * argues for: a missing `deadlines` had to be refused because its absence would be reported as a
 * deadline the adapter does not run, and silence HERE removes a check rather than inventing a
 * guarantee. It also has to be optional for a reason `models` does not have -- an in-memory
 * `AgentSession` still has to satisfy `LaunchSpec`, and every test double in this repository
 * carries a `command` that is a label rather than a program. Declaring the requirement is what
 * separates "this definition spawns this file" from "this definition names a string".
 *
 * `{}` is a legitimate value: the command must exist and there is no one-line install to offer.
 */
export interface ExecutableRequirement {
  /**
   * The one line an operator would run to get it, quoted verbatim in the refusal.
   *
   * A hint rather than an instruction the run will follow, and never executed by anything here.
   */
  install?: string | undefined
  /** Where that line comes from, when the hint alone would be a claim with no source. */
  installFrom?: string | undefined
}

/** One seat, as much of it as this needs. */
export interface CommandSelection {
  /** The seat id, so a refusal names which one of several is wrong. */
  participant: string
  agent: AgentDefinition
  /**
   * The directory a RELATIVE command is resolved against.
   *
   * The seat's own cwd, which is the directory the adapter will spawn in -- so `./bin/agent`
   * means the same thing here as it will mean at exec time.
   */
  cwd: string
}

/** One seat's launch command, and what could be established about it. */
export interface CommandCheck {
  participant: string
  agent: string
  /** Exactly the string from `launch.command`, unmodified. */
  command: string
  /** The file that would be executed, when one was found. Absolute. */
  resolved?: string | undefined
  /** The whole operator-facing refusal, when the command was not found. */
  refusal?: string | undefined
}

/**
 * Where to look, injectable so a test can describe a machine other than the one it runs on.
 *
 * `platform` selects the RULES -- the PATH separator and whether `PATHEXT` applies -- and not a
 * filesystem: paths are still joined and stat'd by the host. A win32 rule set exercised on a posix
 * host therefore proves the search order and the extension expansion, which is where the portability
 * actually lives, and does not pretend to prove drive-letter parsing.
 */
export interface LookupOptions {
  cwd: string
  env?: NodeJS.ProcessEnv | undefined
  platform?: NodeJS.Platform | undefined
}

/** What Windows treats as executable when `PATHEXT` is not set. The documented default. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * The file the OS would execute for `command`, or `undefined` when there is none.
 *
 * The resolution `execvp` performs, in its order:
 *
 *   - A command containing a separator is a PATH to a file and is never searched for. It is
 *     resolved against `cwd` when relative, which is what makes `./tools/agent-wrapper` and
 *     `../vendor/bin/opencode` work as written -- the seat's directory, not this process's.
 *   - Anything else is searched for along `PATH`, first match wins -- and an EMPTY `PATH` entry is
 *     the seat's cwd, because that is what `execvp` does with one. See `searchDirs`.
 *   - On Windows the search additionally tries each `PATHEXT` suffix, because `opencode` there is
 *     `opencode.cmd` on disk -- which is exactly how a globally installed npm CLI lands, so
 *     skipping it would report every npm-installed agent as missing.
 *
 * A directory never matches, and on posix the executable BIT is required rather than mere
 * existence: `PATH` entries routinely contain a directory of the same name as a command, and a
 * non-executable file with the right name is not what the OS would run.
 *
 * WRAPPERS PASS BY CONSTRUCTION. A shell script, a `.cmd` shim, a symlink into a version manager's
 * store -- all are files with the executable bit, and none is treated differently from a compiled
 * binary. Nothing here reads the file's contents or asks what kind of program it is.
 */
export function findExecutable(command: string, opts: LookupOptions): string | undefined {
  if (command === '') return undefined
  const platform = opts.platform ?? process.platform
  const windows = platform === 'win32'
  const env = opts.env ?? process.env

  const separated = command.includes('/') || (windows && command.includes('\\'))
  if (separated) {
    // Already a path. `isAbsolute` is asked first only so an absolute command is not needlessly
    // re-joined; `resolve` would answer the same, and both leave the string's own spelling alone.
    const at = isAbsolute(command) ? command : resolve(opts.cwd, command)
    return firstExecutable(withExtensions(at, windows, env), windows)
  }

  for (const dir of searchDirs(opts)) {
    const found = firstExecutable(withExtensions(join(dir, command), windows, env), windows)
    if (found) return found
  }
  return undefined
}

/**
 * The directories a bare command is searched in, in order.
 *
 * AN EMPTY ENTRY IS THE SEAT'S CWD, which is the POSIX rule and not a convenience: `execvp` treats
 * a zero-length `PATH` element as the current directory, so `PATH=":/usr/bin"` with a wrapper in
 * the working directory is a setup that LAUNCHES. Skipping it -- which this did first -- refused a
 * configuration that would have run, and a check that refuses valid input is worse than no check
 * at all: the workaround is to switch it off, and then nothing is validated. The reproducibility of
 * that setup is a real objection and it is not this function's to make; the only question here is
 * whether the OS would find the file.
 *
 * The cwd is the SEAT's, matching the relative-path branch above and for the same reason: the
 * adapter spawns with `cwd` set, and `uv_spawn` changes directory in the child before `execvp`, so
 * the directory an empty entry names at exec time is the seat's rather than this process's.
 *
 * `PATH` unset searches nowhere. An unset variable has no entries at all, which is different from a
 * variable set to the empty string -- that is ONE empty entry, and so names the cwd.
 */
function searchDirs(opts: LookupOptions): string[] {
  const env = opts.env ?? process.env
  const windows = (opts.platform ?? process.platform) === 'win32'
  // `Path` as well as `PATH`: Windows environment variables are case-insensitive, and a process
  // launched from some shells carries the mixed-case spelling.
  const search = env['PATH'] ?? env['Path']
  if (search === undefined) return []
  return search.split(windows ? ';' : ':').map((dir) => (dir === '' ? opts.cwd : dir))
}

/** The candidate filenames for one directory entry, in the order the OS would try them. */
function withExtensions(base: string, windows: boolean, env: NodeJS.ProcessEnv): string[] {
  if (!windows) return [base]
  const exts = (env['PATHEXT'] ?? DEFAULT_PATHEXT).split(';').filter((e) => e !== '')
  // A command that already carries a known extension is not given a second one.
  if (exts.some((e) => base.toLowerCase().endsWith(e.toLowerCase()))) return [base]
  return [base, ...exts.map((e) => `${base}${e}`)]
}

function firstExecutable(candidates: readonly string[], windows: boolean): string | undefined {
  return candidates.find((c) => isExecutableFile(c, windows))
}

function isExecutableFile(path: string, windows: boolean): boolean {
  try {
    // `statSync` follows symlinks, so a shim pointing into a version manager's store is judged by
    // its TARGET -- and a dangling symlink throws here, which is the right answer for a command
    // whose install was removed underneath it.
    if (!statSync(path).isFile()) return false
    // The permission bit is meaningless on Windows, where executability is the extension. Asking
    // for X_OK there returns true for every readable file and would make `PATHEXT` decorative.
    if (windows) return true
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * One seat's launch command, checked -- or `undefined` when the definition declares nothing.
 *
 * `undefined` rather than a finding, for the reason `checkModelSelection` returns `undefined` for
 * an argv that named no model: a definition that declares no `executable` has not failed a check,
 * it has opted out of one, and reporting that as a negative result would put a line about every
 * in-memory test double into the run log.
 */
export function checkCommandAvailable(
  selection: CommandSelection,
  opts: Omit<LookupOptions, 'cwd'> = {},
): CommandCheck | undefined {
  const { participant, agent } = selection
  const requirement = agent.launch.executable
  if (!requirement) return undefined
  const { command } = agent.launch
  const base = { participant, agent: agent.id, command }
  const resolved = findExecutable(command, { cwd: selection.cwd, ...opts })
  if (resolved !== undefined) return { ...base, resolved }
  return { ...base, refusal: refusalFor(selection, requirement, opts) }
}

function refusalFor(
  selection: CommandSelection,
  requirement: ExecutableRequirement,
  opts: Omit<LookupOptions, 'cwd'>,
): string {
  const { participant, agent } = selection
  const { command } = agent.launch
  const windows = (opts.platform ?? process.platform) === 'win32'
  const separated = command.includes('/') || (windows && command.includes('\\'))
  // The count comes from the same function the search used, so the number in the message cannot
  // describe a different set of directories than the one actually looked in.
  const where = separated
    ? `there is no executable file at ${isAbsolute(command) ? command : resolve(selection.cwd, command)}`
    : `it is not on PATH (${searchDirs({ ...opts, cwd: selection.cwd }).length} directories searched)`
  const install = requirement.install
    ? `\nInstall it with \`${requirement.install}\`` +
      (requirement.installFrom ? ` (${requirement.installFrom}).` : '.')
    : ''
  return (
    `${participant} is seated on ${agent.displayName} (${agent.id}), which launches \`${command}\` -- ` +
    `and ${where}.${install}`
  )
}

/**
 * Refuse a run seated on a CLI that is not installed.
 *
 * Every seat is checked before any of them is reported on, so an operator who has installed
 * neither of two agents is told about both rather than made to run twice -- the argument
 * `refuseUnknownModels` makes, and it is stronger here, because the second install is a download
 * rather than an edit.
 *
 * Throwing rather than warning, for the reason #51 gives: the failure downstream is not merely
 * late, it is MISATTRIBUTED. A seat whose command is absent still registers, still has its hooks
 * written and its trust checked, still has the goal routed to it, and then produces
 * `unknown_abnormal_end` on its first turn -- a verdict that reads as the child misbehaving. A
 * warning on a run that proceeds anyway is a line nobody reads until they are already reading the
 * wrong diagnosis.
 */
export function refuseMissingCommands(
  selections: readonly CommandSelection[],
  opts: Omit<LookupOptions, 'cwd'> = {},
): CommandCheck[] {
  const checks: CommandCheck[] = []
  for (const selection of selections) {
    const check = checkCommandAvailable(selection, opts)
    if (check) checks.push(check)
  }
  const refused = checks.filter((c) => c.refusal !== undefined)
  if (refused.length > 0) {
    throw new Error(
      `${refused.map((c) => c.refusal).join('\n')}\n` +
        `Refusing to start. A seat whose CLI is absent is registered, has its hooks written and ` +
        `its goal routed, and then dies on its first turn as \`unknown_abnormal_end\` with nothing ` +
        `saying the command was missing (#51).`,
    )
  }
  return checks
}
