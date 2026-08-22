/**
 * Registration and participant construction, as data.
 *
 * Conclave will use layered configuration -- global user config defining available
 * agents and personal defaults, project-local `.conclave/` config selecting agents and
 * assigning them to roles. That subsystem is NOT built here, and nothing in this
 * directory reads a file or merges a layer.
 *
 * What is built is the shape configuration will produce, so that adding the Codex
 * adapter is a registration rather than an edit to call sites. If the second adapter
 * required touching the code that constructs the first, the seam would not be a seam.
 */

import type {
  AdapterCapabilities,
  AgentSession,
  Guarantees,
  InputOwnership,
} from '../contract/session.ts'
import { guaranteesFor } from '../contract/session.ts'
import type { ExecutableRequirement } from './executables.ts'
import type { ModelSupport } from './models.ts'
import type { RoleDefinition, RoleId } from './roles.ts'

/**
 * How a child CLI is launched, including the interstitials that must be suppressed by
 * configuration rather than answered by keystroke.
 *
 * Suppression is not cosmetic. During spike 1 a prompt intended for the composer was
 * consumed by Codex's startup update dialog and its default selection ran
 * `npm install -g @openai/codex`. Anything a driver can accidentally "answer" belongs
 * here as a flag.
 */
export interface LaunchSpec {
  command: string
  baseArgs: string[]
  /**
   * That `command` is a real executable which must be present before a seat starts (#51).
   *
   * Optional, and its ABSENCE is what lets a definition carry a `command` that is a label -- every
   * in-memory double in this repository does, because `LaunchSpec` is required and there is no
   * program behind `fake-lead`. Declaring it is the statement "this definition spawns this file",
   * which is the only thing that makes checking for the file meaningful. See
   * `ExecutableRequirement` for why silence removing a check is the safe direction here.
   */
  executable?: ExecutableRequirement | undefined
  /** Documented reasons for each suppression flag, keyed by what it suppresses. */
  suppresses?: Record<string, string> | undefined
  /** Preconditions the adapter cannot fix itself, e.g. Codex hook trust. */
  deploymentState?: string[] | undefined
}

export interface CreateParticipantContext {
  cwd: string
  /** Extra CLI args for this participant, from configuration. */
  args?: string[] | undefined
  watchdogMs?: number | undefined
  readyTimeoutMs?: number | undefined
}

/**
 * A deployment precondition checked BEFORE a session is started.
 *
 * Some guarantees are absent before the first byte is written -- Codex hooks that are
 * registered and enabled but not trusted will never fire, so such a session has no
 * turn-completion signal at all. Starting it anyway means inferring outcomes from
 * evidence we already know will not arrive. Better to refuse, with the reason.
 */
export type Preflight = (
  resolved: ResolvedParticipant,
  ctx: CreateParticipantContext,
) => Promise<void>

/**
 * What one deadline clock does for one adapter.
 *
 * `supported: false` is a statement about the ADAPTER, not a setting: there is no such
 * clock in it, so no configuration turns it on. Stating that is the point. A reader who
 * assumed otherwise is waiting for a `timed_out` that can never arrive, and waiting for a
 * verdict that is not coming is a worse position than knowing there is none.
 *
 * `supported: true` with no `defaultMs` is a third state and not a rounding of either
 * neighbour: the clock exists and is OFF unless the caller sets one. Two of the four
 * built-in adapters are in exactly that state, so collapsing it would misdescribe half of
 * them.
 */
export interface ClockSupport {
  supported: boolean
  /** What the adapter runs when nobody asks. Absent means it runs nothing. */
  defaultMs?: number | undefined
}

/**
 * Both clocks a turn is measured against, as this adapter implements them.
 *
 * Declared here rather than worked out from the agent's id at the call site. An id check is
 * a copy of this table that no one updates, and it lands in whichever module happened to
 * need the answer first; `Relay.deadlines` resolves it through the registry instead.
 */
export interface DeadlineSupport {
  /**
   * The whole turn, however busy it is.
   *
   * Refreshed by nothing -- output moves `silence`, never this -- because this is the clock
   * that guarantees the RUN stops waiting on a turn, and the run's ceilings are checked only
   * between turns.
   *
   * Stops waiting, which on the pty adapters is all it does: it emits a `timed_out` verdict
   * and releases the exchange, leaving the turn running and the seat unsendable until a
   * cancellation, terminal transcript or hook evidence, or the child exiting. The adapters
   * that run one process per turn kill that process when this fires, so there it ends the turn
   * too -- which is exactly why this is declared per adapter rather than assumed. The clock
   * `--turn-timeout` configures.
   */
  absolute: ClockSupport
  /**
   * How long a turn may produce NOTHING before it is called hung.
   *
   * Not a shorter absolute deadline. It answers a different question -- "has this stopped"
   * rather than "has this run long" -- and an adapter can implement one without the other.
   */
  silence: ClockSupport
}

/**
 * For a definition that runs no deadline at all, which is every in-memory test double and
 * any agent registered without a working adapter.
 *
 * Spelled out at each use rather than defaulted in the type, because "declared to have no
 * clocks" and "nobody said" must not produce the same report.
 */
export const NO_DEADLINE_CLOCKS: DeadlineSupport = {
  absolute: { supported: false },
  silence: { supported: false },
}

export interface AgentDefinition {
  id: string
  displayName: string
  capabilities: AdapterCapabilities
  /**
   * Which deadline clocks this adapter runs. Required, and defaulted nowhere.
   *
   * A fallback here would be the whole bug: an adapter that never declared would be
   * reported as enforcing a deadline it does not have, and the report exists to be
   * believed by someone interpreting a `timed_out` they did not watch happen.
   */
  deadlines: DeadlineSupport
  /**
   * How far this adapter can check a model name before launching it (#82). Optional, and the
   * asymmetry with `deadlines` above is deliberate.
   *
   * A missing `deadlines` had to be refused because its absence would be reported as a deadline
   * the adapter does not run -- silence there invents a guarantee. Silence HERE removes one: a
   * definition that declares nothing validates nothing and refuses nothing, which is the state
   * every registration was in before this field existed. Making it required would refuse every
   * test double and every generated registration in order to add a check whose absence is
   * already the safe direction. What it costs is that "cannot be asked" and "nobody said" must
   * stay distinguishable, and they do: `unsupported` is a declared grade and an absent field
   * reports as `undeclared`.
   */
  models?: ModelSupport | undefined
  launch: LaunchSpec
  /** Runs before `create`. Throwing here prevents the session from starting. */
  preflight?: Preflight
  /**
   * Absent when an agent is known and described but has no working adapter yet.
   * Registering it anyway is deliberate: it can be listed and conformance-graded
   * without being constructible, which keeps its lower confidence visible rather than
   * making it look finished by omission.
   */
  create?: (spec: ResolvedParticipant, ctx: CreateParticipantContext) => Promise<AgentSession>
  /** Why `create` is absent, surfaced when someone tries anyway. */
  unavailableReason?: string
}

/** The shape project configuration will produce. Plain data on purpose. */
export interface ParticipantSpec {
  /** Stable id for this seat, e.g. 'impl'. Distinct from the agent id. */
  id: string
  agent: string
  role: RoleId
  /** Overrides the role's default. */
  inputOwnership?: InputOwnership | undefined
  args?: string[] | undefined
  displayName?: string | undefined
}

export interface ResolvedParticipant {
  spec: ParticipantSpec
  agent: AgentDefinition
  role: RoleDefinition
  inputOwnership: InputOwnership
  guarantees: Guarantees
}

export function resolveInputPolicy(
  role: RoleDefinition,
  spec: ParticipantSpec,
): { ownership: InputOwnership; guarantees: Guarantees } {
  const ownership = spec.inputOwnership ?? role.defaultInputOwnership
  return { ownership, guarantees: guaranteesFor(ownership) }
}
