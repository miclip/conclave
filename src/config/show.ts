/**
 * `conclave config show` — what this checkout resolves to, without touching anything.
 *
 * The question it answers is the one asked before a session starts and again after one
 * behaves unexpectedly: which project am I in, which Conclave will actually run, will the
 * participants ask before they act, where do the registrations land -- and what is at
 * those paths right now. That last part overlaps `config check`, and the difference is
 * what each is FOR: `check` is a gate, so it filters by agent, diagnoses Codex trust by
 * spawning `codex app-server`, exits non-zero on drift, and gives up entirely if a
 * template is missing. `show` is a description, so it covers every target, reports a
 * status it could not determine as `unknown` rather than failing, and always exits zero.
 *
 * STRICTLY READ-ONLY, and that is the whole design constraint rather than a nicety:
 *
 *   - `installConfig` is not called, even with `dryRun`. Dry-run creates nothing, but it
 *     THROWS on the first missing template -- so a Conclave whose templates are gone
 *     reports nothing at all, in place of the roots and permissions that were asked for.
 *     Reading and rendering the templates here, per target and inside a try, buys the
 *     same status without letting one broken target take the report down with it.
 *   - No hook diagnosis. That spawns a Codex process and takes a second or two, which is a
 *     surprising price for a command whose name promises to print what is already known.
 *   - Nothing is created, including parent directories. A command run to find out where
 *     files WOULD go must not answer by putting them there. Note that this rules out
 *     `writeAtomic`'s `mkdirSync` even for a target that is about to be reported as
 *     `missing` -- the answer to "is it there" must not be "it is now".
 *
 * The only subprocess it can reach is `git rev-parse` via root resolution, which reads.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AGENT_KINDS,
  render,
  resolveCodexProjectRoot,
  resolveConclaveRoot,
  resolveRepoRoot,
  TARGETS,
  type AgentKind,
  type OutputRoot,
  type RenderTarget,
} from './install.ts'
import { permissionModeFor, readProjectConfig, type PermissionMode } from './project.ts'

/**
 * What the file at a registration's path is, relative to what the template would render.
 *
 *   missing   nothing is at that path. The hooks in it cannot fire, because it is not there.
 *   current   the bytes are exactly what this Conclave would write. Nothing to do.
 *   drifted   something is there and it is not what the template renders. For Codex this
 *             is the interesting one: the handler that IS trusted may not be the handler
 *             the template describes.
 *   unknown   the comparison could not be made -- a missing or malformed template, or an
 *             unreadable destination. Distinct from `drifted` on purpose: "these differ"
 *             and "I could not look" call for different actions, and reporting the second
 *             as the first would send an operator to reinstall a registration that is fine.
 */
export type RegistrationStatus = 'missing' | 'current' | 'drifted' | 'unknown'

export interface ShownRegistration {
  agent: AgentKind
  label: string
  /**
   * Absolute destination. Reported rather than left to the reader to join, because the
   * root each target resolves against is exactly the thing that is easy to get wrong.
   */
  path: string
  /** Which root `path` was built from, so a surprising path is self-explaining. */
  outputRoot: OutputRoot
  /**
   * Whether anything is at `path`. Reported separately from `status`, and always, because
   * it stays answerable when the comparison does not: a Conclave with no templates still
   * knows whether the project has a `.claude/settings.json`.
   */
  exists: boolean
  status: RegistrationStatus
  /**
   * Why the comparison failed, when something went wrong reading either side. Present
   * whenever there was a failure -- including for a `missing` destination, where the
   * absence is a fact on its own but a broken template is still worth saying.
   */
  error?: string
}

export interface ConfigShowReport {
  /** The repository a session here would run in. */
  projectRoot: string
  /** Where Conclave itself lives — what the rendered hook commands point back at. */
  conclaveRoot: string
  /**
   * Where Codex resolves project configuration from: `projectRoot`'s MAIN worktree.
   * Equal to `projectRoot` outside a linked worktree, and reported unconditionally so a
   * consumer never has to decide whether the distinction applied on this run.
   */
  codexProjectRoot: string
  /** The mode in force per agent, after per-agent overrides. Every known agent appears. */
  permissions: Record<AgentKind, PermissionMode>
  registrations: ShownRegistration[]
}

export interface ShowOptions {
  /** Where to resolve the project from. Defaults to the working directory. */
  cwd?: string
  /** Skips root resolution entirely; the caller has already decided. */
  projectRoot?: string
  conclaveRoot?: string
  /** Overrides worktree detection, as `installConfig` does, so tests can render a linked layout. */
  codexProjectRoot?: string
}

/**
 * One target's status, with every failure kept inside this function.
 *
 * The isolation is the point. `installConfig` throws on the first missing template, which
 * is right for a command that is about to write: there is nothing sensible to write. Here
 * it would mean a Conclave with one bad template printing no roots, no permissions and no
 * other registration -- withholding the entire report because of one line of it. So each
 * target's read/render/compare runs in its own try, and a failure becomes a value.
 */
function inspect(target: RenderTarget, path: string, conclaveRoot: string): ShownRegistration {
  const base = { agent: target.agent, label: target.label, path, outputRoot: target.outputRoot }
  // Cheap, and it never throws: an unreadable parent reads as absent, which is the same
  // thing from the point of view of a hook that has to be loaded from here.
  const exists = existsSync(path)

  let expected: string
  try {
    const templatePath = join(conclaveRoot, target.template)
    if (!existsSync(templatePath)) {
      // Names Conclave, not the project: the templates live in Conclave's own checkout,
      // so their absence says nothing whatever about the repository being reported on.
      throw new Error(`missing template ${target.template} under ${conclaveRoot}`)
    }
    // Rendered against `conclaveRoot`, exactly as `installConfig` renders it -- comparing
    // against anything else would report drift on a registration that is byte-correct.
    // `render` also throws on a template with no token and on output that is not JSON.
    expected = render(readFileSync(templatePath, 'utf8'), conclaveRoot)
  } catch (err) {
    // `missing` survives a broken template: the file is not there either way, and that is
    // the more actionable fact. The error rides along so the breakage is not swallowed.
    return { ...base, exists, status: exists ? 'unknown' : 'missing', error: messageOf(err) }
  }

  let actual: string
  try {
    if (!exists) return { ...base, exists, status: 'missing' }
    actual = readFileSync(path, 'utf8')
  } catch (err) {
    // Something is at that path and cannot be read -- a directory, or a mode that denies
    // us. Not drift: we have not seen the bytes.
    return { ...base, exists, status: 'unknown', error: messageOf(err) }
  }

  return { ...base, exists, status: actual === expected ? 'current' : 'drifted' }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Resolve everything and report it.
 *
 * Synchronous and unconditional: every field is computed on every call, because a report
 * whose contents depend on flags is a report a reader has to check the invocation of
 * before trusting. A malformed `.conclave/config.json` throws here rather than being
 * reported as `ask` -- silently showing the default for a file that says something else
 * would make this command actively misleading about the thing it exists to show.
 */
export function showConfig(opts: ShowOptions = {}): ConfigShowReport {
  const conclaveRoot = opts.conclaveRoot ?? resolveConclaveRoot()
  const projectRoot = opts.projectRoot ?? resolveRepoRoot(opts.cwd ?? process.cwd())
  const codexProjectRoot = opts.codexProjectRoot ?? resolveCodexProjectRoot(projectRoot)
  const roots: Record<OutputRoot, string> = { project: projectRoot, codexProject: codexProjectRoot }

  const config = readProjectConfig(projectRoot)
  const permissions = Object.fromEntries(
    AGENT_KINDS.map((agent) => [agent, permissionModeFor(config, agent)]),
  ) as Record<AgentKind, PermissionMode>

  return {
    projectRoot,
    conclaveRoot,
    codexProjectRoot,
    permissions,
    // Every target, not just the ones some hypothetical run would install. Filtering by
    // agent belongs to a command that acts; this one is answering "where would it go, and
    // what is there now".
    registrations: TARGETS.map((t) => inspect(t, join(roots[t.outputRoot], t.output), conclaveRoot)),
  }
}

/**
 * The same report for consumers rather than readers.
 *
 * Nothing derived is added: unlike `config check`, no exit code is computed from this, so
 * there is no rule a consumer could reconstruct differently.
 */
export function formatConfigShowJson(r: ConfigShowReport): string {
  return JSON.stringify(r, null, 2)
}

export function formatConfigShow(r: ConfigShowReport): string {
  const lines = [`project: ${r.projectRoot}`, `conclave: ${r.conclaveRoot}`]
  if (r.codexProjectRoot !== r.projectRoot) {
    lines.push(
      `  the project is a linked worktree; Codex resolves project config from the main`,
      `  worktree, so its sidecar path is under ${r.codexProjectRoot}`,
    )
  }

  lines.push('', 'permissions:')
  for (const agent of AGENT_KINDS) {
    const mode = r.permissions[agent]
    // The consequence, not just the word. `bypass` is the setting whose meaning an
    // operator should never have to remember correctly — and for Codex it is the stronger
    // claim, since that flag drops the sandbox as well as the prompts.
    const consequence = agent === 'codex' ? 'acts without asking, and without a sandbox' : 'acts without asking'
    lines.push(`  ${agent}: ${mode}${mode === 'bypass' ? `  (${consequence})` : ''}`)
  }

  lines.push('', 'registrations:')
  for (const reg of r.registrations) {
    // Status first and column-aligned, so a column of `current` with one `missing` in it
    // is read at a glance rather than by comparing paths. All four words are 7 characters,
    // which is luck rather than design, so pad anyway.
    lines.push(`  ${reg.status.padEnd(7)} ${reg.label}: ${reg.path}`)
    // Indented under its own registration, never collected into a footer: a report with
    // one broken target and one fine one must make it obvious which is which.
    if (reg.error) lines.push(`    could not compare: ${reg.error}`)
  }

  // What the words mean, and -- said plainly, because a status column reads like a
  // promise of action -- that nothing was done about any of it.
  lines.push('', 'Status compares the file on disk against what this Conclave would render.')
  if (r.registrations.some((reg) => reg.status === 'unknown')) {
    lines.push('`unknown` means the comparison could not be made, not that it failed.')
  }
  lines.push('Nothing here is written, rendered to disk, or trusted; `config install` does that.')
  return lines.join('\n')
}
