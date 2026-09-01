import { execFileSync } from 'node:child_process'

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

/**
 * What a seat's subagents are, when the child has been HEARD to start them.
 *
 * `outstanding` is counted from `subagent_start` / `subagent_stop` (see `contract/session.ts`),
 * not guessed from a tool name, and that difference is why the wording differs too. The name
 * list can only say "the seat is inside a tool that usually means delegation", so it says
 * `waiting on a subagent (Task)` and keeps the tool name as the checkable part. An observed
 * count knows something stronger and narrower -- how many are running and since when -- and
 * says exactly that, without the claim that the parent is BLOCKED on them, which nothing here
 * observed. A parent can spawn work and carry on.
 *
 * @param elapsed formatted by the caller, so the duration beside a subagent count and the one
 * beside the seat itself are produced by the same function rather than by two that agree until
 * one of them is changed. `undefined` when nothing recorded a start time.
 */
export interface ObservedSubagents {
  /** Started and not yet seen to stop. Zero is the same as having observed nothing. */
  outstanding: number
  /** How long the oldest of them has been running, already formatted. */
  elapsed?: string | undefined
}

export function describeSubagentWork(
  /** The call the seat is in, if it is in one. Undefined between tool calls. */
  tool: string | undefined,
  observed?: ObservedSubagents | undefined,
): string | undefined {
  const n = observed?.outstanding ?? 0
  // No start was ever heard: the name list is all there is, and it is what the console has
  // always shown. Still the live path for any CLI that does not dispatch `SubagentStart` --
  // Claude Code 2.1.224 does not, 2.1.251 does -- and for the stretch of a turn before the
  // first start lands, so this branch is not a corner case even where both halves are heard.
  if (n <= 0) return tool === undefined ? undefined : describeTool(tool)

  const since = observed?.elapsed ? ` (${observed.elapsed})` : ''
  const count = n === 1 ? '1 subagent' : `${n} subagents`
  // The spawning call adds nothing once the count is known -- "waiting on a subagent (Task)"
  // and "1 subagent running" are the same sentence, one of them guessed. A tool that is NOT
  // delegation is different information: the parent is doing its own work alongside, and
  // dropping it would report a busy seat as idle-but-delegating.
  return tool === undefined || isSubagentTool(tool)
    ? `${count} running${since}`
    : `${tool} · ${count} running${since}`
}

/**
 * Worktrees attached to a repository, by path.
 *
 * The subagent rule -- "a subagent that MODIFIES anything must work in its own git worktree"
 * -- is a sentence in a briefing and nothing checks it. It cannot be ENFORCED from here: the
 * repository cannot distinguish a write by a subagent from a write by its parent, which is
 * the same limit `authority.ts` documents for attribution generally (#8).
 *
 * It can be OBSERVED. A run in which subagents were used and no worktree was ever created is
 * not proof of a violation, and it is the shape a violation takes -- which is worth putting
 * in the record rather than leaving to a reader who was not watching.
 *
 * Reported, never blocking. A subagent that only reads is explicitly allowed to use the
 * shared directory, so a zero here is often correct.
 */
export function worktreePaths(repoRoot: string): string[] {
  try {
    return execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim())
      .filter(Boolean)
  } catch {
    // Not a repository, or git is unavailable. Neither is this module's problem to report.
    return []
  }
}
