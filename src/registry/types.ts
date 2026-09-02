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
import type { EvidenceLevel } from '../contract/outcome.ts'
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
  /**
   * How long a turn may produce NOTHING before the adapter's watchdog calls it hung.
   *
   * Separate from `watchdogMs` because the two clocks answer different questions, and an
   * adapter can run one without the other -- which is exactly why this is handed to every
   * `create` and IGNORED by the two that declare `silence: { supported: false }`. Passing it
   * to an adapter with no silence clock would not turn one on; the run's report says
   * `unsupported` for that seat instead, and the value is not quietly reinterpreted as an
   * absolute budget on the way past.
   *
   * Absent means the adapter keeps its own default -- `DEFAULT_IDLE_MS`, twelve minutes, on
   * the two pty adapters. Absent is NOT "no silence clock": that is the declared
   * `supported: false`, and the two must not collapse.
   */
  idleMs?: number | undefined
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

/**
 * One capability claim, carrying HOW it is supported and WHAT it was read from.
 *
 * `evidence` and `sourceVersion` are orthogonal, and collapsing them corrupts both.
 * `observed_historically` requires behaviour "Produced in a real run", so reaching for it as
 * the downgrade for a stale `--help` string would PROMOTE an advertisement into an observed
 * grade -- the masquerade `EVIDENCE_LEVELS` (`src/contract/outcome.ts`) is written to prevent.
 * The rule instead: when the installed version differs from `sourceVersion` the claim is STALE,
 * `evidence` is untouched, and it is unverified for selection until re-derived against the
 * installed binary. Freshness gates whether a claim may be ACTED ON; it never changes what kind
 * of evidence it was.
 */
export interface GradedClaim {
  supported: boolean
  /** HOW the claim is supported. Never changed by the installed version moving. */
  evidence: EvidenceLevel
  /**
   * WHERE the claim comes from, quoted closely enough that a reader can search for it again.
   * Required when `evidence` is not `unsupported`, because a claim with no source is the thing
   * this whole axis exists to refuse.
   */
  source: string
  /** WHICH version of the CLI `source` was read from, exactly as that CLI reports itself. */
  sourceVersion: string
}

/**
 * What this agent can be INSTRUCTED to do, as distinct from what the adapter can OBSERVE.
 *
 * A SIBLING of `capabilities` rather than a widening of it, and the separation is the whole
 * point. `checkAdapter` (`src/conformance/suite.ts`) grades each `AdapterCapabilities.outcomes`
 * entry against a captured RECORDING -- a fixture the suite either finds or does not. A claim
 * about what an agent can be TOLD has no such fixture and cannot acquire one by the same route:
 * no recording of a turn witnesses that a flag exists. Putting an ungradeable claim inside the
 * structure the suite grades would make it look checked by association, which is exactly the
 * masquerade `EVIDENCE_LEVELS` exists to prevent.
 *
 * Field names are CANONICAL terms rather than any vendor's own, and they are finer than all of
 * them: every one of the four CLIs calls something "background", and those are three separate
 * capabilities below. Same convention `KIMI_HOOK_EVENTS` sets in `src/adapters/kimiConfig.ts` --
 * name the thing once, then locate each agent against it.
 *
 * Every field is optional for the reason `AgentDefinition.models` gives: silence removes a
 * briefing block rather than inventing a permission. An absent field is `undeclared`; a declared
 * `supported: false` is `unsupported`; the two must not report the same.
 */
export interface InstructionCapabilities {
  /** Subagents spawned, AWAITED and reconciled inside one turn. */
  subagents?: GradedClaim | undefined
  /** A task started without the starting call waiting for it. Says nothing about when it ends. */
  backgroundTasks?: GradedClaim | undefined
  /** That such a task has finished, or is awaited, by `turn_end`. */
  turnBoundedLifetime?: GradedClaim | undefined
  /** The session detaches and is reattached by id. Not a turn property. */
  sessionBackgrounding?: GradedClaim | undefined
  /** The call returns before the reply; the session stays foreground. */
  asyncPromptSubmission?: GradedClaim | undefined
  /** Many steps in one invocation, under a cap. */
  boundedIteration?: GradedClaim | undefined
  /** The agent chooses and dispatches a SUBSEQUENT turn. */
  autonomousLoop?: GradedClaim | undefined
}

/**
 * Whether the advisor may put a seat into a given mode by naming a slash command (#200).
 *
 * THE RULE, and it is one sentence: the advisor may change HOW the seat works, never WHETHER
 * IT EXISTS and never what the OPERATOR configured. Everything in every declaration follows
 * from it.
 *
 *   - A work-mode change is ALLOWED. `/compact` on either pty CLI, `/loop` on Claude,
 *     `/review` on Codex: each alters how the seat spends its turns, and the seat, its
 *     context and its history all survive, so the relay's belief about the seat stays true
 *     across the change.
 *   - A command that ENDS OR DISCARDS CONTINUITY is REFUSED. The relay is left holding a seat
 *     handle it believes has a history behind it. Nothing observes the loss -- no adapter
 *     reads the composer's error text -- so the run carries on attributing turns to
 *     continuity that is gone.
 *   - A command that ALTERS OPERATOR CONFIGURATION is REFUSED. The operator chose the seat's
 *     model, its permissions and its hooks, and the run report states those choices as fact.
 *
 * THREE STATES, AND THEY MUST NOT COLLAPSE INTO TWO. This is a union rather than a list with
 * a nullable field because the three answers have different causes and want different
 * repairs:
 *
 *   `declared`     Someone read this CLI's installed bundle and wrote down what it has.
 *                  Within it, an entry may still be a refusal -- see `CommandDeclaration`.
 *   `unsupported`  Someone looked and there is nowhere to type a command AT ALL. Not a
 *                  refusal of any particular verb: the adapter has no composer, so the
 *                  question does not arise. Repairing it would mean a different adapter.
 *   absent         Nobody looked. The honest state for an agent registered without one, and
 *                  the reason the field is optional. Repairing it means reading a binary.
 *
 * Collapsing `unsupported` into absence would report a structural fact as an oversight, and
 * collapsing it the other way would report an oversight as a structural fact. Both are wrong
 * in the direction that stops anyone fixing it.
 *
 * REFUSAL IS THE DEFAULT IN ALL THREE, and that is the one place this differs from
 * `InstructionCapabilities`. There, an absent field withholds a CLAIM, so silence is safe by
 * removing an assertion. Here, an entry grants a PERMISSION to act on another program, so
 * silence must be safe by removing the permission. Both directions are the conservative one;
 * they only look opposite because the two fields carry opposite kinds of thing.
 */
export type CommandPolicy =
  | {
      kind: 'declared'
      /**
       * The version of the CLI every entry was read from, verbatim as that CLI reports
       * itself -- the same freshness convention `GradedClaim.sourceVersion` sets, and for the
       * same reason: a permission to type a command into another program expires when that
       * program moves, and a string comparison against `--version` needs no parser.
       */
      sourceVersion: string
      /**
       * Every command CONSIDERED, refusals included.
       *
       * A refusal is a declaration, not an omission, and it is checked against the installed
       * bundle exactly as an allowance is. A refusal naming a command the CLI no longer has is
       * every bit as stale as a permission naming one -- it reads as a live guard against a
       * hazard that no longer exists, and hides that nobody has looked recently.
       */
      commands: readonly CommandDeclaration[]
    }
  | {
      kind: 'unsupported'
      /** What was looked at, and why no command could be delivered whatever it said. */
      reason: string
    }

/** What the policy says about one command. */
export type CommandDisposition = 'allowed' | 'refused'

export interface CommandDeclaration {
  /** Exactly as it would be typed into the composer, leading slash included. */
  command: string
  disposition: CommandDisposition
  /** Which clause of the rule on `CommandPolicy` decides it, in that clause's own terms. */
  reason: string
  /**
   * A literal from the installed bundle that this command's existence was read from, quoted
   * closely enough to be searched for again.
   *
   * The FORM varies per command AND per CLI, and it is not normalised, because normalising it
   * would be a lie. On Claude, a bundled JavaScript program, commands are declared as
   * `name:"..."` -- except `/quit`, which exists only as an alias inside another command's
   * declaration, and `/loop`, which is a SKILL the bundle ships rather than a command at all.
   * On Codex, a Rust binary, the names are interned into a packed table with no separators, so
   * searching for a bare name proves nothing whatsoever and the pinnable literal is the
   * command's DESCRIPTION instead. One search shape over all of that would either miss most of
   * it or match too loosely to prove anything.
   */
  source: string
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
  /**
   * What this agent can be INSTRUCTED to do (#192), as opposed to what its adapter can observe.
   *
   * Optional for the same reason `models` is, and NOT for the reason `deadlines` is required: an
   * absent declaration here removes a claim rather than inventing one. Nothing reads this yet --
   * it is declared before it is rendered so the data and its provenance land in one reviewable
   * step, rather than arriving as a footnote to whichever briefing first needed it.
   */
  instructionCapabilities?: InstructionCapabilities | undefined
  /**
   * Which slash commands the advisor may ask this seat to run, and which are refused (#200).
   *
   * Optional, and its absence is the THIRD state rather than a shorthand for either declared
   * one: nobody has read this agent's binary. It refuses every command, as the other two
   * states also can, but for a reason that names a different repair. See `CommandPolicy`.
   */
  commandPolicy?: CommandPolicy | undefined
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
