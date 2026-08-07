/**
 * Project-local configuration, from `.conclave/config.json`.
 *
 * The first thing in this codebase that reads a config file. `registry/types.ts` has
 * described the eventual shape for a while -- "global user config defining available
 * agents and personal defaults, project-local `.conclave/` config selecting agents and
 * assigning them to roles" -- and this is deliberately not that. It answers one question,
 * the one an operator actually hit: how do I stop being asked to approve every command.
 *
 * `.conclave/` is already gitignored and already holds machine-local state (the session
 * lock, scratch), which is where a decision this consequential belongs. It is a property
 * of one person's checkout on one machine, not of the project, and committing it would
 * hand everyone who clones the repository a session that never asks permission.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentKind } from './install.ts'
import { AGENT_KINDS } from './install.ts'

export const CONFIG_RELATIVE = '.conclave/config.json'

/**
 * How much a participant is asked before it acts.
 *
 * `ask` is the CLI's own default, whatever that is -- deliberately not restated here,
 * because a default this file invented would drift from the one the CLI actually applies.
 * `bypass` is each CLI's most permissive mode, and is exactly as dangerous as it sounds:
 * the model executes commands without asking and, for Codex, without a sandbox.
 */
export type PermissionMode = 'ask' | 'bypass'

export interface AgentConfig {
  permissions?: PermissionMode
}

export interface ProjectConfig {
  /** Applied to every agent, and overridden by a per-agent entry. */
  permissions?: PermissionMode
  agents?: Partial<Record<AgentKind, AgentConfig>>
}

/**
 * The flags that put each CLI in its most permissive mode.
 *
 * Taken from the CLIs' own `--help` rather than from memory, and kept here as the single
 * place that knows them: a second copy would be a second thing to be wrong when either
 * tool renames a flag.
 *
 *   claude    --dangerously-skip-permissions
 *   codex     --dangerously-bypass-approvals-and-sandbox
 *   opencode  --auto
 *
 * Codex's own description is "Skip all confirmation prompts and execute commands without
 * sandboxing. EXTREMELY DANGEROUS. Intended solely for running in environments that are
 * externally sandboxed" -- which is the honest summary of what this option does and why
 * it is not a default.
 */
export const BYPASS_ARGS: Record<string, string[]> = {
  claude: ['--dangerously-skip-permissions'],
  codex: ['--dangerously-bypass-approvals-and-sandbox'],
  opencode: ['--auto'],
}

/**
 * How each CLI describes its own permissive flag, verbatim.
 *
 * Recorded because the flags are NOT equally self-describing, and that asymmetry is a
 * hazard rather than a detail. Claude's and Codex's both begin `--dangerously`, so a
 * reader scanning a command line cannot miss them. OpenCode's is `--auto`, which reads
 * like a convenience and is not one -- its own help text is the only place the word
 * "dangerous" appears.
 *
 * A test asserts every entry in BYPASS_ARGS has a note here, so a fourth agent whose flag
 * is also blandly named cannot be added without someone reading what it does.
 */
export const BYPASS_NOTES: Record<string, string> = {
  claude: 'Bypass all permission checks. Recommended only for sandboxes with no internet access.',
  codex:
    'Skip all confirmation prompts and execute commands without sandboxing. EXTREMELY ' +
    'DANGEROUS. Intended solely for running in environments that are externally sandboxed.',
  opencode: 'auto-approve permissions that are not explicitly denied (dangerous!)',
}

/** Where the config lives for a project, whether or not it exists. */
export function configPath(projectRoot: string): string {
  return join(projectRoot, CONFIG_RELATIVE)
}

/**
 * Read the project's configuration. A missing file is not an error.
 *
 * A malformed one IS. The alternative -- treating unparseable JSON as absent -- means a
 * typo silently reinstates permission prompts, and the operator discovers it as a session
 * that stops on every command with no explanation of why their configuration did nothing.
 */
export function readProjectConfig(projectRoot: string): ProjectConfig {
  const path = configPath(projectRoot)
  if (!existsSync(path)) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`)
  }

  const config = parsed as ProjectConfig
  // Validated rather than coerced. `"permissions": "bypasss"` silently meaning `ask` is
  // the same failure as an unparseable file, reached by a shorter route.
  const check = (mode: unknown, where: string) => {
    if (mode !== undefined && mode !== 'ask' && mode !== 'bypass') {
      throw new Error(`${path}: ${where} must be "ask" or "bypass", not ${JSON.stringify(mode)}`)
    }
  }
  check(config.permissions, 'permissions')
  for (const [agent, entry] of Object.entries(config.agents ?? {})) {
    if (!(AGENT_KINDS as string[]).includes(agent)) {
      throw new Error(`${path}: unknown agent '${agent}'. Known: ${AGENT_KINDS.join(', ')}`)
    }
    check(entry?.permissions, `agents.${agent}.permissions`)
  }
  return config
}

/** The permission mode in force for one agent: its own entry, else the shared one. */
export function permissionModeFor(config: ProjectConfig, agent: string): PermissionMode {
  const own = (config.agents ?? {})[agent as AgentKind]?.permissions
  return own ?? config.permissions ?? 'ask'
}

/**
 * Launch arguments implied by the configuration, for one participant.
 *
 * Empty for an agent Conclave has no bypass flag for, rather than a guess. Inventing a
 * flag for an unknown CLI would at best be ignored and at worst mean something else.
 */
export function launchArgsFor(config: ProjectConfig, agent: string): string[] {
  if (permissionModeFor(config, agent) !== 'bypass') return []
  return BYPASS_ARGS[agent] ?? []
}
