/**
 * The plan a dry run prints -- one builder, one renderer, both front-ends.
 *
 * A dry run's whole value is that its plan is the plan the real run would use. Two commands
 * printing "the plan" from two blocks of formatting code would satisfy every test that reads
 * either one and still describe different resolutions to the operator comparing them, which
 * is the ninth-through-eleventh instance of the mistake `frontEndParity.test.ts` exists for --
 * and the worst version of it, because the whole point of the output is to be trusted about
 * what would happen.
 *
 * So the two front-ends differ only in what they put IN: `relay` composes its launch
 * arguments in the CLI block, and the console composes them inside `runSession` from the
 * project config it reads itself. Neither owns a line of the rendering.
 *
 * The plan carries no goal when the console was given none. `relay` refuses to start without
 * one, so its plan always has it; a console with an empty goal position comes up and asks,
 * which is a fact about the run being described and belongs in the description rather than
 * showing as a blank field.
 */

import { absoluteSummary, silenceSummary, type RunDeadlines } from './deadlines.ts'
import { ceilingSummary, type RunCeilings } from './guardrails.ts'
import type { CheckSpec } from '../rotation/record.ts'

/** One implementer seat, as it would be launched. */
export interface DryRunSeat {
  id: string
  agent: string
  args: string[]
}

/**
 * Everything the plan describes, already resolved.
 *
 * Deliberately not "the flags": by the time this is built, config-derived arguments have been
 * composed with the invocation's own, the seat list has been expanded, and the reviewer is
 * either a seat or absent. A field here that still needed interpreting would be a place the
 * two front-ends could interpret it differently.
 */
export interface DryRunPlanInput {
  cwd: string
  /** Absent when the console was given no goal and would ask for one. */
  goal?: string | undefined
  advisor: { agent: string; args: string[] }
  /** Every implementer seat, in seat order. Never empty: there is always a first seat. */
  implementers: DryRunSeat[]
  /**
   * Whether the operator named a seat LIST (`--implementers`).
   *
   * Only the JSON reads it, and only to decide whether a `seats` array appears at all: a
   * default dry run's document is what it has always been, one `implementer` key naming one
   * agent, and a key that appeared on every plan would change what an existing reader parses
   * to say nothing it did not already know.
   */
  seatsNamed: boolean
  /** Opt-in (#72). Absent means no reviewer seat and no `reviewer` key. */
  reviewer?: { agent: string; args: string[] } | undefined
  checks: CheckSpec[]
  /**
   * What would stop the run, already resolved by `effectiveCeilings`.
   *
   * REQUIRED, not optional, and that is the whole of the guarantee. Every other field here is
   * something a front-end has; this is something a front-end could compute and forget to, and
   * an optional key would let one of them omit it while both tests and the plan stayed green.
   * A dry run whose plan is silent about the bound that ends the run is #119 with the extra
   * insult of having been asked -- the operator typed the command whose entire purpose is to
   * say what would happen, and it did not say.
   *
   * Passed in rather than derived here for the reason the whole module exists: `relay` reads
   * `--rounds` and the ceiling flags in its CLI block and the console reads them through
   * `SessionOptions`, so a resolution performed HERE would be a third one, able to disagree
   * with the two that are actually handed to `Relay.start`.
   */
  ceilings: RunCeilings
  /**
   * What each seat would be measured against, already resolved by `resolveDeadlines`.
   *
   * Both clocks and every seat, including the seats that resolve to `unsupported`. Required
   * for the same reason as `ceilings`, and with one more of its own: `unsupported` is a fact
   * no amount of correct typing can change, so it is the one line of a plan an operator cannot
   * derive from their own argv. A plan that omitted it would be accurate about everything the
   * operator already knew and silent about the only part they could not have worked out.
   */
  deadlines: RunDeadlines
}

/** A check as the plan reports it: relevance is always explicit, never implied by shape. */
function normalizedChecks(checks: readonly CheckSpec[]): { command: string; relevance: string }[] {
  return checks.map((c) =>
    typeof c === 'string'
      ? { command: c, relevance: 'required' }
      : { command: c.command, relevance: c.relevance },
  )
}

/**
 * The machine-readable plan, for `--json`.
 *
 * Key order is the order this object literal is written in, and it is the order the relay
 * command has printed since `--dry-run` shipped. Nothing consumes it positionally, but a
 * diff of two plans is something an operator does by eye.
 */
export function dryRunPlan(input: DryRunPlanInput): Record<string, unknown> {
  const first = input.implementers[0]!
  return {
    dryRun: true,
    cwd: input.cwd,
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    advisor: input.advisor,
    implementer: { agent: first.agent, args: first.args },
    ...(input.seatsNamed
      ? { implementers: input.implementers.map((s) => ({ id: s.id, agent: s.agent, args: s.args })) }
      : {}),
    ...(input.reviewer ? { reviewer: input.reviewer } : {}),
    checks: normalizedChecks(input.checks),
    // Appended, after every key this document has carried since `--dry-run` shipped, so a
    // reader parsing the old shape reads the same values in the same order and finds two more
    // keys after them.
    //
    // The BLOCKS VERBATIM, not a flattening: these are the same `RunCeilings` and
    // `RunDeadlines` objects `status --json` and the run report write, field for field, so an
    // operator can diff a plan against the status of the run it planned and have the
    // difference mean something. A dry-run-shaped rearrangement of the same numbers would make
    // that diff a comparison of two serializers.
    ceilings: input.ceilings,
    deadlines: input.deadlines,
  }
}

/** `agent --flag value`, or just the agent when it takes no launch arguments. */
function seatLine(agent: string, args: readonly string[]): string {
  return `${agent}${args.length > 0 ? ` ${args.join(' ')}` : ''}`
}

/**
 * The prose plan, one string per line, ready to write.
 *
 * Returned rather than printed because the two front-ends write to different places: `relay`
 * puts human-facing lines on stderr under `--json` so stdout carries the report alone, and
 * the console writes through the same `write` that keeps a half-typed line intact. A renderer
 * that called `console.log` would have to be told which, and that is the argument that
 * eventually becomes two renderers.
 */
export function dryRunPlanLines(input: DryRunPlanInput): string[] {
  const lines = [
    'dry run — nothing was started',
    `  cwd:         ${input.cwd}`,
    `  advisor:     ${seatLine(input.advisor.agent, input.advisor.args)}`,
  ]
  // One line per seat, so the prose says what the JSON says. At N=1 it is the line it has
  // always been: `implementer`, not `implementer` with a number nobody asked for.
  for (const s of input.implementers) {
    const label = input.implementers.length === 1 ? 'implementer' : s.id
    lines.push(`  ${label.padEnd(11)}: ${seatLine(s.agent, s.args)}`)
  }
  if (input.reviewer) {
    lines.push(`  reviewer   : ${seatLine(input.reviewer.agent, input.reviewer.args)}`)
  }
  // What would stop the run, and what each seat would be measured against, in the order the
  // launch banner prints them: the run-wide bound, then the two per-seat clocks, then the
  // rotation line (`checks`, here). Same three summaries the banner calls, so the plan and the
  // banner of the run it describes cannot word the same resolution two ways.
  //
  // Each value NAMES ITS FLAG -- `--rounds`, `--max-turns`, `--turn-timeout`,
  // `--silence-timeout` -- rather than restating the label as a field name. The reader is an
  // operator deciding whether what they typed took effect, which is the argument
  // `ceilingSummary` makes and the reason #119 was invisible: `--rounds 8 · --max-turns 40` is
  // three words that show the budget raised was not the budget meant, and `advisor turns: 8`
  // is not.
  lines.push(`  ceilings:    ${ceilingSummary(input.ceilings)}`)
  lines.push(`  turn:        ${absoluteSummary(input.deadlines)}`)
  lines.push(`  silence:     ${silenceSummary(input.deadlines)}`)
  const checks = normalizedChecks(input.checks)
  lines.push(
    `  checks:      ${
      checks.length > 0
        ? checks.map((c) => `${c.command} [${c.relevance}]`).join(', ')
        : 'none — rotation not armed'
    }`,
  )
  // Last, and never blank. A console invoked with no goal prints what it would do about that
  // rather than an empty field, which reads as a goal that went missing in parsing -- the
  // exact misreading #81 cost a day to.
  lines.push(`  goal:        ${input.goal ?? 'would be asked for'}`)
  return lines
}
