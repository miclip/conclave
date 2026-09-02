/**
 * Built-in agent definitions.
 *
 * These are the defaults global user configuration will eventually supply and override.
 * Registering Codex without a `create` is deliberate: it can be listed, described and
 * conformance-graded while remaining unconstructible, which keeps its lower confidence
 * visible instead of making it look finished by being absent.
 */

import type { AgentSession } from '../contract/session.ts'
import type { RoleDefinition, RoleId } from './roles.ts'
import { ClaudePtyHookAdapter } from '../adapters/claude.ts'
import { CodexPtyHookAdapter } from '../adapters/codex.ts'
import { OpenCodeRunAdapter } from '../adapters/opencode.ts'
import { KimiPrintAdapter } from '../adapters/kimi.ts'
import {
  CLAUDE_CAPABILITIES,
  CODEX_CAPABILITIES,
  KIMI_CAPABILITIES,
  OPENCODE_CAPABILITIES,
} from '../conformance/capabilities.ts'
import { assertCodexHooksExecutable, CONCLAVE_HOOK_MATCH } from '../deployment/codexHookTrust.ts'
import { DEFAULT_IDLE_MS, DEFAULT_WATCHDOG_MS } from '../outcomes/watchdog.ts'
import { effectiveLaunchArgs } from './launch.ts'
import {
  claudeAliasOf,
  claudeAliases,
  isClaudeAliasShaped,
  opencodeModels,
  type ModelSupport,
} from './models.ts'
import {
  CLAUDE_COMMAND_POLICY,
  CODEX_COMMAND_POLICY,
  NO_COMPOSER_COMMAND_POLICY,
} from './commandPolicy.ts'
import {
  CLAUDE_INSTRUCTION_CAPABILITIES,
  CODEX_INSTRUCTION_CAPABILITIES,
  KIMI_INSTRUCTION_CAPABILITIES,
  OPENCODE_INSTRUCTION_CAPABILITIES,
} from './instructionCapabilities.ts'
import { AgentRegistry } from './registry.ts'
import type {
  AgentDefinition,
  CreateParticipantContext,
  DeadlineSupport,
  ResolvedParticipant,
} from './types.ts'

/**
 * Where each `executable.install` hint below came from.
 *
 * Every one of the four is the install that produced the COPY THESE ADAPTERS WERE MEASURED
 * AGAINST, read back off that machine rather than transcribed from a vendor page: `@openai/codex@0.147.0`
 * and `opencode-ai@1.18.15` are npm globals, `kimi` is a `uv` tool shim naming
 * `~/.local/share/uv/tools/kimi-cli`, and `claude` is the native binary the install script places
 * in `~/.local/bin`. The provenance is stated because a hint is a line an operator will paste, and
 * an install command with no source is a claim about someone else's machine.
 *
 * A hint is NEVER run by anything -- it is quoted into a refusal and nothing else. If one of these
 * goes stale the cost is a wrong suggestion beside a correct diagnosis, not a wrong diagnosis.
 */
const INSTALL_HINT_SOURCE = 'the install these adapters were measured against'

/**
 * The pty+hook adapters. Both drive `TurnWatchdog`, which owns a timer per armed turn and
 * runs the silence clock alongside the absolute one, defaulting both when unasked.
 */
const PTY_HOOK_DEADLINES: DeadlineSupport = {
  absolute: { supported: true, defaultMs: DEFAULT_WATCHDOG_MS },
  silence: { supported: true, defaultMs: DEFAULT_IDLE_MS },
}

/**
 * The headless run-per-turn adapters. Both hold a bare `setTimeout` armed only when a
 * `watchdogMs` is passed, so an unconfigured run has no deadline whatsoever -- and neither
 * tracks activity within a turn, so there is nothing a silence clock could be measured
 * against. `unsupported` rather than a default nobody enforces: a turn that goes quiet on
 * these seats produces no verdict at all, and that is what a reader needs told.
 */
const RUN_PER_TURN_DEADLINES: DeadlineSupport = {
  absolute: { supported: true },
  silence: { supported: false },
}

/*
 * Which is why neither `create` below forwards `ctx.idleMs`, and the omission is the honest
 * spelling rather than an oversight. `--silence-timeout` is ACCEPTED on a run that seats one
 * of these -- refusing it would discard a setting the supported seats in the same run are
 * entitled to -- and what the seat gets is not a silence clock but a report saying it has
 * none. `resolveClock` returns `unsupported` for a declared `supported: false` however hard
 * the run configured one, so the truth survives per seat instead of being averaged into a
 * refusal or, worse, into a number this adapter would never enforce.
 */

/**
 * Claude Code names its aliases and nothing else, so only aliases are judged.
 *
 * Measured on 2.1.227: there is no `claude models` subcommand, `--model` with no value opens an
 * interactive picker, and `--help` prints the option text quoted in `claudeAliases`. That text
 * says an alias OR a full model name is accepted and enumerates only the first kind, which is
 * exactly the graded middle this field exists for -- a full name goes to the child unjudged, and
 * `--model opus-5`, the spelling that produced #82, is judged and refused.
 *
 * The honest limit, stated because it is the risk this grade carries: the help calls its three
 * aliases an example ("e.g. 'fable', 'opus', or 'sonnet'"), so an alias claude accepts and does
 * not print here would be refused. The escape hatch needs no flag and no code -- the full model
 * name is passed through -- and the alternative, treating the one enumeration claude offers as
 * advisory, would decline to catch the bug that was actually reported.
 */
const CLAUDE_MODELS: ModelSupport = {
  grade: 'aliases_only',
  ask: { command: 'claude', args: ['--help'], parse: claudeAliases },
  judges: isClaudeAliasShaped,
  normalize: claudeAliasOf,
  noun: 'alias',
  nounPlural: 'aliases',
}

export const CLAUDE_AGENT: AgentDefinition = {
  id: 'claude',
  displayName: 'Claude Code',
  capabilities: CLAUDE_CAPABILITIES,
  deadlines: PTY_HOOK_DEADLINES,
  models: CLAUDE_MODELS,
  instructionCapabilities: CLAUDE_INSTRUCTION_CAPABILITIES,
  // All four definitions in this file declare a policy (#200), in one of the two shapes the
  // union offers: the pty seats carry a list read out of their installed bundle, and the two
  // run-per-turn seats carry `unsupported`, which is a statement about having no composer
  // rather than a refusal of any particular verb. Absence would mean a third thing -- nobody
  // looked -- and after this change no built-in is in that state.
  commandPolicy: CLAUDE_COMMAND_POLICY,
  launch: {
    command: 'claude',
    // The adapter supplies --settings itself, pointing at a generated hook registration
    // rather than mutating the user's configuration.
    baseArgs: [],
    executable: { install: 'curl -fsSL https://claude.ai/install.sh | bash', installFrom: INSTALL_HINT_SOURCE },
  },
  async create(resolved: ResolvedParticipant, ctx: CreateParticipantContext): Promise<AgentSession> {
    return ClaudePtyHookAdapter.start({
      cwd: ctx.cwd,
      command: resolved.agent.launch.command,
      role: resolved.role.id,
      inputOwnership: resolved.inputOwnership,
      args: effectiveLaunchArgs(resolved, ctx),
      watchdogMs: ctx.watchdogMs,
      idleMs: ctx.idleMs,
      readyTimeoutMs: ctx.readyTimeoutMs,
    })
  },
}

/**
 * Codex cannot be asked, so nothing about a Codex model selection is claimed.
 *
 * `codex models` exists and is TTY-gated: run with stdin not a terminal it prints
 * `Error: stdin is not a terminal` and lists nothing, which is what a preflight check has. Giving
 * it a pty purely to read a list would mean driving a full-screen picker to scrape it, and a
 * scrape of a TUI is a model list held in Conclave by another name -- stale the first time the
 * screen changes, and wrong in the direction that refuses valid input.
 *
 * `unsupported` rather than a guess, and the run still starts: a Codex seat with a bad model is
 * left to the second half of #82, where a first turn that produces nothing at all says the model
 * may be why.
 */
const CODEX_MODELS: ModelSupport = {
  grade: 'unsupported',
  noun: 'model',
  nounPlural: 'models',
  reason:
    '`codex models` requires a terminal (`Error: stdin is not a terminal` on 0.147.0), so codex ' +
    'cannot be asked which models it accepts without driving its picker',
}

export const CODEX_AGENT: AgentDefinition = {
  id: 'codex',
  displayName: 'Codex CLI',
  capabilities: CODEX_CAPABILITIES,
  deadlines: PTY_HOOK_DEADLINES,
  models: CODEX_MODELS,
  instructionCapabilities: CODEX_INSTRUCTION_CAPABILITIES,
  commandPolicy: CODEX_COMMAND_POLICY,
  launch: {
    command: 'codex',
    executable: { install: 'npm install -g @openai/codex', installFrom: INSTALL_HINT_SOURCE },
    baseArgs: [
      '-c', 'check_for_update_on_startup=false',
      '-c', 'disable_paste_burst=true',
    ],
    suppresses: {
      check_for_update_on_startup:
        'The startup update dialog consumes typed input. During spike 1 its default ' +
        'selection ran `npm install -g @openai/codex` mid-run.',
      disable_paste_burst:
        'Paste-burst coalescing can swallow the submit when text and Enter arrive close ' +
        'together.',
    },
    deploymentState: [
      'Directory trust: `[projects."<cwd>"] trust_level` in ~/.codex/config.toml.',
      'Hook trust: `[hooks.state."<file>:<event>:<group>:<index>"] trusted_hash` in the ' +
        'USER-level ~/.codex/config.toml, even though the hooks are project-local. An ' +
        'untrusted hook is loaded, listed and enabled, and never runs. Verified on ' +
        '0.146.0: the hash covers the normalised handler (command, type, async, timeout), ' +
        'not the file bytes -- reformatting hooks.json does not re-prompt, but changing a ' +
        'command or timeout flips trustStatus to `modified` and requires re-trusting. ' +
        'Check with deployment/codexHookTrust.ts before launching.',
    ],
  },
  // Wired ahead of the adapter so it cannot be forgotten when the adapter lands: a
  // Codex session whose hooks are enabled-but-untrusted has no turn-completion signal.
  preflight: async (_resolved, ctx) => {
    await assertCodexHooksExecutable(ctx.cwd, CONCLAVE_HOOK_MATCH)
  },
  async create(resolved: ResolvedParticipant, ctx: CreateParticipantContext): Promise<AgentSession> {
    return CodexPtyHookAdapter.start({
      cwd: ctx.cwd,
      command: resolved.agent.launch.command,
      role: resolved.role.id,
      inputOwnership: resolved.inputOwnership,
      args: effectiveLaunchArgs(resolved, ctx),
      watchdogMs: ctx.watchdogMs,
      idleMs: ctx.idleMs,
      readyTimeoutMs: ctx.readyTimeoutMs,
    })
  },
}

/**
 * Approval settings that force a permission dialog.
 *
 * Deliberately NOT part of the launch spec. With default settings Codex auto-approved an
 * out-of-workspace write and no dialog appeared at all, so these are needed to exercise
 * permission flows -- but making them the default would change production behaviour into
 * something more restrictive than a user asked for. Pass them per participant.
 */
export const CODEX_PROMPT_ON_APPROVAL_ARGS = [
  '-c', 'approval_policy="on-request"',
  '-c', 'sandbox_mode="read-only"',
]

/**
 * OpenCode, via `run --format json`.
 *
 * Note what is absent: no `deploymentState`, no `preflight`, no `suppresses`. Nothing has
 * to be installed, registered or trusted before a session can start, because the lifecycle
 * arrives on stdout in a mode the CLI already supports. Both other agents needed a rendered
 * hook registration in the project, and Codex additionally needs that registration trusted
 * in a USER-level file before its hooks will run at all.
 *
 * `baseArgs` is empty on purpose. The adapter composes `run --format json [--session id]`
 * itself, since those are not user-tunable without breaking it, and MODEL SELECTION comes
 * from participant `args` -- `-m provider/model`. That is the whole reason OpenCode widens
 * what Conclave can drive: any model OpenCode can reach is reachable through the same
 * adapter, without Conclave ever holding a model API key or speaking to a provider.
 */
/**
 * OpenCode enumerates, so an absent name is refused rather than launched.
 *
 * `opencode models` prints one `provider/model` per line and exits -- 60 of them on 1.18.15, over
 * every provider the operator has configured. That makes absence a FACT about this installation
 * rather than an absence of knowledge, which is the only condition under which a strict refusal
 * is honest. It is also the agent where the refusal matters most: model selection is the entire
 * reason OpenCode widens what Conclave can drive, so its `-m provider/model` is the argument most
 * likely to be typed by hand and mistyped.
 */
const OPENCODE_MODELS: ModelSupport = {
  grade: 'enumerated',
  ask: { command: 'opencode', args: ['models'], parse: opencodeModels },
  noun: 'model',
  nounPlural: 'models',
}

export const OPENCODE_AGENT: AgentDefinition = {
  id: 'opencode',
  displayName: 'OpenCode',
  capabilities: OPENCODE_CAPABILITIES,
  deadlines: RUN_PER_TURN_DEADLINES,
  models: OPENCODE_MODELS,
  instructionCapabilities: OPENCODE_INSTRUCTION_CAPABILITIES,
  commandPolicy: NO_COMPOSER_COMMAND_POLICY,
  launch: {
    command: 'opencode',
    baseArgs: [],
    executable: { install: 'npm install -g opencode-ai', installFrom: INSTALL_HINT_SOURCE },
  },
  async create(resolved: ResolvedParticipant, ctx: CreateParticipantContext): Promise<AgentSession> {
    return OpenCodeRunAdapter.start({
      cwd: ctx.cwd,
      command: resolved.agent.launch.command,
      role: resolved.role.id,
      inputOwnership: resolved.inputOwnership,
      args: effectiveLaunchArgs(resolved, ctx),
      watchdogMs: ctx.watchdogMs,
    })
  },
}

/**
 * Kimi CLI, via `--print --output-format stream-json`.
 *
 * Like OpenCode: nothing to install, register or trust. Unlike OpenCode, its headless mode
 * emits the CONVERSATION rather than a lifecycle, so completion is inferred rather than
 * announced -- see KIMI_CAPABILITIES.
 *
 * Model and provider come from participant `args`, normally `--config-file <path>` pointing
 * at a generated TOML naming an OpenAI-compatible provider. Conclave holds no key: the file
 * is the user's, and the REPL is the integration.
 */
/**
 * Kimi has no enumeration, and its model normally is not on the argv at all.
 *
 * `kimi models` is not a command (`No such command 'models'` on 1.49.0). The adapter selects the
 * model through the `--config-file` TOML it generates, naming an OpenAI-compatible provider that
 * is the operator's own -- so the set of valid names is a property of THEIR endpoint, which no
 * question to the CLI could answer. `modelFromArgs` already reports `null` for that shape, so in
 * the ordinary case nothing is checked because nothing was selected; this grade covers the case
 * where `-m` was passed through anyway.
 */
const KIMI_MODELS: ModelSupport = {
  grade: 'unsupported',
  noun: 'model',
  nounPlural: 'models',
  reason:
    'kimi has no `models` command (1.49.0) and takes its model from the provider config file the ' +
    'adapter generates, so the valid names belong to the operator’s endpoint rather than to the CLI',
}

export const KIMI_AGENT: AgentDefinition = {
  id: 'kimi',
  displayName: 'Kimi CLI',
  capabilities: KIMI_CAPABILITIES,
  deadlines: RUN_PER_TURN_DEADLINES,
  models: KIMI_MODELS,
  instructionCapabilities: KIMI_INSTRUCTION_CAPABILITIES,
  commandPolicy: NO_COMPOSER_COMMAND_POLICY,
  launch: {
    command: 'kimi',
    baseArgs: [],
    executable: { install: 'uv tool install kimi-cli', installFrom: INSTALL_HINT_SOURCE },
  },
  async create(resolved: ResolvedParticipant, ctx: CreateParticipantContext): Promise<AgentSession> {
    return KimiPrintAdapter.start({
      cwd: ctx.cwd,
      command: resolved.agent.launch.command,
      role: resolved.role.id,
      inputOwnership: resolved.inputOwnership,
      args: effectiveLaunchArgs(resolved, ctx),
      watchdogMs: ctx.watchdogMs,
    })
  },
}

export function defaultRegistry(roles?: Record<RoleId, RoleDefinition>): AgentRegistry {
  return new AgentRegistry(roles).register(CLAUDE_AGENT).register(CODEX_AGENT).register(OPENCODE_AGENT).register(KIMI_AGENT)
}
