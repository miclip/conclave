/**
 * Built-in agent definitions.
 *
 * These are the defaults global user configuration will eventually supply and override.
 * Registering Codex without a `create` is deliberate: it can be listed, described and
 * conformance-graded while remaining unconstructible, which keeps its lower confidence
 * visible instead of making it look finished by being absent.
 */

import type { AgentSession } from '../contract/session.ts'
import { ClaudePtyHookAdapter } from '../adapters/claude.ts'
import { CodexPtyHookAdapter } from '../adapters/codex.ts'
import { OpenCodeRunAdapter } from '../adapters/opencode.ts'
import {
  CLAUDE_CAPABILITIES,
  CODEX_CAPABILITIES,
  OPENCODE_CAPABILITIES,
} from '../conformance/capabilities.ts'
import { assertCodexHooksExecutable, CONCLAVE_HOOK_MATCH } from '../deployment/codexHookTrust.ts'
import { AgentRegistry } from './registry.ts'
import type { AgentDefinition, CreateParticipantContext, ResolvedParticipant } from './types.ts'

export const CLAUDE_AGENT: AgentDefinition = {
  id: 'claude',
  displayName: 'Claude Code',
  capabilities: CLAUDE_CAPABILITIES,
  launch: {
    command: 'claude',
    // The adapter supplies --settings itself, pointing at a generated hook registration
    // rather than mutating the user's configuration.
    baseArgs: [],
  },
  async create(resolved: ResolvedParticipant, ctx: CreateParticipantContext): Promise<AgentSession> {
    return ClaudePtyHookAdapter.start({
      cwd: ctx.cwd,
      role: resolved.role.id,
      inputOwnership: resolved.inputOwnership,
      args: [...resolved.agent.launch.baseArgs, ...(resolved.spec.args ?? []), ...(ctx.args ?? [])],
      watchdogMs: ctx.watchdogMs,
      readyTimeoutMs: ctx.readyTimeoutMs,
    })
  },
}

export const CODEX_AGENT: AgentDefinition = {
  id: 'codex',
  displayName: 'Codex CLI',
  capabilities: CODEX_CAPABILITIES,
  launch: {
    command: 'codex',
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
      role: resolved.role.id,
      inputOwnership: resolved.inputOwnership,
      args: [...resolved.agent.launch.baseArgs, ...(resolved.spec.args ?? []), ...(ctx.args ?? [])],
      watchdogMs: ctx.watchdogMs,
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
export const OPENCODE_AGENT: AgentDefinition = {
  id: 'opencode',
  displayName: 'OpenCode',
  capabilities: OPENCODE_CAPABILITIES,
  launch: {
    command: 'opencode',
    baseArgs: [],
  },
  async create(resolved: ResolvedParticipant, ctx: CreateParticipantContext): Promise<AgentSession> {
    return OpenCodeRunAdapter.start({
      cwd: ctx.cwd,
      role: resolved.role.id,
      inputOwnership: resolved.inputOwnership,
      args: [...resolved.agent.launch.baseArgs, ...(resolved.spec.args ?? []), ...(ctx.args ?? [])],
      watchdogMs: ctx.watchdogMs,
    })
  },
}

export function defaultRegistry(): AgentRegistry {
  return new AgentRegistry().register(CLAUDE_AGENT).register(CODEX_AGENT).register(OPENCODE_AGENT)
}
