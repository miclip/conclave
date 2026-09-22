/**
 * The install a run last launched from on THIS MACHINE, for the notice #356 asks for.
 *
 * `scripts/release.sh` repoints `~/.local/bin/conclave`, which is per-user and shared by every
 * project on the machine. A release cut in one project therefore moves the tool for every
 * other project's NEXT launch, silently. This record is what lets that next launch say so:
 * it holds what the previous launch ran from, and a launch compares itself against it.
 *
 * ## Per user, outside every project -- and why that is the only place that works
 *
 * The first design derived the notice from the project's own previous run, because that
 * needs no new state. It missed the run that mattered most: a project with no previous run
 * gets silence, and a first run is the one already doing hook registration and Codex trust,
 * with minutes of unfamiliar output there to absorb the blame for a bad release. And four
 * truthful per-project notices can never say "this moved twice today", because no single
 * project saw both moves. A machine has a history even when a project does not, so the
 * record is per machine and per user: the scope of the symlink that moves.
 *
 * ## Why `$XDG_STATE_HOME`, and not the three places that look closer
 *
 * The record is STATE in the XDG sense -- something the tool writes for its own next run,
 * which nobody edits and nothing precious depends on -- and that is exactly the category
 * `XDG_STATE_HOME` was added for (history, recently-used, logs). The fallback is the spec's
 * own, `~/.local/state`, which also sits beside the `~/.local/bin` and `~/.local/share` the
 * install already uses; a reader who finds one will find the others.
 *
 * Not `.conclave/` in the project: that is per project, and the paragraph above is why per
 * project cannot say what this notice has to say. Not `.conclave/config.json` either: that
 * file is something an operator writes and the tool reads, and this is the reverse.
 *
 * Not next to the install: the install is the thing that moves. Each release lives in its
 * own directory (#250) and `--prune-install` deletes the old ones, so a record stored there
 * would vanish with the very version it needed to name.
 *
 * ## Installed versus development, and how they are told apart
 *
 * A checkout of this repository changes its build string on every commit, so a comparison
 * that ran for `node bin/conclave.ts` would notice on nearly every run in this repository
 * and become the kind of noise a real notice gets lost in. The notice is about the INSTALL
 * moving, so it only runs for a launch that went through the install.
 *
 * The test is where PATH's `conclave` resolves to. The launcher on PATH is a symlink to
 * `<install>/bin/conclave`, an sh script that execs node on `<install>/bin/conclave.ts`
 * (see `bin/conclave` for why it is a script). So "this process is the install" means: the
 * file this process is running and the `conclave` a shell would find live in the same real
 * directory. `node bin/conclave.ts` in a checkout that is not on PATH fails that test and is
 * `development`: it neither notices nor writes. A checkout that IS on PATH passes it, which
 * is right -- that is the install on that machine -- and is why the comparison below is on
 * the install's identity rather than its commit.
 *
 * ## What "changed" compares
 *
 * The resolved install root, and the package version. Not the full build string: that
 * carries the commit, and a working tree on PATH would then fire once per commit -- the
 * noise this file exists to avoid, arriving by a different door. A release is a new
 * directory, so the root catches the case #356 is about; the version catches an install
 * replaced in place, which nothing here does today but nothing here should assume.
 *
 * ## It cannot fail a run
 *
 * This is a notice. A notice that can break a run is worse than the silence it replaces, so
 * every filesystem operation here is fail-soft: a missing, unreadable or garbage record
 * reads as "no previous record", and a write that fails is reported in the result, never
 * thrown. Nothing here throws on any input.
 */

import { accessSync, constants, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

/** What the previous installed launch ran from. The file's whole content. */
export type InstallLaunchRecord = {
  /** The build string as `version()` reported it: what a notice names. */
  build: string
  /** The resolved install root that build lived in: what a comparison uses. */
  root: string
}

/**
 * How this launch relates to the last one recorded on this machine.
 *
 * `development`: not launched through the install on PATH. Nothing was read or written.
 * `first`: launched through the install, and no usable record existed before this one.
 * `unchanged`: the same install as last time.
 * `changed`: a different install from last time; `previous` is what it was.
 *
 * `recorded` is whether this launch's record was written. False is not an error the run
 * should act on -- the notice for this launch is still right -- but a banner that promised
 * to remember would be lying, and the operator can be told.
 */
export type InstallLaunch =
  | { kind: 'development'; build: string }
  | { kind: 'first'; build: string; recorded: boolean }
  | { kind: 'unchanged'; build: string; previous: InstallLaunchRecord; recorded: boolean }
  | { kind: 'changed'; build: string; previous: InstallLaunchRecord; recorded: boolean }

export type InstallLaunchInputs = {
  /** This build, from `version()`. Named in the notice and stored for the next one. */
  build: string
  /** The REAL path of the file this process is running (`selfEntry()`), not a symlink. */
  entry: string
  /** Where PATH and the XDG variables come from. */
  env: Record<string, string | undefined>
  /** The user's home, for the XDG fallback. Injected for tests; defaults to the real one. */
  home?: string
}

export const STATE_FILE = 'install-launch.json'

/**
 * The per-user state directory. `$XDG_STATE_HOME/conclave` when the variable is set and
 * absolute -- the spec says a relative value is to be ignored -- else `~/.local/state/conclave`.
 */
export function installLaunchStateDir(env: Record<string, string | undefined>, home = homedir()): string {
  const xdg = env['XDG_STATE_HOME']?.trim()
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'state')
  return join(base, 'conclave')
}

export function installLaunchRecordPath(env: Record<string, string | undefined>, home = homedir()): string {
  return join(installLaunchStateDir(env, home), STATE_FILE)
}

/**
 * The first `conclave` a shell would run from this PATH, resolved to its real file, or
 * undefined when there is none or it cannot be resolved. A dangling link, a loop, or an entry
 * that exists but is not executable are all "none": what matters is what a shell would run.
 */
function conclaveOnPath(env: Record<string, string | undefined>): string | undefined {
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, 'conclave')
    try {
      accessSync(candidate, constants.X_OK)
      return realpathSync(candidate)
    } catch {
      /* not here, or not runnable: the shell would keep looking too */
    }
  }
  return undefined
}

/**
 * The install root this process runs from, when it was launched through the install on PATH;
 * undefined otherwise. See "Installed versus development" above for what is being compared.
 */
export function installedRoot(entry: string, env: Record<string, string | undefined>): string | undefined {
  const onPath = conclaveOnPath(env)
  if (onPath === undefined) return undefined
  let real: string
  try {
    real = realpathSync(entry)
  } catch {
    return undefined
  }
  if (dirname(onPath) !== dirname(real)) return undefined
  return dirname(dirname(real))
}

/** The leading token of a build string: `0.5.64 (9adff5a-dirty)` -> `0.5.64`. */
function packageVersion(build: string): string {
  return build.trim().split(/\s+/, 1)[0] ?? ''
}

/** A record, or undefined for anything that is not one. Never throws. */
function readRecord(path: string): InstallLaunchRecord | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { build, root } = parsed as Record<string, unknown>
  if (typeof build !== 'string' || typeof root !== 'string' || build === '' || root === '') return undefined
  return { build, root }
}

/** Atomic where the filesystem allows it, and false rather than a throw where it does not. */
function writeRecord(path: string, record: InstallLaunchRecord): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n')
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

/**
 * Compare this launch with the last installed launch on this machine, and record it.
 *
 * Read and write happen only for an installed launch; a development launch touches nothing.
 * Never throws: this sits on a run's startup path, and see the header for why that matters.
 */
export function noteInstallLaunch(inputs: InstallLaunchInputs): InstallLaunch {
  const { build, entry, env } = inputs
  let root: string | undefined
  try {
    root = installedRoot(entry, env)
  } catch {
    root = undefined
  }
  if (root === undefined) return { kind: 'development', build }

  const path = installLaunchRecordPath(env, inputs.home)
  const previous = readRecord(path)
  const recorded = writeRecord(path, { build, root })

  if (previous === undefined) return { kind: 'first', build, recorded }
  const same = previous.root === root && packageVersion(previous.build) === packageVersion(build)
  return same
    ? { kind: 'unchanged', build, previous, recorded }
    : { kind: 'changed', build, previous, recorded }
}

/** The shape of `noteInstallLaunch`, for a front-end that lets a test hand it a stand-in. */
export type InstallLaunchNoter = (inputs: InstallLaunchInputs) => InstallLaunch

/**
 * What a launch says about its install, as lines for the banner -- or nothing.
 *
 * Nothing for `unchanged` and `development`, because a run with nothing to say prints nothing
 * new. One line for `first`: a fresh machine is its own state, not silence, and the build is
 * the fact worth stating (#356 lost this case once by deriving the notice per project). Two
 * for `changed`: both builds, and the clause no per-project notice could say -- that the
 * install is SHARED by every project on the machine, so it can move for reasons outside
 * this project. That clause is what tells an operator not to bisect their own project
 * for a regression a release put there.
 */
export function installLaunchNotice(launch: InstallLaunch): string[] {
  switch (launch.kind) {
    case 'first':
      return [`  install: ${launch.build} — no earlier launch is recorded on this machine`]
    case 'changed':
      return [
        `  install moved: ${launch.previous.build} → ${launch.build}`,
        '    the install is shared by every project on this machine and can move for reasons outside this project',
      ]
    default:
      return []
  }
}
