/**
 * What each built-in agent can be INSTRUCTED to do, and what that claim was read from.
 *
 * Separate from `src/conformance/capabilities.ts` on purpose, and the separation is not
 * filing. That file holds `AdapterCapabilities`, which `checkAdapter` grades against captured
 * recordings; these claims have no recording and cannot get one by that route, so keeping them
 * out of the graded structure is what stops them looking checked by association. See
 * `InstructionCapabilities` in `./types.ts` for the argument in full.
 *
 * HOW THESE WERE DERIVED. Each claim was read off the copy of the CLI installed on the machine
 * these adapters were measured against, by one of five routes: the CLI's own `--help`, a string
 * in its shipped bundle or binary, `codex features list`, `opencode agent list`, or the Python
 * package `kimi-cli` installs. Every `source` below quotes closely enough to be searched for
 * again, and every one was re-run against the installed binary rather than transcribed.
 *
 * WHY EVERY GRADE IS `inferred_from_documented_event`. That level is "Derived from an event the
 * vendor documents or the binary declares, not yet seen". No claim here has been produced in a
 * run with a fixture captured, so NONE of them is `observed`, and none may be promoted to it by
 * anything short of a recording. An advertisement is not a behaviour.
 *
 * WHY THE ABSENCES ARE ABSENCES. A capability with no entry is UNRESOLVED, not refuted: it was
 * not advertised in any source searched, which proves nothing about whether the CLI can do it.
 * `undefined` is the honest spelling of that, and it is why no field here carries
 * `supported: false` -- a declared `false` would assert a gap nobody established. Notably
 * `turnBoundedLifetime` is absent for all four: every one of them advertises starting background
 * work and not one of them advertises when it ends.
 *
 * WHEN THIS GOES STALE. Each `sourceVersion` is the version literal that CLI prints for itself,
 * verbatim, so a freshness check is a string comparison against `--version` and needs no parser.
 * When the installed version moves, these claims are STALE and their `evidence` is unchanged --
 * see `GradedClaim`. Re-derive by re-running the routes named above; nothing watches these four
 * CLIs on our behalf, and `SubagentStart` arriving between Claude Code 2.1.224 and 2.1.251 is
 * what that drift looks like when it happens.
 */

import type { InstructionCapabilities } from './types.ts'

/** Verbatim `claude --version`. */
const CLAUDE_VERSION = '2.1.325 (Claude Code)'
/** Verbatim `codex --version`. */
const CODEX_VERSION = 'codex-cli 0.153.4'
/** Verbatim `opencode --version`. */
const OPENCODE_VERSION = '1.18.15'
/** Verbatim `kimi --version`. */
const KIMI_VERSION = 'kimi, version 1.49.0'

export const CLAUDE_INSTRUCTION_CAPABILITIES: InstructionCapabilities = {
  subagents: {
    supported: true,
    evidence: 'inferred_from_documented_event',
    source: '`claude --help`: `--agents <json-or-file>  JSON object defining custom agents, or with --print the path to a file that holds one`; `Task` and `Agent` in the installed bundle',
    // Not the `--help` line: that text is generated and its spacing shifts between builds, so a
    // search on it fails for formatting rather than for truth.
    probes: ['--agents', 'Task'],
    sourceVersion: CLAUDE_VERSION,
  },
  backgroundTasks: {
    supported: true,
    evidence: 'inferred_from_documented_event',
    // Sourced from the bundle rather than from `--help`. `--help` offers only `claude agents`,
    // "Manage background agents", and those are the detached SESSIONS `--bg` starts -- which is
    // `sessionBackgrounding` below, not this. `run_in_background` is the in-turn form, and it is
    // the same shape as the literal kimi advertises for the same capability.
    source: '`run_in_background` in the installed bundle',
    probes: ['run_in_background'],
    sourceVersion: CLAUDE_VERSION,
  },
  sessionBackgrounding: {
    supported: true,
    evidence: 'inferred_from_documented_event',
    source: '`claude --help`: `--bg, --background  Start the session in the background and return immediately. Prints the id that `claude attach`, `logs`, `stop` and `rm` take; `claude agents` lists them`, with `claude attach <id|name>`',
    probes: ['--background'],
    sourceVersion: CLAUDE_VERSION,
  },
  autonomousLoop: {
    supported: true,
    evidence: 'inferred_from_documented_event',
    // Measured against 2.1.325: the bundle advertises a time-based auto-expiry on recurring/cron
    // loops -- `recurringMaxAgeMs`, "Recurring tasks auto-expire after ", "auto-expired after ",
    // "-day limit when scheduling recurring jobs". The number of days is interpolated, so it
    // cannot be read from the string. `ScheduleWakeup`'s "Clamped to [60, 3600]" bounds the
    // interval between iterations, not how many there are. No iteration cap like kimi's below was
    // found. Whether the expiry is the same kind of bound as kimi's is open: see #407.
    source: '`ProposeGoalTool` and `<<autonomous-loop>>` in the installed bundle',
    probes: ['ProposeGoalTool', 'autonomous-loop'],
    sourceVersion: CLAUDE_VERSION,
  },
}

export const CODEX_INSTRUCTION_CAPABILITIES: InstructionCapabilities = {
  subagents: {
    supported: true,
    evidence: 'inferred_from_documented_event',
    // Measured against 0.153.4: the claim rests on the `multi_agent  stable  true` row, which is
    // on by default. `multi_agent_v2` is a separate config table
    // (`features.multi_agent_v2.max_concurrent_threads_per_session`, `...wait_timeout_ms`) and
    // `stable false`, so it is off unless opted into and does not carry the claim. The removed
    // `multi_agent_mode` survives only as a protocol/context field name, not as a feature row.
    source: '`codex features list`: `multi_agent  stable  true`; `spawn_agent`, `wait_agent`, `close_agent` in the installed binary',
    probes: ['spawn_agent', 'wait_agent', 'close_agent'],
    sourceVersion: CODEX_VERSION,
  },
  backgroundTasks: {
    supported: true,
    evidence: 'inferred_from_documented_event',
    // The source and the probe are the same string, so nothing else cross-checks it -- these are
    // the neighbours that do, measured against 0.153.4. It sits in the TUI strings beside
    // `tui/src/history_cell/exec.rs`, "Interacted with background terminal: " and
    // "... and N more running", and config carries `background_terminal_max_timeout`: a terminal
    // left running in the background that the agent later waits on or interacts with.
    source: '"Waited for background terminal: " in the installed binary',
    probes: ['Waited for background terminal: '],
    sourceVersion: CODEX_VERSION,
  },
  autonomousLoop: {
    supported: true,
    evidence: 'inferred_from_documented_event',
    // Measured against 0.153.4: a model-facing `create_goal` tool ("The concrete objective to
    // start pursuing. This starts a new active goal..."), a `goals/continuation.md` prompt
    // ("Continue working toward the active thread goal."), and the harness submitting the next
    // turn itself: "skipping goal continuation because turn input submission failed",
    // "...because automatic idle work was rejected". So the goal is not merely persisted across
    // turns; the harness dispatches the continuation.
    //
    // The bound found is a per-goal `token_budget` (`budget_limited`), plus a "blocked audit"
    // of three consecutive goal turns -- and that audit is an instruction to the MODEL about
    // when to mark a goal blocked, not a cap the harness enforces. No iteration count like
    // kimi's below was found. Whether a token budget is the same kind of bound is open: see
    // #409. Nothing here says whether 0.147.0 had this; it was not checked.
    source: '`create_goal` tool and "...counting the original/user-triggered turn and any automatic goal continuations" in the installed binary',
    probes: ['create_goal', 'automatic goal continuations'],
    sourceVersion: CODEX_VERSION,
  },
}

export const OPENCODE_INSTRUCTION_CAPABILITIES: InstructionCapabilities = {
  subagents: {
    supported: true,
    evidence: 'inferred_from_documented_event',
    source: '`opencode agent list`: `explore (subagent)` and `general (subagent)`',
    sourceVersion: OPENCODE_VERSION,
  },
  backgroundTasks: {
    supported: true,
    evidence: 'inferred_from_documented_event',
    source: '`experimental.session.background` in the installed bundle',
    probes: ['experimental.session.background'],
    sourceVersion: OPENCODE_VERSION,
  },
  asyncPromptSubmission: {
    supported: true,
    evidence: 'inferred_from_documented_event',
    // The only one of the four advertising this at all.
    source: '`session.prompt_async` in the installed bundle',
    probes: ['session.prompt_async'],
    sourceVersion: OPENCODE_VERSION,
  },
  boundedIteration: {
    supported: true,
    evidence: 'inferred_from_documented_event',
    source: '"The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input." in the installed bundle',
    probes: ['The maximum number of steps allowed for this task has been reached.'],
    sourceVersion: OPENCODE_VERSION,
  },
}

export const KIMI_INSTRUCTION_CAPABILITIES: InstructionCapabilities = {
  subagents: {
    supported: true,
    evidence: 'inferred_from_documented_event',
    source: '`tools/agent/description.md` in the installed package: "Start a subagent instance to work on a focused task."; `subagent_type` throughout',
    sourceVersion: KIMI_VERSION,
  },
  backgroundTasks: {
    supported: true,
    evidence: 'inferred_from_documented_event',
    source: '`tools/shell/bash.md` in the installed package: `run_in_background=true` "will return a task ID instead of waiting for command completion"',
    sourceVersion: KIMI_VERSION,
  },
  boundedIteration: {
    supported: true,
    evidence: 'inferred_from_documented_event',
    source: '`kimi --help`: `--max-steps-per-turn  INTEGER RANGE [x>=1]  Maximum number of steps in one turn.`',
    sourceVersion: KIMI_VERSION,
  },
  autonomousLoop: {
    supported: true,
    evidence: 'inferred_from_documented_event',
    // The only one of the four where cross-turn continuation is a single documented integer,
    // and `-1` for unlimited is the reason #193's per-run deadlines are the only lever over it.
    source: '`kimi --help`: `--max-ralph-iterations  INTEGER RANGE [x>=-1]  Extra iterations after the first turn in Ralph mode. Use -1 for unlimited.`',
    sourceVersion: KIMI_VERSION,
  },
}
