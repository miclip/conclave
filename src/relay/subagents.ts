/**
 * Naming subagent work, which is otherwise invisible while it happens.
 *
 * Both participants are told to use subagents, and that made a whole class of work opaque in
 * the same change. An operator watching a delegating turn sees this and nothing else:
 *
 *     ⋯ advisor 2m39s · wait_agent
 *
 * A raw tool name and a rising clock. `wait_agent` does not say that another model is doing
 * the work, does not say how many, and reads like an internal detail rather than the most
 * significant thing happening in the session.
 *
 * ## Why a name list rather than an adapter capability
 *
 * The four agents spawn subagents through four differently-named tools, and none of them
 * announces "this is delegation" in any structured field. A vocabulary is therefore the only
 * thing available, and pretending otherwise -- adding a `spawnsSubagent` flag to the contract
 * that every adapter has to fill in from the same string comparison -- would move the guess
 * without removing it.
 *
 * The list is deliberately conservative. A false positive tells an operator a subagent is
 * running when nothing is, which is worse than the raw tool name it replaces: the raw name is
 * at least true.
 */

/**
 * Tools that mean "another model is now doing this".
 *
 * Sources, so a future reader can check rather than trust:
 *   Task        Claude Code's subagent tool
 *   wait_agent  Codex, and the one an operator actually reported seeing
 *   task        OpenCode (`permission.task` exists in its config schema)
 *   Subagent    Kimi, which also emits SubagentStart/SubagentStop hooks
 */
const SUBAGENT_TOOLS = new Set(['task', 'wait_agent', 'subagent', 'spawn_agent', 'agent'])

export function isSubagentTool(tool: string): boolean {
  return SUBAGENT_TOOLS.has(tool.trim().toLowerCase())
}

/**
 * What to show an operator for a tool call, in place of the bare name.
 *
 * Returns undefined when there is nothing better to say, so the caller keeps its existing
 * rendering rather than this module inventing one for every tool in the world.
 */
export function describeTool(tool: string): string | undefined {
  return isSubagentTool(tool) ? `waiting on a subagent (${tool})` : undefined
}
