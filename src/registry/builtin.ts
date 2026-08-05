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
import { CLAUDE_CAPABILITIES, CODEX_CAPABILITIES } from '../conformance/capabilities.ts'
import { assertCodexHooksExecutable } from '../deployment/codexHookTrust.ts'
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
    await assertCodexHooksExecutable(ctx.cwd, 'hook_post.py')
  },
  // No adapter yet. Its hook lifecycle is entirely unverified -- SessionStart did not
  // fire at boot or on thread/start, and every Stop scenario needs a real turn.
  unavailableReason:
    'hook lifecycle unverified; awaiting current-version fixtures after the quota reset',
}

export function defaultRegistry(): AgentRegistry {
  return new AgentRegistry().register(CLAUDE_AGENT).register(CODEX_AGENT)
}
