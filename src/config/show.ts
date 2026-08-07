/**
 * `conclave config show` — what this checkout resolves to, without touching anything.
 *
 * The question it answers is the one asked before a session starts and again after one
 * behaves unexpectedly: which project am I in, which Conclave will actually run, will the
 * participants ask before they act, and where do the registrations land. `config check`
 * answers a narrower question -- have the rendered files drifted from the templates -- and
 * pays for it by rendering, comparing and, unless told not to, spawning `codex app-server`
 * to diagnose trust.
 *
 * STRICTLY READ-ONLY, and that is the whole design constraint rather than a nicety:
 *
 *   - `installConfig` is not called, even with `dryRun`. Dry-run reads every template and
 *     every rendered file, and throws when a template is missing -- so it reports a broken
 *     Conclave installation instead of the roots and permissions that were asked for.
 *   - No hook diagnosis. That spawns a Codex process and takes a second or two, which is a
 *     surprising price for a command whose name promises to print what is already known.
 *   - Nothing is created, including parent directories. A command run to find out where
 *     files WOULD go must not answer by putting them there.
 *
 * The only subprocess it can reach is `git rev-parse` via root resolution, which reads.
 */

import { join } from 'node:path'
import {
  AGENT_KINDS,
  resolveCodexProjectRoot,
  resolveConclaveRoot,
  resolveRepoRoot,
  TARGETS,
  type AgentKind,
  type OutputRoot,
} from './install.ts'
import { permissionModeFor, readProjectConfig, type PermissionMode } from './project.ts'

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
    // agent belongs to a command that acts; this one is answering "where would it go".
    registrations: TARGETS.map((t) => ({
      agent: t.agent,
      label: t.label,
      path: join(roots[t.outputRoot], t.output),
      outputRoot: t.outputRoot,
    })),
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
    lines.push(`  ${reg.label}: ${reg.path}`)
  }
  // Said plainly, because the paths above look like a claim that the files are there.
  lines.push('', 'This reports where things resolve to. It does not check or write them.')
  return lines.join('\n')
}
