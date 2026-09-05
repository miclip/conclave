/**
 * Project-local configuration, from `.conclave/config.json`.
 *
 * The first thing in this codebase that reads a config file. `registry/types.ts` has
 * described the eventual shape for a while -- "global user config defining available
 * agents and personal defaults, project-local `.conclave/` config selecting agents and
 * assigning them to roles" -- and this WAS deliberately not that. It answered one question,
 * the one an operator actually hit: how do I stop being asked to approve every command.
 *
 * ## It is now half of that, and the reason is a dispatcher
 *
 * That decision was made when there were two seats and nothing that chose between them. With
 * a dispatcher and a seat list, "which seat should this work go to" became a question an
 * operator has to answer at every run by retyping the same thing, and #89 is the surface for
 * answering it once. So `roles` lives here: a role names a JOB, and a seat list may reference
 * one by name.
 *
 * Assigning AGENTS to roles is still not here, and the distinction is the point. A role's
 * `agent` and `model` are optional DEFAULTS the invocation overrides -- running the same job
 * against a cheaper model has to be a flag, not a config edit, because that comparison is
 * the experiment conclave exists to make cheap.
 *
 * ## What this file being machine-local costs, stated rather than discovered
 *
 * `.conclave/` is gitignored, and everything above about permissions is the reason. Roles do
 * not have that property -- "never touches migrations" is true for everyone who clones the
 * repository, not for one checkout -- so putting them here means they do NOT travel, and each
 * operator defines their own. That is a deliberate trade for keeping one config concept
 * rather than two; a committed role file is a bigger change, and it would need its own answer
 * about which layer wins.
 *
 * `.conclave/` is already gitignored and already holds machine-local state (the session
 * lock, scratch), which is where a decision this consequential belongs. It is a property
 * of one person's checkout on one machine, not of the project, and committing it would
 * hand everyone who clones the repository a session that never asks permission.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { BUILTIN_ROLES } from '../registry/roles.ts'
import {
  DENIABLE_CAPABILITIES,
  DENIABLE_COMMANDS,
  policyReasonFor,
  type OperatorDenials,
} from '../registry/operatorDenied.ts'
import { dirname, join } from 'node:path'
import type { AgentKind } from './install.ts'
import {  } from './install.ts'

export const CONFIG_RELATIVE = '.conclave/config.json'

/** Roles the code refers to by name, and which a config file therefore may not redefine. */
const BUILTIN_ROLE_IDS = Object.keys(BUILTIN_ROLES)

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

/**
 * A role an operator defined: a JOB, not a seat template.
 *
 * Name, description, and `agent`/`model` as OPTIONAL defaults the invocation may override.
 * That distinction is the whole design (#89). A role that hard-bound its agent and model
 * would make its own most interesting use awkward -- running the same job against a cheaper
 * model to see whether it holds up would mean editing config, when it should mean typing a
 * different flag.
 */
export interface RoleConfig {
  /** What the seat is for. Reaches the advisor's briefing and the seat's own instructions. */
  description: string
  /** Default agent for a seat in this role. Overridable per invocation. */
  agent?: string
  /** Default model, applied as `--model`. Overridable per invocation. */
  model?: string
}

/** The longest a role description may be. See `ROLE_DESCRIPTION_MAX`. */
export const ROLE_DESCRIPTION_MAX = 400

export interface ProjectConfig {
  /** Applied to every agent, and overridden by a per-agent entry. */
  permissions?: PermissionMode
  agents?: Partial<Record<AgentKind, AgentConfig>>
  /**
   * Roles this project can seat by name, keyed by the name `--implementers` will use.
   *
   * Machine-local like the rest of this file, which is a deliberate choice and a real
   * limitation: `.conclave/` is gitignored, so roles do NOT travel with the repository and
   * each checkout defines its own. A shared, committed role file is a bigger change than
   * #89 asked for and would need its own decision about precedence.
   */
  roles?: Record<string, RoleConfig>
  /**
   * Capabilities this project withholds from the advisor's briefing, by canonical name.
   *
   * DENY-ONLY, and the type says so: the value may only be `false`. See `operatorDenied.ts`
   * for why -- a declaration is something read off the installed CLI, and a config file that
   * could write `true` would be asserting a fact about another program on no evidence.
   *
   * Absent means absent. A project with no map here produces the run it produced before this
   * field existed, byte for byte, which is the identity `defaultUnchanged.test.ts` pins.
   */
  capabilities?: Record<string, false>
  /**
   * Slash commands this project withholds, by the name a policy declares, leading slash included.
   *
   * Also deny-only, and for a stronger reason. The refusals in `commandPolicy.ts` are not
   * preferences: they protect the continuity the relay believes it has, the transcript path
   * the parser latched, and the launch facts the run report states. Those are conclave's
   * guarantees, so `"/clear": true` is refused at read with the policy's own reason rather
   * than accepted and quietly dropped.
   */
  commands?: Record<string, false>
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
/**
 * Every agent that can hold a seat, which is NOT the same set as `AGENT_KINDS`.
 *
 * `AGENT_KINDS` is about REGISTRATION -- the agents that need hook files rendered into a
 * project. OpenCode and Kimi need none, so they are absent from it, and validating this file
 * against it rejected a configuration the CLI had just written itself:
 *
 *     $ conclave relay "..." --implementer opencode --bypass opencode
 *       permission mode for opencode set to BYPASS and written to .conclave/config.json
 *     conclave: .conclave/config.json: unknown agent 'opencode'. Known: claude, codex
 *
 * and every subsequent run in that project then failed at config read until someone
 * hand-edited the file. Permissions are a property of a SEAT, so the seat list is what this
 * has to be checked against.
 */
export const CONFIGURABLE_AGENTS = ['claude', 'codex', 'opencode', 'kimi'] as const

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
/**
 * Roles are refused at READ, which is startup, rather than at first dispatch.
 *
 * Same class as #82: a run that starts with a role nobody defined is a run that will fail
 * later, having already spent a boot and told the operator it was working. The three refusals
 * are the ones an operator can actually hit.
 *
 * The COLLISION refusal is the one that earns its place. `--implementers "claude"` names an
 * agent today and must keep doing so, so a role also called `claude` makes one invocation mean
 * two things. Resolution order alone would silently pick a winner; naming the conflict is the
 * only answer that leaves the operator's intent intact (#89).
 */
export function validateRoles(config: ProjectConfig, path: string): void {
  for (const [name, role] of Object.entries(config.roles ?? {})) {
    if (typeof role !== 'object' || role === null || Array.isArray(role)) {
      throw new Error(`${path}: roles.${name} must be an object with a description`)
    }
    if ((CONFIGURABLE_AGENTS as readonly string[]).includes(name)) {
      throw new Error(
        `${path}: role '${name}' has the same name as an agent, so --implementers "${name}" ` +
          `would mean two things. Rename the role. Agents: ${CONFIGURABLE_AGENTS.join(', ')}`,
      )
    }
    if ((BUILTIN_ROLE_IDS as readonly string[]).includes(name)) {
      throw new Error(
        `${path}: role '${name}' is a built-in role and cannot be redefined. The relay, the ` +
          `briefing and the run report all refer to it by name, so changing what it means here ` +
          `would change code that never reads this file. Built-in: ${BUILTIN_ROLE_IDS.join(', ')}`,
      )
    }
    if (typeof role.description !== 'string' || role.description.trim() === '') {
      throw new Error(
        `${path}: roles.${name}.description is required, and is what the advisor is told the ` +
          `seat is for. Without it a named seat is indistinguishable from an unnamed one.`,
      )
    }
    // Bounded because it lands in the advisor's prompt. Self-inflicted rather than hostile,
    // but an unbounded description can still push the actual instructions out of the way,
    // and failing here is cheaper than discovering it in a run's routing.
    if (role.description.length > ROLE_DESCRIPTION_MAX) {
      throw new Error(
        `${path}: roles.${name}.description is ${role.description.length} characters; the limit ` +
          `is ${ROLE_DESCRIPTION_MAX}. It is briefing prose the advisor reads before every ` +
          `routing decision, not documentation.`,
      )
    }
    if (role.agent !== undefined && !(CONFIGURABLE_AGENTS as readonly string[]).includes(role.agent)) {
      throw new Error(
        `${path}: roles.${name}.agent '${role.agent}' is not an agent. Known: ${CONFIGURABLE_AGENTS.join(', ')}`,
      )
    }
  }
}

/**
 * Refuse a `capabilities` or `commands` map that is malformed, names something unknown, or
 * tries to turn anything ON.
 *
 * AT READ, which is startup, for the reason `validateRoles` gives: a run that starts with a
 * configuration nobody can honour is a run that will behave wrongly later, having already
 * spent a boot and told the operator it was working. A denial that silently did nothing is
 * the worst of the three -- the operator believes a capability is withheld and briefs a human
 * accordingly, and it is not.
 *
 * WIDENING IS NAMED, NOT IGNORED. `true` gets its own refusal quoting the policy's reason
 * where there is one, because an operator writing `"/clear": true` has a model of what this
 * file can do, and the repair is to that model rather than to the line.
 */
export function validateDenials(config: ProjectConfig, path: string): void {
  const maps = [
    ['capabilities', config.capabilities, DENIABLE_CAPABILITIES, 'capability'],
    ['commands', config.commands, DENIABLE_COMMANDS, 'command'],
  ] as const
  for (const [field, map, known, noun] of maps) {
    if (map === undefined) continue
    if (typeof map !== 'object' || map === null || Array.isArray(map)) {
      throw new Error(
        `${path}: ${field} must be an object mapping ${noun} names to false, not ${JSON.stringify(map)}`,
      )
    }
    // Read as `unknown`, because the declared type is `false` and the file on disk is not
    // bound by it. TypeScript would call `value === true` unreachable and it is the single
    // most likely thing an operator actually writes.
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
      if (!known.includes(key)) {
        throw new Error(
          `${path}: ${field}.${key} is not a ${noun} anything declares. Known: ${known.join(', ')}`,
        )
      }
      if (value === true) {
        const because = noun === 'command' ? policyReasonFor(key) : undefined
        throw new Error(
          `${path}: ${field}.${key} is true. This file may only NARROW what an adapter ` +
            `declares, never widen it: a ${noun} is available because it was read off the ` +
            `installed CLI and weighed there, and turning one on here would assert something ` +
            `nobody checked.${because ? ` ${key} is refused because: ${because}` : ''} Remove ` +
            `the entry to leave ${key} as declared, or set it to false to withhold it.`,
        )
      }
      if (value !== false) {
        throw new Error(
          `${path}: ${field}.${key} must be false, not ${JSON.stringify(value)}. The only thing ` +
            `this file can say about a ${noun} is that this project declines it.`,
        )
      }
    }
  }
}

/**
 * What one project denies, or `undefined` when it denies nothing.
 *
 * `undefined` rather than a pair of empty arrays, and the distinction is the identity rule:
 * `Relay.start` spreads this key in only when it is present, so a project with no maps hands
 * the relay exactly the options it handed before the maps existed. An empty-array denial would
 * be equivalent in behaviour and not identical in what is passed, and equivalence is what
 * erodes.
 */
export function denialsFrom(config: ProjectConfig): OperatorDenials | undefined {
  const capabilities = Object.keys(config.capabilities ?? {})
  const commands = Object.keys(config.commands ?? {})
  if (capabilities.length === 0 && commands.length === 0) return undefined
  return { capabilities, commands }
}

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
  validateRoles(config, path)
  validateDenials(config, path)
  for (const [agent, entry] of Object.entries(config.agents ?? {})) {
    if (!(CONFIGURABLE_AGENTS as readonly string[]).includes(agent)) {
      throw new Error(
        `${path}: unknown agent '${agent}'. Known: ${CONFIGURABLE_AGENTS.join(', ')}`,
      )
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

/**
 * Set the permission mode for a project, preserving everything else in the file.
 *
 * Written rather than held for one run, because the operator asking for it almost never
 * means "just this once" -- they mean "stop asking me in this project". A flag that applied
 * only to the current invocation would be re-typed every time and eventually put in a shell
 * alias, which is the same persistence with none of the visibility.
 *
 * Merged, never replaced. A file already carrying per-agent entries keeps them; only the
 * key being set changes. Overwriting would silently discard a narrower policy the operator
 * had deliberately configured.
 *
 * The caller is expected to SAY what this did. `.conclave/` is gitignored, so the change is
 * machine-local and invisible to everyone else -- including to the same operator tomorrow,
 * who will not remember typing the flag.
 */
export function setPermissionMode(
  projectRoot: string,
  mode: PermissionMode,
  agent?: string,
): { path: string; previous: PermissionMode | undefined } {
  // Validated BEFORE the write, not only on the next read. `--bypass claud` used to be
  // written happily and then rejected by every subsequent run, which is a typo turned into a
  // broken project.
  if (agent !== undefined && !(CONFIGURABLE_AGENTS as readonly string[]).includes(agent)) {
    throw new Error(
      `unknown agent '${agent}'. Known: ${CONFIGURABLE_AGENTS.join(', ')}`,
    )
  }
  const path = configPath(projectRoot)
  // Read through the validating reader: a file that is already malformed must be reported
  // rather than silently replaced by this write.
  const config = readProjectConfig(projectRoot)
  const previous = agent
    ? ((config.agents ?? {})[agent as AgentKind]?.permissions ?? undefined)
    : config.permissions

  const next: ProjectConfig = agent
    ? { ...config, agents: { ...(config.agents ?? {}), [agent]: { ...(config.agents ?? {})[agent as AgentKind], permissions: mode } } }
    : { ...config, permissions: mode }

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
  return { path, previous }
}
