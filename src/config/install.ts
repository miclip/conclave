/**
 * `conclave config install` — register Conclave's hooks in a project.
 *
 * Both CLIs require an absolute command path in their hook configuration, so an active
 * registration is necessarily machine-local. Committing one bakes somebody's home
 * directory into portable source. The split here is: canonical templates are versioned,
 * rendered registrations are generated and git-ignored.
 *
 * THREE ROOTS, deliberately not collapsed. They coincide only when Conclave is installing
 * into its own checkout, which is the case that hid the distinction for as long as that
 * was the only supported one:
 *
 *   conclaveRoot      where Conclave's own code lives. Templates are read from here, and
 *                     the rendered command paths point back here -- the hook that runs is
 *                     always Conclave's, never something expected of the target project.
 *   projectRoot       the repository a session will run in, and where `.claude/settings
 *                     .json` is written. Resolved from the working directory.
 *   codexProjectRoot  where Codex resolves project configuration for `projectRoot`, which
 *                     is that repository's MAIN worktree. Differs in a linked worktree,
 *                     and not cosmetically: a sidecar written to the linked worktree is
 *                     never read, so the hooks silently do not exist.
 *
 * A consequence worth surfacing rather than hiding: Codex's trust hash covers the
 * normalised handler, which includes that command string. Every project therefore
 * produces a different hash and must trust its own hooks once. That is inherent to
 * diagnosing trust via `hooks/list` instead of reimplementing Codex's hashing, and the
 * installer says so instead of leaving the next person to rediscover it.
 */

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  CONCLAVE_HOOK_MATCH,
  diagnoseHookTrust,
  readCodexHooks,
  resolveCodexProjectRoot,
} from '../deployment/codexHookTrust.ts'

// Re-exported where it used to live: it is Codex deployment knowledge, and moving it next
// to the diagnosis let that diagnosis name an untrusted directory instead of blaming the
// file format. Callers and tests should not have to care that it changed module.
export { resolveCodexProjectRoot }

/**
 * Substituted with `conclaveRoot`, never with the project being registered. Named for
 * what it is: an earlier `{{REPO_ROOT}}` read as "the repository in hand", which is
 * exactly the confusion that made installing into another project render commands
 * pointing at files that project does not have.
 */
export const TEMPLATE_TOKEN = '{{CONCLAVE_ROOT}}'

/**
 * Which directory a target's output path is relative to.
 *
 * `project` is the repository being registered. `codexProject` is the tree Codex resolves
 * that project's configuration from -- its main worktree.
 */
export type OutputRoot = 'project' | 'codexProject'

/**
 * Which CLI a registration is for.
 *
 * Both roles can be filled by the same CLI — two Claudes, or two Codexes — so "install
 * everything" writes files for a tool the operator may never launch. That is not merely
 * untidy: an unused Codex sidecar still has to be TRUSTED before anything reports ready,
 * so it manufactures a setup step for a capability the session does not use.
 */
export type AgentKind = 'claude' | 'codex'

export const AGENT_KINDS: AgentKind[] = ['claude', 'codex']

export interface RenderTarget {
  agent: AgentKind
  /** Template path, relative to `conclaveRoot`. */
  template: string
  /** Rendered output path, relative to whichever root `outputRoot` names. */
  output: string
  outputRoot: OutputRoot
  label: string
}

export const TARGETS: RenderTarget[] = [
  {
    agent: 'claude',
    template: 'config/templates/claude-settings.json',
    output: '.claude/settings.json',
    // Claude reads project settings from the working directory, so a linked worktree
    // gets its own registration and there is nothing to redirect.
    outputRoot: 'project',
    label: 'Claude project hooks',
  },
  {
    agent: 'codex',
    template: 'config/templates/codex-hooks.json',
    output: '.codex/hooks.json',
    outputRoot: 'codexProject',
    label: 'Codex sidecar',
  },
]

/**
 * Conclave's own checkout, from the MODULE's location rather than the working directory.
 *
 * `resolveRepoRoot()` answers a different question -- "what repository am I standing in"
 * -- and using it here reported every working directory as the Conclave checkout, then
 * sent the installer looking for templates that were never there.
 *
 * Realpath'd, because the CLI is expected to be reached through a symlink on PATH and the
 * link's own directory contains no templates.
 */
export function resolveConclaveRoot(): string {
  return realpathSync(join(import.meta.dirname, '..', '..'))
}

/** Compare through symlinks, and tolerate a path that does not exist yet. */
function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  return real(a) === real(b)
}

/**
 * The project a path belongs to: git root, else the nearest package.json ancestor, else
 * the directory itself.
 *
 * That last step used to throw. It was correct while this only ever resolved Conclave's
 * own checkout — a Conclave with no repository root really is broken. As the root of a
 * TARGET project it is wrong: a plain directory with neither git nor a package.json is a
 * perfectly ordinary thing to run a session in, and refusing to register hooks there
 * denies the operator the one thing that would give the session a completion signal.
 */
export function resolveRepoRoot(from: string = process.cwd()): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: from,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (out) return out
  } catch {
    /* not a git checkout, or git absent */
  }
  const start = resolve(from)
  let dir = start
  while (true) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

export function render(templateText: string, conclaveRoot: string): string {
  if (!templateText.includes(TEMPLATE_TOKEN)) {
    throw new Error(`template contains no ${TEMPLATE_TOKEN}; it would render identically everywhere`)
  }
  const rendered = templateText.split(TEMPLATE_TOKEN).join(conclaveRoot)
  // Fail here rather than handing a broken registration to a CLI that will ignore it
  // silently -- an unparseable sidecar is exactly the failure mode that looks like
  // "hooks just don't fire".
  JSON.parse(rendered)
  return rendered
}

/**
 * Write via a temporary sibling plus rename. A half-written hooks.json is not merely
 * inconvenient: Codex would fail to parse it and load no hooks at all, which presents as
 * a lifecycle problem rather than a config one.
 */
export function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, contents)
    renameSync(tmp, path)
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* best effort */
    }
    throw err
  }
}

/**
 * Registrations the project's git is not ignoring.
 *
 * These files are machine-local by construction — they carry absolute paths, which is the
 * whole reason they are generated rather than committed. Writing them into a repository
 * that does not ignore them leaves untracked files in someone's working tree, and the
 * person who ran `config install` has no reason to expect new paths.
 *
 * Reported, never fixed. Appending to a tracked `.gitignore` edits a file the project owns
 * and would show up in their next diff; the paths and the remedy are enough for them to
 * decide. This is the same line drawn around Codex trust: say what is wrong, do not reach
 * into configuration that is not ours.
 */
export function unignored(projectRoot: string, paths: string[]): string[] {
  // `git check-ignore` is the only thing that knows the answer: `.gitignore` composes with
  // `.git/info/exclude`, a global excludesfile, and negations. Matching by eye gets it
  // wrong exactly when a project has done something deliberate.
  return paths.filter((path) => {
    try {
      execFileSync('git', ['check-ignore', '-q', path], {
        cwd: projectRoot,
        stdio: ['ignore', 'ignore', 'ignore'],
      })
      return false
    } catch (err) {
      // Exit 1 means "not ignored". Anything else — not a repository, git absent — means
      // the question does not apply, and a warning nobody can act on is worse than none.
      return (err as { status?: number }).status === 1
    }
  })
}

export interface InstallResult {
  /** Where Conclave itself lives — what the rendered hook commands point at. */
  conclaveRoot: string
  /** The repository being registered. */
  projectRoot: string
  /**
   * Where the Codex sidecar was written. Equal to `projectRoot` except in a linked
   * worktree. Reported rather than derived, because "the file is not where you are" is
   * the thing a reader needs told.
   */
  codexProjectRoot: string
  /** The CLIs this run registered, after deduplication. */
  agents: AgentKind[]
  /** True when the project being registered IS Conclave's own checkout. */
  selfHosted: boolean
  /** Written paths this project's git will not ignore. Empty outside a git repository. */
  unignored: string[]
  dryRun: boolean
  written: { label: string; path: string; changed: boolean }[]
  codex?: {
    ready: boolean
    retrustRequired: boolean
    messages: string[]
  }
}

export interface InstallOptions {
  /**
   * Which CLIs to register. Defaults to all of them.
   *
   * A session passes the agents it will actually launch, so a Claude-only run neither
   * writes a Codex sidecar nor demands a trust decision for one.
   */
  agents?: AgentKind[]
  /** The repository to register. Defaults to whatever the working directory is in. */
  projectRoot?: string
  /** Where Conclave's templates and hook client live. Defaults to this module's checkout. */
  conclaveRoot?: string
  /** Overrides worktree detection; tests use it to render a linked layout on purpose. */
  codexProjectRoot?: string
  /** Skip the Codex diagnosis (it spawns `codex app-server`, costing a second or two). */
  diagnose?: boolean
  /**
   * Report what would change without writing anything.
   *
   * Rendering is already a no-op on an unchanged checkout -- identical bytes are not
   * rewritten, so mtime does not move and no trust transition occurs. This exists so that
   * property can be *verified* before something that depends on it, rather than
   * remembered. Before collecting fixtures, check; only install if something drifted.
   */
  dryRun?: boolean
}

export async function installConfig(opts: InstallOptions = {}): Promise<InstallResult> {
  const conclaveRoot = opts.conclaveRoot ?? resolveConclaveRoot()
  const projectRoot = opts.projectRoot ?? resolveRepoRoot()
  const codexProjectRoot = opts.codexProjectRoot ?? resolveCodexProjectRoot(projectRoot)
  const roots: Record<OutputRoot, string> = { project: projectRoot, codexProject: codexProjectRoot }
  // Deduplicated, because a session with the same CLI in both roles names it twice.
  const agents = [...new Set(opts.agents ?? AGENT_KINDS)]
  const written: InstallResult['written'] = []

  for (const target of TARGETS.filter((t) => agents.includes(t.agent))) {
    const templatePath = join(conclaveRoot, target.template)
    if (!existsSync(templatePath)) {
      // Not "the checkout is incomplete": the templates are read from Conclave's own
      // installation, so their absence says that installation is broken -- and says
      // nothing at all about the project being registered.
      throw new Error(`missing template ${target.template} under ${conclaveRoot}`)
    }
    const outputPath = join(roots[target.outputRoot], target.output)
    // Rendered against `conclaveRoot`, never the output's root: the hook that runs is
    // Conclave's, wherever the registration happens to live.
    const contents = render(readFileSync(templatePath, 'utf8'), conclaveRoot)
    const previous = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : undefined
    const changed = previous !== contents
    // Never rewrite identical bytes. Harmless for Claude; for Codex a rewritten handler
    // would re-hash and invalidate an existing trust decision for no reason.
    if (changed && !opts.dryRun) writeAtomic(outputPath, contents)
    written.push({ label: target.label, path: outputPath, changed })
  }

  const result: InstallResult = {
    conclaveRoot,
    projectRoot,
    codexProjectRoot,
    agents,
    unignored: unignored(projectRoot, written.map((w) => w.path)),
    selfHosted: samePath(conclaveRoot, projectRoot),
    dryRun: opts.dryRun === true,
    written,
  }

  // Nothing to diagnose when Codex is not among them, and diagnosing anyway would spawn
  // `codex app-server` to report a sidecar we deliberately did not write as missing.
  if (opts.diagnose !== false && agents.includes('codex')) {
    try {
      // Diagnose the PROJECT, not Conclave: the question is whether hooks will run where
      // the session will, and those are no longer the same directory.
      const report = await readCodexHooks(projectRoot)
      const diagnosis = diagnoseHookTrust(report, CONCLAVE_HOOK_MATCH)
      result.codex = {
        ready: diagnosis.ready,
        // Re-trust is needed when hooks loaded but are not permitted to execute. A
        // changed command string re-hashes the handler, so this is expected on a fresh
        // checkout rather than a sign something is wrong.
        retrustRequired: !diagnosis.ready && report.hooks.length > 0,
        messages: diagnosis.messages,
      }
    } catch (err) {
      result.codex = {
        ready: false,
        retrustRequired: false,
        messages: [`could not diagnose Codex state: ${String(err)}`],
      }
    }
  }

  return result
}

/** True when the checkout's registrations differ from what the templates would render. */
export function hasDrift(r: InstallResult): boolean {
  return r.written.some((w) => w.changed)
}

/**
 * The same report as `formatInstallResult`, for consumers rather than readers.
 *
 * `drift` is emitted explicitly even though it is derivable from `written`, because it is
 * the field the exit code is computed from. Leaving it out would oblige every consumer to
 * reconstruct that rule, and a consumer that reconstructed it slightly differently would
 * disagree with the process it was reading.
 */
export function formatInstallResultJson(r: InstallResult): string {
  return JSON.stringify({ drift: hasDrift(r), ...r }, null, 2)
}

export function formatInstallResult(r: InstallResult): string {
  const lines = [`project: ${r.projectRoot}`]
  // Only worth a line when they differ. Naming Conclave's own path on every run inside
  // its own checkout is noise, and noise is what a reader learns to skip.
  if (!r.selfHosted) lines.push(`hooks run from: ${r.conclaveRoot}`)
  if (r.codexProjectRoot !== r.projectRoot) {
    // Say it before listing the paths, so the unexpected one reads as intended rather
    // than as a bug in this command.
    lines.push(
      `  the project is a linked worktree; Codex resolves project config from the main`,
      `  worktree, so its sidecar goes to ${r.codexProjectRoot}`,
    )
  }
  for (const w of r.written) {
    const state = w.changed ? (r.dryRun ? 'DRIFT  ' : 'wrote  ') : 'current'
    lines.push(`  ${state} ${w.label}: ${w.path}`)
  }
  if (r.unignored.length > 0) {
    lines.push('')
    lines.push('These are machine-local and this project does not ignore them:')
    for (const p of r.unignored) lines.push(`  ${p.replace(`${r.projectRoot}/`, '')}`)
    lines.push('Add them to .gitignore or .git/info/exclude, or they will show as untracked.')
  }
  if (r.dryRun && hasDrift(r)) {
    lines.push('')
    lines.push('Registrations differ from the templates. Running `config install` would')
    lines.push('rewrite them, which re-hashes the Codex handlers and requires re-trusting.')
  }
  if (!r.codex) return lines.join('\n')

  lines.push('')
  if (r.codex.ready) {
    lines.push('Codex hooks are loaded, enabled and trusted — they will run.')
  } else if (r.codex.retrustRequired) {
    lines.push('Codex hooks need re-trusting before they will run.')
    lines.push('  Codex hashes the normalised handler, which includes the absolute command')
    lines.push('  path, so every checkout must trust its own hooks once. Start `codex` in')
    lines.push('  this directory and choose "Trust all and continue" at the review prompt.')
  } else {
    lines.push('Codex state could not be confirmed.')
  }
  for (const m of r.codex.messages) lines.push(`  - ${m}`)
  return lines.join('\n')
}
