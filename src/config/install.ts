/**
 * `conclave config install` — register Conclave's hooks in a project.
 *
 * WHERE THE TEMPLATES COME FROM IS NOT WHICH HOOK RUNS, and #258 is what happens when the
 * two are collapsed. The templates are read from the release that ran this command; the
 * command they render invokes `conclave` from PATH, resolved afresh every time a hook
 * fires. Registrations therefore render identically everywhere and cannot be pinned to a
 * release that a later one supersedes or `--prune-install` deletes.
 *
 * This used to say that both CLIs "require an absolute command path", so a registration
 * was "necessarily machine-local". Neither half survived measurement: codex-cli 0.153.4
 * resolves a bare command name through PATH and hands the hook the invoking shell's PATH,
 * and Claude Code runs its hook commands through a shell. The outputs are now portable.
 * They stay generated and git-ignored anyway, for the remaining reason: this command
 * writes them into a repository that did not ask for them, and untracked files are a real
 * hazard in a repo with a `git add -A` habit.
 *
 * THREE ROOTS, deliberately not collapsed. They coincide only when Conclave is installing
 * into its own checkout, which is the case that hid the distinction for as long as that
 * was the only supported one:
 *
 *   conclaveRoot      the release these TEMPLATES were read from. It is no longer where
 *                     the hook runs from -- nothing rendered points at it -- so it is
 *                     provenance for this command's own inputs and nothing more.
 *   projectRoot       the repository a session will run in, and where `.claude/settings
 *                     .json` is written. Resolved from the working directory.
 *   codexProjectRoot  where Codex resolves project configuration for `projectRoot`, which
 *                     is that repository's MAIN worktree. Differs in a linked worktree,
 *                     and not cosmetically: a sidecar written to the linked worktree is
 *                     never read, so the hooks silently do not exist.
 *
 * A fourth thing, which is not a root and is the one that decides what executes: whatever
 * `conclave` resolves to on PATH when a hook fires. Reported by `conclaveOnPath`, and
 * checked rather than assumed -- an older `conclave` answers `unknown command: hook`.
 *
 * On Codex trust, which this file used to get wrong in the operator's favour and then
 * against it: the hash covers the NORMALISED HANDLER, so it moves when a handler's own
 * fields move and not otherwise. It is no longer true that every project produces a
 * different hash -- that was a consequence of the absolute path being in the command, and
 * the command no longer has one. Two checkouts of Conclave now render the same handler and
 * share one decision; a project still trusts its own sidecar once, because Codex keys the
 * decision by sidecar path as well as by content.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  CONCLAVE_HOOK_MATCH,
  diagnoseHookTrust,
  readCodexHooks,
  resolveCodexProjectRoot,
} from '../deployment/codexHookTrust.ts'
import { legacyInstallRootOf } from './legacyRegistration.ts'

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

/**
 * A template, with `{{CONCLAVE_ROOT}}` substituted where it appears.
 *
 * A template with NO token is valid, and since #258 both shipped ones are. This used to
 * throw on one, reasoning that it "would render identically everywhere" -- which was the
 * bug rather than the guard. A project registration rendering identically everywhere is
 * the point: it names no install directory, so no release can make it stale and no prune
 * can remove what it points at. Only a RUN's seat hooks are version-pinned, and adapters
 * write those directly rather than through a template.
 *
 * The JSON check stays, and is the part that was actually earning its keep: an
 * unparseable sidecar makes Codex load no hooks at all, which presents as a lifecycle
 * problem rather than a config one.
 */
export function render(templateText: string, conclaveRoot: string): string {
  const rendered = templateText.split(TEMPLATE_TOKEN).join(conclaveRoot)
  // Fail here rather than handing a broken registration to a CLI that will ignore it
  // silently -- an unparseable sidecar is exactly the failure mode that looks like
  // "hooks just don't fire".
  JSON.parse(rendered)
  return rendered
}

/**
 * Which Conclave a rendered registration points at, recovered from the file itself.
 *
 * The discrimination this exists for: a registration that differs from what we would write
 * has either DRIFTED (the template changed, and rewriting is the fix) or is OWNED BY ANOTHER
 * CHECKOUT (the template is identical, rendered against a different Conclave). Those look
 * the same to a byte comparison and want opposite responses -- rewriting the second one
 * hijacks a sidecar another worktree is relying on, and re-hashes a handler whose trust
 * decision then silently dies.
 *
 * Exact rather than a regex over the contents: the template is split on its token, and the
 * candidate must reconstruct the file byte for byte. A near-match is a drifted template and
 * must be reported as one.
 */
export function renderedRootOf(templateText: string, rendered: string): string | undefined {
  const parts = templateText.split(TEMPLATE_TOKEN)
  if (parts.length < 2) return undefined
  const head = parts[0]!
  if (!rendered.startsWith(head)) return undefined
  // The first gap is between the first and second literal parts, so the candidate ends
  // where the second part begins.
  const rest = rendered.slice(head.length)
  const tail = parts[1]!
  const end = tail === '' ? rest.length : rest.indexOf(tail)
  if (end < 0) return undefined
  const candidate = rest.slice(0, end)
  if (!candidate) return undefined
  return parts.join(candidate) === rendered ? candidate : undefined
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
 * These files are GENERATED, which since #258 is the whole of the objection: they no longer
 * carry an absolute path, so a project that wanted to commit them could. What has not
 * changed is that this command writes them into a repository that did not ask for them,
 * leaving untracked files in someone's working tree that the person who ran `config
 * install` has no reason to expect.
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

/**
 * Where `conclave` resolves on PATH, or undefined.
 *
 * `command -v` rather than `which`: it is POSIX, it is what a shell would actually do when
 * a CLI spawns the hook command, and it is not a separate binary that can be absent.
 * Failure of any kind reads as "not found", because every one of them means the operator
 * cannot be told it IS found.
 */
export function conclaveOnPath(): string | undefined {
  try {
    const out = execFileSync('/bin/sh', ['-c', 'command -v conclave'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out || undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the `conclave` on PATH understands `hook`, asked by asking it.
 *
 * Being on PATH is not enough, and this is not hypothetical: measured against codex-cli
 * 0.153.4 with a v0.5.32 binary on PATH, every handler in a v0.5.33 sidecar reported
 * `Failed` — `unknown command: hook`, exit 1 — for a project whose registration was
 * perfectly correct. Nothing else the operator sees at that moment connects a failing hook
 * to an older binary, and `config check` would report the registration as current, because
 * it is.
 *
 * The refusal for a MISSING AGENT is the probe, because it is the one answer only a
 * `conclave` that has this subcommand can give. Asking `--version` and comparing numbers
 * would work today and rot the moment the command is backported or renamed; asking the
 * binary what it can do cannot.
 *
 * No stdin is attached, so this can never be mistaken for a hook firing.
 */
export function understandsHook(binary: string): boolean {
  try {
    execFileSync(binary, ['hook'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    // Exit zero from `hook` with no agent is not something any version does; treat an
    // answer we do not recognise as "cannot confirm" rather than as confirmation.
    return false
  } catch (err) {
    const stderr = String((err as { stderr?: Buffer | string }).stderr ?? '')
    return stderr.includes('needs the agent')
  }
}

export interface InstallResult {
  /**
   * The release these templates were read from.
   *
   * NOT where the hooks run from, though it was until #258 and the field kept the old
   * description for a while afterwards. Nothing rendered points here; what executes is
   * `conclaveOnPath`, resolved when the hook fires.
   */
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
  /**
   * Where `conclave` resolves on PATH, or undefined if it does not resolve at all.
   *
   * Reported because the registrations now DEPEND on it. A command naming an absolute
   * path either worked or named a file that was visibly gone; `conclave hook claude`
   * fails by not being found, which both CLIs surface as a hook that did not run rather
   * than as a missing install. Saying it here is the only place an operator is looking at
   * the moment the dependency is created.
   *
   * The installer's own shell, which is a proxy: what matters is the PATH the CLI spawns
   * its hooks with. They are the same PATH in every ordinary setup and it is the best
   * evidence available without launching the CLI.
   */
  conclaveOnPath?: string | undefined
  /**
   * Whether that binary understands `hook`. Undefined when there is none to ask.
   *
   * Separate from `conclaveOnPath` because the two failures are separate and an operator
   * fixes them differently: one is a PATH to repair, the other is a Conclave to upgrade.
   */
  conclaveOnPathUnderstandsHook?: boolean | undefined
  dryRun: boolean
  /**
   * `sharedWith` names another Conclave checkout that already owns this registration.
   *
   * Only ever set for a file two checkouts share -- in practice the Codex sidecar, which
   * lives in the MAIN worktree and is therefore one file for every linked worktree of the
   * project. `changed: true, sharedWith: <path>` is not drift and must not be treated as
   * it: the templates agree, and what differs is whose hooks would run (#40).
   */
  written: {
    label: string
    path: string
    changed: boolean
    sharedWith?: string | undefined
    /**
     * The install root a REPLACED registration was pinned to, when the file already there
     * was written by a Conclave old enough to bake one in (#258).
     *
     * Set alongside `changed`, never instead of it: the file is being rewritten either way
     * and the operator must be told that -- what this adds is WHY the bytes differ, which
     * is an upgrade rather than someone having edited the file. Distinguishing them
     * matters because the remedies are opposite: a hand-edited registration is a decision
     * to look at, a version-pinned one is a stale artefact to overwrite.
     *
     * Never `sharedWith`. That answered "which checkout owns this file", a question the
     * stable command retires: every Conclave now renders the same bytes, so nothing is
     * owned and there is nothing to hijack. An old file is a migration, not a rival.
     */
    replaces?: string | undefined
  }[]
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

  // A linked worktree needs an EMPTY `.codex/` of its own, or Codex never looks for the
  // sidecar at all.
  //
  // Measured on 0.146.0, from a linked worktree whose main worktree had a valid sidecar:
  //
  //   linked has no .codex directory   -> 0 hooks loaded
  //   linked has an EMPTY .codex dir   -> 5 hooks, sourced from the MAIN worktree
  //   linked has its own hooks.json    -> 5 hooks, still sourced from the main worktree
  //   main sidecar deleted             -> 0 hooks
  //
  // So the directory is a TRIGGER and its contents are ignored. `resolveCodexProjectRoot` is
  // right that the file belongs in the main worktree; what was missing is the thing that
  // makes Codex go and read it. Without this, `codex` in any linked worktree loads no hooks,
  // has no turn-completion signal, and the preflight correctly refuses to start a session --
  // with a diagnostic that names neither cause.
  if (codexProjectRoot !== projectRoot && agents.includes('codex' as AgentKind)) {
    mkdirSync(join(projectRoot, '.codex'), { recursive: true })
  }
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
    // Whose hooks are currently registered here, when they are not ours. See
    // `renderedRootOf`: same template, different Conclave.
    const owner =
      changed && previous !== undefined
        ? renderedRootOf(readFileSync(templatePath, 'utf8'), previous)
        : undefined
    const sharedWith = owner && !samePath(owner, conclaveRoot) ? owner : undefined
    // A registration from before #258, recognised by the install path baked into its
    // command. Checked BEFORE `sharedWith` can claim it and reported instead: a file
    // rendered against another release is not a rival checkout to defer to, it is this
    // project's own registration one version behind, and the answer is to replace it.
    // Deferring would leave the project running a version's hook code indefinitely, which
    // is the quiet half of #258 rather than a fix for it.
    const replaces = changed && previous !== undefined ? legacyInstallRootOf(previous) : undefined
    // Never rewrite identical bytes. Harmless for Claude; for Codex a rewritten handler
    // would re-hash and invalidate an existing trust decision for no reason.
    if (changed && !opts.dryRun) writeAtomic(outputPath, contents)
    written.push({
      label: target.label,
      path: outputPath,
      changed,
      ...(replaces ? { replaces } : sharedWith ? { sharedWith } : {}),
    })
  }

  const onPath = conclaveOnPath()

  const result: InstallResult = {
    conclaveRoot,
    projectRoot,
    codexProjectRoot,
    agents,
    unignored: unignored(projectRoot, written.map((w) => w.path)),
    conclaveOnPath: onPath,
    ...(onPath ? { conclaveOnPathUnderstandsHook: understandsHook(onPath) } : {}),
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
 * What a `config check` decided, in one word.
 *
 * `not_applicable` is a third answer and not a shade of `current`: it says the question was
 * declined, not that the registrations were compared and agreed. A consumer that treats the
 * two as one is claiming a check happened where none did.
 */
export type CheckStatus = 'current' | 'drift' | 'not_applicable'

/** Why a check declined. Named rather than a boolean, so a later exemption is distinguishable. */
export type NotApplicableReason = 'seat_worktree_has_no_registration'

/**
 * A check that did not run, and why.
 *
 * The one case today: a Conclave seat worktree. Registrations are generated and git-ignored,
 * so git never checks them into a seat; a drift check there reports the RUN ROOT's files as
 * missing, which is accurate and worthless. Every seat would fail a check the run root passes,
 * and since seats run the suite at their own HEAD that failure would arrive as a seat test
 * failure with no bug behind it.
 */
export interface CheckNotApplicable {
  status: 'not_applicable'
  reason: NotApplicableReason
  // NO `drift` FIELD, deliberately, and this is the one thing about this shape worth
  // defending. An earlier version emitted `drift: false` so that a consumer gating on it
  // agreed with the zero exit code. That is a claim the command cannot make: nothing was
  // compared, so drift here is UNKNOWN, and `false` says the registrations were checked and
  // agreed. The two facts want different handling by anything that reports on a fleet --
  // "every root is current" is not what a run of seats establishes. Absent, `drift` reads as
  // `undefined`: falsy, so a consumer that gates on it still agrees with the exit code, but
  // distinguishable from `false` by anything that looks. `status` and `reason` carry the rest.
  /** The seat checkout the command was run in. */
  projectRoot: string
  /** The run root that owns the registrations, and where a check does apply. */
  integrationRoot: string
  runId: string
  seat: string
}

export function notApplicableInSeatWorktree(seat: {
  worktreePath: string
  integrationRoot: string
  runId: string
  seatId: string
}): CheckNotApplicable {
  return {
    status: 'not_applicable',
    reason: 'seat_worktree_has_no_registration',
    projectRoot: seat.worktreePath,
    integrationRoot: seat.integrationRoot,
    runId: seat.runId,
    seat: seat.seatId,
  }
}

/**
 * A path as a single shell word, for a line an operator is meant to copy.
 *
 * Printed paths get pasted. An unquoted one breaks on a space and, worse, hands whatever the
 * path contains to the shell -- so a directory name is enough to run something the reader did
 * not type. Single quotes take everything literally; the dance around an embedded quote is the
 * only case that needs care.
 */
function shellQuote(p: string): string {
  return `'${p.split("'").join(`'"'"'`)}'`
}

export function formatCheckNotApplicableJson(r: CheckNotApplicable): string {
  return JSON.stringify(r, null, 2)
}

/**
 * The same decision for a reader. Both renderings carry the status and the reason verbatim,
 * so a human and a script quoting this run are quoting the same two words.
 */
export function formatCheckNotApplicable(r: CheckNotApplicable): string {
  return [
    `project: ${r.projectRoot}`,
    `  status: not_applicable (${r.reason})`,
    `  this is a Conclave seat worktree — run ${r.runId}, seat ${r.seat}.`,
    '  Registrations are generated and git-ignored, so a seat checkout never contains them',
    '  and a check here would report the run root\'s files as missing rather than drifted.',
    `  Check the run root instead:  (cd ${shellQuote(r.integrationRoot)} && conclave config check)`,
  ].join('\n')
}

/**
 * The same report as `formatInstallResult`, for consumers rather than readers.
 *
 * `drift` is emitted explicitly even though it is derivable from `written`, because it is
 * the field the exit code is computed from. Leaving it out would oblige every consumer to
 * reconstruct that rule, and a consumer that reconstructed it slightly differently would
 * disagree with the process it was reading.
 *
 * `status` says the same thing in the vocabulary the declined case needs -- a consumer can
 * switch on one field across every outcome instead of testing `drift` here and `status`
 * there, which is how the two would drift apart.
 */
export function formatInstallResultJson(r: InstallResult): string {
  const status: CheckStatus = hasDrift(r) ? 'drift' : 'current'
  return JSON.stringify({ status, drift: hasDrift(r), ...r }, null, 2)
}

export function formatInstallResult(r: InstallResult): string {
  const lines = [`project: ${r.projectRoot}`]
  // What actually executes, which is NOT `conclaveRoot`. This line used to read `hooks run
  // from: <conclaveRoot>` and was true only while the rendered command named that
  // directory. Since #258 it names none, so printing the release here told a reader the one
  // thing they must not believe -- that a hook fired in this project runs the Conclave they
  // happened to run `config install` from. It runs whatever is on PATH at the time.
  if (r.conclaveOnPath) lines.push(`hooks run: ${r.conclaveOnPath} hook <agent>`)
  // Provenance for this command's own inputs, and labelled as nothing more. Suppressed in
  // Conclave's own checkout, where naming it on every run is noise a reader learns to skip.
  if (!r.selfHosted) lines.push(`templates from: ${r.conclaveRoot}`)
  if (r.codexProjectRoot !== r.projectRoot) {
    // Say it before listing the paths, so the unexpected one reads as intended rather
    // than as a bug in this command.
    lines.push(
      `  the project is a linked worktree; Codex resolves project config from the main`,
      `  worktree, so its sidecar goes to ${r.codexProjectRoot}`,
    )
  }
  for (const w of r.written) {
    // The state says what happened to the FILE; shared ownership is an annotation on top of
    // it, not a replacement for it. Replacing it hid the write: a real `config install` that
    // took a registration over from another checkout reported only `SHARED`, and the
    // operator had to read the file to learn whether anything had changed. Found doing
    // exactly that during a migration.
    //
    // `SHARED` still displaces `DRIFT`, which is a different case and stands: under
    // --dry-run the templates agree and only the owner differs, so calling it drift sends a
    // reader to `config install` -- and running it is precisely what hijacks the file.
    // STALE displaces DRIFT for the same reason SHARED does: they are different findings
    // wanting different reading. `DRIFT` says somebody changed this file; `STALE` says
    // nobody did and the version it was pinned to moved on. Sending a reader to look for
    // an edit that was never made is the wrong half of a day.
    const state = w.replaces
      ? r.dryRun
        ? 'STALE  '
        : 'wrote  '
      : w.sharedWith && r.dryRun
        ? 'SHARED '
        : w.changed
          ? r.dryRun
            ? 'DRIFT  '
            : 'wrote  '
          : 'current'
    const from = w.sharedWith && !r.dryRun ? `  [taken over from ${w.sharedWith}]` : ''
    // Named on the write too, not only under --dry-run. A registration silently swapped
    // for a different one is exactly what this issue is about, and "wrote" alone does not
    // say that the thing replaced was running someone's hooks a moment ago.
    // Past tense only when something actually happened. Under --dry-run nothing was
    // replaced, and a check that says it replaced a registration is a check an operator
    // would stop trusting the moment they looked at the file.
    const replaced = w.replaces
      ? r.dryRun
        ? `  [pinned to ${w.replaces}]`
        : `  [replaced a registration pinned to ${w.replaces}]`
      : ''
    lines.push(`  ${state} ${w.label}: ${w.path}${from}${replaced}`)
  }
  const stale = r.written.filter((w) => w.replaces)
  if (stale.length > 0) {
    lines.push('')
    lines.push(
      r.dryRun
        ? 'These registrations were written by an older Conclave and name the install'
        : 'These registrations were written by an older Conclave and have been replaced:',
    )
    if (r.dryRun) lines.push('directory that was current at the time:')
    for (const w of stale) lines.push(`  ${w.label} was pinned to ${w.replaces}`)
    lines.push('')
    lines.push('That directory is one release, not the installation: since #250 each release')
    lines.push('gets its own, so the hooks kept firing out of that version\'s code — or stopped')
    lines.push('firing when `--prune-install` removed it. The replacement names no directory at')
    lines.push('all, so no release can make it stale.')
    if (r.dryRun) lines.push('Run `conclave config install` to replace them.')
  }

  const shared = r.written.filter((w) => w.sharedWith)
  if (shared.length > 0) {
    lines.push('')
    lines.push('Another Conclave checkout already owns these registrations:')
    for (const w of shared) lines.push(`  ${w.label} runs ${w.sharedWith}`)
    lines.push('')
    // Every consequence, because each one presents as something else entirely.
    lines.push('The Codex sidecar is ONE file shared by every worktree of a project — Codex')
    lines.push('resolves it from the main worktree wherever you are. So while this stands:')
    lines.push('  - hooks here execute that checkout\'s code, not this one\'s;')
    lines.push('  - re-installing here invalidates that checkout\'s Codex trust, because the')
    lines.push('    trust hash covers the handler, and the handler would change;')
    lines.push('  - and the two will keep re-trusting each other for as long as both are used.')
    lines.push('Run `config install` here only if this checkout should own them. To develop')
    lines.push('hook changes, use a separate clone rather than a worktree — a worktree cannot')
    lines.push('hold its own sidecar. See issue #40.')
  }
  if (r.unignored.length > 0) {
    lines.push('')
    lines.push('These are generated and this project does not ignore them:')
    for (const p of r.unignored) lines.push(`  ${p.replace(`${r.projectRoot}/`, '')}`)
    lines.push('Add them to .gitignore or .git/info/exclude, or they will show as untracked.')
    // Said because it changed, and because the old advice was justified by the path: an
    // operator who remembers "these cannot be committed, they are machine-local" would
    // otherwise carry a rule that no longer holds.
    lines.push('They carry no machine-specific path any more, so committing them is a choice')
    lines.push('rather than a mistake — but nothing here writes to a file the project owns.')
  }
  // The dependency this command creates, said where it is created. A registration naming
  // `conclave` is stable across releases precisely because it resolves at fire time --
  // which is also the one way it can fail that an absolute path could not.
  if (r.conclaveOnPath === undefined) {
    lines.push('')
    lines.push('`conclave` does not resolve on PATH in this shell, and the registrations just')
    lines.push('written invoke it by name. Until it does, the hooks will not run: both CLIs')
    lines.push('report that as a hook that failed, not as a missing installation. Put the')
    lines.push('installed binary (usually ~/.local/bin) on PATH.')
  } else if (r.conclaveOnPathUnderstandsHook === false) {
    lines.push('')
    lines.push(`The \`conclave\` on PATH (${r.conclaveOnPath}) does not understand \`hook\`, so`)
    lines.push('these registrations will fail on every invocation — `unknown command: hook`,')
    lines.push('reported as a failed hook. That is an older Conclave than the one you just ran:')
    lines.push('the registration is correct and `config check` will keep saying so. Install this')
    lines.push('version, or point PATH at it.')
  }

  // Only for genuine drift. A shared registration has its own paragraph above, and telling
  // a reader to rewrite it would be advice that causes the damage.
  if (r.dryRun && r.written.some((w) => w.changed && !w.sharedWith && !w.replaces)) {
    lines.push('')
    lines.push('Registrations differ from the templates. Running `config install` would')
    lines.push('rewrite them, which re-hashes the Codex handlers and requires re-trusting.')
  }
  if (!r.codex) return lines.join('\n')

  lines.push('')
  if (r.codex.ready) {
    lines.push('Codex hooks are loaded, enabled and trusted — they will run.')
    // The limit of what this command can see (#41). A run that dies with "no UserPromptSubmit
    // hook after send" sends its operator here, and this line said everything was fine -- a
    // remedy offered for the wrong cause is worse than "I do not know". Registration and trust
    // are static facts about configuration; whether a handler COMPLETES is a fact about the
    // machine at the moment it runs, and nothing here can observe that.
    lines.push('  This reports registration and trust only. It cannot tell whether a handler')
    lines.push('  will finish inside its timeout on a loaded machine — see the attempts journal')
    lines.push('  named in a send-timeout error for that.')
  } else if (r.codex.retrustRequired) {
    lines.push('Codex hooks need re-trusting before they will run.')
    lines.push('  Codex hashes the normalised handler, so a decision lapses when a handler')
    lines.push('  changes — which is what a first install, or replacing a registration an')
    lines.push('  older Conclave wrote, does. Upgrading Conclave on its own no longer does:')
    lines.push('  every release renders the same handler. Start `codex` in this directory')
    lines.push('  and choose "Trust all and continue" at the review prompt.')
  } else {
    lines.push('Codex state could not be confirmed.')
  }
  for (const m of r.codex.messages) lines.push(`  - ${m}`)
  return lines.join('\n')
}
