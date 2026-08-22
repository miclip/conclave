/**
 * The two-party relay. Build order step 5.
 *
 * Deliberately mechanical: no orchestrator model, no summarisation, no intelligence of
 * its own. It declares a lead, starts both sessions, routes prose between them with rank
 * made legible, delivers human messages to one participant or all, and records everything
 * that moved. Confirm the loop is stable before adding anything clever.
 *
 * What it does NOT do, on purpose:
 *   - see or forward tool calls, diffs, file contents or reasoning traces. Prose only,
 *     in both directions, and all of it — the full narration of a turn rather than its
 *     closing message.
 *   - decide anything. Ending a session, rotation and escalation are §7a's, and are not
 *     implemented here.
 */

import type {
  AgentEvent,
  AgentSession,
  RevisionEvent,
  SessionSnapshot,
  TurnEndEvent,
} from '../contract/session.ts'
import { formatVerdict, type Verdict } from '../contract/outcome.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { launchRecordFor, type ParticipantLaunch } from '../registry/launch.ts'
import { refuseMissingCommands } from '../registry/executables.ts'
import { refuseUnknownModels } from '../registry/models.ts'
import type { ParticipantSpec } from '../registry/types.ts'
import type { RoleId } from '../registry/roles.ts'
import { acquire, release } from '../workspace/sessionLock.ts'
import {
  cleanupSeatWorktrees,
  createSeatWorktrees,
  ensureWorktreeHookTrigger,
  nextRunId,
  recoveryLines,
  seatCwd,
  uncommittedClause,
  unwindSeatWorktrees,
  writeManifest,
  type WorktreeManifest,
} from '../workspace/worktrees.ts'
import { CheckLane } from './checkLane.ts'
import {
  failedRequired,
  integrateSeat,
  integrationHead,
  uncertainSnapshotNote,
  type IntegrationCheckResult,
} from './integrate.ts'
import {
  envelope,
  type Audience,
  type MessageKind,
  type Rank,
  type RelayMessage,
  type Visibility,
} from './message.ts'
import { activeTurn, describeActiveTurn } from '../outcomes/activeTurn.ts'
import { RelayEventStream, type ObserveOptions, type RelayEvent, type RunReason } from './observe.ts'
import {
  LIVENESS_REFRESH_EVERY_MS,
  LIVENESS_REFRESH_LIMIT,
  describeLiveness,
  readingOf,
  reportsChildOnCpu,
  sampleLiveness,
  type ChildLiveness,
  type LivenessReading,
  type LivenessRefreshState,
} from '../outcomes/liveness.ts'
import {
  RunHandle,
  type Decision,
  type PauseOption,
  type PauseReason,
  type PauseSupersession,
  type RunOutcome,
  type RunPause,
} from './run.ts'
import { actorFor, resolutionFor, type ResolutionSubject } from './resolution.ts'
import { rotationIntentFor, type RotationIntent, type RotationRecord } from './rotationIntent.ts'
import {
  attributable,
  evidenceForRoot,
  recordAttribution,
  supportFor,
  describeConflict,
  detectConflict,
  dirtyPaths,
  originOf,
  type AuthorityConflict,
  type RestrictedOrigin,
} from './authority.ts'
import { assess, ComplaintLedger, topicOf, type Assessment } from '../rotation/degradation.ts'
import { rotate, type RotationResult } from '../rotation/rotate.ts'
import { checkCommand, type CheckSpec } from '../rotation/record.ts'
import { buildReviewContext, reviewPrompt } from '../rotation/review.ts'
import { resumeBriefing } from './resume.ts'
import { breached, type CeilingBreach, type CeilingState, type Ceilings, effectiveCeilings, type RunCeilings } from './guardrails.ts'
import {
  cancelledByFailedDependencies,
  concurrentSeats,
  dependenciesMet,
  nextDispatch,
  queueDepth,
  parseDecisions,
  recordCompletion,
  refuseDispatch,
  seatsFor,
  type SeatExecution,
  type Task,
  type TaskEvent,
  type TaskPurpose,
  type TaskGrade,
  type TaskRuntime,
  type TaskTarget,
} from './dispatch.ts'
import {
  describeTarget,
  namedTargets,
  recordTargetingTurn,
  targetingSummary,
  type TargetingRecord,
  type TargetingWatch,
} from './targeting.ts'
import { isSubagentTool, worktreePaths } from './subagents.ts'
import type { ClockSupport } from '../registry/types.ts'

export type {
  ObserveOptions,
  RelayActivityEvent,
  RelayEvent,
  RelayMessageEvent,
  RelayPauseEvent,
  RelayResumeEvent,
  RelayRunEndEvent,
  RunReason,
} from './observe.ts'

export interface RelayParticipant {
  id: string
  /**
   * The agent id this seat was filled from, kept so its declared capabilities can be looked
   * up without awaiting a snapshot. Rotation replaces the SESSION and reuses the spec, so
   * this survives a rotation unchanged -- as it must, or a seat's reported deadlines would
   * change when nothing about its adapter did.
   */
  agent: string
  rank: Rank
  /**
   * What this seat is FOR, as distinct from what it may overrule.
   *
   * `RoleId` is open on purpose (`src/registry/roles.ts:15`) — project configuration assigns
   * agents to roles, so a role a build has never heard of has to be a validation error with a
   * message rather than a compile error in someone else's checkout. `ParticipantSpec` has
   * carried it all along and `#join` used to read `spec.agent` and drop it, which is why
   * "named implementers" looked blocked on the rank type when it never was.
   *
   * `Rank` stays closed and is not this. It is an AUTHORITY ordering feeding `outranks()`;
   * three implementers are different in job and identical in authority, and widening it would
   * force an invented ordering among peers into the header `envelope()` renders.
   */
  role: RoleId
  /**
   * What this seat was started with, and which model that names.
   *
   * `ParticipantSpec.args` reached the launch and was then dropped here, the same way
   * `role` was before it (#71): a run could be started with `-m opencode/kimi-k2.7-code`
   * and the record would say only `agent: opencode`, which is any of dozens of models at a
   * ~30x price spread and no instruction for repeating the run. Kept beside `agent` for the
   * same reason `agent` is kept -- so the record can be read without awaiting a snapshot.
   *
   * Survives a rotation unchanged, and must: rotation replaces the SESSION and reuses the
   * spec, so the replacement is launched from this same argv. A seat whose reported model
   * changed when its adapter was restarted would be reporting a change that did not happen.
   */
  launch: ParticipantLaunch
  session: AgentSession
  events: AgentEvent[]
  /** Compaction generation when this session joined. Degradation is measured against it. */
  baselineGeneration: number
  /**
   * Index into `events` at which the current session began.
   *
   * Rotation keeps the routing history and the event list, so without a cursor the
   * retired session's compaction events would be re-read on every advisor turn and the replacement
   * would be judged degraded from the moment it started.
   */
  degradationCursor: number
}

/**
 * What a replacement must reproduce -- and, since #80, what the merged tree must pass.
 *
 * Rotation without verification commands would be a transfer nobody demonstrated, which
 * is the thing §7a exists to prevent -- so leaving this unset does not disable the
 * *detection* of degradation, only the automatic response to it. A degraded implementer
 * with nothing to verify against escalates to the human instead.
 *
 * The name is now narrower than the field's use, and that is deliberate rather than
 * unnoticed: renaming it would break every existing programmatic caller for a change that
 * ADDS a reader, and `--checks` is the spelling operators and scripts already have. What is
 * true is written here instead -- these commands are the run's statement of what "working"
 * means, and two stations read it.
 */
export interface RotationConfig {
  /**
   * Commands the replacement must run and reproduce. Without these, no rotation.
   *
   * A bare string is `required`: a mismatch rolls the rotation back. Pass
   * `{command, relevance}` for a check that should be run and reported without gating the
   * transfer. Relevance is declared HERE, by the orchestrator, and never by a participant.
   *
   * ALSO run against the integration checkout after every merge, including the last (#80).
   * Same commands, same relevance vocabulary, a different tree and a different question: a
   * rotation asks whether a replacement reproduces what the original did, and the merge
   * boundary asks whether the tree the seats built TOGETHER works. Two seats can each be
   * green in their own worktree and merge cleanly into a tree that does not build, which is
   * what a real two-seat run produced and what no other station could see.
   *
   * This changes what an existing N>1 configuration does -- these commands run more often,
   * and a failure now means one of two things depending on where it happened. It changes
   * nothing at N=1, where there is no merge to check. The alternative considered and
   * rejected was a second option to arm separately; see `integrate.ts`, which records both
   * the original objection to reusing this field and why the objection was overruled.
   */
  checks: CheckSpec[]
  /**
   * What mechanical degradation entitles the orchestrator to do. Default `'candidate'`.
   *
   * Two claims ride on this and they are not the same claim:
   *
   *   1. Conclave can execute a transactional rotation.
   *   2. Compaction predicts quality degradation strongly enough to act on unattended.
   *
   * The first is nearly answerable — one live run does it. The second needs a comparison
   * across sessions, because a session may compact without degrading and may degrade
   * before compacting. Until that comparison exists, compaction is a **rotation
   * candidate**: the run pauses and hands the decision to the human, who can call
   * `rotateImplementer()` and watch it happen.
   *
   * `'automatic'` is what the offline suite exercises and what a supervised operator may
   * opt into. It is not the default, because defaulting to it would encode claim 2 as
   * settled on the strength of evidence for claim 1.
   */
  onDegradation?: 'candidate' | 'automatic'
  /** Files whose exact content the transfer depends on, beyond those the advisor names. */
  files?: string[]
  checkTimeoutMs?: number
  /** TEST-ONLY. See `RotationDeps.hooks`; never set in production. */
  hooks?: { afterCapture?: () => Promise<void> }
  /**
   * Per-seat overrides of everything above, keyed by seat id. Absent is the default.
   *
   * D7: rotation policy is a RUN-LEVEL DEFAULT that a seat may override, and the fields above
   * are that default. This is where a heterogeneous run says what it cannot say once (#77): a
   * seat running a different agent on a different part of the tree does not necessarily prove
   * itself with the same commands, and until #78 there was no way to express that because
   * there was only ever one seat rotation could name.
   *
   * A seat that names nothing here is under the run's policy, which is the identity case and
   * the only case a default run reaches -- `rotationFor` returns the run policy unchanged when
   * this is absent, so N=1 cannot take a different path through it.
   *
   * Keyed by seat id rather than by role or agent, because the seat is what rotation replaces.
   * A key naming no seat is NOT an error here: `Relay.start` refuses one, where the seat list
   * is known and the operator can be told which ids exist.
   */
  seats?: Record<string, SeatRotation>
}

/**
 * One seat's departure from the run's rotation policy. Every field optional; absent inherits.
 *
 * Deliberately not `Partial<RotationConfig>`: that would let a seat carry its own `seats` map,
 * and a policy that can nest is a policy whose effective value depends on how deep a reader
 * looked. One level, and the run's is the root.
 */
export interface SeatRotation {
  /**
   * This seat's verification commands, REPLACING the run's rather than adding to them.
   *
   * Replacement is the whole point: a seat that names its own checks has said what proving
   * ITS work means, and concatenating the run's back on would silently reimpose commands the
   * operator just overrode -- on a seat whose tree may not even be able to run them.
   *
   * An empty array is a real setting and means this seat cannot be rotated: there is nothing
   * for a replacement to reproduce, and rotating on nothing is the transfer nobody demonstrated
   * that `checks` exists to prevent. Its degradation is still detected, and still reported.
   */
  checks?: CheckSpec[]
  onDegradation?: 'candidate' | 'automatic'
  files?: string[]
  checkTimeoutMs?: number
  /** TEST-ONLY. See `RotationDeps.hooks`; never set in production. */
  hooks?: { afterCapture?: () => Promise<void> }
}

/**
 * The rotation policy one seat is actually under, with the run's defaults already applied.
 *
 * A resolved value rather than a pair of objects every reader merges for itself, for the reason
 * `boundOf` and `implementerSeats` are functions: the rule that reconciles a default with an
 * override is the whole of the promise, and a rule written at each point of use is a rule that
 * eventually disagrees with itself. `onDegradation` is defaulted HERE and nowhere else, so
 * "what happens when a seat degrades" has exactly one answer.
 */
export interface EffectiveRotation {
  checks: CheckSpec[]
  onDegradation: 'candidate' | 'automatic'
  files?: string[] | undefined
  checkTimeoutMs?: number | undefined
  hooks?: { afterCapture?: () => Promise<void> } | undefined
}

/**
 * What rotation policy applies to one seat: the run's, as amended by that seat's own entry.
 *
 * `undefined` means rotation was never configured for this run, which is a different fact from
 * a seat configured with no checks -- the first is a run with no policy, the second is a policy
 * that says this seat is not rotatable. Both refuse to rotate; only the second was asked for.
 *
 * Field by field, and never a deep merge. Arrays replace (see `SeatRotation.checks`), and a
 * field a seat did not mention takes the run's value, including when the run did not mention
 * it either.
 */
export function rotationFor(
  cfg: RotationConfig | undefined,
  seatId: string,
): EffectiveRotation | undefined {
  if (!cfg) return undefined
  const seat = cfg.seats?.[seatId]
  const files = seat?.files ?? cfg.files
  const checkTimeoutMs = seat?.checkTimeoutMs ?? cfg.checkTimeoutMs
  const hooks = seat?.hooks ?? cfg.hooks
  return {
    checks: seat?.checks ?? cfg.checks,
    onDegradation: seat?.onDegradation ?? cfg.onDegradation ?? 'candidate',
    // Spread rather than assigned, because `exactOptionalPropertyTypes` distinguishes a field
    // set to `undefined` from a field that is absent, and `rotate()` reads these with `in`.
    ...(files === undefined ? {} : { files }),
    ...(checkTimeoutMs === undefined ? {} : { checkTimeoutMs }),
    ...(hooks === undefined ? {} : { hooks }),
  }
}

/**
 * How long to keep re-reading a completed turn whose report came back empty.
 *
 * Generous on purpose: reaching it means the choice is between waiting and discarding a
 * turn's entire account of work already done. It is bounded rather than unbounded because
 * an unrecoverable transcript must still end in a decision rather than a hang.
 */
const DEFAULT_SALVAGE_MS = 90_000

/**
 * How long to wait for a target's transcript to leave `in_progress` before giving up on
 * sending to it at all (#117).
 *
 * Generous for the same reason the salvage window is, and then some: what is being bought is
 * not a better report but the run itself. Sending into a live turn does not queue the text --
 * neither CLI accepts input mid-turn -- it ends the run, so every second spent waiting here is
 * a second that costs nothing against an alternative that costs everything.
 *
 * Bounded rather than unbounded because a child that never finishes must still end in a
 * decision. The bound is what makes the ending honest: at five minutes, "it is still working"
 * has stopped being a wait and become a fact about the run.
 */
const DEFAULT_SEND_PRECONDITION_MS = 300_000

/**
 * How often `#exchangeTurn` looks for the `turn_end` it is waiting on.
 *
 * A cadence and nothing else: nothing counts these, no ending depends on how many have gone by,
 * and the loop runs for as long as the turn does. The one exit besides the event -- the session
 * being closed under it (#143) -- is a signal rather than a count, so this number cannot decide
 * anything even indirectly.
 */
const TURN_POLL_MS = 250

/**
 * The target was still mid-turn when the send precondition's bound expired, so nothing was
 * sent (#117).
 *
 * A named type rather than a bare `Error` because `#loop` catches everything a run can throw
 * and reports it as `transport_failed`. That reason is exactly what this condition must stop
 * claiming, and a string match on the message would be a second way for the two to drift.
 */
export class PeerBusyError extends Error {
  readonly participant: string
  constructor(participant: string, message: string) {
    super(message)
    this.name = 'PeerBusyError'
    this.participant = participant
  }
}

/**
 * The turn this was waiting on was abandoned because `stop()` closed the session under it (#143).
 *
 * A named type for the same reason `PeerBusyError` is one: `#loop` reports every other throw as
 * `transport_failed`, and this is not a transport fault. It is the run being torn down, which
 * `run_end` has already called `stopped` -- and a handle and a stream describing one run must not
 * disagree about how it ended (see `stopWhilePaused.test.ts`).
 *
 * It carries the participant because the only thing worth saying about it is whose turn was lost.
 */
export class TurnAbandonedError extends Error {
  readonly participant: string
  constructor(participant: string, message: string) {
    super(message)
    this.name = 'TurnAbandonedError'
    this.participant = participant
  }
}

export interface RelayOptions {
  registry: AgentRegistry
  cwd: string
  /**
   * A previous run's routing log, replayed into both participants before the first turn.
   *
   * `relay` ends at every pause point by design, so the normal way a long run stops is with
   * work in flight, and the normal recovery was for a human to transcribe the established
   * state into a new goal string. Anything not transcribed was silently re-derived or
   * silently lost -- see issue #34.
   */
  resume?: RelayMessage[] | undefined
  /**
   * Who is answering escalations. Default `'human'`.
   *
   * Declared rather than detected. Detection here would be guessing -- an agent operator and
   * a human at a terminal are indistinguishable from inside the relay -- and guessing wrong
   * either floods a human with questions or starves an agent of them.
   */
  operator?: 'human' | 'agent' | undefined
  /**
   * Wall-clock and turn ceilings, checked at turn boundaries.
   *
   * Distinct from `maxAdvisorTurns`, which bounds how many times the advisor gets to steer. A
   * ceiling bounds the run as a resource: it is what stops a run that is progressing but has
   * been progressing for two hours, which `maxAdvisorTurns` cannot express because a single
   * advisor turn can dispatch work that takes arbitrarily long.
   *
   * Also a recording device. The rotation experiments need "it ran for two hours" to be a
   * deliberate setting rather than an accident, and a ceiling that must be raised on purpose
   * puts the intended length into the record.
   */
  ceilings?: Ceilings | undefined
  /** The advisor. Steers, and cannot see the implementer's tools. */
  lead: ParticipantSpec
  /**
   * The implementer. Still required, and still the whole answer for a default run.
   *
   * At N>1 it keeps a specific job rather than becoming decoration: it names the LEAD
   * implementer -- the seat whose role an untargeted instruction resolves against, and the
   * seat `rotateImplementer` means when nothing names one. That is why `implementers`, when
   * given, must contain it (see `Relay.start`): a singular field nothing reads would be a trap,
   * and every operation that is genuinely singular needs a seat it can name without choosing.
   */
  implementer: ParticipantSpec
  /**
   * Every implementer seat, when a run has more than one.
   *
   * Absent is the default and must stay behaviourless: the effective seat list is
   * `implementers ?? [implementer]` (see `implementerSeats`), so a caller that never heard of
   * this field gets exactly the run it got before -- one seat, joined in the same order, with
   * the same routing log. That is D1's identity case stated as an option rather than as a
   * branch: nothing downstream asks how many seats there are, it asks the seat list.
   *
   * Neither front-end sets it. There is no flag for it and adding one is a separate decision;
   * this is the programmatic surface the dispatcher's seat table was already written against.
   */
  implementers?: ParticipantSpec[] | undefined
  /**
   * The reviewer seat (#72, D9b). Absent is the default and must stay behaviourless: no
   * reviewer declared, no review task is ever admitted, and the merge boundary runs exactly
   * as it does today.
   *
   * Rank `implementer` -- joined through the same seats loop as every implementer, at
   * `spec.role`, so nothing about rank assignment changes for it -- but it is not one of
   * `implementerSeats()`: `#implementers()` reads `role`, not rank, and a reviewer's role is
   * `'reviewer'`. It never gets a worktree. It does not write, so there is no tree to isolate
   * it into, and the diff it reviews is taken against the producing seat's tree, not its own.
   */
  reviewer?: ParticipantSpec | undefined
  /**
   * Advisor turns before the relay stops and hands back to the human.
   *
   * One advisor turn is one pass of the dispatcher: the advisor's standing reply is read as
   * assignment decisions, at most one task is admitted, and that task runs to a graded verdict
   * and a released seat before the advisor is asked again. Counting advisor turns is what the
   * bound has always measured; it is named for that now rather than for the exchange shape it
   * used to be described by.
   */
  maxAdvisorTurns?: number
  /**
   * @deprecated The former name of `maxAdvisorTurns`. Use that instead.
   *
   * PROGRAMMATIC COMPATIBILITY ONLY. It exists so an existing caller that constructs
   * `RelayOptions` directly -- a test, a script, an embedder -- keeps working across the
   * rename instead of failing to compile. Neither front-end reads it: `--rounds` feeds
   * `maxAdvisorTurns` in `bin/conclave.ts` and in `src/repl/session.ts`, and that must stay
   * true, because the alias is the compatibility shim and not the supported path.
   *
   * `maxAdvisorTurns` wins when both are given. Deliberately not an error: a caller that
   * sets both has almost certainly added the new name over an old one it did not notice, and
   * the new name is the one it meant. The precedence is pinned by a test rather than left to
   * be rediscovered from `??` -- see `advisorTurns.test.ts`.
   *
   * Nothing in the product should grow a reader for this. When the last external caller is
   * gone, this field goes with it, and `boundOf` below is the one place that has to change.
   */
  maxRounds?: number
  /**
   * Per-turn deadline, handed to each adapter's watchdog rather than kept here.
   *
   * Optional, so the run's actual budget is not readable off this field. Ask `deadlines`.
   */
  turnWatchdogMs?: number
  /**
   * How long to wait for the transcript to catch up with a turn the hook says has ended.
   * NOT a turn deadline; see `#exchange`. Default 15s.
   */
  transcriptSettleMs?: number
  /**
   * How much LONGER to wait when a completed turn's report came back empty.
   *
   * Separate from `transcriptSettleMs` because the two are budgets against different costs.
   * The settle window is paid on every turn, so it must stay small. This is paid only when
   * the alternative is routing a blank or ending the run, so it can be generous -- and it
   * stops the instant prose appears, which is almost always at once. Default 90s.
   */
  transcriptSalvageMs?: number
  /**
   * How long to wait for a target that is still mid-turn before refusing to send (#117).
   *
   * A third budget, against a third cost. The settle and salvage windows are both paid AFTER a
   * turn ended, buying a better account of it; this one is paid BEFORE a send, and what it
   * buys is the send being possible at all. Default 5 minutes -- see
   * `DEFAULT_SEND_PRECONDITION_MS` for why it is much the largest of the three.
   */
  sendPreconditionMs?: number
  /**
   * Routing-log entries as they are recorded. Kept for callers that only want the log and
   * only want it pushed at them; `observe()` is the fuller surface, and carries the
   * participant activity this does not.
   */
  onLog?: (m: RelayMessage) => void
  /** Enables automatic rotation on mechanical degradation. See `RotationConfig`. */
  rotation?: RotationConfig
  /**
   * Injected for testing the pause's child-liveness evidence and its refresh.
   *
   * Production samples the actual child process. An in-memory fake has no child, so without
   * this seam the whole of #101 -- the measurement, its timestamp, and the re-measurement that
   * makes the timestamp move -- is unreachable from any test that does not spawn a real CLI.
   * The console already carries the identical seam for its `/continue` guard
   * (`src/repl/session.ts:332`), and the two are deliberately the same shape.
   */
  liveness?: ((pid: number) => Promise<ChildLiveness>) | undefined
  /**
   * How often a paused run re-measures its liveness evidence. Default
   * `LIVENESS_REFRESH_EVERY_MS`.
   *
   * A test that had to wait thirty real seconds to see the second measurement would not be
   * written, and the refresh would ship with only its first tick ever observed.
   */
  livenessRefreshMs?: number | undefined
  /** How many re-measurements at most. Default `LIVENESS_REFRESH_LIMIT`. */
  livenessRefreshLimit?: number | undefined
  /**
   * The clock the DURATION CEILING is measured on, and nothing else. Defaults to `Date.now`.
   *
   * Injected for the same reason `livenessRefreshMs` is: the alternative is a test that sleeps.
   * A duration ceiling proved by sleeping is a fixture calibrated to the machine it was written
   * on -- the fake session's own `holdTurn` doc has the story of the last one of those -- and
   * #112 needs two facts proved about this clock that a sleep cannot separate: that a paused
   * interval does not advance it, and that an active one still does.
   *
   * Deliberately NOT the clock the routing log, the verdicts or the report timestamps are
   * written with. Those are records of when something happened in the world, and a run whose log
   * disagreed with the wall would be a worse artefact than an untested ceiling. The one reading
   * beyond the ceiling that moves with it is the seat table's opening `idleSince`, stamped from
   * the same instant the window opens because it IS that instant.
   */
  now?: (() => number) | undefined
}

/**
 * What the git boundary decided about one seat.
 *
 * Returned rather than acted on inside `#crossBoundary`, because the seat is still `integrating`
 * when the merge runs and marking it blocked there would be overwritten by the release that
 * follows. The caller owns the ordering; this owns the judgement.
 */
type BoundaryOutcome =
  /** Merged, empty, or not a worktree run at all — the seat carries on normally. */
  | { kind: 'clear' }
  | { kind: 'blocked'; seatId: string; escalate: boolean; detail: string; evidence: string[] }
  /**
   * The merge went in and the integrated tree fails its configured checks (#80).
   *
   * NOT `blocked`, and the difference is the whole of what this issue is about. A blocked
   * merge is one seat's problem in one seat's tree: git said so, the work is on a branch that
   * will not go in, and the seat that produced it is the seat that repairs it. This is the
   * opposite shape -- every merge succeeded, every seat's own tree was green, and what is red
   * is the combination. So no seat is marked, no seat is blocked, and the task that happened
   * to be merged last is not the task at fault. The seat is released exactly as a clear
   * boundary releases it.
   */
  | {
      kind: 'integration_red'
      /** The tasks whose combination is red, newest last. Never one seat's name alone. */
      contributors: MergeContribution[]
      failures: IntegrationCheckResult[]
    }

/** One merge that is in the integration checkout, and whose work is therefore in the tree. */
interface MergeContribution {
  taskId: string
  seatId: string
  integrationSha: string
}

/**
 * One completed turn, as `#exchange` hands it back.
 *
 * Named rather than inline because a turn is now a value that OUTLIVES the call that produced
 * it: with several seats in flight, a completed turn waits in an arrival queue until the
 * dispatcher gets to it, and a queue of anonymous object literals is a queue nobody can read.
 */
export interface TurnResult {
  /** The report, or the narration it was rebuilt from. Never the interstitial prose alone. */
  prose: string
  /** The `turn_end` this turn settled on, BEFORE supersession is resolved. */
  end: TurnEndEvent
  /** Whether the transcript settle window was exhausted with the turn still in progress. */
  unsettled: boolean
  emittedSinceSend: number
  /**
   * How long this participant's event list was when the prompt went out.
   *
   * The `before` half of the subtraction above, kept rather than discarded so the count can be
   * TAKEN AGAIN later against the same origin. That is what lets a paused run refresh both
   * halves of its liveness evidence on one clock: a fresh CPU sample paired with the frozen
   * count would date one fact to the other's moment, which is the mistake `describeLiveness`
   * already refuses to make for the `/continue` guard (#101, #83).
   *
   * And the count is not decoration on that line. A child whose events go 18 → 26 while the
   * operator reads the pause is producing; one stuck at 18 is not, and neither fact is legible
   * from a number that cannot move.
   */
  emittedBefore: number
  /** Paths that became dirty in this participant's own root during the turn. */
  changedDuringTurn: string[]
}

/**
 * One turn that has come back, waiting for the dispatcher to get to it.
 *
 * The `error` arm is why this is a union rather than a record with an optional field: a turn
 * that threw has no report, and a reader that could ask for `report` on a failed completion
 * would eventually do so. Errors travel as VALUES here because the alternative is an unhandled
 * rejection: with several turns in flight, the one that throws is not the one anything is
 * awaiting, and a rejection nobody is holding takes the process down rather than the run.
 */
type Completion =
  | { task: Task; seat: RelayParticipant; exec: SeatExecution; report: TurnResult }
  | { task: Task; seat: RelayParticipant; exec: SeatExecution; error: unknown }

/** The default when a caller names no bound, in one place so the two fields cannot disagree. */
export const DEFAULT_ADVISOR_TURNS = 6

/**
 * How many advisor turns this run gets.
 *
 * A function rather than a `??` chain at the point of use, so the deprecated alias is read in
 * exactly one place. That matters more than the line it saves: the resolution rule is the
 * whole content of the compatibility promise, and a rule written inline is a rule that gets
 * written a second time somewhere else and quietly disagrees with itself. Deleting the alias
 * later means deleting one clause here.
 */
export function boundOf(opts: Pick<RelayOptions, 'maxAdvisorTurns' | 'maxRounds'>): number {
  return opts.maxAdvisorTurns ?? opts.maxRounds ?? DEFAULT_ADVISOR_TURNS
}

/**
 * The implementer seats this run actually has, in configured order.
 *
 * A function for the same reason `boundOf` is one: the rule that reconciles the plural option
 * with the singular one is the whole of the compatibility promise, and a `??` written at each
 * point of use is a rule that eventually disagrees with itself. One reader, so "what are the
 * seats" has exactly one answer and the N=1 identity cannot rot.
 *
 * Order is configured order, and it is load-bearing at join time only: seats are joined in this
 * order, which at N=1 is the order the default run has always had. Nothing else reads the
 * position -- scheduling reads the seat table, and the lead implementer is named by id.
 */
export function implementerSeats(
  opts: Pick<RelayOptions, 'implementer' | 'implementers'>,
): ParticipantSpec[] {
  return opts.implementers ?? [opts.implementer]
}

/**
 * The id of the Nth implementer seat, counting from zero.
 *
 * The first seat is `implementer` at EVERY N, and that is the whole content of the function.
 * That id is in every message header, every routing log line, the run report, the session lock
 * and `status --json` today, and `RelayOptions.implementer` names it by hand -- so a scheme that
 * renamed it once a second seat appeared would change all of those for an operator who asked
 * only for a second seat. Later seats are numbered from two, the way an operator counts them,
 * which is also the pair (`implementer`, `implementer-2`) the merge and attribution tests were
 * already written against.
 *
 * Not operator-supplied. D6 wants seat ids the operator chooses, and choosing them means
 * sanitising them into a path and a ref name (`sanitize` in `src/workspace/worktrees.ts`);
 * that is a decision with its own failure modes and it is not this one.
 */
export function seatIdFor(index: number): string {
  return index === 0 ? 'implementer' : `implementer-${index + 1}`
}

/**
 * What `--implementer` and `--implementers` between them asked for.
 *
 * `default` is the absent case and it must stay literally absent: the front-end passes no
 * `implementers` key at all, so `implementerSeats` returns `[implementer]` by the same
 * expression it always did. `listed` is the operator naming the seat list themselves, whether
 * that list has one entry or four.
 */
export type SeatPlan =
  | { kind: 'default' }
  | { kind: 'listed'; seats: SeatRequest[] }
  | { kind: 'refused'; reason: string }

/**
 * One seat as the operator asked for it: an agent, and the launch arguments meant for THAT seat.
 *
 * The agent and its arguments travel together because the alternative was two flags read
 * positionally -- `--implementers a,b --implementers-args "x;y"` -- where the correlation
 * between the two lists exists only in the operator's head and in the order they typed them. A
 * shell that eats one entry of one list silently shifts every argument onto the wrong seat, and
 * the run starts: seat two is launched with seat three's model and nothing anywhere says so.
 * Heterogeneous seats (#77) are the point of the feature, so getting the pairing wrong is not a
 * cosmetic failure -- it is the feature doing the opposite of what it was asked.
 *
 * `args` is always present and may be empty, rather than optional. A seat that named no
 * arguments and a seat whose arguments were dropped somewhere read identically once the field
 * can be absent, and this is the field the whole syntax exists to carry.
 */
export interface SeatRequest {
  agent: string
  /** Launch arguments typed for this seat alone, empty when the entry named only an agent. */
  args: string[]
}

/**
 * Read the two seat flags together, or refuse the invocation.
 *
 * One reader for both front-ends, for the reason `ceilingsFrom` is one: two blocks that each
 * parsed a comma list would eventually disagree about a trailing comma, and the operator would
 * discover it by getting a different number of seats from `relay` than from `session`.
 *
 * The refusals are the interesting part, and both are cases where the alternative is a run that
 * starts wrong rather than one that fails:
 *
 *   - an empty or flag-shaped entry -- `--implementers claude,` or `--implementers --json` --
 *     is a shell that ate an argument, and silently dropping it starts a run with fewer seats
 *     than the operator typed.
 *   - `--implementer x --implementers y,z` names two different agents for the SAME seat, since
 *     the first entry of the list IS the seat `--implementer` names (`seatIdFor(0)`). Picking
 *     one would ignore a flag the operator typed on purpose; there is no third seat to put the
 *     loser in.
 *
 * `--implementer claude --implementers claude,claude` is not a conflict and is accepted: the
 * operator restated the lead seat and then added one.
 *
 * ENTRY SYNTAX. An entry is an agent optionally followed by that seat's launch arguments,
 * separated by whitespace, and entries are separated by commas:
 *
 *   --implementers "claude --model opus-5, claude --model sonnet-5"
 *
 * The comma is the seat boundary and the first token of each entry is the agent; everything
 * after it belongs to that seat and to no other. The split is whitespace, the same naive rule
 * `extraArgs` applies to `--implementer-args`, and deliberately not a shell parser: an argument
 * needing quotes belongs in `.conclave/config.json`, which is keyed by agent and has a file's
 * worth of room. The cost, stated rather than discovered: an argument containing a COMMA cannot
 * be written here, because the comma is read as the next seat.
 *
 * Only the agent is checked for flag shape. `--implementers "claude --model x"` is an entry
 * whose arguments legitimately begin with a dash, while `--implementers ",claude"` or an entry
 * whose FIRST token is flag-shaped is still a shell that ate an argument -- so the refusal that
 * catches a lost entry survives, and the one that would have caught the new syntax is gone.
 */
export function implementerSeatPlan(raw: {
  /** What `--implementer` resolved to, its default included. */
  implementer: string
  /** The raw `--implementers` value, empty when the flag was not given. */
  implementers: string
  /** Whether `--implementer` was actually typed, as opposed to falling back. */
  implementerNamed: boolean
}): SeatPlan {
  const listed = raw.implementers.trim()
  if (listed === '') return { kind: 'default' }
  const seats: SeatRequest[] = []
  for (const entry of listed.split(',')) {
    const [agent, ...args] = entry.trim().split(/\s+/).filter(Boolean)
    if (agent === undefined || agent.startsWith('-')) {
      const detail =
        agent === undefined ? 'an empty entry' : `an entry whose agent looks like a flag ("${agent}")`
      return {
        kind: 'refused',
        reason:
          `--implementers "${raw.implementers}" has ${detail}. It is a comma-separated list of ` +
          `seats, each an agent followed by that seat's own launch arguments: ` +
          `--implementers "claude,claude" or --implementers "claude --model opus-5, claude --model sonnet-5".`,
      }
    }
    seats.push({ agent, args })
  }
  if (raw.implementerNamed && seats[0]!.agent !== raw.implementer) {
    return {
      kind: 'refused',
      reason:
        `--implementer ${raw.implementer} and --implementers "${raw.implementers}" name different agents ` +
        `for the same seat. The first entry of --implementers IS the seat --implementer names ` +
        `('${seatIdFor(0)}'), so drop one or make them agree.`,
    }
  }
  return { kind: 'listed', seats }
}

/**
 * One `ParticipantSpec` per seat, ids assigned by `seatIdFor` and args resolved per agent.
 *
 * `argsFor` is a callback rather than a list because launch arguments are a property of the
 * AGENT -- `.conclave/config.json` keys them that way -- and two seats can be filled by
 * different ones. At N=1 this returns exactly the object both front-ends built inline before it
 * existed, which is what keeps the default run's spec unchanged.
 *
 * Three sources, composed in that order: what the project configured for the agent, what
 * `argsFor` adds for every implementer seat (`--implementer-args`), and last the arguments the
 * operator typed for THIS seat. Last wins, which is the rule the child CLIs themselves apply to
 * a repeated flag, so a seat that names its own `--model` overrides the one the run set for all
 * of them rather than being overridden by it.
 */
export function implementerSpecsFor(
  seats: readonly SeatRequest[],
  argsFor: (agent: string) => string[],
): ParticipantSpec[] {
  return seats.map((seat, i) => {
    const args = [...argsFor(seat.agent), ...seat.args]
    return {
      id: seatIdFor(i),
      agent: seat.agent,
      role: 'implementer',
      ...(args.length > 0 ? { args } : {}),
    }
  })
}

/**
 * The reviewer seat `--reviewer` asked for, or `undefined` if it was not given (#72).
 *
 * The one shared builder both front-ends read, for the reason `implementerSeatPlan` and
 * `implementerSpecsFor` are: two blocks that each parsed `--reviewer` locally would
 * eventually disagree about what an empty value means. `agent` empty is `undefined` --
 * D1's "expressible and off" as a return value rather than a branch a caller writes.
 *
 * Singular, fixed id `'reviewer'`: unlike `--implementers` there is no list syntax, because
 * the issue this answers is "one more blind reader", not a pool of them.
 */
export function reviewerSpecFor(
  agent: string,
  argsFor: (agent: string) => string[],
): ParticipantSpec | undefined {
  if (agent === '') return undefined
  const args = argsFor(agent)
  return { id: 'reviewer', agent, role: 'reviewer', ...(args.length > 0 ? { args } : {}) }
}

/**
 * One clock, as one seat will actually run it.
 *
 * Tagged rather than `number | undefined`, because the two ways of having no number are not
 * the same fact and a reader acts differently on each. `disabled` means nothing is watching
 * and a deadline COULD be set; `unsupported` means the adapter has no such clock, so a turn
 * that trips it produces no verdict and no configuration will change that. Collapsing them
 * -- or omitting the field, which reads as neither -- leaves a reader waiting for a
 * `timed_out` that cannot arrive.
 */
export type DeadlineClock =
  | { status: 'enforced'; ms: number }
  | { status: 'disabled' }
  | { status: 'unsupported' }

/** What one seat is measured against. Both clocks, always both present. */
export interface ParticipantDeadlines {
  /** The seat, not the agent: ids are what the turns in the report are keyed by. */
  id: string
  agent: string
  /**
   * The whole turn, however busy. Refreshed by NOTHING.
   *
   * Child output pushes out `silence` and never this, so a turn that keeps producing still
   * reaches this number -- and what happens when it does is that the run stops awaiting that
   * exchange and reports `timed_out`. Not that the turn ends: nothing here reaches the child,
   * and the seat stays unsendable until a cancellation, terminal transcript or hook evidence,
   * or the process exiting. The released wait is what the run needs, because `--max-turns` and
   * `--max-minutes` are checked at turn boundaries and nowhere else, so a turn output could
   * extend without limit would be a run no ceiling could end.
   *
   * A `timed_out` from THIS clock is the case #36 did not fix. The adapters re-read the
   * transcript when a deadline fires, but a working turn's transcript says `in_progress`,
   * which is not evidence it ended, so the verdict stands on a turn that was fine. A reader
   * seeing `timed_out` on a seat whose turns are legitimately long should suspect this number
   * before suspecting the child.
   *
   * Suspect, not confirm. This is the CONFIGURED budget and nothing else: neither this field
   * nor any other in the report says which of the two clocks actually produced a given
   * verdict. That provenance exists on the watchdog's update at the moment it fires and is not
   * retained here, so the artifact answers "what was this seat measured against" and cannot
   * answer "which clock produced this verdict" -- and neither question is "what ended this
   * turn", which is not something either clock does.
   */
  absolute: DeadlineClock
  /**
   * How long the turn may say NOTHING. A different question, not a tighter version.
   *
   * The only one of the two that substantive child output pushes out, and the one that reaches
   * an ordinary hang: a child that stopped working stopped writing, so this fires at its own
   * budget rather than leaving the turn to the absolute cap. That is the part of #36 that was
   * fixed, against the incident actually reported -- the wait went from ~44 information-free
   * minutes to this number.
   *
   * A configured budget, like the field above it, and equally silent about which clock fired.
   */
  silence: DeadlineClock
}

/**
 * The deadlines a run was measured against — per seat, because the verdict is.
 *
 * There is no run-wide answer, and reporting one was wrong: a `timed_out` belongs to a
 * participant, and two seats in the same run can be on different clocks or on none. The
 * adapters differ in what they can KNOW rather than only in how they were wired, so a
 * single pair of numbers here would be an average that neither seat honours.
 */
export interface RunDeadlines {
  /**
   * What the invocation ASKED for, and nothing more. Kept because the gap between this and
   * `participants` is itself worth seeing -- `--turn-timeout 60` against a seat whose
   * adapter has no silence clock is a request half of which went nowhere.
   */
  configuredAbsoluteMs: number | null
  participants: ParticipantDeadlines[]
}

/**
 * Resolve one declared clock against what this run asked for.
 *
 * The only place the precedence lives: an unsupported clock stays unsupported however hard
 * it is configured, a request beats the adapter's default, and an absent default with no
 * request is off rather than infinite.
 */
function resolveClock(support: ClockSupport, requestedMs: number | undefined): DeadlineClock {
  if (!support.supported) return { status: 'unsupported' }
  const ms = requestedMs ?? support.defaultMs
  return ms === undefined ? { status: 'disabled' } : { status: 'enforced', ms }
}

/**
 * A participant's own statement that something is unresolved.
 *
 * Lifted verbatim from a turn's report rather than detected. Detection was considered and
 * rejected: "I haven't run X", "that is inherited reasoning" and "I believe but did not
 * verify" are all real phrasings, and any pattern list would be incomplete in a way that is
 * WORSE than nothing -- a missed flag would then be doubly silent, absent from the summary
 * and presumed covered by a mechanism that claims to catch it.
 *
 * So it is a convention the participants are told about, which also makes flagging a
 * first-class act rather than a paragraph that happens to be well written.
 */
export interface RelayFlag {
  participant: string
  text: string
  /** Routing-log position of the turn that raised it, so it can be found in context. */
  seq: number
  /**
   * The closing statement that retired this, when one did. Absent while it still stands.
   *
   * SUPERSEDED IS NOT NEVER-RAISED, and both have to remain readable off the record (#131).
   * A seat is shown its own accumulated flags at the close and asked which still stand; the
   * ones it does not restate stop being outstanding, because the seat is the only thing in
   * this system that can make that judgement. But a seat that answers `NONE` because it was
   * lazy or truncated looks exactly like a seat that fixed everything, so the item is retired
   * rather than deleted, and `flagSummary` still prints it under its own heading. A summary
   * going quiet is a worse failure than a summary being noisy.
   */
  supersededBy?: number
  /**
   * Later routing-log positions where the same participant raised this same text verbatim.
   *
   * The duplicate is collapsed rather than counted twice -- three turns of "conformance.sh
   * remains unrun" is one unresolved item, and a summary that says `3 flagged items carried`
   * over the top of it is telling an operator something false about how much is outstanding.
   * The positions are kept because collapsing must not be lossy: a flag re-raised on three
   * separate turns is a different fact from one raised once, even though the count is the same.
   */
  restated?: number[]
}

/** The marker participants are told to use. Line-initial, so prose about it does not match. */
export const FLAG_MARKER = /^\s*FLAG:\s*(.+)$/gim

export function extractFlags(prose: string): string[] {
  const out: string[] = []
  for (const m of prose.matchAll(FLAG_MARKER)) {
    const text = m[1]?.trim()
    if (text) out.push(text)
  }
  return out
}

/**
 * The marker that separates a build-changing scope question from a result-qualifying concern.
 *
 * The relay cannot read intent, so it needs a line-initial prefix. A question that would change
 * what is built is answered on the implementer's authority if the run continues, so it must
 * pause for a human answer; a concern that only qualifies the result is a `FLAG:` and the run
 * continues. The distinction is the whole reason the two markers exist.
 */
export const UNANSWERED_MARKER = /^\s*UNANSWERED:\s*(.+)$/gim

export function extractUnanswered(prose: string): string[] {
  const out: string[] = []
  for (const m of prose.matchAll(UNANSWERED_MARKER)) {
    const text = m[1]?.trim()
    if (text) out.push(text)
  }
  return out
}

/**
 * How the advisor says something to the HUMAN without halting the run.
 *
 * Until now it had two options and neither is this. Fold the finding into the next
 * instruction, which is what the briefing tells it to do and which pollutes an instruction
 * with something the implementer does not need; or `ESCALATE`, which stops the run to say it.
 * So a finding worth recording but not worth stopping for had nowhere to go and died with the
 * turn.
 *
 * This is a ROUTING capability rather than only a convention. The advisor can already produce
 * prose; what it could not do is direct part of that prose at the human alone. A `NOTE:` line
 * is lifted out of the reply, recorded addressed to nobody, and the REMAINDER is still routed
 * to the implementer as the instruction.
 *
 * On adoption, honestly: the `FLAG:` convention added for #30 was not used by the one real
 * participant that had something to flag (#38), and there is no reason to assume this fares
 * better. What is different is that the fallback is not silence -- a note that is never
 * written simply leaves things as they are today, whereas an unwritten FLAG made an empty
 * `flags` array read as "nothing outstanding". Worth shipping on those terms and worth
 * measuring rather than assuming.
 */
export const NOTE_MARKER = /^[ \t]*NOTE:[ \t]*(.+)$/gim

export function splitNotes(prose: string): { notes: string[]; rest: string } {
  const notes: string[] = []
  for (const m of prose.matchAll(NOTE_MARKER)) {
    const text = m[1]?.trim()
    if (text) notes.push(text)
  }
  // The remainder is what the implementer receives. A note left in would read as part of the
  // instruction, which is the pollution this exists to remove.
  const rest = prose.replace(NOTE_MARKER, '').replace(/\n{3,}/g, '\n\n').trim()
  return { notes, rest }
}

/** A reviewer's verdict, read off its report (#72). See `REVIEWER_BRIEFING`. */
export type ReviewVerdict = { accepted: true } | { accepted: false; reason: string }

/**
 * Parse a reviewer's reply. Fails closed, the same direction `parseDecisions` does.
 *
 * `ACCEPT` must be the whole reply -- an exact match, not merely a line starting with it --
 * so a reviewer that writes ACCEPT and then explains itself anyway is treated as having
 * said something else, rather than the explanation being silently dropped. Anything that is
 * not exactly ACCEPT is a rejection: nothing merges on an ambiguous reply, which is the safe
 * direction to fail in when the alternative is guessing that unclear prose meant yes.
 *
 * `REJECT: <reason>` is read for the reason; a reply that rejects without that exact form
 * still rejects, using its own full text as the reason, so a reviewer that forgets the
 * format still blocks the merge rather than being silently ignored.
 */
export function parseReviewVerdict(prose: string): ReviewVerdict {
  if (/^\s*ACCEPT\s*$/i.test(prose)) return { accepted: true }
  const m = /^[ \t]*REJECT:[ \t]*([\s\S]+)$/im.exec(prose)
  const reason = m?.[1]?.trim()
  return { accepted: false, reason: reason && reason.length > 0 ? reason : prose.trim() }
}

const LEAD_BRIEFING = `You are the ADVISOR on a two-agent coding session, and you are in charge of it.

Another AI model — the implementer — does the actual work in this repository. You cannot
see its tool calls, its diffs, or its code. You see only the prose it writes back, exactly
as a human following along would. You share its working directory, so you can read files
and run commands yourself to check any claim it makes; prefer doing that over believing it.

YOU HOLD THE GOAL. The human gave it to you and not to the implementer, which has been
told only that you are steering. What the implementer needs to know in order to do the
next piece of work is your call, every time. Sometimes that is the whole goal; sometimes
it is deliberately less, because knowing the destination changes how the work gets done —
a reviewer told what verdict is wanted stops being a reviewer. Neither is the safe
default, so decide rather than reaching for one.

Withholding is not licence to mislead. Never state something false about the work, and
never let the implementer believe it has finished something it has not.

If the goal is ambiguous, ASK — reply exactly ESCALATE: followed by your question. The
human sees it, answers, and the run continues with their reply in front of you. That is
cheaper than spending the implementer's turn on a guess and unwinding it afterwards.

Do investigative work YOURSELF rather than handing it over. Research, code review, reading
the codebase, checking a claim, comparing options — you share the working directory and
have the same tools, so a question you can answer is not an instruction. The implementer's
turn is for CHANGING the repository; sending it a task that touches nothing spends its
turn and delays the work it is actually doing.

Your job is to give it one concrete instruction at a time and react to what comes back.
Reply with the instruction itself and nothing else — no preamble, no restating the plan.
Keep it short. When you investigated something yourself, put what you FOUND in the next
instruction, briefly — otherwise the finding dies with your turn. If the work looks
finished, reply exactly DONE. If it has gone wrong or stalled and needs a human, reply
exactly ESCALATE: followed by why.

If you have something the HUMAN should know that does NOT need to stop the run -- a finding, a
risk you are proceeding despite, a decision you made and why -- put it on its own line
beginning NOTE:. It is recorded for the operator and is not sent to the implementer, and the
rest of your reply is still the instruction. Reserve ESCALATE for when you actually need an
answer before you can continue.`

/**
 * Added to the advisor's briefing when the run has MORE THAN ONE implementer seat.
 *
 * Conditional, and that is the whole reason it is a separate constant. `LEAD_BRIEFING` says
 * "give it one concrete instruction at a time" and a default run must keep being told exactly
 * that: a live experiment is running against the unmodified briefing and its pre-registration
 * says not to change it mid-study (spikes/experiments/04-complaint-as-signal.md), and D1 says
 * the default run must not pay for a feature it did not ask for. An advisor that never hears
 * about the syntax never writes it, and `parseDecisions` treats a reply without a directive
 * exactly as it always has.
 *
 * What it teaches is the syntax and the two rules that make it safe to fail closed on: the
 * whole reply is refused if any part of it is malformed, and a seat that is blocked takes only
 * its own repair. Both are stated as consequences the advisor can avoid rather than as
 * implementation notes, because an advisor that does not know a reply was rejected simply
 * writes the same reply again.
 */
const MULTI_SEAT_BRIEFING = `THIS RUN HAS MORE THAN ONE IMPLEMENTER SEAT, so you must say who each instruction is for.

Address every instruction with a line that starts either

  @seat <seat-id>: <the instruction>

to name one specific seat, or

  @role <role>: <the instruction>

to name a job and let the dispatcher pick the longest-idle seat that does it. The instruction
runs from the colon to the next such line, so it can be several lines long. You may put several
in one reply and they are dispatched CONCURRENTLY to different seats:

  @seat implementer: Add the parser tests for the new syntax.
  @seat implementer-2: Sweep docs/ for references to the old flag name.

Two seats given work in one reply work at the same time. Their reports come back to you one at
a time, in the order they finish, not in the order you wrote them — so a report answering your
second instruction may arrive before one answering your first. Read what each report is about
rather than assuming which it answers.

The whole reply is rejected if ANY part of it is wrong: a seat id or role that does not exist,
text outside a directive, a directive with no instruction after it, or DONE/ESCALATE mixed in
with assignments. Nothing is admitted and you are asked again. So do not write a preamble, and
send DONE or ESCALATE on their own, as a reply that assigns nothing.

DONE while a seat is still working does not end the run: you will be given the outstanding
report first and asked again.

If a seat's work fails to merge you are told so, and that seat then takes NOTHING except the
repair. Address the repair to it BY NAME with @seat — an untargeted instruction will go to a
different free seat, and the blocked one stays blocked until you name it.`

/**
 * Added to the advisor's briefing when the operator is an AGENT rather than a human.
 *
 * `LEAD_BRIEFING` tells the advisor that asking is cheaper than guessing, and then leaves the
 * threshold to its judgement. That judgement is calibrated for a human: expensive to
 * interrupt, possibly absent, and annoyed by a question they consider obvious.
 *
 * None of that holds for an agent operator, which answers in seconds and is not annoyed. So
 * the plumbing in #1 would be necessary but not sufficient -- shipping a channel without
 * retuning the threshold leaves it largely unused.
 *
 * What is added is deliberately about the KIND of question, not merely a lower bar. An
 * operator that is the same kind of thing as the participants shares their blind spots, so
 * escalating "may I run this command" adds nothing: the value is entirely in escalating the
 * things an outside view would catch, and a wrong premise is the one that costs most.
 *
 * Appended rather than edited into LEAD_BRIEFING. A live experiment is running against the
 * unmodified briefing and its pre-registration says not to change it mid-study
 * (spikes/experiments/04-complaint-as-signal.md), so the default path stays byte-identical.
 */
const AGENT_OPERATOR_NOTICE = `The operator of this session is an AGENT, not a human.

That changes what is worth asking. An answer costs seconds rather than an interruption, so
escalate more readily than you otherwise would — but escalate the things an outside view
catches, not permission. Specifically: a premise in the goal you suspect is wrong, acceptance
criteria you cannot make observable, and a choice between two defensible designs where the
operator's intent decides it.

Do NOT escalate to ask permission to act, or to report progress. Nothing about an agent
operator makes those useful, and they crowd out the questions that are.

One caution about the answer you get back. An agent operator is the same kind of thing you
are and may share your blind spots, so its reply is not independent confirmation the way a
human's is. Treat it as another opinion with authority over the goal, not as evidence.`

/**
 * Added to the advisor's briefing when this run has a REVIEWER seat (#72, D9b).
 *
 * Conditional for the same reason `MULTI_SEAT_BRIEFING` is: a default run must never pay in
 * briefing tokens for a seat it does not have, and a live experiment is pinned against the
 * unmodified `LEAD_BRIEFING` text (see the comment above `MULTI_SEAT_BRIEFING`).
 *
 * Deliberately short, and deliberately not a syntax lesson: review is dispatched by the
 * orchestrator the moment a seat's work is ready, not by the advisor addressing anything, so
 * there is no `@seat`/`@role` form to teach here. What the advisor needs is not "how to send
 * work to the reviewer" but "what a review report means when one arrives", so an accepted or
 * rejected verdict is not mistaken for an ordinary implementer report.
 */
const REVIEWER_BRIEFING_FOR_ADVISOR = `THIS RUN ALSO HAS A REVIEWER SEAT. You do not send it anything: completed
implementer work is sent to it automatically, before it merges, and you will see its verdict
as an ordinary report. If it accepts, the work proceeds to the integration checkout exactly
as it would with no reviewer. If it rejects, a repair task is created automatically and
dispatched back to the seat that produced the work — you do not need to do anything for that
to happen either. You will see both the rejection and the repair as ordinary reports. Only a
SECOND rejection of the same work reaches you, as a pause, because at that point another
automatic repair is unlikely to change anything.`

const IMPLEMENTER_BRIEFING = `You are the IMPLEMENTER on a two-agent coding session.

Another AI model — the advisor — is steering. It cannot see your tool calls or your code,
only what you write, so your prose is the entire report. Say what you did, what you found,
and anything you are unsure about.

It outranks you on process, but you are not required to agree with it. If an instruction
is wrong, say so plainly and say why, then proceed unless a human overrules. Silent
compliance is worse than disagreement.

If you finish work while something remains unchecked -- a test you did not run, a belief you
took from a comment rather than confirmed, an assumption you could not close -- end your
report with a line beginning FLAG: and say it in one sentence. A flag does NOT stop the run.
It is carried into the final summary so the operator sees it, because the summary is the part
anyone actually reads.

If you had to choose a build-changing scope direction without an answer, end your reply with a
line beginning UNANSWERED: followed by the question in one sentence. Include what you did
meanwhile in the same reply. An UNANSWERED line PAUSES the run until the human answers it; it
is not a flag, because the build cannot proceed until the question is settled. Choices about
how to build remain yours; use FLAG: for every concern that only qualifies the result rather
than invalidating it.`

/**
 * What a REVIEWER seat is told instead of `IMPLEMENTER_BRIEFING` (#72, D9b).
 *
 * Sent only to a seat whose role is `reviewer` -- a reviewer is rank `implementer` (D5), so
 * without this it would fall into the `IMPLEMENTER_BRIEFING` loop and be told it writes code,
 * which is wrong on every count that matters: it has no worktree, is never asked to change
 * anything, and its report is read as a verdict rather than as work done.
 *
 * States the load-bearing rule up front, the same one the module doc of `rotation/review.ts`
 * argues for: everything it is given is captured mechanically, never written by the seat under
 * review. `WITHHELD_GOAL_NOTICE` is sent to this seat too, for the reason `LEAD_BRIEFING`
 * gives its own name to: "a reviewer told what verdict is wanted stops being a reviewer".
 */
const REVIEWER_BRIEFING = `You are the REVIEWER on this session. You do not write code and hold no goal.

You will be sent one review at a time: the instruction a seat was given, and what changed in
its tree, captured directly from git and from the configured checks — never written or
summarised by that seat. Treat everything in a review as fact, because none of it passed
through anyone's account of their own work.

Read the diff. Judge it against the instruction it was answering, not against work you would
have done differently. Reply with exactly ACCEPT and nothing else if it should merge. Reply
with a line starting REJECT: followed by why, if it should not — be specific enough that the
seat that produced it can act on your reason without seeing anything else you wrote. A
rejection becomes a task assigned back to that seat automatically; you do not dispatch it
yourself.`

/**
 * What the implementer is told INSTEAD of the goal.
 *
 * The human's goal now reaches the advisor alone. Two reasons, and the second is the one
 * that made it unconditional: a session may deliberately need the implementer not to know
 * where the work is heading — a reviewer told what verdict is wanted stops being a
 * reviewer — and a goal that went to both by default made that impossible to arrange
 * after the fact. The first is simply that the advisor is in charge, and an instruction
 * that has to compete with the recipient's own reading of the goal is a weaker
 * instruction.
 *
 * Said out loud rather than left as an absence. An implementer that noticed no goal would
 * reasonably go looking for one, or ask, and spend a turn doing it.
 */
/**
 * How a direct question announces itself.
 *
 * Asked out of run, a participant has no way to know it. The advisor was told "get the
 * implementer to fix those" and reasonably assumed its reply would be routed onward as an
 * instruction, the way every reply during a run is. It cannot be — there is no loop to
 * carry it — so it did the next most sensible thing and spawned a subagent to do the work,
 * announcing that it was "handing the fix to an implementer agent".
 *
 * That is the orchestrator's omission, not the model's mistake. A message that arrives
 * with no context about what can be done with the answer invites exactly that inference.
 */
const DIRECT_QUESTION_NOTICE = `[Direct question from the human. No run is in flight: your
reply goes to them and to nobody else, and nothing you say here is routed to the other
participant. Answer them, or say what you would instruct — do not spawn a subagent to
stand in for the other participant.]`

const WITHHELD_GOAL_NOTICE = `The advisor holds this session's goal. You have not been given
it, and that is deliberate rather than an oversight — do not go looking for it or ask what
it is. Work from the instruction in front of you, and say plainly when something about it
does not make sense to you.`

/**
 * Subagents, and the one hard rule about them.
 *
 * Both CLIs can spawn subagents and neither was told so, which left the only form of
 * parallelism available to a participant unused. WHEN to use them is a judgement about
 * the work, so it is left to the participant -- an orchestrator that mandated subagents
 * would be making that call with less information than the model has.
 *
 * The worktree rule is not a preference. Two writers in one checkout is the exact failure
 * this session is built to detect rather than cause: `sessionLock` refuses to stage while
 * participants are live, and restricted-message attribution reads `git status` to decide
 * which participant dirtied which path. A subagent editing the shared directory makes
 * both of those lie -- its writes are indistinguishable from its parent's, so an aside
 * gets attributed to work that did not come from it. Read-only subagents are exempt
 * because they cannot dirty anything.
 */
const SUBAGENT_BRIEFING = `You can spawn subagents, and should when work genuinely splits —
independent research, reviewing several files at once, exploring parts of the codebase that
do not depend on each other. You decide when it is worth it; nobody is asking you to use
them for their own sake.

A subagent is YOURS. It is not the other participant in this session. "The implementer" and
"the advisor" name two peers with their own sessions and their own context, reachable only
through what this orchestrator routes between them — you cannot spawn one, and a subagent
you spawn is not one however you label it. If you want the other participant to do
something, say so in your reply; do not hand the job to a subagent and call it delegation.

One rule, and it is not negotiable: a subagent that MODIFIES anything must work in its own
git worktree, never in the shared working directory. Another model is working in that
directory right now, and this session decides who changed what by reading git state — a
second writer in the same checkout makes that attribution wrong, silently. Subagents that
only read (research, review, search) can use the shared directory freely.`

/**
 * The revision that withdrew a `turn_end`, and whatever replaced it.
 *
 * Adapters retract a verdict BY NUMBER — `revision.replaces` names the seq of the
 * `turn_end` being withdrawn (see `#apply` in `adapters/claude.ts`) — so this is an exact
 * link rather than an inference from timing or turn keys. A compaction revision carries an
 * empty `replaces` and therefore never matches, which is correct: compaction rewrites
 * history without contradicting a verdict.
 *
 * The replacement is the next `turn_end` after it. The tracker emits the revision and its
 * successor back to back, and nothing can be sending this participant a new turn at the
 * points where this is consulted — between exchanges, or with the loop suspended at a pause.
 */
function supersessionOf(
  events: AgentEvent[],
  end: TurnEndEvent,
): { revision: RevisionEvent; replacement: TurnEndEvent | undefined } | undefined {
  const i = events.findIndex((e) => e.type === 'revision' && e.replaces.includes(end.seq))
  if (i < 0) return undefined
  const replacement = events.slice(i + 1).find((e) => e.type === 'turn_end') as TurnEndEvent | undefined
  return { revision: events[i] as RevisionEvent, replacement }
}

/**
 * What makes two `turn_incomplete` pauses the same question. See `Relay#incompleteAnswered`.
 *
 * A module function rather than a template written twice, because the whole latch turns on the
 * two spellings agreeing: one built at the arming site and one at the checking site would latch
 * an answer nothing could ever match, and the failure would be invisible -- the run would simply
 * go on asking, which is what it does today.
 */
function incompleteSignature(
  outcome: Verdict['outcome'],
  provenance: readonly { source: string; detail: string }[],
  reading: LivenessReading,
): string {
  // The PROVENANCE is in the key, not just the outcome, and that is not belt and braces.
  // `timed_out`'s own contract says it means a deadline expired and never says why -- the why is
  // in the provenance chain, which is also what the pause shows the operator as its evidence.
  // Keying on the outcome alone collapses two different faults that happen to end a turn the same
  // way into one question, and answers the second with the first one's answer while the child
  // still reads `working`. That is the failure this whole latch exists to avoid, reached from
  // the inside. Raised by an independent review, and pinned by a test that mutates this line.
  //
  // Stable enough to match a genuine repeat: these details are categorical sentences, not
  // timestamps or durations. Where one does carry a value -- a tool name, an abort reason -- a
  // change in it IS a different situation, and asking again is right.
  const why = provenance.map((x) => `${x.source}:${x.detail}`).join('|')
  return `${outcome}/${why}/${reading}`
}

/** What a `turn_incomplete` pause needs in order to be recognised again. */
interface IncompleteLatch {
  seat: RelayParticipant
  outcome: Verdict['outcome']
  provenance: readonly { source: string; detail: string }[]
}

/** A pause in front of a human that rests on a turn verdict, and can therefore go stale. */
/**
 * What one advisor turn did about assigning work, accumulated as the turn runs (#79).
 *
 * The instrument's single source of truth for a turn in progress. Every site that used to write
 * a `TargetingRecord` now writes a field here instead, and `#finaliseTargeting` reads the whole
 * of it once, on the turn's way out. The reason is the denominator: three recording sites meant
 * three paths a turn had to REACH to be counted, and every exit added between them shrank the
 * count without anyone being wrong about anything. It happened three times.
 *
 * Nothing here is a conclusion. `outcome` is not a field, because which of them a turn was
 * is decided at the finalizer from what actually happened -- including the verdict, which can
 * still change while the operator reads a pause.
 */
interface AdvisorAttempt {
  /**
   * Which advisor turn this is, on the run's own numbering — the key its record will carry.
   *
   * Held on the attempt rather than only passed to the finalizer because this object IS the
   * instrument's live view of the turn: `targetingWatch.pending` points at it while the turn is
   * open (see `TargetingWatch.pending`), and a surface naming the open turn has to be able to
   * say which one it is.
   */
  readonly turn: number
  /**
   * The `turn_end` this reply was read from, held rather than re-read off `next`.
   *
   * `next` is REASSIGNED inside the turn -- the failure path re-asks, and so does the
   * notes-only path -- so by the time the finalizer runs, `next.end` can belong to a different
   * turn entirely. Resolving supersession against that would file one turn's verdict on
   * another turn's record.
   */
  readonly end: TurnEndEvent
  /**
   * The verdict the DISPATCH decision was taken on, resolved at the top of the turn.
   *
   * Kept beside the finalizer's own reading so the two can be compared: when they differ, the
   * run acted on a claim its adapter later withdrew, and that is the one thing the record has
   * to be able to say. See `UnadmittedReason.verdict_superseded`.
   */
  readonly heldVerdict: Verdict['outcome']
  /** Whether the reply used `@seat`/`@role`, off `parseDecisions` and never re-read from prose. */
  readonly addressed: boolean
  /** What it named, as written and unvalidated. Empty on the unaddressed form. */
  readonly targets: string[]
  /** Which parse rule refused it, if one did. */
  readonly refusal?: TargetingRecord['refusal']
  /** Which run ceiling refused the whole batch before admission, if one did. */
  ceiling?: TargetingRecord['ceiling']
  /** Set once the batch is past every gate and its instructions are being admitted. */
  admitted: boolean
}

interface VerdictPause {
  handle: RunHandle
  participant: string
  /** The `turn_end` the pause was raised on; a revision naming it withdraws the pause's claim. */
  endSeq: number
  outcome: string
  /** True once the revision has been seen and only the replacement is still outstanding. */
  withdrawn: boolean
}

export class Relay {
  readonly log: RelayMessage[] = []
  /**
   * When the duration ceiling's window opened. Set on the first turn taken, not at construction.
   *
   * The window it opens is measured in ACTIVE time, not wall-clock: `activeMs` deducts every
   * interval the run spent paused, and that getter is where the reasoning lives (#112).
   */
  #startedAt = Date.now()
  /**
   * The window's terminal reading, stamped once when the run ends. See `activeMs`.
   *
   * Both figures together rather than the active one alone, because a run that `stop()` ends
   * while a pause is still open has a paused total that is also still moving at that instant.
   * Freezing one of a pair that must add up is how a record comes to contradict itself.
   */
  #atEnd: { activeMs: number; pausedMs: number } | undefined
  /** Worktrees present when the run began, so new ones can be told from pre-existing ones. */
  #worktreesAtStart: string[] | undefined
  /**
   * Every worktree seen at any point during the run.
   *
   * Sampled repeatedly rather than only at the end, because a subagent that FOLLOWS the
   * briefing creates a worktree, works in it, and removes it -- leaving an end-of-run diff of
   * nothing, indistinguishable from never having made one. The signal would then have fired
   * on the compliant case as readily as on the violation, which is worse than not having it.
   */
  #worktreesSeen = new Set<string>()
  /**
   * `opts.cwd`'s HEAD at run start, used as the review diff base for a seat with no worktree
   * (#72). At N=1 there is no separate integration checkout to diff a seat's branch against
   * -- work happens directly in `opts.cwd` -- so this is the closest available "before".
   */
  #runStartSha: string | undefined
  /**
   * What `handle.suspendedMs` read when the ceiling window opened.
   *
   * The window starts at `#startedAt`, which is set after the briefings rather than at
   * construction, so a suspension from before it is not inside the interval being measured and
   * subtracting it would drive the elapsed reading negative. Nothing pauses that early today;
   * this is what keeps that from being a fact the subtraction silently depends on.
   */
  #suspendedAtStart = 0
  /**
   * Whether the ceiling window has opened. False until `#runLoop` reaches its first turn.
   *
   * `#startedAt` cannot answer this: it is initialised at construction so that it is never
   * `undefined`, which means a relay that has not run yet reports an elapsed time anyway. It is
   * harmless for the ceiling, which is only ever checked inside the loop, and NOT harmless for
   * `activeMs`, which a report may read off a relay whose run never started.
   */
  #windowOpened = false
  /** Turns taken across all participants, which is what a ceiling counts. */
  #turnsTaken = 0
  #participants = new Map<string, RelayParticipant>()
  #seq = 0
  #opts: RelayOptions
  #stopped = false
  /**
   * Per participant: has `stop()` finished closing its session, and a promise that says so.
   *
   * This is the signal `#exchangeTurn`'s poll leaves on, and the reason it is keyed on the CLOSE
   * rather than on `#stopped` is the whole of #143's design question.
   *
   * `#stopped` is set at the top of `stop()`, before a single session has been touched. A poll
   * that left there would leave while the adapter was still mid-sentence -- and on
   * `ClaudeSession` the sentence is the point: `close('graceful')` reconciles from the transcript
   * BEFORE it terminates the pty, so a graceful close is routinely the thing that ESTABLISHES the
   * verdict and emits the very `turn_end` being waited for. Leaving early would throw away a
   * report that was about to arrive, which is worse than the leak it was fixing: a lost verdict is
   * work the run can no longer account for, where a parked poll is only a timer nobody unrefs.
   *
   * So the line is "the adapter has finished saying what happened AND the relay has heard it",
   * not "somebody asked us to stop". `stop()` fires each participant's signal once two things
   * have both happened: that participant's own `close('graceful')` has returned, and the
   * `#attach` reader forwarding its events has drained. The second half is a barrier rather than
   * a grace period on purpose -- how long a verdict takes to cross the forwarder is not something
   * this code should be guessing a number for, and a guess that is ever wrong loses a report.
   *
   * ## Which adapters actually guarantee that verdict
   *
   * None of them (filed as #146); #143 establishes it rather than assuming. Read out per adapter:
   *
   *   claude.ts   `close('graceful')` reconciles from the transcript BEFORE terminating the pty,
   *               which is the ordering the contract asks for and the reason this signal is not
   *               `#stopped`. But the reconcile issues a verdict only for a turn the transcript
   *               already shows as finished -- a genuinely live turn classifies `in_progress`
   *               (the pty is still alive at that point by construction) and emits nothing. The
   *               verdict then comes from the `exit` listener, which `close()` does not await, so
   *               it races `#events.close()` at the end of the same method.
   *   codex.ts    The same shape and the same race, and weaker at the reconcile: a turn the
   *               transcript has not recorded yet is skipped without the tracker being asked.
   *   kimi.ts     Kills first and waits for the child's own exit to produce the verdict, capped
   *               at 3s. A child that ignores SIGTERM -- and neither this adapter nor opencode
   *               escalates to SIGKILL -- leaves the turn open and the stream closes over it.
   *   opencode.ts Identical to kimi's, cap included.
   *
   * So a mid-turn `stop()` may or may not produce a terminal `turn_end`, on every adapter this
   * project has, and which one it does is decided by an unsequenced race between a transcript
   * read and a socket shutdown. That is the case this exists for: the poll has to be able to
   * leave WITHOUT one, and it must not leave before the race has been given its chance to be
   * won. `FakeRotationSession` is the honest floor -- its `close()` emits nothing under any
   * circumstances -- which is why the tests drive both ends against it.
   *
   * What this does NOT do is synthesize the missing verdict. `TurnResult.end` would have to be
   * invented, and a `turn_end` the relay wrote itself would be indistinguishable in the routing
   * log from one an adapter observed. The turn is recorded as lost instead, by name, in
   * `#runLoop`'s `finally`.
   */
  #closed = new Map<string, { done: boolean; promise: Promise<void>; fire: () => void }>()
  /** Set by `RunHandle.requestPause()`; consumed at the next advisor-turn boundary. */
  #pauseRequested: string | undefined
  /** The pause currently in front of a human, when it rests on a verdict. See `#trackSupersession`. */
  #verdictPause: VerdictPause | undefined
  #stream = new RelayEventStream()
  #ended = false
  /**
   * The outcome `run_end` actually carried — the run's one ending, kept rather than recomputed.
   *
   * `#end` returns whatever its CALLER asked for, on every call, so a second `#end` after the
   * run is over gets back a well-formed outcome that was never emitted anywhere. That is
   * harmless where the caller is the loop unwinding past an ending it already made, and it is
   * not harmless in `stop()`, which has to settle the handle with the run's outcome and would
   * otherwise settle a finished `done` run as `stopped`. Recorded where `run_end` is emitted so
   * the two cannot disagree.
   */
  #firstEnd: RunOutcome | undefined
  /**
   * The seat worktrees this run created, or `undefined` at N=1.
   *
   * `undefined` is the load-bearing value: it is what makes a default run touch none of this
   * code rather than run a one-element version of it. Every read is `?.`-guarded for that
   * reason, and none of them asks how many seats there are.
   */
  #worktrees: WorktreeManifest | undefined
  /**
   * Seats whose merge failed, keyed by seat id, in the order they blocked.
   *
   * `parent` is the integration HEAD the failed merge was attempted against, and it is what
   * makes a repeat distinguishable from a fresh conflict: a second failure against a MOVED
   * parent is new information and gets its own repair round, while a second failure against
   * the same one means the repair did not repair and nothing another turn could change has
   * changed. Insertion order is the queue order, so the oldest block is repaired first.
   */
  #blocked = new Map<string, { parent: string; paths: string[]; attempts: number }>()
  /**
   * Every merge that reached the integration checkout, oldest first.
   *
   * Kept because a red tree has to be attributed to a COMBINATION, and the combination is not
   * readable from the merge that happened to be last: that one merged cleanly, its seat's tree
   * was green, and blaming it would be the same error as blaming the other half. What can be
   * said honestly is which tasks are in the tree, so that is what is recorded and what the
   * repair instruction names.
   *
   * Empty on every run without seat worktrees, which is every default run.
   */
  #merges: MergeContribution[] = []
  /**
   * The integration checks that were red when they last ran, and are not known to be green.
   *
   * Cleared ONLY by a later merge whose checks pass -- not by a repair being dispatched, not
   * by a seat reporting that it fixed it, and not by the advisor saying the work is done. The
   * tree is what it is; a claim about it is not a measurement of it. This is what `#end` reads
   * to refuse to report success over a tree that does not build (#80).
   */
  #integrationRed: { contributors: MergeContribution[]; failures: IntegrationCheckResult[] } | undefined
  /**
   * Index into `#merges` of the last merge whose checks passed, or `undefined` if none has.
   *
   * The fixed point a red result is attributed from: the tree was measured working there, so
   * the tasks merged up to and including it are not implicated by a failure that appeared
   * later. Everything from it onward is.
   */
  #lastGreenMerge: number | undefined
  /**
   * Mechanical facts the advisor must have before it writes its next instruction.
   *
   * Deliberately NOT `#pending`. That queue is human messages, and the DONE guard reads it to
   * decide that the human outranks an advisor calling the work finished — putting orchestrator
   * bookkeeping in there would make a merge conflict masquerade as an operator instruction.
   * These are prefixed and unenveloped: nobody should read them as participant speech.
   */
  #leadNotices: string[] = []
  /** True while `#loop` owns the participants. `ask` refuses rather than racing it. */
  #looping = false
  /**
   * The seat the pause in front of the operator would rotate, or none.
   *
   * Written by `#halt` beside the `rotate` option it accompanies, and read by the handle the
   * operator answers with. Not on `RunPause`: the pause is a document about a condition, and
   * every reader of it -- the status file, the console, a poller -- would then be carrying a
   * field that only the handle's own control path has any use for.
   */
  #rotationSeat: string | undefined

  /**
   * The supervised run's handle, when there is one. Read for its PAUSE and nothing else.
   *
   * `run()` sets none, and that is the honest answer rather than a gap: an unattended run has
   * nobody in front of a decision, so a rotation taken there was never an answer to a question
   * put to an operator.
   */
  #handle: RunHandle | undefined

  private constructor(opts: RelayOptions) {
    this.#opts = opts
    // A wait is minutes long when it happens -- a rotation holds the lane across a whole agent
    // turn -- and it happens between two stations neither of which narrates the other. Recorded
    // as an orchestrator note because the alternative is a gap in the log with nothing in it.
    this.#checkLane.onWait = (waiting, holder) => {
      this.#record({
        from: 'orchestrator',
        fromRank: 'human',
        to: [],
        kind: 'note',
        text:
          `${waiting.seat}'s ${waiting.station} section is waiting for the check lane, held by ` +
          `${holder.seat}'s ${holder.station} section. It is queued, not blocked: nothing about ` +
          `${waiting.seat}'s work has been judged.`,
      })
    }
    // Set here and nowhere else. Whether rotation was configured cannot depend on how far
    // the run got -- see rotationWatch.armed and issue #31.
    this.rotationWatch.armed = opts.rotation !== undefined
    // The same rule, for the same reason, one instrument later. Whether the advisor had a
    // second seat to address is a property of the options and cannot depend on how far the run
    // got: a run that ends before its first instruction must still report that targeting WAS
    // applicable, or "not measured" reads as "measured, and the advisor never targeted".
    //
    // Counted on ROLE, not on the length of the seat list, because that is what
    // `#implementers()` counts and `#implementers()` is what gates `MULTI_SEAT_BRIEFING`. The
    // briefing gate reads this field rather than recomputing the count, so the run that is
    // MEASURED for using the syntax is exactly the run that was TAUGHT it -- two expressions
    // that agree today would be an instrument reporting under-use by an advisor that was never
    // told the syntax exists.
    this.targetingWatch.seats = implementerSeats(opts).filter((s) => s.role === 'implementer').length
    this.targetingWatch.applicable = this.targetingWatch.seats > 1
  }

  /**
   * The run-scoped lane the configured checks run behind. One slot, not configurable.
   *
   * Both stations are real since #78: a merge boundary at N>1, and a seat-local rotation at any
   * N. `spawnSync` already serialises the commands themselves; what this serialises is the
   * WINDOW a rotation verifies across, which a merge would otherwise move underneath it.
   * `CheckLane` carries the whole argument, including exactly how reachable a wait is.
   *
   * Public because `history()` is the only record that a station reached the lane at all --
   * "never contended" and "never reached" are otherwise the same silence. Nothing outside the
   * relay should acquire it during a run.
   */
  readonly #checkLane = new CheckLane()

  get checkLane(): CheckLane {
    return this.#checkLane
  }

  static async start(opts: RelayOptions): Promise<Relay> {
    const seats = implementerSeats(opts)
    // Checked before anything is launched, because every one of these fails SILENTLY later.
    // `#join` keys the participant map by id, so a duplicate id would overwrite a seat that
    // already has a live child -- leaving a process nothing routes to and nothing closes.
    if (seats.length === 0) {
      throw new Error('a relay needs at least one implementer seat: `implementers` was empty')
    }
    const ids = new Set<string>()
    for (const spec of [opts.lead, ...seats, ...(opts.reviewer ? [opts.reviewer] : [])]) {
      if (ids.has(spec.id)) throw new Error(`duplicate participant id '${spec.id}': seat ids must be unique`)
      ids.add(spec.id)
    }
    // The singular option must be one of the seats. It is not a formality: `untargeted` and
    // `rotateImplementer` both name it, so an `implementers` list that omits it would leave
    // those two reading a spec no participant was created from.
    if (!seats.some((s) => s.id === opts.implementer.id)) {
      throw new Error(
        `implementers must include the lead implementer '${opts.implementer.id}': it is the seat ` +
          `an untargeted instruction and a rotation name, and a run whose seat list omits it has no ` +
          `answer for either`,
      )
    }
    // A per-seat rotation policy for a seat this run does not have is refused here rather than
    // ignored. It is the same failure as a misspelled flag that parses: the operator has said
    // what proving THAT seat means, the run starts without it, and the seat it was meant for
    // quietly stays on the run default -- which is exactly the configuration they were
    // overriding. Checked where the seat ids are known, so the message can list them.
    for (const seatId of Object.keys(opts.rotation?.seats ?? {})) {
      if (!seats.some((s) => s.id === seatId)) {
        throw new Error(
          `rotation.seats names '${seatId}', which is not a seat in this run ` +
            `(${seats.map((s) => s.id).join(', ')}): a per-seat policy for a seat that does not ` +
            `exist would leave the seat it was meant for on the run default`,
        )
      }
    }
    // The seats this run actually fills, resolved once and used by both preflight checks below.
    //
    // A spec that does not resolve -- unknown agent, a role that is not a model seat -- is left to
    // `#join`, which already refuses it with the message written for it. Reporting an unknown
    // agent from the executable or model checker would answer a question nobody asked.
    //
    // `cwd` is the run's for every seat, including seats that will be launched in their own
    // worktree: a seat's directory does not enter its argv (`effectiveLaunchArgs`), and a relative
    // launch command is written relative to where the operator started the run.
    const modelCtx = { cwd: opts.cwd, watchdogMs: opts.turnWatchdogMs }
    const specs = [opts.lead, ...seats, ...(opts.reviewer ? [opts.reviewer] : [])]
    const selected = specs.flatMap((spec) => {
      try {
        return [{ participant: spec.id, resolved: opts.registry.resolve(spec) }]
      } catch {
        return []
      }
    })
    // A configuration that does not RESOLVE is refused for that, and neither preflight below runs.
    //
    // Dropping the unresolvable spec is not enough on its own, and CI proved it: `conclave session
    // --lead nope` resolves no lead and a default implementer, and on a machine with neither CLI
    // installed the executable check refused the IMPLEMENTER's missing `claude` -- so the operator
    // was told to install something while the thing actually wrong with their command line, an
    // agent named `nope`, went unmentioned. The developer machine hid it by having `claude` on
    // PATH. Both checks describe seats this run would fill; when the seating itself is invalid,
    // there is no such run to describe, and `#join` refuses it with the message written for it.
    const checkable = selected.length === specs.length ? selected : []

    // Every seat's CLI, looked for before ANY of them is launched and before anything at all is
    // created (#51). FIRST, ahead of the model check: enumerating models means spawning the very
    // command in question, so an absent binary reaching that check is reported as a model that
    // could not be verified rather than as the missing install it is.
    //
    // Note where this sits -- above `new Relay(opts)`, above `createSeatWorktrees`, above every
    // `#join` and so above every adapter preflight and hook write. That placement IS the issue:
    // the failure it prevents was never the first turn dying, it was the registration, the hook
    // files, the trust check and the routed goal that happened first, on the operator's behalf, in
    // a configuration that could never have run.
    //
    // Only SELECTED agents are checked. A registry may describe an agent nobody seated -- that is
    // what `list()` is for -- and refusing a run because an agent it does not use is uninstalled
    // would make the registry's breadth a liability.
    refuseMissingCommands(checkable.map((s) => ({ participant: s.participant, agent: s.resolved.agent, cwd: opts.cwd })))

    // Every seat's model, asked of the children before ANY of them is launched (#82). The same
    // kind of check as the five above -- a configuration that otherwise fails silently, and this
    // one fails silently for twelve minutes and then reports a watchdog. `createParticipant`
    // refuses it too, and that is the floor rather than a duplicate: it refuses one seat at a
    // time, by which point the seats before it have live children, so the whole list is checked
    // here where the whole list is known.
    const modelChecks = await refuseUnknownModels(
      checkable.map((s) => ({
        participant: s.participant,
        agent: s.resolved.agent,
        model: launchRecordFor(s.resolved, modelCtx).model,
      })),
    )

    const relay = new Relay(opts)

    // What could NOT be established, said out loud. The issue asks for this in as many words --
    // "an agent whose models cannot be enumerated says so rather than guessing" -- and a check
    // whose negative result is invisible is a check an operator will believe covered them. Only
    // the seats that named a model and were not judged produce a line; a checked seat is silent,
    // because a note on every seat is a note nobody reads. A default run names no model at all,
    // so its log is the log it has always been.
    for (const check of modelChecks) {
      if (check.unchecked === undefined) continue
      relay.#record({
        from: 'orchestrator',
        fromRank: 'human',
        to: [],
        kind: 'note',
        text: `${check.participant} model '${check.model}' was NOT verified before launch: ${check.unchecked}`,
      })
    }

    // Isolation, and only where it is needed. One implementer works in the operator's cwd on
    // the operator's branch with no worktree, no branch and no manifest -- the default run must
    // not pay for an isolation it does not need, and D1 makes that the identity case rather
    // than a fast path. Every call below is inside this branch for that reason.
    //
    // Created BEFORE any implementer is launched, all of them or none: an adapter's cwd is
    // fixed at launch, so a tree that appears afterwards is a tree its seat can never move
    // into. `createSeatWorktrees` refuses a dirty integration checkout first, which is the
    // refusal the whole scheme rests on.
    if (seats.length > 1) {
      const runId = nextRunId(opts.cwd, Date.now(), process.pid)
      relay.#worktrees = createSeatWorktrees({
        repoRoot: opts.cwd,
        runId,
        seatIds: seats.map((s) => s.id),
      })
    }

    // Sequential rather than parallel: two CLIs negotiating terminals and hook trust at
    // once produces interleaved failures that are miserable to attribute. That argument does
    // not weaken with more seats, so the loop stays sequential too.
    try {
      await relay.#join(opts.lead, 'advisor')
      for (const spec of seats) {
        // The advisor stays in the integration checkout at every N. It reads committed state
        // and steers; it is not one of the writers this isolates from each other.
        const tree = relay.#worktrees?.seats.find((s) => s.seatId === spec.id)
        if (tree) ensureWorktreeHookTrigger(tree)
        await relay.#join(spec, 'implementer', tree ? seatCwd(tree) : opts.cwd)
      }
      // The reviewer, if declared (#72). Rank `implementer` -- D5's job/authority split is
      // exactly what makes this legal: identical authority to the seats above, a different
      // job. No worktree: it does not mutate anything, so there is no tree to isolate it
      // into, and it stays in the integration checkout the same way the advisor does.
      if (opts.reviewer) await relay.#join(opts.reviewer, 'implementer', opts.cwd)
    } catch (e) {
      // CHILDREN FIRST, and unconditionally. Every session that did start is a live process,
      // and an earlier version of this returned through the unwind's own throw before reaching
      // them -- so the one case that leaves a tree behind was also the one case that leaked
      // every child that had already launched. Closing is best-effort because the startup
      // failure is the thing being reported and a teardown error must not replace it.
      for (const p of relay.participants) {
        try {
          await p.session.close('graceful')
        } catch {
          /* already gone, or never fully there. The original failure is what matters. */
        }
      }
      // Then the trees, which are only safe to read once nothing is writing to them. Unwound
      // narrowly: only the trees this start created, only while they are still clean, and
      // never with `--force` -- anything else is retained and named, because a tree that is
      // not obviously ours to delete is not ours to delete.
      if (relay.#worktrees) {
        const lines = recoveryLines(unwindSeatWorktrees(relay.#worktrees))
        if (lines.length > 0) throw new Error(`${(e as Error).message}\n${lines.join('\n')}`)
      }
      throw e
    }
    // Records what the tree looked like before the participants touched it, so the
    // operator's own tooling can refuse to sweep their work into an unrelated commit. Every
    // seat is listed: the lock names who is working in this checkout, and a seat missing from
    // it is a writer the guard cannot attribute a change to.
    acquire(opts.cwd, [
      { id: opts.lead.id, agent: opts.lead.agent },
      ...seats.map((s) => ({ id: s.id, agent: s.agent })),
      ...(opts.reviewer ? [{ id: opts.reviewer.id, agent: opts.reviewer.agent }] : []),
    ])
    return relay
  }

  /** The repository the run works in. Read by the terminal record; see relay/report.ts. */
  get cwd(): string {
    return this.#opts.cwd
  }

  /**
   * The seat worktrees, or `undefined` when the run has none — which is every default run.
   *
   * Read-only on purpose. The manifest on disk is the record; this is a view of it for a
   * caller that already holds the relay, and a second writer would put the file and the
   * object into a disagreement no reader could settle.
   */
  get worktrees(): WorktreeManifest | undefined {
    return this.#worktrees
  }

  /** Who answers escalations. Default `'human'`; see RelayOptions.operator. */
  get operator(): 'human' | 'agent' {
    return this.#opts.operator ?? 'human'
  }

  get participants(): RelayParticipant[] {
    return [...this.#participants.values()]
  }

  /**
   * Every implementer seat, in join order.
   *
   * The replacement for `participants.find((p) => p.rank === 'implementer')`, which was correct
   * only because there was one. A `find` over a rank does not fail at N>1 -- it returns the
   * first seat, quietly, and whatever it fed goes on looking right. So the plural answer is the
   * only one this class offers, and the two operations that genuinely need a single seat name
   * one explicitly below.
   *
   * Filtered on ROLE rather than rank (#72). The two used to coincide -- every rank
   * `implementer` seat did implementer work -- but a reviewer is rank `implementer` with a
   * different job (D5), and every caller of this method means the job: rotation eligibility,
   * the opening `IMPLEMENTER_BRIEFING` loop, and the closing question all mean "a seat that
   * writes code", none of them "a seat that shares implementer's authority". `#dispatchSeats`
   * below is the rank-based answer, for the one caller that needs it.
   */
  #implementers(): RelayParticipant[] {
    return this.participants.filter((p) => p.role === 'implementer')
  }

  /**
   * Every seat the dispatcher may hand a task to: rank `implementer`, whatever the job.
   *
   * The rank-based answer `#implementers()` used to be, kept alongside it because `#seatState`
   * needs a table that includes the reviewer -- a review task is dispatched through the exact
   * same scheduler as ordinary work, so a seat with nothing to write is still a seat with
   * something to be assigned.
   */
  #dispatchSeats(): RelayParticipant[] {
    return this.participants.filter((p) => p.rank === 'implementer')
  }

  /**
   * The reviewer seat, or `undefined` on every run that did not declare one (#72).
   *
   * At most one: `RelayOptions.reviewer` is singular, unlike `implementers`, because the
   * issue that motivates it is answered by one more blind reader, not by a pool of them.
   */
  #reviewerSeat(): RelayParticipant | undefined {
    return this.participants.find((p) => p.role === 'reviewer')
  }

  /**
   * The working root a participant's changes appear in.
   *
   * Modelled on the ROOT, never on the seat count. At N=1 every participant answers
   * `opts.cwd`, so every read below groups exactly as it always did and the default run is
   * byte-for-byte what it was; at N>1 each linked implementer answers its own worktree and the
   * advisor still answers the integration checkout. Nothing here asks how many seats there are
   * -- an `if (seats.length === 1)` would be D1's wrong abstraction, and wrong on its own terms
   * as well, since two participants can share a root at any N.
   */
  #rootOf(participantId: string): string {
    return (
      this.#rootOverride.get(participantId) ??
      this.#worktrees?.seats.find((s) => s.seatId === participantId)?.worktreePath ??
      this.#opts.cwd
    )
  }

  /**
   * Roots for participants the worktree manifest does not name.
   *
   * One entry ever, and only while it is needed: a rotation's audition works in the tree of the
   * seat it is auditioning for, and it is not that seat yet -- it holds `<seat>~replacement`
   * precisely so nothing confuses the two. Empty on every run that never rotates, which is
   * every default run.
   */
  #rootOverride = new Map<string, string>()

  /**
   * The seat the required singular option names.
   *
   * Not "the first implementer": `RelayOptions.implementer` is a spec the caller wrote, and
   * `Relay.start` has already refused a seat list that omits it, so this is a lookup by id and
   * cannot pick between seats. At N=1 it is the only seat there is.
   */
  #leadImplementer(): RelayParticipant {
    const p = this.#participants.get(this.#opts.implementer.id)
    // Unreachable through `start`, which validates it. Thrown rather than `!`-asserted because
    // the alternative is a `undefined.role` several frames away from the cause.
    if (!p) throw new Error(`the lead implementer '${this.#opts.implementer.id}' is not a participant`)
    return p
  }

  /**
   * What each seat's turns are actually measured against.
   *
   * The single place a declared clock meets this run's configuration, and it goes through
   * the REGISTRY: the support table belongs to the adapter, so reading it from the agent
   * definition is the only version of this answer that a new adapter updates by existing.
   * An `agent === 'kimi'` check here would be a copy of that table, in a module that has no
   * business holding one, silently wrong the day a fifth adapter lands.
   *
   * Nothing here is per-turn. It is the policy each seat is under for the whole run, which
   * is what a reader interpreting `timed_out` after the fact needs; the turn's own elapsed
   * time is in its provenance.
   */
  get deadlines(): RunDeadlines {
    const requested = this.#opts.turnWatchdogMs
    return {
      configuredAbsoluteMs: requested ?? null,
      participants: this.participants.map((p) => {
        const declared = this.#opts.registry.get(p.agent).deadlines
        return {
          id: p.id,
          agent: p.agent,
          absolute: resolveClock(declared.absolute, requested),
          // No `requested`: `--turn-timeout` is the absolute clock, and passing it here
          // would silently retune a budget nobody asked to change -- and would report a
          // silence deadline for adapters that run none.
          silence: resolveClock(declared.silence, undefined),
        }
      }),
    }
  }

  /**
   * What stops this run, every ceiling of it, including the ones nobody set.
   *
   * Read off the options rather than reconstructed by whoever is reporting: the run's advisor
   * budget is `boundOf`'s answer and no other, so a status document cannot say 8 while the loop
   * counts to 6. That is the whole of #119 -- a run ended at a bound the operator did not know
   * they had, and no surface could be asked what the bound was.
   *
   * A getter beside `deadlines`, which reports the same kind of fact the same way: the policy
   * this run is under for its whole length, with `null` where nothing was configured.
   */
  get ceilings(): RunCeilings {
    return effectiveCeilings({
      advisorTurns: boundOf(this.#opts),
      ...(this.#opts.ceilings ? { ceilings: this.#opts.ceilings } : {}),
    })
  }

  /**
   * The clock the duration ceiling is read from. See `RelayOptions.now`.
   *
   * Used by exactly two readings -- when the ceiling window opened, and how far into it the run
   * is -- so that a test can move one without moving the timestamps on the record.
   */
  #now(): number {
    return this.#opts.now?.() ?? Date.now()
  }

  /**
   * How long this run has spent PAUSED inside its ceiling window.
   *
   * ## What the duration ceiling counts, and why this is subtracted from it (#112)
   *
   * A run reported "ended: budget" after five pause/continue cycles on one healthy piece of
   * work. The ceilings had bounded the tool rather than the run: `--max-minutes` was wall-clock
   * from the first turn, so a night spent waiting for an operator to answer `/continue` was
   * spent out of the same allowance as the work. One number was measuring two things -- how much
   * a run may do, and how long a human took to answer it -- and only the first is a run going
   * wrong.
   *
   * So the ceiling now measures ACTIVE run time: wall-clock, less every interval the run was
   * suspended at a pause. A suspended run dispatches nothing, sends nothing and spends no
   * quota; there is no runaway to bound, and the clock it was on was measuring the operator.
   *
   * ## What still stops a run that never makes progress
   *
   * This is the constraint the change had to hold, because trading a bounded failure for an
   * unbounded one would be strictly worse than the defect. Nothing here exempts a stuck run:
   *
   *   - A turn that ends `timed_out` still costs a turn (`#turnsTaken`, `--max-turns`) and still
   *     costs the advisor turn that drove it (`maxAdvisorTurns`). Both are UNCHANGED by #112 and
   *     both are what a seat wedged in a timeout loop exhausts. A truncated turn is charged
   *     exactly what a completed one is charged, deliberately: it burned a full watchdog of
   *     child time to produce nothing, which makes it the most expensive kind of turn, not a
   *     free one. Exempting it is the change that WOULD unbound this.
   *   - The time such a run spends is active time -- the watchdog runs while the child runs --
   *     so `--max-minutes` still accrues through every one of those turns and still fires.
   *
   * What is subtracted is only the interval where a human holds the run and nothing is running.
   * A run parked at a pause forever is parked by a person, spends nothing, and would never have
   * been ended by a ceiling anyway: an unattended run has no handle, and `#halt` with no handle
   * ends the run rather than pausing it.
   *
   * Zero for an unattended run, and zero before the window opens, so `run()` behaves exactly as
   * it did.
   */
  get pausedMs(): number {
    if (this.#atEnd) return this.#atEnd.pausedMs
    const suspended = (this.#handle?.suspendedMs ?? 0) - this.#suspendedAtStart
    return suspended > 0 ? suspended : 0
  }

  /**
   * The duration ceiling's OWN reading: how long this run has spent running, net of pauses.
   *
   * Exposed rather than left to be reconstructed, because it cannot be reconstructed. The
   * obvious arithmetic -- a report's `durationMs` minus `pausedMs` -- is wrong twice over, and
   * quietly:
   *
   *   - `durationMs` is measured from the front-end's own start, which is before the sessions
   *     are spawned and before any seat is briefed. The ceiling window opens after all of that
   *     (`#runLoop`), so the subtraction overstates active time by however long the launch took.
   *   - The two figures need not even be on the same clock. `durationMs` is wall-clock by
   *     definition; this is whatever `RelayOptions.now` is.
   *
   * So a reader asking "how much of the ceiling did this run actually spend" gets the number the
   * ceiling compared, from the object that compared it, and never a second derivation that
   * agrees with it only approximately. `breached` is handed exactly this value.
   *
   * ## It stops when the run does
   *
   * Live while the run is going, because that is what a ceiling checked at every boundary needs.
   * FROZEN at the ending, because a report is not assembled at the instant a run ends: teardown
   * happens, `runReport` awaits a snapshot from every participant, and a front end may write the
   * document later still. A figure that kept counting through all that would grow past anything
   * the ceiling ever saw and would disagree with the ending's own detail, which quotes it -- a
   * record contradicting itself about the one number that stopped the run. See `#atEnd`.
   */
  /**
   * Stop the run's clock, once, wherever the run was decided.
   *
   * `#end` is the obvious home and is not the only one: a ceiling breach settles what the run's
   * active time WAS at the instant it was checked, and only then drains the seats still working.
   * Stamping at `#end` alone let the report carry a larger number than the ending's own detail
   * quoted, on exactly the runs that had work outstanding. Idempotent, so the breach and the
   * `#end` that follows it cannot disagree either.
   */
  #stopClock(): void {
    this.#atEnd ??= { activeMs: this.activeMs, pausedMs: this.pausedMs }
  }

  get activeMs(): number {
    if (this.#atEnd) return this.#atEnd.activeMs
    if (!this.#windowOpened) return 0
    const active = this.#now() - this.#startedAt - this.pausedMs
    return active > 0 ? active : 0
  }

  /**
   * `cwd` is where this participant's adapter is launched, and it is fixed at launch.
   *
   * Defaulting to the run cwd is the whole of the N=1 case and the whole of the advisor's case
   * at any N: the integration checkout is where they belong. An implementer seat at N>1 is
   * handed its own linked worktree instead, and it has to be handed it HERE -- an adapter's
   * working directory cannot be changed afterwards, so a session started in the shared
   * checkout is a seat that shares the checkout for the rest of the run.
   */
  async #join(spec: ParticipantSpec, rank: Rank, cwd: string = this.#opts.cwd): Promise<void> {
    // One context object, used twice on purpose. The argv recorded below is composed by the
    // same function every built-in adapter composes its child's argv with, from the same spec
    // and the same context -- so the record is the launch rather than a reconstruction of it.
    // Read AFTER the session exists, so a seat that failed to start fails exactly as before.
    const ctx = { cwd, watchdogMs: this.#opts.turnWatchdogMs }
    const session = await this.#opts.registry.createParticipant(spec, ctx)
    const launch = launchRecordFor(this.#opts.registry.resolve(spec), ctx)
    const p: RelayParticipant = { id: spec.id, agent: spec.agent, rank, role: spec.role, launch, session, events: [], baselineGeneration: 0, degradationCursor: 0 }
    this.#participants.set(spec.id, p)
    this.#attach(p)
    // The role is named only when it says something the rank has not. At N=1 it repeats it,
    // and the join note is the line an operator reads at startup -- so the default run's log
    // is the same log it has always been.
    const as = spec.role === rank ? `${rank}` : `${rank} in role ${spec.role}`
    this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `${spec.id} joined as ${as} (${spec.agent})` })
    // Anything the adapter had to do to the operator's machine to make this session exist --
    // today, answering Claude Code's folder-trust dialog (#108). A separate note rather than a
    // suffix on the join line: the join line is the same line it has always been on a run
    // where nothing needed doing, and these appear only when something did.
    for (const notice of session.startupNotices ?? []) {
      this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `${spec.id}: ${notice}` })
    }
  }

  /**
   * Start forwarding one session's events.
   *
   * One consumer per session: the event queue delivers each event to exactly one reader.
   * This loop is that reader, and forwarding from here is what lets an observer see a turn
   * in progress -- the routing log says nothing between an instruction and the report that
   * answers it, which is the entire duration of the work.
   *
   * Separate from `#join` because rotation replaces a participant's session in place, and
   * the replacement needs its own reader. The loop closes over the session rather than
   * reading `p.session`, so the retired one's iteration ends with it rather than quietly
   * pushing the new session's events under the old reader.
   */
  #attach(p: RelayParticipant, session: AgentSession = p.session): void {
    // Kept rather than voided, because `stop()` has to be able to WAIT for it (#143). Keyed on
    // the participant and overwritten on rotation, so what is stored is always the reader for the
    // session `p.session` currently names -- a retired session's reader ends on its own, either
    // with its stream or at the identity check below, and nothing needs to wait for that.
    //
    // Storing it changes nothing about failure: it was unawaited before and it is unawaited now
    // until teardown, so a throw in here surfaces exactly as it always did.
    this.#forwarding.set(
      p.id,
      (async () => {
        for await (const e of session.events()) {
          if (p.session !== session) return
          p.events.push(e)
          this.#trackPermission(p, e)
          this.#trackSupersession(p, e)
          this.#stream.emit({ type: 'activity', participant: p.id, rank: p.rank, event: e })
        }
      })(),
    )
  }

  /**
   * Per participant: the `#attach` reader for the session it currently holds.
   *
   * The barrier `stop()` closes the #143 race on. A `turn_end` emitted inside `close('graceful')`
   * exists before `close()` returns and reaches `p.events` only afterwards, through this reader --
   * so "the adapter has finished saying what happened" is not "close returned", it is "close
   * returned AND everything it said has been forwarded". Waiting for this loop to END is that
   * second half stated exactly, rather than approximated by a grace period: the reader finishes
   * when the session's event stream finishes, which is a fact about the adapter rather than a
   * guess about how fast it is.
   */
  #forwarding = new Map<string, Promise<void>>()

  /**
   * Which participants are stopped at a permission prompt, and for what.
   *
   * Both adapters implement `decidePermission` down to the keystroke, and nothing above
   * them ever called it: the console rendered `awaiting a permission decision` and offered
   * no way to answer, so the turn sat there until a watchdog gave up on it -- releasing this
   * run's wait and emitting a verdict, while the child went on standing at the same prompt
   * nobody could answer. The event was already on the stream — what was missing was somewhere
   * to remember it and something able to reply.
   */
  #awaitingPermission = new Map<string, { tool: string }>()

  /**
   * A request stands until the turn ends or another replaces it.
   *
   * The first cut cleared on ANY later event, reasoning that a permission answered in the
   * child's own terminal would otherwise leave a stale entry. That was wrong about what a
   * waiting session emits: the transcript poller reports the very tool call being waited
   * on, so a `tool_use` arrives immediately AFTER `permission_requested` and cancelled the
   * request microseconds after it appeared. The console printed "needs a permission
   * decision", and `/allow` a moment later answered "nobody is waiting" — which is exactly
   * as useless as having no command at all.
   *
   * `turn_end` is the honest boundary: a turn that ended is not sitting at a prompt. A
   * second request replaces the first, since only one dialog can be up at a time.
   *
   * The stale case that motivated the first version is real but cheap: answering in the
   * child's terminal and then using `/allow` writes a keystroke that no dialog consumes.
   * That is a stray key in a session, against a request that could not be answered at all.
   */
  #trackPermission(p: RelayParticipant, e: AgentEvent): void {
    if (e.type === 'permission_requested') this.#awaitingPermission.set(p.id, { tool: e.tool })
    else if (e.type === 'turn_end') this.#awaitingPermission.delete(p.id)
  }

  /** Participants stopped at a permission prompt right now, with the tool each named. */
  permissionsPending(): { id: string; tool: string }[] {
    return [...this.#awaitingPermission].map(([id, { tool }]) => ({ id, tool }))
  }

  /**
   * Answer a participant's permission prompt.
   *
   * Recorded, because it is a human decision about what a participant may do — the same
   * class of thing as an instruction, and exactly what someone reading the log afterwards
   * needs in order to explain why a tool call did or did not happen.
   */
  async decidePermission(participantId: string, decision: 'allow' | 'deny'): Promise<void> {
    const p = this.#participants.get(participantId)
    if (!p) {
      const known = [...this.#participants.keys()].sort().join(', ')
      throw new Error(`unknown participant '${participantId}'. Known: ${known}`)
    }
    const pending = this.#awaitingPermission.get(participantId)
    if (!pending) throw new Error(`${participantId} is not waiting on a permission decision`)
    await p.session.decidePermission(decision)
    this.#awaitingPermission.delete(participantId)
    this.#record({
      from: 'orchestrator',
      fromRank: 'human',
      to: [],
      kind: 'note',
      text: `you ${decision === 'allow' ? 'allowed' : 'denied'} ${participantId}: ${pending.tool}`,
    })
  }

  /**
   * A pause the system has since talked itself out of.
   *
   * The relay's pause is a snapshot of the evidence model at one instant; the evidence model
   * keeps going. A run that paused on `timed_out` and then received the late `Stop` proving
   * the turn completed leaves a human adjudicating a verdict that has been withdrawn — and
   * the only party holding both the pause and the revision is this one. The revision does
   * reach the operator's console today, as one line reading `transcript revised
   * (late_signal)`, which names neither the verdict nor the pause it demolishes.
   *
   * It surfaces and does not decide: the run stays paused. See `RunHandle.supersede`.
   */
  #trackSupersession(p: RelayParticipant, e: AgentEvent): void {
    const pending = this.#verdictPause
    if (!pending || pending.participant !== p.id) return

    if (!pending.withdrawn) {
      if (e.type !== 'revision' || !e.replaces.includes(pending.endSeq)) return
      pending.withdrawn = true
      this.#supersede(
        pending,
        `the ${pending.outcome} verdict this pause was raised on has been withdrawn ` +
          `(${e.reason}); the run is still paused, and the decision is still yours`,
      )
      return
    }

    // The replacement follows its revision immediately, and no new turn can be in flight for
    // this participant while the loop is suspended at the pause, so the next `turn_end` is
    // it. A withdrawal with no replacement is also possible — the turn is simply open again
    // — which is why the note above stands on its own rather than waiting for this.
    if (e.type === 'turn_end') {
      // `completed` means the Stop hook proved the turn ended. Another `timed_out` means the
      // watchdog fired again on the same still-running turn. Those two are the only cases where
      // the operator must be told the running state explicitly; other outcomes are terminal
      // verdicts and use the neutral `formatVerdict()` wording instead.
      const outcome = e.verdict.outcome
      const note =
        outcome === 'completed'
          ? `the ${pending.outcome} verdict this pause was raised on was withdrawn and replaced ` +
            `with completed; the turn ended, but the run is still paused until you decide`
          : outcome === 'timed_out'
            ? `the ${pending.outcome} verdict this pause was raised on was withdrawn and replaced ` +
              `with another timed_out; the turn is still running, so the same decision faces you`
            : `the ${pending.outcome} verdict this pause was raised on was withdrawn and replaced ` +
              `with ${formatVerdict(e.verdict)}; the run is still paused, and the decision is still yours`
      this.#supersede(pending, note, e.verdict)
      this.#verdictPause = undefined
    }
  }

  /**
   * A verdict a pause rests on has been withdrawn.
   *
   * On the stream as well as the pause, because it is the ONE moment a waiting operator
   * cares about and `state` never changes across it: paused while the child works, paused
   * once it finishes. A monitor polling state is silent through exactly the event it is
   * waiting for, so it had to be discovered by re-reading the status file.
   */
  #emitSupersession(pause: RunPause): void {
    this.#stream.emit({ type: 'supersede', pause })
  }

  #supersede(pending: VerdictPause, note: string, verdict?: Verdict): void {
    const info: PauseSupersession = { at: Date.now(), note, ...(verdict === undefined ? {} : { verdict }) }
    // Recorded only if the pause was still there to amend. Logging a supersession for a
    // pause the operator has already resolved would put a decision in the log that nobody made.
    if (pending.handle.supersede(info)) {
      // On the stream too. See `#emitSupersession`: the run stays paused across this, so a
      // watcher polling `state` never sees it.
      if (pending.handle.pause) this.#emitSupersession(pending.handle.pause)
      // Marked, because this one arrives AFTER the pause block has been written to a
      // terminal and cannot be taken back. `RunPause.superseded` carries the same note for a
      // pause printed after the fact; the mark is what lets a reader see the two arrival
      // orders the same way instead of one shouting and the other reading as more background.
      this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: note, supersession: true })
    }
  }

  #record(m: Omit<RelayMessage, 'seq' | 'at' | 'visibility' | 'excluded'>): RelayMessage {
    // Derived from provenance, never from recipient count. An advisor instruction reaches
    // one participant and is entirely ordinary; a human message that skips one is not.
    let visibility: Visibility = 'normal'
    let excluded: string[] = []
    if (m.kind === 'note') {
      visibility = 'internal'
    } else if (m.kind === 'goal') {
      // NOT restricted, even though it reaches the advisor alone.
      //
      // `restricted` means a human chose to hide THIS message from THIS participant, and
      // everything downstream reads it that way: `audit()` lists what was withheld, and
      // `asymmetryAt` answers whether a disagreement might be explained by it. The goal
      // reaching the advisor alone is now how every session works — so marking it would
      // make the audit permanently non-empty and asymmetry permanently true, which is the
      // same as making both say nothing. A signal present in every run is not a signal.
      //
      // The implementer not holding the goal is still visible: it is in the briefing it
      // was given, and in this message's `to`.
      visibility = 'normal'
    } else if (m.fromRank === 'human') {
      const missing = [...this.#participants.keys()].filter((id) => !m.to.includes(id))
      if (missing.length > 0) {
        visibility = 'restricted'
        excluded = missing
      }
    }

    const full: RelayMessage = { ...m, visibility, excluded, seq: ++this.#seq, at: Date.now() }
    this.log.push(full)
    this.#opts.onLog?.(full)
    this.#stream.emit({ type: 'message', message: full })
    return full
  }

  /**
   * Follow the session as it happens: everything already emitted, then live, until the
   * run ends. Attach before `run()` or during it; a late subscriber is not short of
   * anything an early one had.
   *
   * One call is one subscription -- iterate the returned iterable once. Breaking out of
   * the loop detaches it.
   */
  observe(opts: ObserveOptions = {}): AsyncIterable<RelayEvent> {
    return this.#stream.observe(opts)
  }

  /**
   * Participant events that arrived after the run ended and were refused by the stream.
   * Expected during teardown -- a child can still be emitting -- and reported rather than
   * silently swallowed. They remain on the participant and in its transcript.
   */
  get droppedAfterEnd(): number {
    return this.#stream.droppedAfterClose
  }

  /**
   * Terminal, and emitted exactly once however the run and `stop()` interleave.
   *
   * One filter sits in front of it: a run whose integration checkout is red does not report
   * an outcome that reads as success (#80). Here rather than at the call sites because there
   * are eleven of them and the guarantee has to hold at all of them -- a red tree that reached
   * `done` down one path and `integration_failed` down another would be the same silent
   * failure with an extra step. `done` and `budget` are the two endings that claim the work
   * finished, so those are REPLACED; every other reason already says something went wrong and
   * keeps saying it, with the tree's state appended so nothing is lost either way.
   */
  #end(reason: RunReason, detail?: string): { reason: RunReason; detail?: string } {
    const note = this.#integrationRedNote()
    if (note) {
      if (reason === 'done' || reason === 'budget') reason = 'integration_failed'
      detail = detail === undefined ? note : `${detail}. ${note}`
    }
    if (!this.#ended) {
      this.#ended = true
      // The instant the run is over is the instant its clock stops. Before this, both figures
      // recomputed on every read, so a report assembled after teardown -- `runReport` awaits a
      // snapshot per participant, and a front end may write it seconds later -- would claim more
      // active time than any ceiling ever observed, and contradict the very detail beside it that
      // says what the ceiling saw. Stamped here rather than in the loop because this is the one
      // place a run ends, however it ends, and `#ended` already makes it exactly once.
      this.#stopClock()
      this.#firstEnd = detail === undefined ? { reason } : { reason, detail }
      this.#stream.emit({ type: 'run_end', reason, detail })
      this.#stream.close()
    }
    return detail === undefined ? { reason } : { reason, detail }
  }

  /**
   * What an outcome has to say about the tree, or nothing when the tree is not known to be red.
   *
   * One sentence, built in one place, so `#end` and the drain's return say the same thing and
   * a reader can tell they are the same claim rather than two independent descriptions.
   */
  #integrationRedNote(): string | undefined {
    const red = this.#integrationRed
    if (!red) return undefined
    const tasks = red.contributors.map((c) => `${c.taskId} (${c.seatId})`).join(' + ')
    const failing = red.failures
      .map((f) => `\`${f.command}\` exited ${f.exitCode ?? 'without a status'}`)
      .join(', ')
    return (
      `the integration checkout fails its configured checks — ${failing} — after merging ${tasks}; ` +
      `each seat's own work was green in its own tree and no merge conflicted`
    )
  }

  /**
   * An outcome `#halt` already emitted, amended if the drain that followed it left a red tree.
   *
   * The ordering here is the honest limitation recorded on `Closing`: a halt calls `#end`
   * itself, so `run_end` is on the stream before the seats still in flight have merged. What
   * the CALLER gets back can still be true, and a run that ends holding a tree that does not
   * build must say so in every place it says anything.
   */
  #redAware(outcome: RunOutcome): RunOutcome {
    const note = this.#integrationRedNote()
    if (!note || outcome.detail?.includes(note)) return outcome
    return { reason: outcome.reason, detail: outcome.detail === undefined ? note : `${outcome.detail}. ${note}` }
  }

  /**
   * Every point at which one participant knew something another did not, because we
   * withheld it.
   *
   * This is the whole reason restricted messages are labelled. When two participants
   * disagree, a human needs to be able to tell whether they disagree about the work or
   * merely hold different information — and only the orchestrator can answer that,
   * because only it routed both sides.
   */
  audit(): { seq: number; at: number; informed: string[]; excluded: string[]; text: string }[] {
    return this.log
      .filter((m) => m.visibility === 'restricted')
      .map((m) => ({ seq: m.seq, at: m.at, informed: m.to, excluded: m.excluded, text: m.text }))
  }

  /** Participants that held withheld information at or before `seq`. */
  asymmetryAt(seq: number): { informed: string[]; excluded: string[] } {
    const informed = new Set<string>()
    const excluded = new Set<string>()
    for (const m of this.log) {
      if (m.seq > seq || m.visibility !== 'restricted') continue
      for (const id of m.to) informed.add(id)
      for (const id of m.excluded) excluded.add(id)
    }
    return { informed: [...informed], excluded: [...excluded] }
  }

  #resolve(audience: Audience): string[] {
    if (audience === 'all') return [...this.#participants.keys()]
    if (!this.#participants.has(audience.only)) {
      throw new Error(`unknown participant '${audience.only}'`)
    }
    return [audience.only]
  }

  /**
   * Deliver text to a participant and return its prose for that turn.
   *
   * Prose comes from the snapshot rather than the event stream: the snapshot is
   * authoritative and carries the full narration, where a turn_end carries only a verdict.
   */
  /**
   * One exchange with one participant, with no run in flight.
   *
   * `say` QUEUES: it puts text in a participant's pending queue, and the run loop delivers
   * it at the next turn boundary. That is right during a run and useless between runs --
   * with no loop to drain it the message waits forever, so the console refused to accept
   * one at all. But the sessions are still alive when a run ends; only the loop stopped.
   * Asking the implementer to start the server so you can try what it just built is not a
   * new goal, and having to invent one to be heard is the wrong shape.
   *
   * A turn, not a queue: this sends and waits, so the caller gets the reply. It routes to
   * nobody else -- the other participant neither sees the question nor the answer, exactly
   * as `>advisor` means during a run.
   *
   * Refuses while a run is in flight. Two things sending turns to one session would
   * interleave with the loop's own, and the resulting transcript would be neither's.
   */
  async ask(participantId: string, text: string): Promise<string> {
    if (this.#looping) {
      throw new Error('a run is in flight; use the run handle to address a participant')
    }
    const p = this.#participants.get(participantId)
    if (!p) {
      const known = [...this.#participants.keys()].sort().join(', ')
      throw new Error(`unknown participant '${participantId}'. Known: ${known}`)
    }
    // Per PARTICIPANT, not globally. A session runs one turn at a time, so a second
    // question to the same one has to wait — but the participants are independent, and
    // asking the implementer to start a server has no bearing on asking the advisor to
    // look at something while it does.
    if (this.#asking.has(participantId)) {
      throw new Error(`${participantId} is still answering; one question at a time each`)
    }
    this.#asking.add(participantId)
    try {
      // The log records what the HUMAN said; the participant is sent the framing too. A
      // transcript full of orchestrator boilerplate would bury the thing actually asked.
      this.#record({ from: 'human', fromRank: 'human', to: [participantId], kind: 'constraint', text })
      const turn = await this.#exchange(p, `${DIRECT_QUESTION_NOTICE}\n\n${text}`)
      // `to: []` because it is going to the human, who is not a routed participant. The
      // console renders an unaddressed participant message as `→ you`.
      this.#record({ from: p.id, fromRank: p.rank, to: [], kind: 'report', text: turn.prose })
      return turn.prose
    } finally {
      this.#asking.delete(participantId)
    }
  }

  /** Participants with an out-of-run question in flight. See `ask`. */
  #asking = new Set<string>()

  /**
   * What the rotation detector has actually observed.
   *
   * Rotation is the one subsystem that is silent until it acts. Everything else in a run
   * announces itself — participants joining, each turn routed, settle warnings, the final
   * verdict — so after an hour of work these were indistinguishable from outside: the
   * detector ran and saw nothing; the detector never ran; `--checks` was rejected and
   * rotation was never configured; rotation fired and rolled back quietly.
   *
   * A negative result is only evidence if the instrument was known to be live. Without
   * this, "no rotation" and "no rotation mechanism" produce identical logs — which made an
   * hour of deliberate degradation testing unable to demonstrate its own null.
   */
  readonly rotationWatch = {
    /**
     * Whether rotation was CONFIGURED. A property of the options, not of anything that
     * happened during the run.
     *
     * This was previously assigned inside `#considerRotation`, i.e. only once an assessment
     * had actually been made. A run that ended before its first assessment -- an early
     * escalation, an empty report, an abort -- therefore reported the initial `false` and
     * claimed "no checks configured" when checks had been supplied and echoed back at
     * startup. See issue #31: one invocation asserted ARMED on its first line and NOT ARMED
     * on its last.
     *
     * That is worse than the ambiguity this whole structure exists to remove. An operator
     * seeing only one of the two lines believes the wrong thing confidently, and the negative
     * results these counters exist to support become unciteable.
     *
     * So it is set once, at construction, from the options. Nothing that happens during a run
     * can change whether rotation was configured for it.
     */
    armed: false,
    assessments: 0,
    degradationsSeen: 0,
    /** Candidates raised. Distinct from rotations, which are candidates ACTED on. */
    candidates: 0,
    complaintsSeen: 0,
    peakGeneration: 0,
    rotations: 0,
    /**
     * Each accepted rotation, with WHY it happened. See `rotationIntent.ts` for the argument.
     *
     * `rotations` above is this array's length and is kept as its own field rather than derived
     * from it: every existing consumer reads the counter, and a number that started disagreeing
     * with the array it was computed from would be worse than either alone. They are written
     * together, in one place, where a replacement is accepted.
     *
     * Only ACCEPTED rotations. A rolled-back one replaced nothing, and the routing log already
     * carries it -- putting it here would make `records.length` stop meaning `rotations`.
     */
    records: [] as RotationRecord[],
  }

  /**
   * Whether the advisor actually USED the assignment syntax this run depends on (#79).
   *
   * The second instrument in this file that exists because a negative result was unciteable
   * without one, and it is built to `rotationWatch`'s shape deliberately. Multi-seat dispatch
   * needs `@seat`/`@role`; `parseDecisions` proves the syntax PARSES and nothing proves the
   * briefing ELICITS it. An unaddressed reply is routed by fallback and produces an ordinary
   * task, so "the advisor chose not to parallelise" and "the advisor does not know the syntax"
   * left the same record -- established rather than assumed: an unaddressed reply and an
   * `@role`-addressed one are identical at the parser's own output, so no reader downstream
   * could have told them apart even in memory.
   *
   * And it is not only lost parallelism. A `merge_blocked` seat takes nothing but a repair
   * addressed to it BY NAME (`untargetedTarget` routes around it while any other seat is free),
   * the advisor is told about the block exactly once (`#tellLead` drains), and the escalation
   * that would report the stall is gated on a repair attempt that never arrives. So an advisor
   * that under-uses the syntax can strand a seat for the rest of the run with nothing detecting
   * it. This is what detects it.
   *
   * See `targeting.ts` for what each field means and why the one-seat run counts nothing.
   */
  readonly targetingWatch: TargetingWatch = {
    applicable: false,
    seats: 0,
    records: [] as TargetingRecord[],
  }

  /**
   * Unresolved items participants flagged, in the order raised.
   *
   * A run can legitimately end `done` while carrying one: the caveat that prompted this was
   * about a gate the goal had assigned to the operator, not to the participants, so DONE was
   * the right verdict. The defect was that a terminal verdict had no way to carry anything
   * but its own binary value, and the flag survived only in the middle of a 350-line routing
   * log (issue #30).
   */
  readonly flags: RelayFlag[] = []

  /**
   * Raise a flag, collapsing an exact duplicate from the same participant into the first one.
   *
   * "Exact" is textual identity after trimming, which both callers have already done, and it
   * is deliberately the ONLY test applied: deciding from the words whether two differently
   * phrased flags are the same concern -- or whether a flag's subject has since been fixed --
   * is the judgement this whole mechanism exists to route to a participant, and guessing it
   * here would be the same class of error as the defect in #131. Verbatim repetition is the
   * one case a machine can settle, and the closing question asks for the restatement verbatim
   * precisely so that it can.
   *
   * A duplicate of an already-SUPERSEDED flag is a new flag, not a restatement of a retired
   * one: it means the concern came back after a seat said it was done with it, and merging
   * the two would quietly restore an item the record shows as closed.
   */
  #raiseFlag(participant: string, text: string, seq: number): void {
    const standing = this.flags.find(
      (f) => f.participant === participant && f.text === text && f.supersededBy === undefined,
    )
    if (standing) {
      standing.restated = [...(standing.restated ?? []), seq]
      return
    }
    this.flags.push({ participant, text, seq })
  }

  /** What is still outstanding: everything raised that no closing statement has retired. */
  outstandingFlags(): RelayFlag[] {
    return this.flags.filter((f) => f.supersededBy === undefined)
  }

  /**
   * Raised, then not restated when the seat that raised it was asked what still stands.
   *
   * Narrowed on the way out so a consumer does not have to defend against a `supersededBy`
   * that the filter has already established is there.
   */
  supersededFlags(): (RelayFlag & { supersededBy: number })[] {
    return this.flags.filter((f): f is RelayFlag & { supersededBy: number } => f.supersededBy !== undefined)
  }

  /**
   * The implementer's guaranteed last word, asked once when the advisor says DONE.
   *
   * A run used to end on the advisor's verdict alone, with the implementer's final report
   * never consulted. In the first live four-agent run the implementer ended its report with a
   * direct question -- "if you intended something else, tell me what the expected behaviour
   * should be" -- the advisor replied DONE, and the run reported unqualified success with the
   * question unanswered and unrecorded (#37).
   *
   * `FLAG:` was supposed to cover that and did not: the implementer wrote prose rather than
   * the marker, so `flags` was empty (#38). Asking directly does not depend on a participant
   * having remembered a convention fifteen turns earlier, on the advisor choosing to answer,
   * or on a heuristic trying to spot a question in prose -- "if you intended something else,
   * tell me" contains no question mark, and a pattern list that missed it would make the miss
   * doubly silent.
   *
   * Costs one turn per completed run. That is the price of a DONE that means something.
   *
   * Anything other than NONE is carried, structured or not. A participant that answers in
   * prose is telling us something; discarding it for lacking a prefix would repeat the exact
   * failure this exists to fix.
   *
   * It is also the RECONCILIATION, which is what #131 is about. Every `FLAG:` line raised
   * during the run was lifted as it went past, and this question's answer was then appended
   * to the same list with nothing compared: a conscientious seat that answered honestly --
   * restating the two things that still stood -- ended the run with four flagged items, two of
   * them the same two. The count an operator reads off the last three lines of a DONE was
   * inflated by the very diligence it was meant to reward.
   *
   * So the seat is SHOWN its own accumulated flags here and asked which of them still stand.
   * That is the same question it was already being asked, made answerable: it is the only
   * participant in a position to know that the thing it flagged on turn three was fixed on
   * turn nine, and nothing outside it can read that off the text without guessing.
   *
   * What the answer does NOT do is delete. The items it does not restate are marked
   * superseded and stay in the record and in the summary under their own heading, because
   * `NONE` from a seat that fixed everything and `NONE` from a seat that ran out of context
   * are the same four characters. Replacement would make the second one silent, and silence
   * is the failure mode this whole mechanism was built against.
   *
   * And it reconciles only on an answer. An empty reply, a dead session, a send that throws --
   * none of those is a judgement that anything was resolved, so every historical flag survives
   * them untouched.
   */
  async #closingQuestion(impl: RelayParticipant): Promise<void> {
    // Nothing to ask if it never worked. A relay that ended before the implementer's first
    // turn has no last word to give it.
    if (impl.events.length === 0) return

    // And nothing to ask a session that cannot answer. If the implementer's last turn ended
    // `process_exited` or `transport_lost`, `send` throws -- `write to a dead pty` -- and
    // `#loop`'s catch would convert an already-completed run into `transport_failed`, with
    // the log contradicting itself: `advisor reports the work complete` is already recorded.
    //
    // The advisor's DONE stands. A closing question is worth one turn, never a verdict.
    const last = impl.events.filter((e) => e.type === 'turn_end').at(-1)
    if (last && last.verdict.outcome !== 'completed') return
    if (impl.session.state !== 'running') return

    // Read BEFORE the question is asked, because asking it is what changes them: `#exchange`
    // lifts the answer's own FLAG: lines as the turn goes past, so after the await this list
    // no longer says what the seat was carrying when it was asked.
    const carried = this.flags.filter((f) => f.participant === impl.id && f.supersededBy === undefined)
    // How many times each was restated before the question. A restatement DURING the closing
    // turn is how `#raiseFlag` records a verbatim repeat, and it is the signal that the seat
    // said this one still stands -- but only the growth is, since a flag raised twice earlier
    // arrives here with a non-empty list already.
    const restatementsBefore = new Map(carried.map((f) => [f, (f.restated ?? []).length]))
    const flagsBefore = this.flags.length

    try {
      const reply = await this.#exchange(
        impl,
        'The advisor considers this work complete and the session is about to end.\n\n' +
          'Before it does: is anything unresolved, unverified, or unanswered? A test you did ' +
          'not run, a belief you took from a comment rather than confirmed, a question you ' +
          'asked that was not answered, or a disagreement with how this was closed.\n\n' +
          (carried.length === 0
            ? ''
            : 'You raised these during the run:\n' +
              carried.map((f) => `  [msg ${f.seq}] ${f.text}`).join('\n') +
              '\n\nThat list is now yours to settle: your answer REPLACES it. Restate — ' +
              'word for word, so it is recognised as the same item rather than counted twice ' +
              '— only the ones that STILL stand. Leave out any that have since been resolved. ' +
              'Add anything not on the list that has not been settled.\n\n') +
          'Reply with one FLAG: line per item, or exactly NONE if there is nothing. This is ' +
          'carried into the run summary; it does not reopen the work.',
      )

      const prose = reply.prose.trim()
      // A `note`, not a `report`. It is not relayed to the advisor and answers nobody's
      // instruction -- it is the participant's closing statement to the RECORD. Filing it as a
      // report made it the last thing `kind === 'report'` queries returned, which is how the
      // relayed-report assertions started reading it instead of the actual last report.
      const closing = this.#record({
        from: impl.id,
        fromRank: 'implementer',
        to: [],
        kind: 'note',
        text: `closing statement: ${prose || '(no reply)'}`,
      })
      // Silence is not a judgement. A seat that said nothing has not told us anything was
      // resolved, so its history stands exactly as it was.
      if (!prose) return

      // Which of the carried flags the seat restated verbatim. `#raiseFlag` collapsed each of
      // those into the flag it repeats rather than pushing a second copy, so they are found by
      // the growth in `restated` and not in the tail of `flags`.
      const restated = carried.filter((f) => (f.restated ?? []).length > (restatementsBefore.get(f) ?? 0))
      // `#exchange` already lifted any FLAG: lines. Anything else is carried whole rather than
      // dropped for want of a prefix (#38) -- but only when the answer really was unstructured.
      // A bare NONE is structured, and a verbatim restatement lifted a line that `#raiseFlag`
      // then merged, so neither is prose to be salvaged.
      const lifted = this.flags.length > flagsBefore || restated.length > 0
      if (!lifted && !/^NONE\b/i.test(prose)) {
        this.#raiseFlag(impl.id, prose, closing.seq)
      }

      // The reconciliation. Everything this seat was carrying that it did not restate is
      // retired against this statement -- not deleted, because `flagSummary` and the report
      // both still show it, labelled with what retired it and when.
      for (const f of carried) {
        if (restated.includes(f)) continue
        f.supersededBy = closing.seq
      }
    } catch (err) {
      // A closing question is worth one turn, never a verdict. If the send fails anyway --
      // a session that died between the advisor's DONE and this ask -- the run has already
      // completed and must not be reclassified by an epilogue.
      this.#record({
        from: 'orchestrator',
        fromRank: 'human',
        to: [],
        kind: 'note',
        text: `closing question not asked: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  /**
   * Whether subagents were used, and whether any worktree appeared while they were.
   *
   * The briefing tells a subagent that MODIFIES anything to work in its own worktree. Nothing
   * enforces that and nothing can: the repository cannot tell a subagent's write from its
   * parent's (#8). What it can do is record the shape a violation takes -- delegation
   * happened, no worktree was created -- and leave the reading to a human.
   *
   * A zero is frequently correct. A subagent that only reads is explicitly allowed the shared
   * directory, so this is evidence to weigh and never a verdict.
   */
  subagentUse(): { delegated: boolean; worktreesCreated: string[] } {
    const before = new Set(this.#worktreesAtStart ?? [])
    // Participant EVENTS, not `#evidence`. Evidence keeps tool arguments and discards the
    // tool name -- the gap recorded in #8 -- so reading it here would have made `delegated`
    // permanently false while looking like it worked.
    const delegated = this.participants.some((p) =>
      p.events.some((e) => e.type === 'tool_use' && isSubagentTool(e.tool)),
    )
    for (const w of worktreePaths(this.#opts.cwd)) this.#worktreesSeen.add(w)
    return {
      delegated,
      worktreesCreated: [...this.#worktreesSeen].filter((p) => !before.has(p)),
    }
  }

  /**
   * Lines naming everything left unresolved. Empty when there is nothing to carry.
   *
   * Two sections, and the second one is the point of #131. What is OUTSTANDING is what the
   * seats that raised it still say is outstanding, so a run whose implementer flagged three
   * things and then reported one still standing says `1 flagged item carried` -- the count is
   * the seat's own arithmetic rather than the transcript's.
   *
   * What was superseded is printed under it anyway. Retiring a flag on a seat's say-so is the
   * best signal available and it is still only a claim; an operator who can see `raised, then
   * not restated` can go and check, and one who sees nothing cannot. This is the section that
   * keeps a truncated `NONE` from reading exactly like a clean run.
   */
  flagSummary(): string[] {
    const outstanding = this.outstandingFlags()
    const superseded = this.supersededFlags()
    if (outstanding.length === 0 && superseded.length === 0) return []

    const line = (f: RelayFlag): string => {
      // Every position it was raised at, not just the first. A concern raised on three turns
      // is one item and three data points, and the collapse must not hide the second fact.
      const again = (f.restated ?? []).length > 0 ? ` (raised again at msg ${(f.restated ?? []).join(', ')})` : ''
      return `  ${f.participant} [msg ${f.seq}] — ${f.text}${again}`
    }

    const lines: string[] = []
    if (outstanding.length > 0) {
      lines.push(`${outstanding.length} flagged item${outstanding.length === 1 ? '' : 's'} carried:`)
      lines.push(...outstanding.map(line))
    }
    if (superseded.length > 0) {
      const n = `${superseded.length} earlier item${superseded.length === 1 ? '' : 's'}`
      lines.push(
        `${outstanding.length === 0 ? 'nothing outstanding, but ' : ''}${n} superseded at the close ` +
          `(raised, then not restated when the seat was asked what still stands):`,
      )
      lines.push(...superseded.map(line))
    }
    return lines
  }

  /**
   * Whether the tree was ever measured against the configured checks, and if not, why not.
   *
   * `--checks` feeds two stations. It arms rotation, which is what it has always meant, and
   * since #80 it also measures the integration checkout after a merge. Only the second one is
   * about whether the WORK is any good, and it needs a merge to happen at -- so a
   * single-implementer run, which has no seat worktrees by design and therefore no merge
   * boundary, never reaches it. That is deliberate: a single-seat run must not acquire a
   * per-task CI step from a flag that used to mean rotation alone.
   *
   * What was not deliberate is that the run then reported `done` in exactly the words it uses
   * when every check passed (#153). An operator arms the flag precisely so the run does not
   * have to be taken on trust, and the summary let them believe it had been measured. Nothing
   * about the behaviour changes here; what changes is that the run says which of the two
   * stations the flag reached.
   *
   * Undefined when there is nothing to disclaim: with no checks configured the rotation line
   * above already reports the detector unarmed for want of them, and a second line saying it
   * again is one an operator learns to skip past on the common run -- which is what would make
   * it useless on the run where it matters. Same reasoning as `targetingSummary` staying
   * silent with one seat.
   */
  integrationSummary(): string | undefined {
    const checks = this.#opts.rotation?.checks
    if (!checks || checks.length === 0) return undefined
    const commands = checks.map((c) => `\`${checkCommand(c)}\``).join(', ')
    if (this.#worktrees) {
      const measured = this.#merges.length
      return measured === 0
        ? `integration: ${commands} armed, but nothing merged, so the tree was never measured`
        : `integration: ${commands} measured after each of ${measured} merge${measured === 1 ? '' : 's'}` +
          `${this.#integrationRed ? ' — the tree is RED' : ''}`
    }
    return (
      `integration: NOT MEASURED — ${commands} armed rotation only. One implementer works in ` +
      `the operator's checkout, so there is no merge for the integration check to run at. ` +
      `Run it yourself, or use a second seat.`
    )
  }

  /** One line an operator can read to know whether the detector was live and what it saw. */
  rotationSummary(): string {
    const w = this.rotationWatch
    // The counters cannot say this and would be MISREAD without it: a run that stopped rotating
    // because no replacement could ever be observed reports the same `0 rotations` as a run that
    // never needed one (#76). Carried by every armed branch below for the reason the "nothing was
    // measured" branch exists at all -- saying nothing happened over the top of an event that did
    // is a stronger falsehood than an ambiguity.
    const stopped = this.#rotationUnobservable
      ? `\n  rotation STOPPED after ${this.#rotationUnobservable.seat}: acceptance produced no ` +
        `observable output, so no replacement could pass and the fix is upstream of rotation`
      : ''
    if (!w.armed) {
      return `rotation: NOT ARMED (no checks configured) — ${w.assessments} assessments, no rotation possible`
    }
    // Armed but never exercised. Distinct from both "armed and saw nothing" and "not
    // configured", and previously indistinguishable from the latter -- which is the defect
    // in #31. A reader must be able to tell that the instrument was live but the run ended
    // before it was used, because that says the run is uninformative rather than negative.
    // ...unless a rotation actually happened, which an operator can force at a pause before
    // any assessment has been made. Saying "nothing was measured" over the top of a
    // completed transfer would be a stronger falsehood than the ambiguity #31 was about:
    // one hides an absence of evidence, the other hides an event.
    if (w.assessments === 0 && w.rotations === 0) {
      return (
        `rotation: armed — 0 assessments, the run ended before any were made ` +
        `(nothing was measured; this is not a negative result)${stopped}`
      )
    }
    return (
      `rotation: armed — ${w.assessments} assessments, ${w.degradationsSeen} degraded, ` +
      `${w.complaintsSeen} complaints, ${w.candidates} candidates, ${w.rotations} rotations, ` +
      `peak compaction generation ${w.peakGeneration}${stopped}${this.rotationIntentSummary()}`
    )
  }

  /**
   * What each rotation was FOR, appended to the summary line and rendered from the records.
   *
   * Empty when nothing rotated, which is the common case and the one where a breakdown of zero
   * would be noise. The moment something does rotate this is the line that stops the run report
   * from being unusable as evidence: `1 rotations` beside a compaction generation reads as the
   * proxy having fired, and it reads that way whether or not it did (#75).
   *
   * The reasons themselves are here rather than only in the JSON because the terminal report is
   * what a human actually reads at the end of a run, and an operator-initiated rotation whose
   * reason is invisible is the record #75 is about wearing a counter.
   */
  rotationIntentSummary(): string {
    const records = this.rotationWatch.records
    if (records.length === 0) return ''
    const byIntent = new Map<RotationIntent, number>()
    for (const r of records) byIntent.set(r.intent, (byIntent.get(r.intent) ?? 0) + 1)
    const counts = [...byIntent].map(([intent, n]) => `${n} ${intent}`).join(', ')
    // A rotation whose loser would not die is still a rotation and still counted above -- the
    // replacement proved itself and took the seat. What the count cannot say is that something
    // may still be running, and this is the line a human actually reads at the end of a run. An
    // orphaned child holding a worktree is not a detail to leave in the routing log 300 lines up.
    const cleanup = (r: RotationRecord): string =>
      r.cleanupFailure
        ? `\n      outgoing session NOT confirmed disposed of (state '${r.cleanupFailure.outgoingState}'): ` +
          `${r.cleanupFailure.detail} — check for an orphaned process`
        : ''
    return `\n  rotation intent: ${counts}${records.map((r) => `\n    ${r.seat} (${r.intent}) — ${r.reason}${cleanup(r)}`).join('')}`
  }

  /**
   * Every accepted rotation and why, for a reader outside the process.
   *
   * Copied, and the objects with it: the caller may keep what it is handed, and a shared array
   * would let a reader of a finished run watch a list the relay still owns. The same rule
   * `report.ts` follows for `launch`.
   */
  rotationRecords(): RotationRecord[] {
    return this.rotationWatch.records.map((r) => ({ ...r }))
  }

  /**
   * Record one advisor turn's assignment attempt. THE recording site, and the only one (#79).
   *
   * ## Why it is a `finally` and not a call at each ending
   *
   * The contract `targetingTurns` states -- "every turn that tried to instruct" -- is a property
   * of WHERE this runs, not of any arithmetic. It was stated three times before and broken three
   * times, always the same way: a recorder placed on the path a turn took, and then an exit
   * added above it. Validation moved above the recorder and every refused turn vanished. The
   * queue ceiling was hoisted out of the admission loop and every ceiling-refused batch vanished
   * with it -- `continue advisor` from a check that sits above the recorder is a turn that was
   * never counted, and the run could then report `NONE used @seat/@role` about an advisor whose
   * one addressed reply had proved the briefing works.
   *
   * So the turn cannot leave without passing here. Every `continue advisor`, every re-ask,
   * every `return`, every throw, and every exit somebody adds next year. That placement is the
   * enforcement; nothing else in this file needs to remember anything.
   *
   * ## Classification, from the turn's completed state
   *
   * Read off `AdvisorAttempt` and the participant's event log at the moment the turn is over,
   * never from where in the code the turn happened to end:
   *
   *   - admitted at all → `admitted`, whatever else also happened;
   *   - otherwise the turn did not complete → `incomplete`, carrying the SETTLED verdict;
   *   - otherwise a ceiling refused it → `ceiling`;
   *   - otherwise the parser refused it → `invalid`;
   *   - otherwise it was whole, valid and never admitted → `unadmitted`, which is the
   *     reconciliation and the future-exit net at once. See `UnadmittedReason`.
   *
   * ## The verdict is re-resolved HERE, and that is the reconciliation
   *
   * `#exchange` settles on the first `turn_end`; a late signal that withdraws it can arrive at
   * any point afterwards, INCLUDING while the operator is reading the pause this turn raised.
   * The dispatch decision was already taken by then and cannot be unmade -- but the record can
   * be written after it, and it is. A turn failed on a `timed_out` that the adapter withdrew
   * and replaced with `completed` mid-pause is filed as `unadmitted / verdict_superseded`: a
   * whole valid reply the run had already stopped dispatching. It is NOT filed as `incomplete`,
   * which is a permanent claim that the advisor's reply could not be trusted, about a turn its
   * own adapter says ended.
   *
   * The names are kept exactly as the reply wrote them -- unvalidated, and on a refusal one of
   * them is usually why it failed. That is the point: an operator deciding whether to fix the
   * briefing or the seat names in it needs to read the name the advisor reached for.
   */
  #finaliseTargeting(turn: number, lead: RelayParticipant, attempt: AdvisorAttempt | undefined): void {
    // The live view of this turn ends HERE, whatever the turn was, and before any return below.
    // One statement, unconditional, in the same synchronous block as the append: a turn cannot be
    // pending and recorded at once (which would count it twice on every live surface) and cannot
    // be neither (which would put the run back to reporting NONE off the turns that are over).
    // Assigned rather than deleted so a reader sees the field go out, and placed above the guard
    // for the same reason the recording site is where it is -- an exit added below must not be
    // able to leave a finished turn showing as open.
    this.targetingWatch.pending = undefined
    // A turn that assigned nothing: DONE, ESCALATE, or a turn that ended above the parse. It was
    // never asked to name a seat, so counting it would report under-use by an advisor that was
    // not assigning anything.
    if (!attempt) return
    // The verdict as it stands NOW, which is not always the one the turn was failed on, and is
    // sometimes not a verdict at all. `supersessionOf` answers in THREE states and all three mean
    // different things:
    //
    //   - `undefined` — no revision names this `turn_end`, so its own verdict stands;
    //   - a revision WITH a replacement — the adapter withdrew its claim and made another, and
    //     the replacement is its last word;
    //   - a revision with NO replacement — the adapter withdrew its claim and has not made
    //     another. There is no verdict for this turn. It is OPEN.
    //
    // The third used to be collapsed into the first by `?.replacement ?? attempt.end`, which
    // reads the withdrawn `turn_end` back out and files the turn as `incomplete` carrying the
    // very verdict the adapter retracted -- a permanent claim that the advisor's reply could not
    // be trusted, sourced to a claim its own adapter took back. `incompleteTurns` is also the
    // bucket that withholds the under-use finding, so one retracted verdict suppressed a finding
    // for the rest of the run on evidence that had been withdrawn.
    //
    // The pause raised over this turn already handles the no-replacement case explicitly -- see
    // `preSuperseded` at the guard, which tells the operator the verdict was withdrawn with
    // nothing put in its place. This is the same fact, reaching the permanent record.
    const superseded = supersessionOf(lead.events, attempt.end)
    const settled = superseded === undefined ? attempt.end : superseded.replacement
    const ended = settled?.verdict.outcome
    const record: TargetingRecord = attempt.admitted
      ? { turn, addressed: attempt.addressed, targets: attempt.targets, outcome: 'admitted' }
      : ended === undefined
        ? // Withdrawn with nothing behind it: the turn is OPEN, and that is its own outcome. Not
          // `incomplete`, which would quote the retracted verdict as though it still stood; and
          // not `unadmitted`, which this branch used to write and which says the opposite of what
          // is known here -- `unadmitted` means a whole valid reply the run had stopped
          // dispatching, and what makes such a reply whole is the REPLACEMENT saying the turn
          // ended `completed` after all. With nothing behind the withdrawal there is no such
          // statement, so filing it there certified elicitation off a turn its own adapter says
          // is still open. See `UNDISPATCHED.withdrawn`, which classes it as unsettled evidence.
          //
          // Above the ceiling and refusal branches for the same reason the bad-verdict branch is
          // above them: if the turn never got a verdict, what the run did with its reply is not
          // what the record should say happened to it.
          { turn, addressed: attempt.addressed, targets: attempt.targets, outcome: 'withdrawn' }
        : ended !== 'completed'
          ? // The verdict wins over a parse refusal when both are wrong. A reply that would not
            // parse on a turn that also timed out is most likely a truncated reply, and calling it
            // a refusal would report the advisor as having written something malformed when what
            // happened is that it never finished writing.
            { turn, addressed: attempt.addressed, targets: attempt.targets, outcome: 'incomplete', verdict: ended }
          : attempt.ceiling !== undefined
            ? { turn, addressed: attempt.addressed, targets: attempt.targets, outcome: 'ceiling', ceiling: attempt.ceiling }
            : attempt.refusal !== undefined
              ? { turn, addressed: attempt.addressed, targets: attempt.targets, outcome: 'invalid', refusal: attempt.refusal }
              : {
                  turn,
                  addressed: attempt.addressed,
                  targets: attempt.targets,
                  outcome: 'unadmitted',
                  // Which of the two, decided by whether the run acted on a verdict that no longer
                  // stands. `unclassified` is unreachable as this file stands and is not dead: it
                  // is what an exit added between the ceiling and admission will produce, and a
                  // visibly unexplained record is a defect somebody can find.
                  unadmitted: attempt.heldVerdict === 'completed' ? 'unclassified' : 'verdict_superseded',
                }
    if (!recordTargetingTurn(this.targetingWatch, record)) return
    // The reconciliation, said out loud. The contemporaneous note above the pause reported the
    // verdict this turn was failed on; if the adapter has since withdrawn it, a reader comparing
    // the log with the record would otherwise find them disagreeing with nothing to explain it.
    // Written rather than the earlier note being edited: a log is an account of what was
    // believed when, and a line rewritten after the fact is a line nobody can date.
    if (ended !== attempt.heldVerdict) {
      this.#record({
        from: 'orchestrator',
        fromRank: 'human',
        to: [],
        kind: 'note',
        text:
          `advisor turn ${turn} was failed on a ${attempt.heldVerdict} verdict that has since been ` +
          // Said as what happened, because the two are different situations for a reader: one
          // turn has a new verdict to reconcile against, the other has none at all and is left
          // open. Writing "replaced with undefined" would be the record admitting it had not
          // looked.
          (ended === undefined
            ? `withdrawn with nothing put in its place, so the turn has no verdict at all and its ` +
              `targeting record reads ${record.outcome} `
            : `withdrawn and replaced with ${ended}, so its targeting record reads ${record.outcome} `) +
          `rather than ${attempt.heldVerdict === 'completed' ? 'invalid' : 'incomplete'} — the reply ` +
          `was ${attempt.addressed ? `read whole and named ${attempt.targets.join(', ') || 'a target'}` : 'read whole and named nobody'}, ` +
          `and the run had already stopped dispatching it. Nothing about the turn is re-run; this ` +
          `is the permanent record being made to agree with the adapter's last word.`,
      })
    }
  }

  /**
   * One line an operator can read to know whether the advisor used the assignment syntax (#79).
   *
   * `undefined` on a one-seat run, and both front-ends print nothing rather than printing that
   * there is nothing to say. See `targetingSummary` in `targeting.ts` for the argument; the
   * rendering lives there because it is a pure function of the counters and a summary that
   * needed a relay to test would be tested against a run instead of against its own cases.
   */
  targetingSummary(): string | undefined {
    return targetingSummary(this.targetingWatch)
  }

  /**
   * What the targeting instrument saw, for a reader outside the process.
   *
   * Copied, records and all, for the reason `rotationRecords` copies: the status document is
   * written repeatedly from a live relay, and handing out the array it still owns would let a
   * reader of an earlier document see a list that moved underneath it.
   */
  targeting(): TargetingWatch {
    const w = this.targetingWatch
    return {
      applicable: w.applicable,
      seats: w.seats,
      records: this.targetingRecords(),
      // Projected to the three fields `TargetingPending` declares, never the attempt itself: the
      // attempt carries this turn's `turn_end` and its dispatch state, both of which keep moving
      // after this copy is handed out, and one of which is an outcome the turn has not reached.
      ...(w.pending === undefined
        ? {}
        : {
            pending: { turn: w.pending.turn, addressed: w.pending.addressed, targets: [...w.pending.targets] },
          }),
    }
  }

  /** Every advisor turn that tried to instruct and how it addressed it, copied. See `targeting`. */
  targetingRecords(): TargetingRecord[] {
    return this.targetingWatch.records.map((r) => ({ ...r, targets: [...r.targets] }))
  }

  /**
   * The rotation policy one seat is actually under, for a reader outside the process.
   *
   * The SAME resolution every decision inside the relay makes -- `rotationFor` against this
   * run's config -- rather than a second reading of the option object. A reported policy that
   * was derived independently is a policy that can disagree with the one being enforced, and
   * the whole complaint in #103 is an observer being told something false about what is armed.
   *
   * Per seat because arming is per seat (D7, #78): one `--checks` can be replaced on
   * `implementer-2` alone, and a run-wide answer would be wrong for exactly the seat whose
   * pause the operator is holding.
   *
   * `undefined` keeps its meaning from `rotationFor` and is not flattened here: a run with no
   * rotation policy at all is a different fact from a seat a policy declared unrotatable, and
   * the caller that reports this is the one place that distinction has to survive.
   */
  rotationOf(seatId: string): EffectiveRotation | undefined {
    return rotationFor(this.#opts.rotation, seatId)
  }

  /**
   * How many exchanges this relay currently has open on each participant, by id.
   *
   * The relay's OWN bookkeeping, and deliberately not a reading of an adapter. A session's state
   * says `running` whether or not a turn is in progress, the transcript settles behind the hook,
   * and `AgentEvent` has no idle member -- so every way of inferring this from the child is a
   * guess that is wrong for a window rather than a fact. What this records instead is something
   * the relay knows for certain because it is the only thing that does it: a send it issued and
   * has not yet finished reading the answer to.
   *
   * A count rather than a set of ids. Nothing nests today, and a set would silently clear the
   * outer entry the moment something did -- which would hand out permission to rotate over a
   * live turn, in the exact code that exists to refuse it.
   */
  #exchanges = new Map<string, number>()

  /** Whether the relay is mid-exchange with this participant. See `#exchanges`. */
  #busy(participantId: string): boolean {
    return (this.#exchanges.get(participantId) ?? 0) > 0
  }

  /**
   * One exchange, bracketed so the bookkeeping cannot leak.
   *
   * The whole turn is in `#exchangeTurn`; this is only the bracket. Split rather than wrapped in
   * place so the release sits in a `finally` that no later edit inside a 150-line method can slip
   * past: a turn that throws -- a transport fault, a session closed underneath it (#143) -- must
   * leave the participant rotatable, or one lost turn would make the seat permanently unrotatable
   * and the refusal would outlive the condition it describes.
   *
   * An expired deadline is deliberately NOT in that list. It throws nothing and ends nothing:
   * `#exchangeTurn` runs no clock of its own, the adapter's watchdog emits a `timed_out` verdict
   * as an ordinary event, this method stops waiting and RETURNS a result, and the child goes on
   * doing whatever it was doing. The `finally` covers it either way, so the distinction costs
   * nothing here -- but a reader who takes a deadline for a thrower will go looking for a
   * cancellation that this code does not perform.
   */
  async #exchange(p: RelayParticipant, text: string): Promise<TurnResult> {
    this.#exchanges.set(p.id, (this.#exchanges.get(p.id) ?? 0) + 1)
    try {
      return await this.#exchangeTurn(p, text)
    } finally {
      const left = (this.#exchanges.get(p.id) ?? 1) - 1
      if (left > 0) this.#exchanges.set(p.id, left)
      else this.#exchanges.delete(p.id)
    }
  }

  /**
   * The precondition on a peer send: the target is not in the middle of a turn (#117).
   *
   * `/continue` has refused to send into a live turn since #43, because continuing SENDS and
   * neither CLI accepts input mid-turn. That guard covers the OPERATOR's send. This is the same
   * refusal for the relay's own, which is the one that was ending runs: four in a single
   * operator session, three of them mid-task, every one of them reported as `transport_failed`.
   *
   * Read off the TARGET's own event stream, via `activeTurn` -- the same predicate the console's
   * `/continue` guard now uses, so the two cannot answer this question differently again.
   *
   * Two things it is deliberately NOT. It is not the settle loop's `unsettled` flag: that flag
   * describes a turn the hook has already ended whose transcript is merely lagging, which is a
   * flush race and not a live turn, and it belongs to whichever participant the PREVIOUS
   * exchange was with -- `#runLoop`'s dispatcher resolves a task to a seat and `launch` looks
   * that participant up, so it is routinely somebody else. And it is not a CPU sample: that is
   * a proxy for the wrong quantity and is wrong in both tails (see `activeTurn`).
   *
   * Read at the top of the turn rather than literally at the send: everything between here and
   * `send` is synchronous (`worktreePaths`, `dirtyPaths`), so no turn can begin in the gap. The
   * relay is the only thing that starts turns under `mediated` input ownership, which is what
   * makes that guarantee hold rather than merely be likely.
   *
   * The relay WAITS where the console refuses. `/continue` is a human at a prompt who can retype
   * in a second, so a refusal costs them nothing; a peer send is the run's only way forward, and
   * a turn that is merely long is the commonest reason to be here. A wait that succeeds is
   * recorded, because a run that quietly stalls for four minutes and then continues is
   * indistinguishable from a run that hung.
   */
  async #awaitSendable(p: RelayParticipant): Promise<void> {
    // A session `stop()` has already closed is not going to become sendable, and nothing is
    // going to be sent to it (#143). Reached when teardown lands between two turns rather than
    // inside one: the loop is unwinding either way, and waiting out the precondition's bound --
    // five minutes by default -- would make `stop()` sit through it, since `stop()` now waits for
    // the loop. Thrown as an abandoned turn rather than as `peer_busy`, because nothing here is
    // busy: the run was taken away.
    const closed = this.#closeSignal(p.id)
    if (closed.done) {
      throw new TurnAbandonedError(p.id, `${p.id}'s session was closed before this turn could be sent`)
    }
    if (!activeTurn(p.events)) return

    const bound = this.#opts.sendPreconditionMs ?? DEFAULT_SEND_PRECONDITION_MS
    const startedAt = Date.now()
    const eventsAtStart = p.events.length
    let turn = activeTurn(p.events)
    while (turn && Date.now() - startedAt < bound && !closed.done) {
      await Promise.race([new Promise((r) => setTimeout(r, 100)), closed.promise])
      turn = activeTurn(p.events)
    }
    // Closed under us while waiting. Same reasoning as above, and checked after the loop rather
    // than inside it so the last look at `activeTurn` still counts: a close that ended the turn
    // makes this participant sendable in the only sense that matters, and the give-up path below
    // must not be entered for a turn that has just finished.
    if (turn && closed.done) {
      throw new TurnAbandonedError(p.id, `${p.id}'s session was closed while its previous turn was still open`)
    }
    const busy = turn !== undefined
    // Sub-second waits are reported in milliseconds. A bound set small -- a test, an operator
    // who wants the run to give up quickly -- would otherwise report every wait as "0s", which
    // reads as a wait that never happened.
    const elapsed = Date.now() - startedAt
    const waited = elapsed < 1000 ? `${elapsed}ms` : `${Math.round(elapsed / 1000)}s`
    if (!busy) {
      this.#record({
        from: 'orchestrator',
        fromRank: 'human',
        to: [],
        kind: 'note',
        text:
          `${p.id} was mid-turn, so the relay waited ${waited} for the turn to end before ` +
          `sending; sending into a live turn is what ends a run with no hook after the send`,
      })
      return
    }

    // The bound expired. Everything below is the weaker outcome #117 allows for, and it is
    // deliberately not a send: a send here is the failure this exists to prevent, and would
    // trade a run ended honestly for a run ended misleadingly.
    const evidence = [
      `${p.id}: ${describeActiveTurn(turn!)}, and it had not ended after ${waited}`,
      `${p.events.length - eventsAtStart} event(s) arrived from it while waiting`,
    ]
    // CPU as COLOUR, never as the decision. It is a proxy for the wrong quantity -- a child
    // blocked in `sleep` inside a Bash call is mid-turn at 3% and a finished one twitches to 4%
    // -- so it is worth a sentence to a human choosing what to do next and nothing at all to
    // the branch above. Best effort besides: an adapter with no single child to name says
    // nothing, and that is "cannot say" rather than "not running" (#43, #45).
    const pid = p.session.childPid
    if (pid !== undefined) {
      try {
        const sample = await (this.#opts.liveness ?? sampleLiveness)(pid)
        evidence.push(`its child (pid ${pid}) reads ${readingOf(sample)}, which decided nothing here`)
      } catch {
        // A sampling failure is not worth turning into a second failure mode on a path that
        // is already ending the run.
      }
    }
    // Dealt with, not abandoned. The old ending left the child running: in the run #117 was
    // reported from it went on to write 764 lines across six files, unwatched, into a tree the
    // run record said nothing more about. Cancel first so the turn stops, then close, which
    // reconciles the transcript before terminating and so keeps the best account of what it
    // managed to do.
    const dealt: string[] = []
    try {
      await p.session.cancel()
      dealt.push('its live turn was cancelled')
    } catch (e) {
      dealt.push(`its live turn could not be cancelled (${e instanceof Error ? e.message : String(e)})`)
    }
    try {
      await p.session.close('graceful')
      dealt.push('and the session was closed')
    } catch (e) {
      dealt.push(`and the session could not be closed (${e instanceof Error ? e.message : String(e)})`)
    }
    const detail =
      `${p.id} was still mid-turn after ${waited}, so nothing was sent to it: ` +
      `${evidence.join('; ')}. ${dealt.join(', ')}.`
    this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: detail })
    throw new PeerBusyError(p.id, detail)
  }

  /**
   * The close signal for one participant, created on first use by whichever side asks first.
   *
   * Both sides need it and neither can be relied on to run first: a turn can be in flight long
   * before anyone stops the relay, and `stop()` can be called on a participant that never took a
   * turn at all. Created lazily here so the two always get the same object.
   */
  #closeSignal(id: string): { done: boolean; promise: Promise<void>; fire: () => void } {
    const existing = this.#closed.get(id)
    if (existing) return existing
    let resolve!: () => void
    const promise = new Promise<void>((r) => {
      resolve = r
    })
    const signal = {
      done: false,
      promise,
      fire: () => {
        signal.done = true
        resolve()
      },
    }
    this.#closed.set(id, signal)
    return signal
  }

  async #exchangeTurn(p: RelayParticipant, text: string): Promise<TurnResult> {
    // Nothing is sent to a participant that is still working. First, because a send that lands
    // mid-turn is not queued -- it ends the run (#117) -- and second, because everything below
    // this line is bookkeeping for a turn that is about to start, and a turn that will never be
    // sent must not be counted as one.
    await this.#awaitSendable(p)
    // Counted here, where a turn actually starts, so the ceiling measures work done rather
    // than advisor turns entered -- one advisor turn can drive one turn or several.
    this.#turnsTaken += 1
    // Sampled per turn: a worktree created and removed inside one turn is still evidence the
    // rule was followed, and only a repeated sample can see it.
    if (this.#worktreesAtStart) for (const w of worktreePaths(this.#opts.cwd)) this.#worktreesSeen.add(w)
    const before = p.events.length
    // What the tree looked like before this turn. Only ever used to say what a LOST report
    // would have described: an escalation that says "the report came back empty" and one
    // that says "the report came back empty; 3 files changed on disk" ask very different
    // things of whoever reads it (#39).
    // THIS participant's root, not the run's. The diff exists to say what this turn changed,
    // and at N>1 the integration checkout is not where this turn's work lands -- reading it
    // would report another seat's merge as this seat's turn, and would miss everything this
    // seat actually wrote. At N=1 the two are the same directory.
    const turnRoot = this.#rootOf(p.id)
    const treeBeforeTurn = new Set(dirtyPaths(turnRoot))
    await p.session.send(text, { kind: 'peer_relay' })

    // No timeout of its own. The adapter's watchdog guarantees a terminal verdict for a
    // hung turn -- that is what it is for -- so a deadline here would be a second clock
    // racing the first.
    //
    // An earlier version threw after ten minutes, which killed both sessions on a turn
    // that was merely long. It discarded working sessions to report a timeout, and it did
    // so with a hardcoded throw rather than the `timed_out` verdict the design already
    // defines. Losing the session is worse than waiting for it.
    //
    // It does have ONE exit besides the event: the session being closed under it (#143). Not the
    // same thing as a deadline, and deliberately not `#stopped` either -- see `#closed` for why
    // the line is drawn at the close returning rather than at the request to stop. Until someone
    // closes this session, this loop is exactly the loop it has always been.
    const terminal = (): TurnEndEvent | undefined =>
      p.events.slice(before).find((e) => e.type === 'turn_end') as TurnEndEvent | undefined
    const closed = this.#closeSignal(p.id)
    let end: TurnEndEvent | undefined
    for (;;) {
      end = terminal()
      if (end) break
      // The signal does not fire until the session is closed AND its reader has drained, so the
      // look taken at the top of this iteration has already seen every event the close produced.
      // There is nothing left to wait for and nothing to wait a grace period for: if a verdict
      // existed, `terminal()` would be holding it.
      if (closed.done) {
        throw new TurnAbandonedError(
          p.id,
          `${p.id}'s session was closed while its turn was still open, and the close produced no ` +
            `verdict for it — so the turn was abandoned and its report is lost`,
        )
      }
      // Raced rather than slept through, so a stop does not wait out a poll interval it has
      // already made pointless.
      await Promise.race([new Promise((r) => setTimeout(r, TURN_POLL_MS)), closed.promise])
    }

    // The transcript can lag the hook. `Stop` fires when the turn ends; the final assistant
    // message may not have been flushed yet, so reading the snapshot the instant `turn_end`
    // arrives can return a turn holding only its interstitial narration.
    //
    // Observed live and repeatedly: an advisor asked for the same trace three times because
    // every report it received was a preamble -- "I'll do the deeper trace properly" and
    // nothing else. The implementer had answered; the relay had read too early. Intermittent,
    // which is what a flush race looks like.
    //
    // So settle on the TRANSCRIPT rather than on the hook's timing. This is not a second
    // deadline on the turn -- the adapter's watchdog owns that -- it is a bounded wait for
    // the record of a turn that has already ended. When the bound is hit the prose is used
    // anyway and the shortfall is recorded, because a truncated report the log explains is
    // recoverable and a silent one is not.
    const settleBy = Date.now() + (this.#opts.transcriptSettleMs ?? 15_000)
    let snap = await p.session.snapshot()
    while (snap.turns.at(-1)?.state === 'in_progress' && Date.now() < settleBy) {
      await new Promise((r) => setTimeout(r, 150))
      snap = await p.session.snapshot()
    }
    // Returned as well as noted. The note is for a human reading the console; the flag is
    // for everything else, and it is the part that was missing — a caller consuming the
    // routing log saw an ordinary report and had no way to know it was captured early.
    const unsettled = snap.turns.at(-1)?.state === 'in_progress'
    if (unsettled) {
      this.#record({
        from: 'orchestrator',
        fromRank: 'human',
        to: [],
        kind: 'note',
        text:
          `${p.id}'s transcript still showed the turn in progress after the settle window; ` +
          `the report below may be incomplete`,
      })
    }
    // The report, not the narration. A participant that receives "I'll start by finding the
    // relevant code" answers the intention rather than the result, which is how an advisor
    // ends up re-asking for work already done. The narration reaches the human live, as
    // `message` events; see repl/session.ts.
    const proseOf = (s: SessionSnapshot) => {
      const t = s.turns.at(-1)
      return t?.report ?? t?.assistantText ?? ''
    }

    // A completed turn with NOTHING to show for it is worth waiting much longer for.
    //
    // The settle window above is a budget spent on every turn, so it is deliberately small.
    // This is not that: reaching here means the alternative is routing a blank the advisor
    // reasons from, or ending the run outright -- and against that cost another minute of
    // polling is nothing. Observed live on a turn that rewrote 200 lines of a record file:
    // 25s was not enough, the report came back empty, and the run ended holding no account
    // of work that was sitting on disk (#39).
    //
    // Only for the unsettled case. A turn whose transcript DID settle and still said
    // nothing is a participant genuinely saying nothing -- a different fault, and one no
    // amount of waiting fixes.
    if (unsettled && proseOf(snap).trim() === '') {
      const salvageMs = this.#opts.transcriptSalvageMs ?? DEFAULT_SALVAGE_MS
      const salvageBy = Date.now() + salvageMs
      while (proseOf(snap).trim() === '' && Date.now() < salvageBy) {
        await new Promise((r) => setTimeout(r, 250))
        snap = await p.session.snapshot()
      }
      this.#record({
        from: 'orchestrator',
        fromRank: 'human',
        to: [],
        kind: 'note',
        text:
          proseOf(snap).trim() === ''
            ? `${p.id}'s report was still empty after waiting a further ` +
              `${Math.round(salvageMs / 1000)}s for the transcript`
            : `${p.id}'s report arrived after the settle window; the run continues with it`,
      })
    }
    this.#collectEvidence(p, snap)
    let prose = proseOf(snap)

    // Last resort: rebuild the report from what we WATCHED the child say.
    //
    // The transcript is the canonical account and this is not it -- but a completed turn
    // whose canonical account is empty is the case where canonical has already failed. The
    // adapter streamed `message` events throughout the turn (it is how the console renders
    // narration live), so the prose exists in memory even when the snapshot has none of it
    // and the Stop hook carried no `last_assistant_message` to fall back to.
    //
    // Observed twice in one live run, on a build that already had the hook fallback: both
    // turns completed, both salvage windows expired, and one of the lost reports described
    // eight changed files. The work was on disk and the account of it was thrown away while
    // a copy sat in the event list.
    //
    // Marked as reconstructed rather than passed off as the report. It is the narration, not
    // the closing message, so it is longer and less pointed than what the peer would have
    // received -- and a reader deciding how much to trust an instruction built on it should
    // be told which one they have.
    if (prose.trim() === '') {
      const streamed = p.events
        .slice(before)
        .filter((e): e is Extract<AgentEvent, { type: 'message' }> => e.type === 'message' && e.role === 'assistant')
        .map((e) => e.text.trim())
        .filter(Boolean)
      if (streamed.length > 0) {
        prose = streamed.join('\n\n')
        this.#record({
          from: 'orchestrator',
          fromRank: 'human',
          to: [],
          kind: 'note',
          text:
            `${p.id}'s transcript yielded no report, so the one below was rebuilt from the ` +
            `${streamed.length} message(s) streamed during the turn — narration, not its closing statement`,
        })
      } else {
        // The stage that says nothing used to be the one with nothing to say (#94). A salvage
        // that SUCCEEDS explains its own provenance; a salvage that finds nothing recorded
        // no line at all, so an operator saw two notes about waiting and then silence, and
        // had to infer from an absent third note that a third stage existed. Observed on
        // oath-lang: seq 11-14 salvaged from 10 streamed messages and said so, seq 17-19 hit
        // this branch and the run went quiet.
        //
        // It is also the fact that separates the two ways this ends. "The transcript could
        // not be read" and "there was nothing to read" call for different actions -- raise
        // --settle, or go and look at what the child actually did -- and only this branch
        // knows which one happened.
        this.#record({
          from: 'orchestrator',
          fromRank: 'human',
          to: [],
          kind: 'note',
          text:
            `${p.id}'s transcript yielded no report and nothing was streamed during the turn, ` +
            `so there is nothing to rebuild one from`,
        })
      }
    }
    for (const text of extractFlags(prose)) {
      this.#raiseFlag(p.id, text, this.log.length)
    }
    return { prose, end, unsettled, emittedSinceSend: p.events.length - before, emittedBefore: before, changedDuringTurn: dirtyPaths(turnRoot).filter((f) => !treeBeforeTurn.has(f)) }
  }

  /**
   * Tool inputs each participant's session has recorded, in the order they were observed.
   *
   * Append-only, and that is the point: a snapshot is REBUILT from the transcript, and
   * compaction can shorten it. Holding an index into a list that shrinks under us would
   * silently re-read the wrong turns, so evidence accumulates here and only the count of
   * turns already consumed is tracked against the snapshot.
   */
  #evidence = new Map<string, string[]>()
  #turnsConsumed = new Map<string, number>()
  /** How much evidence each participant had when the last restricted message was sent. */
  #evidenceAtOrigin = new Map<string, number>()

  #collectEvidence(p: RelayParticipant, snap: SessionSnapshot): void {
    const consumed = this.#turnsConsumed.get(p.id) ?? 0
    // Never index past the end: a compacted transcript can hold fewer turns than we have
    // already read, and `slice` past the end must mean "nothing new", not "start over".
    const fresh = snap.turns.slice(Math.min(consumed, snap.turns.length))
    const args = fresh.flatMap((t) =>
      t.toolCalls.map((c) => c.args).filter((a): a is string => Boolean(a)),
    )
    if (args.length > 0) this.#evidence.set(p.id, [...(this.#evidence.get(p.id) ?? []), ...args])
    this.#turnsConsumed.set(p.id, snap.turns.length)
  }

  /**
   * A human message. Addressed to one participant or all, and recorded either way.
   *
   * Not delivered as a turn — it is queued as context the next exchange carries, so a
   * constraint does not consume a turn of its own.
   */
  #pending = new Map<string, string[]>()
  /**
   * The same queue in the operator's own words, for display.
   *
   * `#pending` holds enveloped text — rank header and all — which is what a participant
   * must receive and not what a human wants read back to them.
   */
  #pendingRaw = new Map<string, string[]>()

  /** What is queued for delivery at the next exchange, per participant. */
  pending(): { id: string; texts: string[] }[] {
    return [...this.#pendingRaw]
      .filter(([, texts]) => texts.length > 0)
      .map(([id, texts]) => ({ id, texts: [...texts] }))
  }
  /** Conflicts the human has already ruled on, so continuing does not re-raise them. */
  #adjudicated = new Set<string>()

  /**
   * Restricted human messages, and what can be traced to each. Only these can produce an
   * authority conflict: an instruction everyone saw cannot be reversed by someone who
   * could not see it.
   */
  readonly restrictedOrigins: RestrictedOrigin[] = []
  /**
   * What each ROOT looked like when the last restricted message was delivered, keyed by root.
   *
   * A map rather than one list, because at N>1 there is no single tree for "the tree at the
   * origin" to mean. Participants that share a root share one entry -- which is every
   * participant at N=1, so the map has exactly one key there and holds exactly the list the
   * single field used to hold.
   *
   * Only the roots of the INFORMED recipients are snapshotted. A root nobody was told about is
   * a root whose changes cannot have come from this message, and taking the snapshot anyway
   * would be scanning another seat's tree for artifacts that are not its business.
   */
  #treeAtOrigin: Map<string, string[]> | undefined

  say(text: string, audience: Audience = 'all', kind: MessageKind = 'constraint'): RelayMessage {
    const to = this.#resolve(audience)
    const m = this.#record({ from: 'human', fromRank: 'human', to, kind, text })
    if (m.visibility === 'restricted') {
      this.restrictedOrigins.push(originOf(m))
      // Snapshot each root a recipient works in, so paths appearing after this message can be
      // attributed to it. One entry per DISTINCT root: two participants in the same checkout
      // are looking at the same tree, and diffing it twice would say so twice.
      this.#treeAtOrigin = new Map()
      for (const id of to) {
        const root = this.#rootOf(id)
        if (!this.#treeAtOrigin.has(root)) this.#treeAtOrigin.set(root, dirtyPaths(root))
      }
      // And mark where each recipient's evidence stands, so attribution reads only the
      // tool calls made AFTER the message — work done before it cannot have come from it.
      for (const id of to) this.#evidenceAtOrigin.set(id, (this.#evidence.get(id) ?? []).length)
    }
    for (const id of to) {
      const queue = this.#pending.get(id) ?? []
      queue.push(envelope({ from: 'human', fromRank: 'human', kind, text }))
      this.#pending.set(id, queue)
      const raw = this.#pendingRaw.get(id) ?? []
      raw.push(text)
      this.#pendingRaw.set(id, raw)
    }
    return m
  }

  /**
   * Tell a participant that the human resolved a conflict in favour of proceeding.
   *
   * Human rank, because that is what it is: the human was shown both sides and chose. It
   * is deliberately NOT registered as a restricted origin — an adjudication is not work,
   * so nothing can later be detected as reversing it, and one conflict cannot breed
   * another.
   */
  #adjudicate(participantId: string, originSeq: number): void {
    const text =
      `I have seen both my earlier restricted instruction (#${originSeq}) and the advisor's ` +
      `instruction to reverse it, and I am allowing the advisor's instruction to proceed. ` +
      `This is my decision with both in view, not the advisor overriding me.`
    this.#record({ from: 'human', fromRank: 'human', to: [participantId], kind: 'constraint', text })
    const queue = this.#pending.get(participantId) ?? []
    queue.push(envelope({ from: 'human', fromRank: 'human', kind: 'constraint', text }))
    this.#pending.set(participantId, queue)
    // Deliberately not in `#pendingRaw`: an adjudication the orchestrator wrote is not
    // something the operator typed, and reading it back to them as "queued" would be a lie.
  }

  #drain(id: string): string {
    const queue = this.#pending.get(id) ?? []
    this.#pending.set(id, [])
    this.#pendingRaw.set(id, [])
    return queue.join('\n\n')
  }

  /**
   * Run the session. Returns why it stopped.
   *
   * The relay itself decides nothing beyond the advisor-turn budget: DONE and ESCALATE are the
   * advisor's calls, and both hand back to the human rather than being acted on. §7a's
   * rotation and termination authority is not implemented here.
   */
  /**
   * Attribute paths that appeared since a restricted message to that message.
   *
   * Two conditions, not one. A path must have become dirty since the aside — `git status`
   * is the only thing that knows that — AND be named by a tool input from a participant
   * that actually received the aside. The second is what makes this attribution rather
   * than a repository diff: a colleague editing in the same checkout dirties paths that
   * no participant's tool calls mention, and those are now dropped.
   *
   * Still coarse, and still never asserts intent. It claims the participant touched the
   * path, not that it meant to, and not that the aside is why.
   */
  /**
   * The evidence line that says whether a quiet child is working or idle.
   *
   * Appended to a `turn_incomplete` pause because it is the fact that decides what the
   * operator should do, and until now every one of them left to fetch it from `ps` by hand
   * -- three times in one day, across two projects, one of whom still chose wrong and lost a
   * run (#43, #45).
   *
   * Best effort by construction. An adapter with no single child to name returns nothing and
   * the pause reads exactly as it did before; a sampling failure is not worth sinking a
   * pause a human is waiting on.
   *
   * Returns the MEASUREMENT and not just the sentence, because the sentence has to be written
   * again -- `#refreshPauseLiveness` re-renders this same line every interval, and a caller
   * holding only prose could not tell which of the pause's evidence lines was its to rewrite.
   */
  async #measureLiveness(
    p: RelayParticipant,
    emittedBefore: number,
    refresh: LivenessRefreshState,
  ): Promise<{ line: string; sample: ChildLiveness; reading: LivenessReading; emitted: number } | undefined> {
    const pid = p.session.childPid
    if (pid === undefined) return undefined
    try {
      const sample = await (this.#opts.liveness ?? sampleLiveness)(pid)
      // Counted NOW against the origin the turn recorded, not carried over from the last
      // reading. Both halves of the line then date from the same moment, which is the rule the
      // `/continue` guard already follows by passing no count at all rather than a stale one.
      const emitted = p.events.length - emittedBefore
      const line = describeLiveness(sample, emitted, refresh)
      // The count travels with the reading so a caller that has to write the sentence AGAIN can
      // write the same one. `#suppressedIncomplete` is that caller: it renders this reading with
      // no refresh state, because a line promising to be re-measured while the pause lasts would
      // be promising it for a pause that is not being raised.
      return { line, sample, reading: readingOf(sample), emitted }
    } catch {
      return undefined
    }
  }

  /**
   * What the last restricted message can be shown to have caused, in ONE participant's tree.
   *
   * The reporter is passed in rather than assumed, and everything below is scoped to the root
   * that reporter works in:
   *
   *   - the CANDIDATES come from that root and no other. Diffing the integration checkout for a
   *     seat's artifacts would attribute another seat's merge to this seat's aside, and would
   *     miss everything the seat actually wrote, since uncommitted work in a linked worktree is
   *     invisible everywhere else.
   *   - the EVIDENCE comes only from informed participants sharing that root. An excluded
   *     participant could not have acted on the message -- that rule is unchanged -- and an
   *     informed one working in a DIFFERENT tree cannot have caused a path in this one.
   *   - the SEAT is recorded when the root is a seat's own worktree, because then the tree
   *     itself names the actor. On a shared root it is `null` and the confidence stays what it
   *     has always been.
   *
   * At N=1 every participant shares `opts.cwd`, so the candidate set and the evidence set are
   * the ones this produced before there were roots to distinguish, and every attribution is
   * `seat: null` / `reasoned_but_unverified`. Nothing about the default run is upgraded: a
   * shared checkout does not learn who wrote a file because the code got more careful.
   */
  #attributeArtifacts(reporter: RelayParticipant): void {
    const origin = this.restrictedOrigins.at(-1)
    if (!origin || !this.#treeAtOrigin) return
    const root = this.#rootOf(reporter.id)
    const snapshot = this.#treeAtOrigin.get(root)
    // No snapshot for this root means nobody working here was told, so there is no baseline to
    // diff against and nothing here can be traced to the message.
    if (!snapshot) return
    const before = new Set(snapshot)
    const candidates = dirtyPaths(root).filter((p) => !before.has(p))
    if (candidates.length === 0) return

    const evidence = evidenceForRoot(
      origin.informed,
      (id) => this.#rootOf(id),
      root,
      (id) => (this.#evidence.get(id) ?? []).slice(this.#evidenceAtOrigin.get(id) ?? 0),
    )
    const seat = root === this.#opts.cwd ? null : reporter.id
    for (const path of attributable(candidates, evidence)) {
      recordAttribution(origin, { path, support: supportFor(path, evidence), seat })
    }
  }

  /**
   * A point where a human is meant to decide.
   *
   * Attended and unattended runs differ here and nowhere else. `start()` suspends the loop
   * holding everything it had; `run()` has already committed to returning an outcome, so
   * the same point escalates and ends. Both record the same note, because the evidence for
   * the decision should not depend on who is watching.
   */
  async #halt(
    handle: RunHandle | undefined,
    p: {
      /**
       * The condition and the evidence its scope is computed from -- not its reason alone.
       *
       * A caller says what its condition is ABOUT; `resolutionFor` says who may resolve it
       * and what it stops. Taking the reason from here rather than as a separate field is
       * what makes it impossible for a pause's reason and its classification to disagree.
       */
      subject: ResolutionSubject
      detail: string
      evidence: string[]
      /**
       * The seat whose child to measure, and the origin its output count is taken from.
       *
       * The MEASUREMENT is made here rather than by the caller, which is a move inward: the
       * three call sites used to append `await this.#livenessEvidence(...)` to their own
       * evidence arrays, so each one knew where in that array the liveness line had landed and
       * none of them wrote it down. Refreshing a line means rewriting it in place, and a
       * position nobody records is a position nobody can rewrite. This is also the one place
       * every pause passes through, which is the argument `#halt` already makes for itself.
       */
      liveness?: { participant: RelayParticipant; emittedBefore: number }
      conflict?: AuthorityConflict
      verdictOf?: { participant: string; endSeq: number }
      superseded?: PauseSupersession
      /**
       * Remember the answer, and do not put the same question twice. See `#incompleteAnswered`.
       *
       * Only the `turn_incomplete` sites pass it. `seat` is the participant whose session the
       * answer is about -- the same object `liveness` names, and the latch needs the OBJECT
       * rather than the id so it can tell an operator who declined from one who rotated and
       * then resumed. `outcome` is the verdict outcome, which is half the signature; the other
       * half is the liveness reading, and that is measured below rather than passed in.
       */
      latch?: IncompleteLatch
    },
  ): Promise<RunOutcome | undefined> {
    const reason: PauseReason = p.subject.reason
    /**
     * The seat `rotate` would act on, if it is offered.
     *
     * The condition's own subject, because a pause about `implementer-2` that offered to rotate
     * `implementer` would be a menu describing the API rather than the situation -- the exact
     * fault the paragraph below is about, one seat over. A pause about no seat at all falls back
     * to the lead, which at N=1 is the only seat and at N>1 is why `rotatable` refuses.
     */
    const target = 'participant' in p.subject ? p.subject.participant : p.verdictOf?.participant
    const rotationSeat = target ?? this.#opts.implementer.id
    // Rotation checks are the operator pre-delegating rotation authority (D2), and they are
    // read here rather than passed in: a condition that could declare its own authority
    // would eventually declare the wrong one. Read for the SEAT this pause is about, since a
    // per-seat policy can arm or disarm one seat without the others (D7, #78).
    const armed = (rotationFor(this.#opts.rotation, rotationSeat)?.checks.length ?? 0) > 0
    const resolution = resolutionFor(p.subject, { rotationArmed: armed })
    // Every request that reaches here must have somebody routed to answer it. Total today --
    // every authority falls back to the operator -- so this cannot throw and changes nothing.
    // It is here rather than with the routing it guards because this is the one place every
    // pause passes through, and because the day a `mechanical` authority is wired to a
    // resolver that does not exist, the alternative to throwing is silence.
    actorFor(resolution)
    // Measured BEFORE the `paused` note, and still only where somebody is attending. The
    // unattended run pays nothing, exactly as it did when this sat below the branch: `#end`
    // takes a reason and a detail, and the evidence array never reached it, so a reading taken
    // for an unattended halt was the better part of a second of `ps` thrown away.
    //
    // What moved it up is the latch below, which needs the reading to know whether this is a
    // question the operator has already answered -- and the note must not say `paused` for a
    // pause that is then not put. Nothing records between here and there, so the note's place
    // in the log relative to everything else is unchanged.
    //
    // `{ count: 0 }` is the honest opening state now that the sample is only taken where a
    // refresher will follow it: the line says it is re-measured while the pause lasts, and it
    // is. Rendering that sentence for a run about to end would have promised updates from a
    // loop that was never going to exist.
    // The run ended while this halt was being assembled, which `relay.stop()` can do at any point
    // the loop is not inside an await it owns (#142). There is nobody to put a question to and
    // nothing that could answer it, so the halt is abandoned before it does anything at all.
    //
    // FIRST, ahead of the liveness sample and the latch, and that placement is the correction an
    // independent review asked for. Measuring samples a participant `stop()` has just closed, and
    // `#forgetIncompleteAnswer` discards an answer the operator gave about a situation nobody is
    // going to be asked about again -- both on a run that is already over. Neither reopens state
    // or the ledger, so nothing was WRONG afterwards, but teardown that still reaches into a
    // torn-down seat is not teardown, and the latch it clears belongs to #107's record.
    //
    // It also stands ahead of the `paused (...)` routing-log note, which is why the guard is
    // worth having on top of the one in `RunHandle.pauseAt`: that note is the log's account of a
    // decision point a human was at, and writing one for a pause that is then not raised makes
    // the log describe a moment that never existed. A note with no pause under it is worse than
    // a gap to someone reconstructing what the operator saw. Nothing awaits between here and
    // `pauseAt`, so the check cannot go stale.
    if (handle?.state === 'ended') return handle.outcome ?? this.#end('stopped')

    const measured =
      handle && p.liveness
        ? await this.#measureLiveness(p.liveness.participant, p.liveness.emittedBefore, { count: 0 })
        : undefined
    if (handle && p.latch) {
      if (measured && this.#incompleteAnswered(p.latch, measured.reading)) {
        this.#suppressedIncomplete(p.latch, measured, p.detail)
        return undefined
      }
      // Seen, and it is not what was answered. The remembered answer is void from HERE, before
      // the pause is even raised, and this is the ONLY place anything forgets one -- see
      // `#forgetIncompleteAnswer`. Holding it until the new answer arrives would let a seat
      // oscillating A -> B -> A match it again on the way back, which is a child behaving oddly
      // being asked about LESS rather than more.
      //
      // An unmeasurable child lands here too, and belongs here: "the character has not changed"
      // is a claim, and a run that cannot take a reading cannot make it.
      this.#forgetIncompleteAnswer(p.latch)
    }
    this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `paused (${reason}): ${p.detail}` })
    if (!handle) {
      return this.#end(
        'escalated',
        `${p.detail} Nobody is attending this run, so it ends here — use relay.start(goal) ` +
          `to pause at this point and decide instead.`,
      )
    }
    const evidence = measured ? [...p.evidence, measured.line] : p.evidence
    // Not awaited yet. `pauseAt` installs the pause and flips the handle to `paused`
    // synchronously, and only the promise it returns is the suspension -- so reading
    // `handle.pause` here gets the very object the operator will be handed, before anything
    // can act on it. Emitting from the argument object instead would announce a pause that
    // is equal to the operator's and not the same as it, and `supersede()` mutates in place.
    // Only the options that would actually DO something.
    //
    // The list used to be four constants, documented as "descriptive: the methods exist
    // regardless" -- so it described the API rather than the situation. An operator whose
    // ADVISOR had gone silent was offered `rotate`, chose it, and got nothing: rotation
    // replaces the implementer, always, and their implementer was fine. Reported from
    // another project, which discovered the no-op only by reading `rotations` in the status
    // JSON afterwards. A menu that lists an inert choice is worse than a short menu, because
    // picking it costs a turn and teaches nothing.
    //
    // Everything needed was already on the pause: `verdictOf` names the seat whose verdict
    // this rests on, and the relay knows whether rotation is armed.
    const implIds = new Set(this.#implementers().map((x) => x.id))
    const aboutImplementer = p.verdictOf === undefined || implIds.has(p.verdictOf.participant)
    // And `rotate` only where it names something. Since #78 that is a wider set than it was:
    // rotation replaces a NAMED seat, so a pause about a seat can offer it at any N, and only a
    // pause that names no seat in a run with several still has no seat it could mean. The latch
    // takes it away again -- offering a rotation that has already been shown to be unable to
    // pass is the inert choice this list exists to keep out, and it costs a turn to discover.
    const rotatable = implIds.has(rotationSeat) && this.#rotationUnobservable === undefined
    const options: PauseOption[] = ['continue', 'constrain', 'abort']
    if (armed && rotatable && aboutImplementer) options.splice(1, 0, 'rotate')
    // The seat the handle's `rotate` will act on, set alongside the option that offers it. The
    // handle is built once per run and a pause is per condition, so the target cannot travel on
    // the closure that made the handle.
    this.#rotationSeat = rotatable ? rotationSeat : undefined
    // `wait` only where it is the right answer: the child is measurably alive, so the turn
    // is still happening and every other option is destructive. Offering it always would
    // invite waiting on a child that has already exited, which is a decision to sit
    // indefinitely on something that will never arrive.
    //
    // The evidence carrying the liveness reading is the same one the operator reads, so the
    // option and the reason cannot disagree; `reportsChildOnCpu` says which readings count (#83).
    if (evidence.some(reportsChildOnCpu)) options.splice(1, 0, 'wait')

    const deciding = handle.pauseAt({
      reason,
      resolution,
      detail: p.detail,
      evidence,
      options,
      ...(p.conflict === undefined ? {} : { conflict: p.conflict }),
      ...(p.verdictOf === undefined ? {} : { verdictOf: p.verdictOf }),
      ...(p.superseded === undefined ? {} : { superseded: p.superseded }),
      ...(measured === undefined || p.liveness === undefined
        ? {}
        : {
            liveness: {
              participant: p.liveness.participant.id,
              index: evidence.length - 1,
              sample: measured.sample,
              reading: measured.reading,
              firstAt: measured.sample.measuredAt,
              refreshes: 0,
            },
          }),
      atSeq: this.#seq,
    })
    // Set by the line above; nothing runs between the two that could clear it -- with the one
    // exception the guard above already returned on, an ended handle, which `pauseAt` refuses to
    // install a pause on. Read as a value rather than asserted non-null so that a future ending
    // this method has not been taught about is an ordinary unwind instead of a crash on `!`, and
    // so the emit and the refresher below cannot be handed a pause that does not exist.
    const pause = handle.pause
    if (!pause) return handle.outcome ?? this.#end('stopped')
    // Which session is in the seat right now, read before the operator can change it. #118 needs
    // the same fact for the same reason: an operator who ROTATED and then resumed did not answer
    // a question about this evidence, they replaced the thing the evidence was about, and
    // remembering that as an answer would silence the first pause raised against a new session.
    const answering = p.latch?.seat.session
    this.#stream.emit({ type: 'pause', pause })
    // Started here and stopped in the `finally`, so its lifetime is exactly the suspension.
    // Nothing else in this method may return between the two.
    const refreshing =
      p.liveness && pause.liveness
        ? this.#refreshPauseLiveness(handle, pause, p.liveness.participant, p.liveness.emittedBefore)
        : undefined

    let decision: Decision | undefined
    try {
      decision = await deciding
    } finally {
      refreshing?.stop()
    }
    // Nobody decided: the run was ended out from under the question -- `relay.stop()`, which is
    // what a console reaching the end of a piped stdin does. The handle has already been settled
    // by whoever ended it, so its outcome is the run's outcome and this returns THAT rather than
    // deriving a second one: a run torn down after a ceiling had already ended it must not be
    // re-reported as `stopped` on the way out of a pause it never left (#142).
    //
    // Nothing else happens on this path, and each omission is the same omission. No `resume`,
    // for the reason the abort below gives. No `#armIncomplete`, because arming remembers an
    // ANSWER against evidence, and the whole content of this case is that there was none -- a
    // latch set here would silence the first pause of the next run on the strength of a question
    // nobody read. The `finally` above has already stopped the refresher.
    //
    // `#end('stopped')` only as a backstop: the handle is settled before the pause is released,
    // so `outcome` is present by construction, and a settle that somehow did not happen still
    // has to return an outcome rather than a hole.
    if (decision === undefined) return handle.outcome ?? this.#end('stopped')
    // No `resume` on an abort. The run does not continue, and `run_end` is what says so --
    // a resume followed immediately by the end would read as a session that carried on.
    if (decision.kind === 'abort') return this.#end('stopped', decision.detail)
    // Before the note, so the two events bracket the suspension itself as tightly as the
    // loop can see it; the note is the log's account of the same moment.
    this.#stream.emit({ type: 'resume', pause })
    this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `resumed from ${reason}` })
    // The answer is remembered on the reading the operator was LAST SHOWN, not on the one the
    // pause opened with. `#refreshPauseLiveness` rewrites that block while they decide, and a
    // child that went quiet mid-decision is what they answered about -- latching the opening
    // `working` there would silence a later working pause on the strength of a reading nobody
    // saw. `#armIncomplete` takes it from there, and remembers nothing but a live child.
    if (p.latch && p.latch.seat.session === answering) {
      // The verdict as it stands NOW, not the one the pause opened with. `#trackSupersession`
      // amends a pause in place while the operator reads it -- a `timed_out` withdrawn and
      // replaced with `completed`, or with a different fault -- and the answer they gave was
      // about what they were last shown, exactly as the reading is. Arming the original outcome
      // let an operator who answered "the turn finished, carry on" arm `timed_out`, so the next
      // genuine timeout was suppressed on the strength of an answer about a turn that had ended.
      //
      // `completed` needs no special case: the check site is only reached for a verdict that did
      // NOT complete, so a signature built on `completed` can never match and the pause is left
      // effectively unarmed -- the right answer for an operator told the turn resolved itself.
      // Raised by an independent review.
      this.#armIncomplete(
        p.latch,
        pause.superseded?.verdict?.outcome ?? p.latch.outcome,
        pause.liveness?.reading ?? measured?.reading,
      )
    }
    return undefined
  }

  /**
   * Keep a paused run's liveness evidence measured rather than remembered.
   *
   * ## What was actually wrong
   *
   * A pause captured one reading of the child and then served it, unchanged, for as long as the
   * pause lasted. `conclave status --json` was the only thing an agent operator had, and it kept
   * saying `is still working (cpu 3.3%, 5.1%, 3.5%) — 18 event(s) since the prompt was sent`
   * about a child that had since settled to 0.2% with its turn over. The operator waited out a
   * finished turn twice in one day and then aborted a run they could have continued (#101).
   *
   * The reporter also believed a SECOND pause had replayed the first one's samples, from the
   * byte-identical line appearing minutes apart. That part is not what happened, and it is worth
   * writing down because it points at a different mechanism: the loop is suspended at `await
   * deciding` above for the whole pause, so `#halt` cannot run again, and a watchdog `revision`
   * or replacement `turn_end` arriving meanwhile goes to `#trackSupersession`, which amends THE
   * SAME `RunPause` in place (`src/relay/run.ts:747`). There was one pause, read twice. The
   * evidence was not re-derived because nothing had re-derived it since it was captured -- which
   * is the same defect, reached by a shorter path than the report proposed.
   *
   * ## Why a refresh here and not a re-sample on read
   *
   * The issue's first suggestion was to re-sample when `status` is read. `conclave status` is a
   * separate short-lived process reading `status.json` off disk; it holds no `RunHandle`, and the
   * child pids it would have to sample are never written to that file. Re-sampling on read means
   * first publishing per-seat child pids, then having every reader shell out to `ps` -- so the
   * measurement would be made by whoever happened to look, on a machine that may not be the one
   * the child is on. The orchestrator owns the pty and already knows the pid. It measures.
   *
   * ## Bounded, and loudly so
   *
   * `LIVENESS_REFRESH_LIMIT` re-measurements and then it stops. The bound is not the interesting
   * part; SAYING SO is. A refresher that fell silent at its limit would leave the operator with a
   * number that looks live and is not, which is precisely #101 with extra machinery. So the last
   * refresh writes `final` into the line and into `pause.liveness`, and from then on the reading
   * advertises that it only ages.
   *
   * ## What this does NOT do
   *
   * It does not decide anything, and `/continue` does not read it. That guard samples the child
   * itself at the instant of the decision, because continuing SENDS into whatever is there and a
   * reading up to `LIVENESS_REFRESH_EVERY_MS` old is not a reading of now. The conservative
   * refusal from #43 is untouched; this makes the evidence beside it honest about its age, which
   * is a different job (see `resumeRun` in `src/repl/session.ts`).
   */
  #refreshPauseLiveness(
    handle: RunHandle,
    pause: RunPause,
    participant: RelayParticipant,
    emittedBefore: number,
  ): { stop(): void } {
    const everyMs = this.#opts.livenessRefreshMs ?? LIVENESS_REFRESH_EVERY_MS
    const limit = this.#opts.livenessRefreshLimit ?? LIVENESS_REFRESH_LIMIT
    /**
     * The session the first reading was of.
     *
     * `rotate` is an option ON a pause and does not resolve it, so a seat can be replaced while
     * this loop is running: `#rotate` swaps `p.session` and splices the audition's events onto
     * the front of the seat's own. Sampling on would then measure the REPLACEMENT's child and
     * count events belonging to two different children against one origin -- a reading about
     * nothing that ever existed. There is no honest refresh of a measurement whose subject is
     * gone, so it stops and says the seat was replaced.
     */
    const measuredSession = participant.session
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const stop = (): void => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
    /**
     * Whether there is still anything to measure for.
     *
     * `handle.pause !== pause` is the ordinary case: the operator decided while a sample was in
     * flight. It now also covers teardown, because `relay.stop()` settles the handle and
     * `settle()` clears the pause -- so this predicate is true the instant the run ends, and the
     * `finally` that calls `stop()` runs a moment later as the released `#halt` unwinds (#142).
     *
     * `#stream.closed` is kept, and is no longer the only thing standing between a stopped run
     * and a timer sampling a closed session's pid for the rest of its bound -- half an hour past
     * teardown, emitting into a stream that counts refusals as an alarm. It was written when
     * `stop()` left the pause parked forever, and it is retained as the check that does not
     * depend on the handle at all: `#end` closes the stream on EVERY ending, including the ones
     * an unattended run reaches with no handle to settle.
     */
    const over = (): boolean => stopped || handle.pause !== pause || this.#stream.closed
    const tick = async (): Promise<void> => {
      if (over()) return stop()
      const block = pause.liveness
      if (!block) return stop()
      const replaced = participant.session !== measuredSession
      const count = replaced ? block.refreshes : block.refreshes + 1
      const last = replaced || count >= limit
      const state: LivenessRefreshState = last
        ? {
            count,
            final: replaced
              ? `${participant.id}'s session was replaced, so there is no longer a child this reading is about`
              : `re-measuring has reached its limit of ${limit}`,
          }
        : { count }
      // The seat is gone: say so on the existing reading rather than measuring a stranger.
      const measured = replaced ? undefined : await this.#measureLiveness(participant, emittedBefore, state)
      if (over()) return stop()
      // A sampling failure keeps the previous READING rather than blanking it: a pause a human
      // is deciding at is not improved by losing the line it was deciding on. The line is still
      // rewritten, from that same unchanged sample, so its refresh state stays true -- the first
      // version only rewrote on success, which meant a `ps` that failed every time walked to the
      // bound with `final` set in the JSON and a line still promising updates. That is #101 with
      // a flag nobody reads, and it is worth more care than the failure itself: the prose is what
      // an operator acts on, and the fact beside it is what an agent acts on, so the two
      // disagreeing is worse than either being stale.
      if (measured) {
        block.sample = measured.sample
        block.reading = measured.reading
      }
      pause.evidence[block.index] = measured?.line ?? describeLiveness(block.sample, undefined, state)
      block.refreshes = count
      if (last) block.final = state.final
      // `wait` recomputed with the line it is justified by. It is offered when the evidence
      // reports a child with something on the CPU, and that evidence now MOVES -- so a menu
      // decided once at raise time would drift away from the reason for it, which is the exact
      // coupling `reportsChildOnCpu` exists to prevent (#83). Both directions matter: a pause
      // raised on an idle child that has since started working must offer the non-destructive
      // option, and one raised on a working child that has since gone must stop advertising a
      // wait for something that will never arrive.
      //
      // Only `wait`. Every other option turns on configuration and authority, which a CPU
      // sample says nothing about.
      const shouldWait = pause.evidence.some(reportsChildOnCpu)
      const offered = pause.options.indexOf('wait')
      if (shouldWait && offered === -1) pause.options.splice(1, 0, 'wait')
      else if (!shouldWait && offered !== -1) pause.options.splice(offered, 1)
      // The status file is written from the LIVE pause object on any event, so an in-place
      // change reaches disk on the next one -- and a pause is precisely when nothing else is
      // flowing. Same reasoning as `/wait` in the console (`src/repl/session.ts:2113`), and the
      // reader who needs it most is the one polling from outside.
      this.#stream.emit({ type: 'liveness', pause })
      if (last) return stop()
      schedule()
    }
    const schedule = (): void => {
      if (over()) return
      // Rescheduled after each reading rather than on an interval: a sample costs the better
      // part of a second, and an interval shorter than a slow `ps` would stack ticks.
      timer = setTimeout(() => void tick(), everyMs)
      // Nothing here should keep the process alive. A paused run is held open by the operator,
      // not by its own diagnostics.
      timer.unref()
    }
    // A limit of zero means off, and it has to be checked HERE rather than in the tick: the
    // bound is tested after a reading has been taken, so a zero that reached the timer would
    // take exactly one measurement and then announce it had reached a limit of none.
    if (limit > 0) schedule()
    return { stop }
  }

  /**
   * Start a run you can hold onto.
   *
   * The supervised form. Pauses suspend the loop rather than ending it, so a rotation
   * candidate is a decision point rather than a dead end -- see `run.ts` for why restarting
   * `run()` is not the same as resuming.
   */
  start(goal: string): RunHandle {
    const handle = new RunHandle(
      {
        // The seat the CURRENT pause is about, which is the one the operator is looking at. With
        // no pause in front of them there is no seat named, and the unnamed form's own rule
        // applies: the lead at N=1, refused at N>1.
        rotate: (reason) =>
          this.#rotationSeat === undefined
            ? this.rotateImplementer(reason)
            : this.rotateSeat(this.#rotationSeat, reason),
        // The same seat, exposed so the handle can ask whether a reason has to be STATED before
        // it starts a transaction (#75). It is a read of `#rotationSeat` rather than a second
        // derivation from the pause, because a front end that resolved the target differently
        // from the `rotate` above would demand a reason for one seat and rotate another.
        rotationTarget: () => this.#rotationSeat,
        constrain: (text, audience) => this.say(text, audience),
        requestStop: () => {
          this.#stopped = true
        },
        requestPause: (reason) => {
          this.#pauseRequested = reason
        },
      },
      // The handle's suspension ledger is subtracted from this relay's elapsed reading, so the
      // two have to be taken from the same clock. See `RelayOptions.now`.
      { now: () => this.#now() },
    )
    // Kept so `rotateSeat` can read the pause the operator is actually looking at, which is
    // what classifies a rotation's intent (#75). The handle is the only thing that holds it:
    // `#halt` hands the pause object to `pauseAt` and then suspends inside an await, so there
    // is no relay-side field to consult and duplicating one would give two answers about a
    // single decision. `handle.pause` is `undefined` once the operator answers, which is
    // exactly when a rotation is no longer an answer to that question.
    this.#handle = handle
    // The settle is part of what `stop()` waits for, not just the loop body: a caller that has
    // awaited `stop()` and then reads `run.state` must not be reading it a tick early.
    this.#looped = this.#loop(goal, handle).then(
      (outcome) => handle.settle(outcome),
      // Retained as a backstop only. #loop now converts a throw into a `transport_failed`
      // outcome, so this fires only for something #loop itself could not handle.
      (err: Error) => handle.settle(this.#end('transport_failed', `the run threw: ${err.message}`)),
    )
    void this.#looped
    return handle
  }

  /**
   * Should this implementer be replaced?
   *
   * Called every advisor turn, because a session may compact without saying so and a session
   * that says so may not have. Returns a run-ending verdict when the answer needs a human,
   * and `undefined` when the run should carry on -- either because nothing is wrong or
   * because the rotation succeeded and there is now a fresh implementer to carry on with.
   */
  async #considerRotation(
    impl: RelayParticipant,
    prose: string,
    handle: RunHandle | undefined,
  ): Promise<RunOutcome | undefined> {
    const snap = await impl.session.snapshot()
    /**
     * A generation nobody could re-read does not start a rotation.
     *
     * `snapshot()` on both adapters is contained: when the transcript will not answer it hands
     * back the last projection the view was in a position to build, flagged `containedFallback`,
     * rather than rejecting. That is right for the consumers that are DESCRIBING a session, and
     * this is not one of them. `compactionGeneration` is the mechanical evidence that the
     * participant lost context, and this is the code that ACTS on it -- it quiesces a working
     * session, spends an advisor handoff turn and starts a replacement. `rotation/rotate.ts`
     * already refuses to write an unverified generation into the handoff record; this is the
     * other half of the same rule, and without it a rotation could still be STARTED by the
     * number the handoff would then decline to record.
     *
     * Only the SNAPSHOT channel is withheld. `detectDegradation` reads two independent things,
     * and a `revision` event is a live signal that already arrived -- it does not become
     * doubtful because a later read of the file did not answer. So the events still speak for
     * themselves, and what is suppressed is the generation comparison alone. Handing `assess`
     * the baseline as the current generation is how that is said: no delta, so no evidence from
     * this channel, and every other input to the verdict is untouched.
     *
     * The evidence is DEFERRED, not discarded. Nothing on this path moves the baseline, so the
     * same generation is weighed again next advisor turn, and the first turn whose read succeeds
     * raises the candidate that was withheld here. The cost of being wrong is lateness; the cost
     * of the opposite was rotating a working session on a number nobody read.
     */
    const unverified = snap.containedFallback === true
    // Withheld only where it would have MATTERED. A fallback whose generation is still the
    // baseline has nothing to withhold, and a note on every turn of a wedged transcript is noise
    // an operator learns to scroll past -- which is how a record stops being read at all.
    const withheld = unverified && snap.compactionGeneration > impl.baselineGeneration
    // Counted before the decision, so the tally proves the detector RAN regardless of what
    // it concluded. That is the whole point: a zero here means "looked and saw nothing",
    // and its absence would mean "never looked".
    this.rotationWatch.assessments += 1
    // NOT gated on `unverified`. This is a high-water mark of what has been observed, not an
    // input to a decision. A stale fallback's number was read at some point; a NEVER-read's was
    // not, and is a synthesized zero -- which is safe here only because zero cannot raise a
    // high-water mark. It would not be safe in anything that averaged or counted. The generation
    // only ever rises (`reconcile.ts` takes `max(0, ...)` fresh markers), so the peak cannot be
    // overstated by a stale reading. An operator seeing a peak here with no candidate against it
    // is seeing exactly the condition the note below explains.
    this.rotationWatch.peakGeneration = Math.max(
      this.rotationWatch.peakGeneration,
      snap.compactionGeneration,
    )
    const verdict = assess({
      participant: impl.id,
      prose,
      baselineGeneration: impl.baselineGeneration,
      currentGeneration: unverified ? impl.baselineGeneration : snap.compactionGeneration,
      events: impl.events.slice(impl.degradationCursor),
      ledger: this.complaints,
      at: Date.now(),
    })

    if (verdict.degraded) this.rotationWatch.degradationsSeen += 1
    if (verdict.complained) this.rotationWatch.complaintsSeen += 1

    // Recorded before the branches, so it is written whatever the verdict turns out to be. The
    // usual outcome is that nothing else fires and this note is the ONLY trace that a compaction
    // signal was seen and set aside -- so it has to name the number, the baseline it was measured
    // against, and the reason it did not count, or an operator reading the log afterwards cannot
    // tell a withheld candidate from one that was never raised.
    if (withheld) {
      this.#record({
        from: 'orchestrator',
        fromRank: 'human',
        to: [],
        kind: 'note',
        text:
          `${impl.id}: compaction generation ${snap.compactionGeneration} (baseline ` +
          `${impl.baselineGeneration}) was NOT counted as rotation evidence -- the snapshot is a ` +
          `contained fallback, the last projection the view could build rather than a read taken ` +
          `just now, so the generation is a claim about a transcript state nobody has confirmed. ` +
          `Rotation consideration is DEFERRED, not declined for good: the baseline is unchanged, ` +
          `so the same generation is weighed again on the next turn whose read answers.`,
      })
    }

    if (verdict.decision === 'continue') {
      if (verdict.reason === 'unbacked') {
        // Overriding a complaint is a decision, so it is recorded as one. The count is
        // scoped and decays; a single early complaint must not read as a pattern.
        this.#record({
          from: 'orchestrator',
          fromRank: 'human',
          to: [],
          kind: 'note',
          // Carries what a retrospective analysis needs, because this note IS the record:
          // the topic it is scoped by, and the generation that proves no compaction sat
          // behind it. See spikes/experiments/04-complaint-as-signal.md — an unbacked
          // complaint is a prediction, and one nobody can score is one nobody can learn
          // from. The seq this record gets is the index the scoring window starts at.
          text:
            `${impl.id} asked for a fresh session with no compaction behind it; continuing. ` +
            `topic: ${topicOf(prose)}; unbacked complaints on this topic: ` +
            `${this.complaints.count(impl.id, topicOf(prose))}; ` +
            `compaction generation ${snap.compactionGeneration} (baseline ${impl.baselineGeneration})`,
        })
      }
      return undefined
    }

    // The evidence is observed; the conclusion drawn from it is not. `detectDegradation` reports
    // COMPACTION -- parsed from the transcript, mechanically checkable. Whether a compacted seat
    // then does worse work is #10, and #10 is still open. Rendering every verdict as
    // "<seat> is degraded" asserted that unanswered thing as fact, in the one place an operator
    // is being asked to decide on it, and did so fifteen lines above a comment saying the link is
    // unestablished (#98). It reached further than a pause: `rotateSeat` below takes this same
    // string as the recorded REASON for a rotation, so the claim outlived the run that made it.
    //
    // So: say what was seen, name what is not known, and leave the weighing to the reader. The
    // decision offered is unchanged -- what changes is that it is no longer offered under a
    // finding the run has no means to support.
    //
    // Switched on `reason` rather than assuming compaction, because a degradation signal that is
    // not compaction must not inherit compaction's wording, nor its caveat, by default.
    const compacted = verdict.reason === 'degraded' || verdict.reason === 'corroborated'
    const said = verdict.complained ? 'and said so' : 'and did not say so'
    // No trailing period: every caller below continues the sentence.
    const detail =
      `${impl.id} ${compacted ? 'compacted' : 'showed a degradation signal'} ${said}: ` +
      `${verdict.evidence.join('; ')}` +
      (compacted
        ? ` — whether compaction predicts degraded work is unestablished (#10), so this is a ` +
          `candidate on what was observed and not a finding about the quality of its work`
        : '')
    // The evidence CLASS, and the whole of what the latch below remembers (#118). Taken from
    // `verdict.reason` rather than recomputed, and taken WHOLE rather than folded into a
    // boolean: `degraded` and `corroborated` are two different questions to put to an operator,
    // and a class this code does not yet know about must not be silently answered by a decision
    // that was made about a different one.
    const cls: Assessment['reason'] = verdict.reason
    // THIS SEAT'S policy: the run's default as amended by its own entry (D7, #78). A seat whose
    // override configures no checks is in the same position as a run that configured none --
    // there is nothing a replacement could reproduce -- so it takes the same branch.
    const cfg = rotationFor(this.#opts.rotation, impl.id)
    if (!cfg || cfg.checks.length === 0) {
      // Detection does not depend on configuration; the response does. Rotating with
      // nothing to verify against would be a transfer nobody demonstrated, so an unarmed run
      // cannot rotate. That is an argument against ROTATING, and it used to be read as an
      // argument for ENDING (#96).
      //
      // Ending here inverted the relationship between confidence and severity. The branch
      // below already says it, about the armed case: "ending a run is the most drastic action
      // available, not a neutral one", and nothing yet shows compaction and degradation
      // coincide (#10) -- so this branch acted hardest on the weakest evidence, and did it
      // where there was least means to check. Observed on oath-lang: a healthy implementer
      // compacted normally, mid-work with 220 insertions and a new test file on disk, and the
      // run was ended under a message that correctly said a human was needed -- while the
      // human was sitting at the console it never asked.
      //
      // A HUMAN-ATTENDED run asks, exactly as the armed one does. The pause carries the fact
      // that makes this pause different: rotation is not among the options, so the decision is
      // to continue or to stop, and arming --checks is what would widen it next time.
      //
      // An AGENT-operated run does not ask, and that is the second half of the same argument
      // (#107). #96 replaced an ending with a question because a human was sitting there and
      // the question cost them a moment. Under `--operator agent` there is no such reader:
      // the only answers on offer are `continue` and `stop and re-run with --checks`, an agent
      // operator cannot re-launch the run it is currently driving, so every one of these
      // pauses resolves to `continue` — and the run pays a full operator round-trip for it.
      // Worse, it recurs. `#acknowledge` moves the baseline so ONE compaction is raised once,
      // but a long implementer compacts repeatedly, and each fresh generation is new evidence
      // that raises the pause again. A run driven by an agent therefore stops, over and over,
      // on the one condition it has no means to act on. Compaction is normal operation for a
      // long session; it must never be what ends or stalls the run.
      //
      // So the agent-operated run takes the same note-and-continue path the unattended one
      // takes, for the same reason and with the same record: the candidate is counted in
      // `rotationWatch`, written to the routing log, and reaches the operator through the
      // summary and `status --json`. Recorded, not acted on -- which is what this branch has
      // claimed to do since #96. A human at the console still gets the pause.
      const why = cfg
        ? `${impl.id}'s own rotation policy configures no checks, so it cannot be rotated`
        : `No rotation checks are configured`
      this.rotationWatch.candidates += 1
      let replaced = false
      if (handle && this.operator !== 'agent' && this.#declined(impl.id).has(cls)) {
        // Asked and answered (#118). See `#suppressedCandidate`.
        this.#suppressedCandidate(impl, cls, detail)
      } else if (handle && this.operator !== 'agent') {
        // Which session is in the seat right now, so the resume below can tell "the operator
        // declined" from "the operator rotated and then resumed". Only the first is a decision
        // about the evidence; the second replaced the thing the evidence was about.
        const answering = impl.session
        const halted = await this.#halt(handle, {
          subject: { reason: 'rotation_candidate', participant: impl.id },
          detail: `${detail}. ${why}, so this cannot be adjudicated — continue, or stop and re-run with --checks.`,
          evidence: verdict.evidence,
        })
        if (halted) return halted
        replaced = impl.session !== answering
        if (!replaced) this.#declined(impl.id).add(cls)
      } else {
        // Nobody to ask, or nobody a question would help. Unattended it carries on for the
        // same reason the armed unattended run does -- there is nobody to ask, and ending is
        // not the neutral thing to do while waiting -- and agent-operated it carries on
        // because the question has no answer that changes anything. The two are named apart
        // in the note, because an operator reading the log afterwards has to be able to tell
        // "nobody was there" from "somebody was there and was deliberately not interrupted".
        this.#record({
          from: 'orchestrator',
          fromRank: 'human',
          to: [],
          kind: 'note',
          text:
            `rotation candidate recorded, run continues ` +
            `(${handle ? 'agent-operated' : 'unattended'}, ` +
            `${cfg ? 'seat has' : 'run has'} no checks to adjudicate with): ${detail}`,
        })
      }
      // Baseline moved either way, so one compaction is raised once. Without this the same
      // generation re-raises on every subsequent turn, which on an unarmed run is now a
      // repeating pause rather than a single fatal one -- a worse failure than the one fixed.
      //
      // Unless the seat was replaced while the question was outstanding (#128): `snap` is the
      // RETIRED session's, and acknowledging it against the replacement would hand a session at
      // generation 0 a baseline of 1.
      return replaced
        ? this.#answeredByReplacement(impl, snap.compactionGeneration)
        : this.#acknowledge(impl, snap.compactionGeneration)
    }
    if (cfg.onDegradation === 'candidate') {
      // A candidate, not a verdict. The mechanism is built and the policy is not earned:
      // nothing yet shows that compaction and degradation coincide, so acting on it would be
      // inferring quality from a proxy that has never been checked against quality.
      //
      // An ATTENDED run stops and asks -- a human is there, and the pause costs a moment.
      //
      // An unattended one records it and CARRIES ON. It used to end, which was invisible
      // while the counter could not move: no unattended run had ever raised a candidate. The
      // moment the counter was fixed, every long unattended run would have stopped at the
      // first compaction -- and ending a run is the most drastic action available, not a
      // neutral one. "Recorded, not acted on" has to mean recorded and not acted on.
      //
      // The count reaches the operator through `rotationWatch` and the summary, which is the
      // whole point of those counters existing.
      this.rotationWatch.candidates += 1
      let replaced = false
      if (handle && this.#declined(impl.id).has(cls)) {
        // Asked and answered (#118). See `#suppressedCandidate`.
        this.#suppressedCandidate(impl, cls, detail)
      } else if (handle) {
        const answering = impl.session
        const halted = await this.#halt(handle, {
          subject: { reason: 'rotation_candidate', participant: impl.id },
          detail: `${detail}. Recorded as a rotation candidate, not acted on.`,
          evidence: verdict.evidence,
        })
        if (halted) return halted
        replaced = impl.session !== answering
        if (!replaced) this.#declined(impl.id).add(cls)
      } else {
        this.#record({
          from: 'orchestrator',
          fromRank: 'human',
          to: [],
          kind: 'note',
          text: `rotation candidate recorded, run continues (unattended): ${detail}`,
        })
      }
      // As above (#128): `snap` describes the session that was in the seat when the question was
      // put, and the operator may have answered it by replacing that session.
      return replaced
        ? this.#answeredByReplacement(impl, snap.compactionGeneration)
        : this.#acknowledge(impl, snap.compactionGeneration)
    }

    // A fault an earlier rotation proved nothing can get past. Declined WITHOUT attempting,
    // which is the point of the latch: acceptance needs an observed turn, that turn travels the
    // transport that is not working, and spending a full transaction -- a quiesce, an advisor
    // handoff turn, a fresh child, two repository captures -- to be told the same thing again is
    // the loop #76 is about. The operator was told once, in the terms that name the remedy; this
    // is recorded rather than re-raised, because a pause every advisor turn on a decision the
    // human has already been handed teaches them to stop reading pauses.
    if (this.#rotationUnobservable) {
      const held = this.#rotationUnobservable
      this.#record({
        from: 'orchestrator',
        fromRank: 'human',
        to: [],
        kind: 'note',
        text:
          `${detail}. Rotation was NOT attempted: an earlier rotation of ${held.seat} could not be ` +
          `accepted because the replacement produced no observable output, so no replacement can ` +
          `pass while that holds and the fix is upstream of rotation. ${impl.id} stays in service.`,
      })
      return this.#acknowledge(impl, snap.compactionGeneration)
    }

    // The seat by name (#78). This used to decline at N>1 -- and before that, to THROW, which
    // `#loop`'s backstop reported as `transport_failed`: a transport fault, for a policy gap
    // (#74). Rotation now replaces the degraded seat's session, in that seat's own worktree,
    // while its siblings keep working; nothing here asks how many seats the run has.
    // `degradation_automatic` stated rather than left to be derived (#75). Nobody is asked on
    // this path -- that is what `onDegradation: 'automatic'` MEANS -- so there is no pause to
    // classify from, and the pause reading would record the one unambiguously proxy-driven
    // rotation in the run as operator-initiated.
    //
    // Through the PRIVATE form, which is the only way to state an intent at all. `rotateSeat` no
    // longer takes one: an embedder able to declare `degradation_automatic` could forge rows
    // into the population #10 treats as the proxy predicting degradation, and forged rows are
    // indistinguishable from evidence. This is the one call site that knows better, and it is
    // inside the class that owns the record.
    const result = await this.#rotateSeatDeclaring(impl.id, detail, 'degradation_automatic')
    // Both outcomes that replaced the seat. `rotated_cleanup_failed` is a successful transfer
    // whose loser could not be confirmed dead, so there is nothing for the loop to decide and
    // nothing to halt for: the seat holds a proven replacement and carries on. The disposal
    // ambiguity is recorded by `#rotateSeatTransaction` and printed in the run report, which is
    // where an operator can act on it -- halting the run over it would stop the work to report
    // a process that may not exist.
    if (result.status === 'rotated' || result.status === 'rotated_cleanup_failed') return undefined
    if (result.reason === 'acceptance_unobservable') {
      // The one rollback that is not an invitation to try again. `rotateSeat` has latched it and
      // recorded the evidence; this puts it in front of the human with the remedy named, because
      // an operator told only "rotation failed" will retry, and retrying is the loop.
      const halted = await this.#halt(handle, {
        subject: { reason: 'rotation_candidate', participant: impl.id },
        detail:
          `rotation could not be accepted and ROTATION IS NOT THE REMEDY: ${result.detail} ` +
          `${impl.id} is back in service and no further rotation will be attempted this run.`,
        evidence: [
          ...verdict.evidence,
          ...(result.evidence ?? []),
          'the original implementer is back in service',
          'a replacement cannot demonstrate itself while the transport it would demonstrate over is not working',
        ],
      })
      return halted ?? this.#acknowledge(impl, (await impl.session.snapshot()).compactionGeneration)
    }
    const halted = await this.#halt(handle, {
      subject: { reason: 'rotation_candidate', participant: impl.id },
      detail: `rotation failed (${result.reason}): ${result.detail}`,
      evidence: [...verdict.evidence, 'the original implementer is back in service'],
    })
    return halted ?? this.#acknowledge(impl, (await impl.session.snapshot()).compactionGeneration)
  }

  /**
   * This evidence has been dealt with. Stop re-raising it.
   *
   * Without this, a candidate re-raises on the very next advisor turn, on the same compaction,
   * forever -- the operator either abandons the feature or stops reading the pauses, and the
   * second is worse. Moving the baseline means a *later* compaction is new evidence and is
   * raised again, which is the distinction that makes the signal worth surfacing at all.
   *
   * Found by three tests hanging rather than by design.
   */
  /**
   * Evidence classes an attended operator has already declined, per seat (#118).
   *
   * `#acknowledge` makes each compaction a NEW piece of evidence -- that is what stops one
   * finding being re-raised forever, and it is right. What it cannot say is that the new
   * evidence answers a question the operator has already answered. A long implementer compacts
   * by design; every one of those compactions is genuine, and every one of them re-put the same
   * pause, in the same words, differing only in a generation pair. Observed as four identical
   * `rotation_candidate` pauses in one run. An operator asked the same question four times stops
   * reading pauses, and the one that finally differs is the one they skim.
   *
   * So the decision is remembered rather than the evidence. Scoped three ways, and each scope is
   * load-bearing:
   *
   *   - by SEAT, because declining a candidate for one implementer says nothing about another;
   *   - by CLASS, because `corroborated` -- the seat compacted AND said so -- is strictly more
   *     than the `degraded` the operator declined on, and is a question they have not been
   *     asked. That is what keeps this from degenerating into "ask once per run";
   *   - by SESSION, cleared wherever a replacement takes the seat, because the decision was
   *     about the session that is now gone.
   *
   * Deliberately NOT an escalating threshold ("ask again after N more"). A threshold re-asks on
   * evidence whose class has not changed, which is the thing being fixed; the count an operator
   * would want out of one is already in `rotationWatch.candidates` and in the routing log, where
   * reading it costs nobody a turn.
   *
   * Only ATTENDED declines are recorded. An unattended or agent-operated run never puts the
   * question, so there is no answer to remember and nothing to suppress -- those paths keep the
   * note-and-continue they already had (#96, #107, #113).
   */
  #declinedClasses = new Map<string, Set<Assessment['reason']>>()

  /** This seat's declined classes, created on first use. */
  #declined(seat: string): Set<Assessment['reason']> {
    let s = this.#declinedClasses.get(seat)
    if (!s) {
      s = new Set()
      this.#declinedClasses.set(seat, s)
    }
    return s
  }

  /**
   * A candidate the operator was not asked about, because they already declined this class.
   *
   * Written to the routing log rather than dropped, and this is the half that keeps "not asked"
   * from becoming "not watched". `rotationWatch.candidates` has already counted it; this note is
   * where a retrospective reader finds WHICH compaction it was -- `detail` carries the generation
   * pair -- and why nobody was interrupted for it.
   */
  #suppressedCandidate(impl: RelayParticipant, cls: Assessment['reason'], detail: string): void {
    this.#record({
      from: 'orchestrator',
      fromRank: 'human',
      to: [],
      kind: 'note',
      text:
        `rotation candidate recorded, run continues (the operator already declined a ${cls} ` +
        `candidate for this session of ${impl.id}, and this is the same evidence class, so the ` +
        `same question is not put again): ${detail}`,
    })
  }

  /**
   * The same argument, one condition over: a `turn_incomplete` already answered (#107).
   *
   * ## What was actually wrong
   *
   * A run doing one coherent piece of work raised nine `turn_incomplete` pauses. Every one of
   * them said `implementer turn ended timed_out (uncertain)` beside a liveness line saying the
   * child was working; every one of them was answered `/wait` and then `/continue`; and nothing
   * anywhere remembered that the question had been put. `#verdictPause` looks like the place it
   * would live and is not -- it exists to match a later revision to a live pause, and it is
   * cleared the moment the pause resolves.
   *
   * ## What identifies "the same question", which is NOT the same turn
   *
   * The obvious key is the turn, and it does not work, for two reasons established from the code
   * rather than assumed:
   *
   *   - `endSeq` is a fresh sequence number on every watchdog verdict, so it cannot identify a
   *     turn across two of them. The issue's own comment thread had already found this.
   *   - a turn cannot raise two of these anyway. `#halt` stays suspended at `await deciding` for
   *     the whole life of a pause, and a second watchdog verdict for the same turn arrives
   *     through `#trackSupersession`, which amends the pause in place. So the nine were nine
   *     DISTINCT turns of one long piece of work -- and `turnKey` would suppress none of them.
   *     (It is also optional on `TurnEndEvent`, so an adapter may not supply one at all.)
   *
   * What repeats is not a turn, it is a SITUATION, and that is what is remembered. Scoped three
   * ways, on #118's pattern and for the same reasons:
   *
   *   - by SEAT, because an answer about one implementer says nothing about another;
   *   - by SIGNATURE -- the verdict outcome and the liveness reading, taken whole. `timed_out`
   *     and `transport_lost` are two different questions; so are `working` and `mixed`, which
   *     #83 went to some trouble to keep apart and which must not be folded back together here;
   *   - by SESSION, cleared wherever a replacement takes the seat, because the answer was about
   *     the session that is now gone.
   *
   * ## ONE answer per seat, not a collection of them
   *
   * The obvious structure is a set of answered signatures per seat, and it is wrong. A set only
   * ever grows, so a run that oscillates accumulates permissions and never returns them: after
   * working, quiet and mixed have each been seen once, every subsequent deadline matches
   * something and the seat goes silent for the rest of the run. "Asked once" drifts into "never
   * asks again", by exactly the route that makes it hardest to notice.
   *
   * So this holds the CURRENT character and nothing else. Any `turn_incomplete` whose signature
   * does not match the remembered one invalidates it before pausing -- so A → B → A asks all
   * three times, which is right on its own terms as well as structurally: a child alternating
   * between working and quiet is a child behaving oddly, and that is worth MORE of an operator's
   * attention than one steadily working, not less.
   *
   * ## And the half that must NOT be silenced
   *
   * Only a reading that reports a live child arms this -- see `#armIncomplete` -- and a quiet or
   * gone reading actively clears whatever was remembered. Liveness turning from "the child is
   * working" into "the child is idle or gone" is new information, and it voids a keep-waiting
   * answer that was given about a live child: an operator who answered `/wait` about a live seat
   * and then hears nothing when it dies is worse off than one asked nine times. Silence is for
   * the case where the answer would genuinely be the same, and a dead child is not that case.
   *
   * The suppression COUNT is not reset by any of this. It is cumulative for the session, because
   * it answers "how many times did this run decline to interrupt me", and a counter that restarted
   * whenever the latch re-armed would understate exactly the runs where it mattered most.
   *
   * Deliberately NOT a policy flag and NOT a standing answer the operator types. The issue offers
   * `/wait auto` as a third shape; a flag would make this the operator's job to configure, and
   * the thing being fixed is a question with no decision content, which the run can see for
   * itself.
   */
  #incompleteAnswered(latch: IncompleteLatch, reading: LivenessReading): boolean {
    return this.#incompleteAnswers.get(latch.seat.id) === incompleteSignature(latch.outcome, latch.provenance, reading)
  }

  /**
   * Forget this seat's remembered answer, because the situation it was about no longer holds.
   *
   * Called at the OBSERVATION and not at the arming, which is the whole of the current-character
   * rule: by the time a pause is raised the run has already seen evidence that the character
   * changed, and leaving the old answer in place until the new one resolves would let an
   * oscillation match it again on the way back.
   */
  #forgetIncompleteAnswer(latch: { seat: RelayParticipant }): void {
    this.#incompleteAnswers.delete(latch.seat.id)
  }

  /**
   * Remember this answer, if it is one that can be repeated.
   *
   * The reading is the gate. `working` and `mixed` both report something on the CPU -- they are
   * the readings that offer `wait`, and the ones where "the child is fine, carry on" is an answer
   * that stays true while nothing changes. `not_computing` and `gone` are not: they are the
   * readings a pause exists for, and an operator who saw one and continued has not agreed to be
   * told nothing next time. Those, and a seat with no measurable child, leave the seat with no
   * remembered answer -- which is where the observation above has already put it.
   *
   * Remembers and never forgets, deliberately: forgetting belongs to the observation, and an
   * invariant with two owners is one a later edit can leave half-applied.
   */
  #armIncomplete(latch: IncompleteLatch, outcome: Verdict['outcome'], reading: LivenessReading | undefined): void {
    if (reading !== 'working' && reading !== 'mixed') return
    this.#incompleteAnswers.set(latch.seat.id, incompleteSignature(outcome, latch.provenance, reading))
  }

  /**
   * A `turn_incomplete` the operator was not asked about, because they already answered it.
   *
   * Written to the routing log rather than dropped, and this is the half that keeps "not asked"
   * from becoming "not watched". Nothing else counts these -- there is no `rotationWatch` for
   * deadlines -- so the note carries the running count itself, and an operator reading afterwards
   * can see how many times the run declined to interrupt them without counting the lines.
   */
  #suppressedIncomplete(
    latch: { seat: RelayParticipant; outcome: Verdict['outcome'] },
    measured: { sample: ChildLiveness; reading: LivenessReading; emitted: number },
    detail: string,
  ): void {
    const n = (this.#suppressedIncompletes.get(latch.seat.id) ?? 0) + 1
    this.#suppressedIncompletes.set(latch.seat.id, n)
    // Re-rendered with no refresh state rather than reusing `measured.line`. That line was built
    // for a pause and ends "re-measured while the pause lasts" -- true where a refresher follows
    // it and a promise of updates nothing will deliver here, which is #101's defect written into
    // the note that exists to stop #107's.
    const line = describeLiveness(measured.sample, measured.emitted)
    this.#record({
      from: 'orchestrator',
      fromRank: 'human',
      to: [],
      kind: 'note',
      text:
        `turn_incomplete recorded, run continues (the operator already answered a ${latch.outcome} ` +
        `pause for this session of ${latch.seat.id} while the child read ${measured.reading}, and ` +
        `the reading has not changed character, so the same question is not put again — ` +
        `${n} suppressed so far for this seat): ${detail}. ${line}`,
    })
  }

  /**
   * The ONE `turn_incomplete` signature each seat's operator has currently answered.
   *
   * A value and not a set, and that is load-bearing rather than a simplification. See
   * `#incompleteAnswered`.
   */
  #incompleteAnswers = new Map<string, string>()

  /**
   * How many re-raises this seat's latch has swallowed, for the note that says so.
   *
   * Cumulative for the life of the session, unlike the answer above: the answer is about the
   * situation right now, the count is about the whole run.
   */
  #suppressedIncompletes = new Map<string, number>()

  /**
   * The candidate was answered by REPLACING the seat, not by ruling on its evidence (#128).
   *
   * `#considerRotation` snapshots once, before it decides anything, and `rotate` is an option ON
   * a pause rather than a resolution of one -- so an operator can promote a replacement and then
   * resume, and the snapshot the resume path still holds belongs to a session that has been
   * retired. `#acknowledge` would write that generation onto the seat, over the `0` that
   * `rotateSeat` had just correctly set, and the new session would carry its predecessor's
   * baseline for the rest of the run.
   *
   * It hid well, because nothing STOPPED working: `detectDegradation` reads the snapshot channel
   * and the `revision` channel together, exactly so that either can be ahead of the other, and
   * the replacement's first compaction still raised its candidate off the revision event. What
   * was lost was the `rose N → M` line beside it -- the evidence an operator reads to see how far
   * the seat has actually gone -- on the one pause where the seat is newest and that number
   * matters most.
   *
   * So the baseline is not touched here. `rotateSeat` set it, from the session that is actually
   * in the seat, and this records that it did. The note exists because every other candidate
   * ends in one, and a resolution that left no line would read as a candidate that went nowhere.
   */
  #answeredByReplacement(impl: RelayParticipant, retired: number): undefined {
    this.#record({
      from: 'orchestrator',
      fromRank: 'human',
      to: [],
      kind: 'note',
      text:
        `rotation candidate answered by replacing ${impl.id}: the baseline is the new session's ` +
        `own (${impl.baselineGeneration}), not the retired session's ${retired}, so the ` +
        `replacement is judged on what IT does from here`,
    })
    return undefined
  }

  #acknowledge(impl: RelayParticipant, generation: number): undefined {
    impl.baselineGeneration = generation
    impl.degradationCursor = impl.events.length
    // `get` rather than `#declined`, which would create an entry for a seat that has never had
    // one -- a reader is not a writer, and the note below is only reporting.
    const declined = [...(this.#declinedClasses.get(impl.id) ?? [])]
    this.#record({
      from: 'orchestrator',
      fromRank: 'human',
      to: [],
      kind: 'note',
      // Says what HAPPENED, not who decided it. Every caller lands here -- a human who declined
      // at a pause, an unattended run with nobody to ask, and an agent-operated run that was
      // deliberately not interrupted (#107) -- and only the first of those declined anything.
      // The note used to say "declined" for all three, which put a decision in the record of
      // two runs where nobody made one. The note that names the actor is the candidate note
      // above; this one is about the baseline.
      //
      // The tail is conditional since #118, because the unconditional form stopped being true.
      // "A later one will" was a promise about what the run would do next, and the latch is
      // exactly the thing that can now make it false -- a later compaction of a class the
      // operator has already declined is recorded, not put. An operator reading a note that
      // promises a pause they will never see is worse off than one reading nothing: they will
      // wait for it. The un-latched wording is left exactly as it was, so this reads the same on
      // every run where nothing has been declined.
      text:
        `rotation candidate closed at compaction generation ${generation}: the baseline moved, ` +
        `so this compaction will not be raised again` +
        (declined.length > 0
          ? `. A later one is new evidence, but ${declined.join(' and ')} has already been ` +
            `declined for this session, so a later candidate of that class is recorded rather ` +
            `than put (#118)`
          : ` and a later one will`),
    })
    return undefined
  }

  /**
   * Run to completion without a supervisor.
   *
   * Kept as it was: every pause point is terminal for this form, because a call that has
   * already committed to returning an outcome has nowhere to suspend to. `start()` is the
   * attended form, and the difference is deliberate rather than incidental.
   */
  async run(goal: string): Promise<RunOutcome> {
    const looping = this.#loop(goal, undefined)
    this.#looped = looping
    return looping
  }

  /**
   * The run in progress, so `stop()` can wait for it to unwind (#143).
   *
   * Held here rather than only in `start()`'s `void` call because `run()` -- the unattended form
   * -- has no handle to hang it off, and the thing `stop()` needs is the same in both.
   */
  #looped: Promise<unknown> | undefined

  async #loop(goal: string, handle: RunHandle | undefined): Promise<RunOutcome> {
    this.#looping = true
    try {
      return await this.#runLoop(goal, handle)
    } catch (err) {
      // A transport failure ENDS the run; it does not escape it.
      //
      // `start()` already caught throws and settled the handle, but `run()` -- the
      // unattended form the CLI uses -- let them propagate. A 12-turn run died on
      // `no UserPromptSubmit hook after send` and printed no verdict, no message count and
      // no rotation summary, because those lines all sit after `relay.run(goal)` returned.
      // The runs most worth diagnosing were the ones that reported least (issue #32).
      //
      // Ending here means the caller gets an outcome, the run-end event fires, and every
      // summary line is reachable on the abnormal path as well as the normal one.
      const detail = err instanceof Error ? err.message : String(err)
      // The one throw that is NOT a transport failure. `#awaitSendable` refused to send into a
      // live turn, which is a decision this loop made about pacing -- the transport was never
      // asked to carry anything and never failed. Reporting it as a transport fault is the
      // misdirection #117 is about, arriving one layer later.
      if (err instanceof PeerBusyError) return this.#end('peer_busy', detail)
      // Nor is a turn abandoned by teardown (#143). `stop()` closed the session under it, so the
      // send that never came back was one this relay withdrew rather than one the transport
      // dropped. `#end` is first-outcome-wins and `stop()` has already ended the run as
      // `stopped`, so this call returns that outcome rather than installing a second one -- and
      // saying `stopped` here rather than `transport_failed` is what keeps a relay stopped
      // BEFORE its run ever started from reporting a fault it did not have.
      if (err instanceof TurnAbandonedError) return this.#end('stopped', detail)
      return this.#end('transport_failed', detail)
    } finally {
      this.#looping = false
    }
  }

  /**
   * The task queue: immutable records of what the advisor decided, in admission order.
   *
   * Append-only, and never edited after admission. Anything that would be an edit is instead a
   * new record or a change to `#taskRuntime`, which references it. See `dispatch.ts` for why
   * the two are separate structures and why only this class touches either.
   */
  #queue: Task[] = []
  /** What happened to each task, keyed by `Task.id`. */
  #taskRuntime = new Map<string, TaskRuntime>()
  /**
   * Per-seat execution state, keyed by participant id.
   *
   * Built from the seats work can be dispatched TO. The advisor is not one of them at any N --
   * it is the seat that decides what the others do, which is a fact about rank rather than
   * about how many implementers there are (D5). Keyed by id rather than holding the
   * participant, so it survives a rotation: `rotateImplementer` swaps the SESSION in place and
   * keeps the id, precisely so existing references stay valid.
   */
  #seatState = new Map<string, SeatExecution>()
  #taskSeq = 0
  /**
   * A monotonic counter stamped on every dispatcher transition.
   *
   * Wall clock cannot answer "was the next task assigned before the previous verdict was
   * graded?" -- two transitions in the same millisecond are indistinguishable, and that is
   * exactly the pair a scheduling change reorders without anyone noticing. This can.
   *
   * Deliberately NOT a `#record` note. D4 asks each transition to write one so the routing log
   * explains the schedule as well as the traffic, and that is right the day seats run
   * concurrently -- but at N=1 it would add messages to a log whose numbering is asserted
   * contiguous, for a schedule that has exactly one shape. The marks carry the same ordering
   * evidence without changing what a default run records.
   */
  #ordinal = 0

  /**
   * The dispatcher's account of this run: what was admitted, and what became of it.
   *
   * Deep copies, sharing nothing with the originals. The queue and the runtime are Relay's
   * alone (D4), and a caller holding a live reference is the second writer the rule exists to
   * prevent -- `readonly` on `Task` stops the compiler and stops nothing at runtime, and a
   * shallow copy leaves `target`, `dependsOn`, `restrictedOrigins`, the marks and the verdict's
   * provenance all pointing at the objects the dispatcher is still scheduling against.
   *
   * `structuredClone` rather than a copy written out field by field, deliberately: a hand-rolled
   * copy shares every nested field added after it was written, and it fails silently the day
   * `TaskRuntime` grows one. This cannot.
   */
  tasks(): { task: Task; runtime: TaskRuntime }[] {
    return this.#queue.map((task) => ({
      task: structuredClone(task),
      runtime: structuredClone(this.#taskRuntime.get(task.id)!),
    }))
  }

  /** Per-seat execution state, copied the same way and for the same reason. */
  seats(): SeatExecution[] {
    return [...this.#seatState.values()].map((s) => structuredClone(s))
  }

  #mark(task: Task, event: TaskEvent): void {
    this.#taskRuntime.get(task.id)!.marks.push({ event, ordinal: ++this.#ordinal })
  }

  /**
   * Admit a task. The advisor PROPOSES; the dispatcher validates and admits, and this is the
   * only place a `Task` record comes into existence.
   *
   * The dependency check runs even though nothing the advisor can currently write carries a
   * dependency: a rule that only starts running once there is something to test it with is a
   * rule nobody has tested.
   */
  #admit(instruction: string, target: TaskTarget, origin: number, purpose: TaskPurpose, parent?: string): Task {
    const task: Task = {
      id: `t-${++this.#taskSeq}`,
      seq: this.#taskSeq,
      origin,
      instruction,
      target,
      // Designated at admission by whoever routed it, never inferred from the prose. See
      // `TaskPurpose`: this is the one fact that lets a blocked seat accept its repair and
      // nothing else.
      purpose,
      // The original task under review or repair (#72). Absent for `work`/`merge_resolution`.
      ...(parent === undefined ? {} : { parent }),
      dependsOn: [],
      // Snapshotted at admission, so the conflict question is answered against the restricted
      // messages that existed when the advisor decided rather than against later ones.
      restrictedOrigins: this.restrictedOrigins.map((o) => o.seq),
      admittedAt: Date.now(),
    }
    this.#queue.push(task)
    this.#taskRuntime.set(task.id, { state: 'admitted', marks: [] })
    this.#mark(task, 'admitted')
    if (dependenciesMet(task, this.#taskRuntime)) {
      this.#taskRuntime.get(task.id)!.state = 'ready'
      this.#mark(task, 'ready')
    }
    return task
  }

  /**
   * Admit a review task for a completed piece of work (#72). Called from `#runLoop` once a
   * task's own turn is graded and this run has a reviewer -- never from inside
   * `#crossBoundary`, which is the whole of "review is a dispatched task, not a hook the
   * boundary calls".
   *
   * `parent` is set to `work.id`: the IMMEDIATE task this review is for, whether that is the
   * original `work` task or a `review_resolution` repair. See `Task.parent`: a repair whose
   * own parent is itself a repair is the second rejection, which `resolveReview` in
   * `#runLoop` reads directly off `work.purpose` rather than climbing a chain.
   *
   * The context is built the way a rotation handoff's record is: mechanically, from the
   * producing seat's own tree, never from that seat's report. See `rotation/review.ts`.
   */
  #admitReview(work: Task, seatId: string, reviewer: RelayParticipant): Task {
    const manifest = this.#worktrees
    const tree = manifest?.seats.find((s) => s.seatId === seatId)
    const root = tree ? tree.worktreePath : this.#opts.cwd
    const base = (tree && manifest ? integrationHead(manifest.integrationRoot) : this.#runStartSha) ?? 'HEAD'
    const ctx = buildReviewContext({
      root,
      base,
      checks: this.#opts.rotation?.checks ?? [],
      instruction: work.instruction,
      ...(this.#opts.rotation?.checkTimeoutMs === undefined
        ? {}
        : { checkTimeoutMs: this.#opts.rotation.checkTimeoutMs }),
    })
    return this.#admit(reviewPrompt(ctx), { kind: 'role', role: reviewer.role }, work.origin, 'review', work.id)
  }

  /**
   * Cancel every queued task whose dependency failed, and everything behind it.
   *
   * A no-op today in the only way that matters: nothing the advisor can write carries a
   * dependency, so `dependsOn` is empty on every admitted task and the sweep condemns
   * nothing. It is wired now rather than with the feature that needs it because the rule it
   * enforces is what makes dependencies SAFE to create -- a queue that can hold a task
   * nothing will ever run is the thing that must not exist BEFORE the first edge is written,
   * not after.
   *
   * `cancelledBy` records the causal task id rather than the bare fact, so an operator
   * reading `tasks()` afterwards is told which failure took this work out rather than being
   * left to reconstruct it from the marks.
   */
  #cancelUnrunnable(): void {
    for (const { task, cancelledBy } of cancelledByFailedDependencies(this.#queue, this.#taskRuntime)) {
      const runtime = this.#taskRuntime.get(task.id)!
      runtime.state = 'cancelled'
      runtime.cancelledBy = cancelledBy
      this.#mark(task, 'cancelled')
    }
  }

  /**
   * Hand a ready task to a seat, and refuse if that seat is not free.
   *
   * The ungraded refusal is the one this exists for. A seat is free when its turn ended AND its
   * verdict is graded (D4): a `timed_out (uncertain)` seat must not be handed more work, and
   * freeing it at `turn_end` would do exactly that while looking like a scheduling decision
   * somebody made. Enforced here rather than left to the order of the calls, because a
   * two-stage release is precisely the kind of ordering a later change collapses by accident.
   *
   * Admission is deliberately NOT guarded this way. A queue may hold work for a busy seat --
   * that is a scheduling wait, and refusing it would reintroduce lockstep at the front door.
   */
  #assign(task: Task, seat: SeatExecution): void {
    // The task's own target, so this asks exactly what `seatFor` asked. A resolution task
    // named at a `merge_blocked` seat is a legal dispatch and must not be refused here.
    const refusal = refuseDispatch(seat, this.#taskRuntime, task)
    if (refusal) throw new Error(`dispatcher refused ${task.id}: ${refusal}`)
    const runtime = this.#taskRuntime.get(task.id)!
    runtime.state = 'assigned'
    runtime.seat = seat.seat
    seat.current = task.id
    seat.state = 'running'
    seat.dispatched += 1
    this.#mark(task, 'assigned')
  }

  /** The turn is sent. This is the point `#exchange` counts against the turn ceiling. */
  #sending(task: Task): void {
    const runtime = this.#taskRuntime.get(task.id)!
    runtime.state = 'running'
    runtime.sentAt = Date.now()
    this.#mark(task, 'sent')
  }

  /**
   * The turn ended, settled, and its report was recorded.
   *
   * The seat becomes `integrating`: not running, and not available. The report being ready and
   * the tree being ready are different facts, and at N>1 handing this seat new work here would
   * write into a tree the boundary flow is still committing.
   */
  #reported(task: Task, seat: SeatExecution, reportSeq: number, unsettled: boolean): void {
    const runtime = this.#taskRuntime.get(task.id)!
    runtime.endedAt = Date.now()
    runtime.unsettled = unsettled
    runtime.reportSeq = reportSeq
    runtime.state = 'reported'
    seat.state = 'integrating'
    this.#mark(task, 'ended')
    this.#mark(task, 'reported')
  }

  /**
   * The verdict, resolved through supersession and judged. No seat is freed without one.
   *
   * `end` is the event the verdict was READ FROM -- the replacement when a late revision
   * withdrew the original. Recorded here rather than when the turn ended, because until this
   * point there is no answer to which event that is, and a field holding the withdrawn one in
   * the meantime would say something the relay had already stopped believing.
   */
  #grade(task: Task, end: TurnEndEvent, grade: TaskGrade): void {
    const runtime = this.#taskRuntime.get(task.id)!
    runtime.end = end
    runtime.grade = grade
    this.#mark(task, 'graded')
  }

  /**
   * The integration boundary, and the release it earns.
   *
   * At N=1 there is nothing to commit: one tree, and it is the operator's cwd (D1). A
   * no-change boundary passes straight through rather than being treated as an error -- most
   * tasks at any N change no files, and requiring a commit to free a seat would deadlock every
   * read-only one.
   */
  #integrate(task: Task, seat: SeatExecution): void {
    const runtime = this.#taskRuntime.get(task.id)!
    if (runtime.grade === undefined) {
      throw new Error(`dispatcher cannot free ${seat.seat}: ${task.id} has no graded verdict`)
    }
    recordCompletion(runtime, 'integrated', Date.now())
    this.#mark(task, 'integrated')
    seat.current = undefined
    seat.state = 'idle'
    seat.idleSince = Date.now()
    this.#mark(task, 'released')
  }

  /**
   * The boundary that did not happen: release the seat, and record that it did not.
   *
   * The counterpart to `#integrate`, and it exists because the two used to be one. Every
   * boundary went through `#integrate` whatever the merge did, so a task whose merge
   * CONFLICTED still recorded `integratedAt` and could derive `complete` — a queue in which
   * "this work is in the integration checkout" was true of work that provably was not, and the
   * dependency rules are written against exactly that fact. A dependent of a conflicted task
   * would have been released to run against a base that never absorbed it.
   *
   * So: no `recordCompletion`, which is what leaves `integratedAt` unset and keeps `complete`
   * underivable, and an explicit `failed` mark so the transition is in the record rather than
   * inferred from an absence. The seat is released from its task — the turn really did end —
   * but into `merge_blocked` rather than `idle`, so nothing but its own repair can reach it.
   *
   * `routed` may still land afterwards and must: the advisor did hear the report, and
   * `recordCompletion` already refuses to move a `failed` task off its state.
   */
  #failBoundary(task: Task, seat: SeatExecution): void {
    const runtime = this.#taskRuntime.get(task.id)!
    if (runtime.grade === undefined) {
      throw new Error(`dispatcher cannot free ${seat.seat}: ${task.id} has no graded verdict`)
    }
    runtime.state = 'failed'
    this.#mark(task, 'failed')
    seat.current = undefined
    seat.state = 'merge_blocked'
    // Stamped even though a blocked seat is not selectable: it becomes the ordering key the
    // moment the block clears, and a seat resuming with an ancient `idleSince` would jump the
    // queue ahead of seats that have genuinely been waiting.
    seat.idleSince = Date.now()
    this.#mark(task, 'released')
  }

  /**
   * Hold a seat's release pending a reviewer's verdict (#72).
   *
   * NOT `#integrate` and NOT `#failBoundary`: neither fact they record has happened yet.
   * `task`'s own runtime stays exactly where `#reported` left it -- `reported`, no
   * `integratedAt` -- because nothing has crossed the boundary. Only the seat moves: released
   * from the task it just finished, but not free, because review is a task this run has not
   * yet decided to keep. `#crossBoundary` runs later, from `crossAndSettle` in `#runLoop`,
   * once (and only if) the verdict is ACCEPT.
   */
  #awaitReview(seat: SeatExecution): void {
    seat.current = undefined
    seat.state = 'review_pending'
    seat.idleSince = Date.now()
  }

  /**
   * The repair a REJECTED review earns: release the seat, but into `review_blocked` rather
   * than `idle`, so nothing but its named `review_resolution` repair can reach it (#72).
   *
   * The counterpart to `#failBoundary`, and deliberately not a call to it: that function's
   * `merge_blocked` is a claim about GIT, and a review rejection is a claim about neither
   * seat's tree failing to merge -- it may merge cleanly and still be the wrong change.
   */
  #failReview(task: Task, seat: SeatExecution): void {
    const runtime = this.#taskRuntime.get(task.id)!
    runtime.state = 'failed'
    this.#mark(task, 'failed')
    seat.current = undefined
    seat.state = 'review_blocked'
    seat.idleSince = Date.now()
    this.#mark(task, 'released')
  }

  /**
   * Commit this seat's work and merge it into the integration checkout.
   *
   * A no-op without seat worktrees, which is every default run — the guard is the `undefined`
   * manifest and not a seat count, so N=1 does not take a shorter path through this code, it
   * takes none of it.
   *
   * Every outcome is recorded as an orchestrator note, because a merge is a change to the
   * operator's own checkout made by something they are not watching, and a boundary that
   * moved their HEAD without saying so is indistinguishable from one that did nothing.
   *
   * A conflict does NOT stop the run and does not pause it. Only that seat is marked; its
   * branch and tree are untouched, what it committed is intact, and resolution is work
   * the advisor has to dispatch back to that seat. What the notices say about the tree is
   * READ from the tree at the moment they are written -- see `uncommittedClause` -- because a
   * seat's child goes on writing after its boundary commit and a notice that asserted
   * otherwise would be the reason an operator stopped looking. Blocking every other seat on one seat's
   * conflict would be lockstep again, reached from a different direction. Making the blocked
   * seat undispatchable, and raising this onto a decision queue the advisor services, is the
   * seat-block machinery — not built here.
   */
  async #crossBoundary(task: Task, seatId: string): Promise<BoundaryOutcome> {
    // N=1 takes none of this: no manifest, no merge, no checks against an integration tree
    // that does not exist -- and so no reason to touch the lane. Guarded before the acquire
    // rather than inside it, so a default run does not acquire a lane it has no use for.
    if (!this.#worktrees?.seats.some((s) => s.seatId === seatId)) return { kind: 'clear' }
    // The WHOLE boundary, not just the checks. `integrateSeat` merges into the integration
    // checkout and resets the seat worktrees onto the new HEAD, which is precisely the change
    // a rotation's two captures would read as `repository_diverged`. One acquire, here, at the
    // outermost point: the checks `integrateSeat` runs for itself must not take the lane a
    // second time, which is why `integrate.ts` knows nothing about it.
    //
    // Outside the boundary's own try/catch on purpose. That catch converts a throw into
    // `merge_blocked`, and a lane fault is not a claim about anyone's branch.
    return this.#checkLane.run(
      { seat: seatId, station: 'integration', detail: task.id },
      () => this.#mergeAndCheck(task, seatId),
    )
  }

  /**
   * The boundary itself, with the lane already held. See `#crossBoundary`.
   *
   * Synchronous, as it has always been: both `integrateSeat` and the checks it runs are
   * `spawnSync`. That is what makes the lane's protection a real invariant rather than a hope
   * -- nothing can interleave inside this -- and it is also why a check command freezes every
   * other seat's I/O for as long as it runs, which is a separate problem this does not fix.
   */
  /**
   * The snapshot caveat as an evidence LINE, or nothing at all.
   *
   * `evidence` is a list of statements a human reads at a pause, so the caveat arrives as its
   * own entry rather than glued to the end of another one -- an operator scanning the list
   * would not find it inside a sentence about branches. Trimmed of the leading space the prose
   * form carries for its own call sites.
   */
  #snapshotEvidence(note: string): string[] {
    return note === '' ? [] : [note.trim()]
  }

  #mergeAndCheck(task: Task, seatId: string): BoundaryOutcome {
    const manifest = this.#worktrees
    if (!manifest) return { kind: 'clear' }
    const tree = manifest.seats.find((s) => s.seatId === seatId)
    if (!tree) return { kind: 'clear' }
    const note = (text: string): void => {
      this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text })
    }
    // The verdict the run GRADED, not the latest event. `#grade` resolves supersession before
    // any boundary runs -- a withdrawn `timed_out` that a late Stop replaced is already the
    // replacement by now -- so reading it here is reading the run's own answer rather than
    // asking git's caller to form a second opinion. Absent when a caller reached the boundary
    // without one, and an absent verdict adds nothing rather than being guessed at.
    const turnEnd = this.#taskRuntime.get(task.id)?.end?.verdict
    // Said once, so the commit trailer and every notice below cannot describe different turns.
    // The rule is uniform on purpose: EVERY surface this function uses to tell a human or the
    // advisor what a boundary did carries the caveat when the turn was uncertain. A caveat on
    // the routing note alone is worse than none, because the two readers who can act on it --
    // the advisor dispatching the repair, and the operator reading a halt -- are the two who
    // would not have seen it.
    const snapshot = uncertainSnapshotNote(turnEnd)
    try {
      const result = integrateSeat(
        manifest,
        tree,
        {
          taskId: task.id,
          seq: task.seq,
          advisorTurn: task.origin,
          turnEnd,
        },
        // The run's already-configured checks, against the tree the merge just produced. No
        // second option to arm: an operator who has said what "working" means for this
        // project has said it, and a station that needs saying twice is a station that will
        // not be armed on the run that needs it (#80).
        {
          checks: this.#opts.rotation?.checks,
          checkTimeoutMs: this.#opts.rotation?.checkTimeoutMs,
        },
      )
      if (result.status !== 'blocked') {
        if (result.status === 'nothing_to_merge') {
          // NOT "changed nothing", which is a claim about the whole turn and was never checked.
          // What was checked is one `git status` at one instant, and a child that had not
          // finished writing is indistinguishable from one with nothing to say -- so the note
          // says what was observed and when, and nothing more.
          note(
            `${seatId} had no uncommitted changes when the boundary read its tree at ` +
              `${new Date(result.checkedAt).toISOString()} for ${task.id}; nothing was integrated.${snapshot}`,
          )
        } else {
          note(
            `${seatId}'s work for ${task.id} merged into ${manifest.integrationRoot} at ` +
              `${result.integrationSha.slice(0, 12)}.${snapshot}`,
          )
          for (const n of result.notes) note(n)
        }
        // A boundary that got through IS the repair, whatever the instruction that produced it
        // was called. Nothing else clears a block: not a turn, not an advisor saying so.
        if (this.#blocked.delete(seatId)) {
          const cleared = `${seatId}'s merge conflict is resolved and its work is in the integration checkout. It takes ordinary work again.`
          note(cleared)
          this.#tellLead(cleared)
        }
        if (result.status === 'merged') {
          const red = this.#judgeIntegration(task, seatId, result.integrationSha, result.checks, note)
          if (red) return red
        }
        return { kind: 'clear' }
      }

      const prior = this.#blocked.get(seatId)
      const repeat = prior !== undefined && prior.parent === result.parent
      this.#blocked.set(seatId, {
        parent: result.parent,
        paths: result.paths,
        attempts: repeat ? prior.attempts + 1 : 1,
      })
      const conflicting = result.paths.length > 0 ? ` Conflicting: ${result.paths.join(', ')}.` : ''
      // Read the tree, once, and say what is in it. A conflict is aborted some time after the
      // boundary commit and the seat's child has been alive throughout, so "its work is
      // committed and nothing has been discarded" -- what all three of these notices used to
      // say -- was a claim nothing had checked. Read here rather than per notice so the note,
      // the advisor's instruction and the halt evidence cannot describe different trees.
      const held = uncommittedClause(tree.worktreePath)
      note(
        `${seatId}'s work for ${task.id} could not be merged and the integration checkout was ` +
          `left as it was. What it committed is intact on ${tree.branch}, and ${held}.${snapshot}` +
          `${conflicting} ${result.detail}`,
      )
      if (!repeat) {
        // The advisor is told because resolution is WORK, and work is dispatched. It is told in
        // the terms it has to act in: the conflict is the seat's to resolve, in the seat's own
        // tree, and the next instruction goes there whether or not the advisor names it.
        this.#tellLead(
          `${seatId}'s committed work is on ${tree.branch} but will not merge into the integration ` +
            `checkout.${conflicting} It is blocked and takes no other work until this clears. Your next ` +
            `instruction goes to ${seatId}: tell it to merge the current integration HEAD into its own ` +
            `branch, resolve the conflict IN ITS OWN WORKTREE, verify whatever you think that needs, and ` +
            `report. As of now ${held}.${snapshot} No other seat is affected.${this.#addressBlocked(seatId)}`,
        )
      }
      return {
        kind: 'blocked',
        seatId,
        escalate: repeat,
        detail:
          `${seatId}'s branch ${tree.branch} still will not merge into ${result.parent.slice(0, 12)} ` +
          `after a resolution turn.${conflicting}`,
        evidence: [
          `attempt ${repeat ? prior.attempts + 1 : 1} against the same integration parent ${result.parent.slice(0, 12)}`,
          `what it committed is on ${tree.branch}, and ${held}; that worktree is retained`,
          `no other seat is blocked by this`,
          ...this.#snapshotEvidence(snapshot),
        ],
      }
    } catch (e) {
      // The run does not die on a boundary it could not complete. But it does not shrug either:
      // this used to return `clear`, which released the seat for ordinary work on the strength
      // of a boundary that THREW -- the one case in which nothing is known about whether the
      // work merged, whether the tree is mid-merge, or whether the manifest was written. An
      // unknown boundary is treated exactly as a failed one, because the safe reading of "I
      // could not tell" is not "it was fine".
      const detail = (e as Error).message
      // The same read as the conflict path, and here it carries more: a boundary that THREW
      // may not have got as far as the commit at all, so the tree is the only account of what
      // the seat still holds. Taken before the manifest write, so the note and the manifest
      // describe the same moment.
      const held = uncommittedClause(tree.worktreePath)
      note(`${seatId}'s boundary for ${task.id} did not complete: ${detail}. ${held}.${snapshot}`)
      // Best-effort, and its failure is not fatal: the tree is retained either way by the
      // cleanup rules, and a manifest that could not be written is one more thing the operator
      // is told about rather than a reason to lose the seat state.
      try {
        tree.mergeState = 'merge_blocked'
        writeManifest(manifest)
      } catch (writeError) {
        note(`${seatId}'s manifest could not be updated: ${(writeError as Error).message}`)
      }
      // The same repeat rule as a conflict. `parent` is read best-effort, because a boundary
      // that threw may have been git failing in the first place; an unreadable HEAD is its own
      // value, so two unreadable attempts in a row still count as a repeat.
      const parent = integrationHead(manifest.integrationRoot) ?? 'unreadable'
      const prior = this.#blocked.get(seatId)
      const repeat = prior !== undefined && prior.parent === parent
      this.#blocked.set(seatId, { parent, paths: [], attempts: repeat ? prior.attempts + 1 : 1 })
      if (!repeat) {
        this.#tellLead(
          `${seatId}'s work could not be integrated: the boundary itself failed (${detail}). Whatever it ` +
            `committed is on ${tree.branch}, and ${held}.${snapshot} It is blocked and takes no other work ` +
            `until this clears. Your next instruction goes to ${seatId}: tell it to get its branch into ` +
            `a state that merges cleanly, working IN ITS OWN WORKTREE, and report.${this.#addressBlocked(seatId)}`,
        )
      }
      return {
        kind: 'blocked',
        seatId,
        escalate: repeat,
        detail: `${seatId}'s boundary for ${task.id} failed again: ${detail}`,
        evidence: [
          `attempt ${repeat ? prior.attempts + 1 : 1} against integration parent ${parent.slice(0, 12)}`,
          `the boundary raised an error rather than reporting a conflict, so what merged is unknown`,
          `its branch ${tree.branch} is untouched, its worktree is retained, and ${held}`,
          ...this.#snapshotEvidence(snapshot),
        ],
      }
    }
  }

  /**
   * What the configured checks said about the tree this merge produced (#80).
   *
   * Called once per merge that actually went in, and it is the only place the run learns
   * anything about the INTEGRATION result. Everything before it -- git reporting no conflict,
   * every seat's own checks passing in every seat's own tree -- is compatible with a tree that
   * does not build, which is what the first real two-seat run produced.
   *
   * Returns the red outcome, or `undefined` when the tree is green or unchecked. The caller
   * decides what a red one costs; this decides only what is true.
   */
  #judgeIntegration(
    task: Task,
    seatId: string,
    integrationSha: string,
    checks: IntegrationCheckResult[],
    note: (text: string) => void,
  ): BoundaryOutcome | undefined {
    const merge: MergeContribution = { taskId: task.id, seatId, integrationSha }
    this.#merges.push(merge)
    // Unchecked is not green, and it is not red either. A run with no integration checks
    // configured says nothing about its tree, and saying nothing is the honest answer.
    if (checks.length === 0) return undefined

    // Reported whatever their relevance, because an operator reading the log is entitled to
    // see a check that did not pass even when it was declared not to decide anything.
    for (const c of checks.filter((c) => c.exitCode !== 0)) {
      note(
        `integration check \`${c.command}\` exited ${c.exitCode ?? 'without a status'} ` +
          `[${c.relevance}] after ${task.id} merged at ${integrationSha.slice(0, 12)}`,
      )
    }

    const failures = failedRequired(checks)
    if (failures.length === 0) {
      // Green, and this is the ONLY thing that clears a red tree. A repair that was dispatched
      // and a seat that reports success are both claims; this is the measurement.
      if (this.#integrationRed) {
        const cleared = `the integration checkout passes its checks again at ${integrationSha.slice(0, 12)}.`
        note(cleared)
        this.#tellLead(cleared)
      }
      this.#integrationRed = undefined
      this.#lastGreenMerge = this.#merges.length - 1
      return undefined
    }

    // The combination, not the last merge. Everything from the last merge that was GREEN
    // through this one is in the tree and is part of what is red; before that green point the
    // tree was measured working, so those tasks are not implicated by this failure.
    const from = this.#lastGreenMerge ?? 0
    const contributors = this.#merges.slice(from)
    this.#integrationRed = { contributors, failures }
    return { kind: 'integration_red', contributors, failures }
  }

  /**
   * How the advisor is told a merge produced a red tree, and what it is asked to do about it.
   *
   * Deliberately NOT the `merge_blocked` wording one function up, and the difference is the
   * point of #80. That notice says "your next instruction goes to THIS seat, this is its
   * conflict, in its own worktree" -- correct for a conflict, wrong here. Neither seat did
   * anything wrong, so the repair cannot be assigned by fault; it names both tasks, says the
   * failure belongs to their combination, and leaves the choice of seat to the advisor, which
   * is the only participant that can see both halves.
   */
  #tellLeadIntegrationRed(red: { contributors: MergeContribution[]; failures: IntegrationCheckResult[] }): void {
    const tasks = red.contributors.map((c) => `${c.taskId} (${c.seatId})`).join(' + ')
    const failing = red.failures
      .map((f) => `\`${f.command}\` exited ${f.exitCode ?? 'without a status'}:\n${f.output || '(no output)'}`)
      .join('\n\n')
    this.#tellLead(
      `The integration checkout now fails its configured checks. Every merge was clean and every ` +
        `seat's own work was green in its own tree; what is red is the COMBINATION of ${tasks}. ` +
        `No seat is blocked and no seat is at fault, so this is not assigned for you: dispatch a ` +
        `repair task for it, to whichever seat you judge best placed, and say in the instruction ` +
        `that the seat must read BOTH halves — the defect exists in neither of them alone. Naming ` +
        `one seat as the cause would be a guess.\n\n${failing}`,
    )
  }

  /**
   * How to address a blocked seat, appended to the notice that says one is blocked.
   *
   * Empty at N=1, which is what keeps the single-seat notice byte-identical: with one seat
   * there is nothing to disambiguate, the untargeted redirect puts the next instruction on it
   * regardless, and telling an advisor that was never taught `@seat` to use it would be
   * instructions for a syntax it has not been given.
   *
   * At N>1 it is the difference between a block that clears and one that does not. The
   * untargeted redirect deliberately no longer fires while another seat is free -- that was
   * starvation -- so an advisor that does not name the seat sends the repair somewhere else and
   * the block persists with nothing reporting why.
   */
  #addressBlocked(seatId: string): string {
    return this.#seatState.size > 1
      ? ` Address it BY NAME — reply with a line beginning "@seat ${seatId}:" — because an ` +
        `untargeted instruction now goes to a different free seat and leaves this one blocked.`
      : ''
  }

  /** Queue a mechanical fact for the advisor's next prompt. See `#leadNotices`. */
  #tellLead(text: string): void {
    this.#leadNotices.push(`[ORCHESTRATOR — mechanical, not a participant speaking]\n\n${text}`)
  }

  #drainLeadNotices(): string {
    const notices = this.#leadNotices
    this.#leadNotices = []
    return notices.join('\n\n')
  }

  /**
   * The report reached the advisor.
   *
   * Independent of integration, and a task reaches the two in either order: the advisor must
   * not wait on a merge to hear what a seat found, and a seat whose integration succeeded must
   * not idle through an advisor turn to collect its next task.
   */
  #routed(task: Task): void {
    recordCompletion(this.#taskRuntime.get(task.id)!, 'routed', Date.now())
    this.#mark(task, 'routed')
  }

  /**
   * The run as the ceilings see it, read from the live dispatcher rather than reconstructed.
   *
   * One reader, so the two check points below cannot disagree about what "queue depth" meant
   * at each of them. The counts come from `dispatch.ts` for the same reason the transitions
   * do: this class owns the objects, that module owns what their states mean.
   */
  #ceilingState(): CeilingState {
    return {
      // The same getter a report reads, not a second computation of it. Two expressions for one
      // quantity is how a record comes to disagree with the ceiling it is describing.
      elapsedMs: this.activeMs,
      turns: this.#turnsTaken,
      queueDepth: queueDepth(this.#queue, this.#taskRuntime),
      concurrentSeats: concurrentSeats([...this.#seatState.values()]),
    }
  }

  /**
   * `undefined` when no ceilings were configured, so absent stays exactly behaviourless.
   *
   * `projection` overrides individual readings to ask what the state WOULD be. Ceilings are
   * checked before the mutation they would forbid (D8), not after it, so the check that stops
   * an admission asks about the queue that admission would produce -- and when it stops the
   * run, the task was never admitted and the seat was never marked running. A check placed
   * after the mutation leaves a task nothing will dispatch and a seat nothing will free, which
   * is a dispatcher state no reader could interpret and no resume could continue from.
   */
  #breachedNow(projection: Partial<CeilingState> = {}): CeilingBreach | undefined {
    if (!this.#opts.ceilings) return undefined
    return breached(this.#opts.ceilings, { ...this.#ceilingState(), ...projection })
  }

  async #runLoop(goal: string, handle: RunHandle | undefined): Promise<RunOutcome> {
    const lead = this.participants.find((p) => p.rank === 'advisor')!
    const seats = this.#implementers()
    /** Absent on every run that did not declare one (#72); the whole of D1's "expressible and off". */
    const reviewerSeat = this.#reviewerSeat()
    /** Named, not chosen: whose role an instruction that targets nothing resolves against. */
    const impl = this.#leadImplementer()

    // `to` is the whole of it. `#record` derives `restricted` and `excluded` from the gap
    // between recipients and participants, so a goal the implementer does not get is
    // audited as a withheld human message without any special casing here.
    this.#record({ from: 'human', fromRank: 'human', to: [lead.id], kind: 'goal', text: goal })

    // A prior run's routing log, replayed. Both seats get it: the implementer needs the
    // work already done, and the advisor needs to know what it already decided -- an advisor
    // that re-issues an instruction the log shows as completed is the failure this prevents.
    const prior = this.#opts.resume?.length ? `${resumeBriefing(this.#opts.resume)}\n\n` : ''

    // Every seat, sequentially and in join order. A seat that was never briefed does not know
    // it is in a relay, what it may not assume about the goal, or what the subagent rule is --
    // and it would find out only by receiving its first instruction cold, which is not a
    // failure anything reports. At N=1 this is the one exchange it has always been.
    for (const seat of seats) {
      await this.#exchange(
        seat,
        `${IMPLEMENTER_BRIEFING}\n\n${SUBAGENT_BRIEFING}\n\n${WITHHELD_GOAL_NOTICE}\n\n${prior}Acknowledge briefly; do not start work yet.`,
      )
    }
    // The reviewer's own opening turn, sent `REVIEWER_BRIEFING` instead of
    // `IMPLEMENTER_BRIEFING` -- it is rank `implementer` but not one of `seats` above, which
    // is filtered on role precisely so this loop does not tell it it writes code (#72).
    if (reviewerSeat) {
      await this.#exchange(
        reviewerSeat,
        `${REVIEWER_BRIEFING}\n\n${SUBAGENT_BRIEFING}\n\n${WITHHELD_GOAL_NOTICE}\n\n${prior}Acknowledge briefly; do not start work yet.`,
      )
    }
    let next = await this.#exchange(
      lead,
      `${LEAD_BRIEFING}\n\n${SUBAGENT_BRIEFING}\n\n` +
        // Only when there is more than one seat to address. See MULTI_SEAT_BRIEFING: an advisor
        // that never hears the syntax never writes it, and the default run's briefing is
        // byte-identical to what it has always been.
        //
        // Read off `targetingWatch.applicable`, which is `#implementers().length > 1` resolved
        // from the options at construction (#79). The same condition it always was, asked in
        // one place: the instrument that counts whether the advisor USED the syntax must be
        // measuring exactly the runs that were TAUGHT it, and two expressions for one question
        // is how that stops being true.
        `${this.targetingWatch.applicable ? `${MULTI_SEAT_BRIEFING}\n\n` : ''}` +
        // Only when a reviewer is declared, for the same reason (#72). The default run pays
        // nothing for this either.
        `${reviewerSeat ? `${REVIEWER_BRIEFING_FOR_ADVISOR}\n\n` : ''}` +
        `${this.#opts.operator === 'agent' ? `${AGENT_OPERATOR_NOTICE}\n\n` : ''}` +
        `${prior}The goal for this session:\n\n${goal}\n\nGive the implementer its first instruction.`,
    )

    const maxAdvisorTurns = boundOf(this.#opts)
    this.#startedAt = this.#now()
    // The ceiling window opens here, so the pause ledger is baselined here too. See
    // `#suspendedAtStart`: only suspensions INSIDE the window may be subtracted from it.
    this.#suspendedAtStart = handle?.suspendedMs ?? 0
    this.#windowOpened = true
    this.#worktreesAtStart = worktreePaths(this.#opts.cwd)
    this.#worktreesSeen = new Set(this.#worktreesAtStart)
    // Best-effort and only ever read as a fallback (`#admitReview`): a repo with no commits
    // yet leaves this `undefined`, and `reviewPrompt`'s caller already treats a missing base
    // as `HEAD`.
    if (reviewerSeat) this.#runStartSha = integrationHead(this.#opts.cwd)
    // Every seat the SCHEDULER may dispatch to -- `#dispatchSeats()`, rank-based, not `seats`
    // above -- because a review task is dispatched through this exact table and a reviewer
    // seat absent from it could never be assigned one.
    this.#seatState = new Map(
      this.#dispatchSeats().map((p): [string, SeatExecution] => [
        p.id,
        { seat: p.id, role: p.role, state: 'idle', idleSince: this.#startedAt, dispatched: 0 },
      ]),
    )
    // The target for an instruction that names none, which is every instruction the advisor can
    // currently write: there is no target syntax in its briefing, and inventing one here would
    // change what the advisor is asked to produce rather than how the relay schedules it. The
    // ROLE rather than the seat id, because the rule that resolves it -- longest-idle seat
    // filling the role -- is the same rule at any N, and at N=1 it has exactly one answer.
    //
    // The LEAD implementer's role, read off the option the caller wrote rather than off
    // whichever seat a rank scan returned first. At N>1 with seats in different roles those
    // two are different answers, and only one of them is something a caller decided.
    const untargeted: TaskTarget = { kind: 'role', role: impl.role }
    /**
     * Where an instruction that names no target actually goes.
     *
     * The role — unless EVERY seat that could fill it is blocked, in which case the oldest
     * block, by name, because there is nothing else the work could reach.
     *
     * The condition used to be "any seat is blocked", which at N=1 is the same question and at
     * N>1 is starvation: one seat failing to merge redirected every subsequent untargeted
     * instruction onto it, so the free seats sat idle while the blocked one collected work it
     * is not allowed to do — and `canTake` would have refused all of it anyway, leaving the
     * queue holding tasks nothing could dispatch. A blocked seat is now reached the way the
     * advisor is told to reach it: BY NAME, with `@seat`, which `#purposeFor` designates as
     * that seat's repair.
     *
     * At N=1 the two conditions cannot differ. The one compatible seat being blocked is both
     * "a seat is blocked" and "every seat is blocked", so the single-seat repair path is the
     * one it has always been: the redirect, the designation, and the instruction that arrives.
     *
     * Oldest block first: `#blocked` is insertion-ordered, and only blocks on seats this target
     * could have reached are considered.
     */
    const untargetedTarget = (): TaskTarget => {
      const compatible = seatsFor([...this.#seatState.values()], untargeted)
      const stuck = [...this.#blocked.keys()].find((id) => compatible.some((s) => s.seat === id))
      const allBlocked = compatible.every((s) => s.state === 'merge_blocked')
      return allBlocked && stuck !== undefined ? { kind: 'seat', seat: stuck } : untargeted
    }

    /**
     * What a task admitted at this target is FOR.
     *
     * `merge_resolution` for anything that names a blocked seat, and `work` for everything
     * else. Still a fact about ROUTING rather than a reading of the instruction: the seat table
     * says the seat is blocked, and the reply named that seat. Nothing here parses prose, which
     * is the property `TaskPurpose` exists to keep — an advisor that happened to write "resolve
     * the conflict" in ordinary work must not slip onto a blocked seat, and one that wrote a
     * repair in different words must not be locked out of its own.
     *
     * Read off `#seatState` rather than `#blocked` deliberately: `canTake` decides whether the
     * dispatch is legal from the seat table, and a designation taken from a different structure
     * could disagree with the check that acts on it.
     */
    const purposeFor = (target: TaskTarget): TaskPurpose =>
      target.kind === 'seat' && this.#seatState.get(target.seat)?.state === 'merge_blocked'
        ? 'merge_resolution'
        : 'work'

    /**
     * Turns that have been sent and not yet come back, keyed by task id.
     *
     * The stored promise NEVER rejects: a turn that throws pushes its error onto `arrived` and
     * is re-raised when the dispatcher gets to it. An unhandled rejection here would be a
     * process-level crash raised from whichever seat happened to fail first, rather than the
     * run outcome the caller is waiting on.
     */
    const inflight = new Map<string, Promise<void>>()
    /**
     * Completed turns in the order they were OBSERVED, which is the order they are processed.
     *
     * An array rather than `Promise.race` alone. Racing tells you that SOMETHING finished; with
     * two already-settled promises it resolves in argument order, which is admission order
     * wearing a disguise. The push below happens inside each turn's own continuation, so this
     * list is arrival order by construction, and `Promise.race` is used only to wait.
     */
    const arrived: Completion[] = []
    /**
     * Tasks whose turn came back as a THROW and was re-raised, which ends the run.
     *
     * Kept because the re-raise is what removes them from every other account: the task has left
     * `inflight` and has been shifted off `arrived`, so by the time the `finally` below runs,
     * `outstanding()` is zero and the note that names lost turns had nothing to name. At N=1 that
     * made the note unreachable on the only two endings it exists for -- a turn abandoned by
     * `stop()` (#143) and a turn that threw -- which is to say, unreachable.
     *
     * A turn that threw is the plainest case of the thing the note is about: the instruction went
     * out and no report came back.
     */
    const abandoned: string[] = []
    /**
     * Turns this run still owes an answer to: sent and not back, or back and not yet processed.
     *
     * Both, and the second is not pedantry. A turn that has arrived has left `inflight` and has
     * NOT been graded, integrated or routed — so a check that asked only about `inflight` would
     * see a run with two finished reports sitting in the queue as a run with nothing
     * outstanding, end it, and lose them. It did exactly that before this existed.
     */
    const outstanding = (): number => inflight.size + arrived.length

    /**
     * Send one admitted task to the seat it was assigned, and do not wait for it.
     *
     * The report is recorded HERE, the moment the turn comes back, rather than when the
     * dispatcher gets round to it. `#record` stamps `seq` from one global counter at the moment
     * of recording, so that sequence is the run's real order — a report held back until its
     * predecessor had been through an advisor turn would be stamped after instructions that
     * were written later than it arrived, and the routing log would disagree with the run it
     * describes.
     */
    const launch = (task: Task, exec: SeatExecution): void => {
      const seat = this.#participants.get(exec.seat)!
      this.#record({ from: lead.id, fromRank: 'advisor', to: [seat.id], kind: 'instruction', text: task.instruction })
      const aside = this.#drain(seat.id)
      this.#sending(task)
      const work = (async (): Promise<Completion> => {
        const report = await this.#exchange(
          seat,
          [aside, envelope({ from: lead.id, fromRank: 'advisor', fromRole: lead.role, kind: 'instruction', text: task.instruction })]
            .filter(Boolean)
            .join('\n\n'),
        )
        const recorded = this.#record({
          from: seat.id,
          fromRank: 'implementer',
          to: [lead.id],
          kind: 'report',
          text: report.prose,
          ...(report.unsettled ? { unsettled: true } : {}),
        })
        // The seat is now `integrating`: not running, and not available. Its verdict has not
        // been graded yet, and until it has, nothing can be dispatched to it.
        this.#reported(task, exec, recorded.seq, report.unsettled)
        return { task, seat, exec, report }
      })()
      inflight.set(
        task.id,
        work
          .then(
            (c) => void arrived.push(c),
            (error: unknown) => void arrived.push({ task, seat, exec, error }),
          )
          .finally(() => void inflight.delete(task.id)),
      )
    }

    /**
     * Send everything the queue can send right now, and return the ceiling that stopped it.
     *
     * Called twice per iteration and for different reasons: after admission, so a reply naming
     * two seats puts both to work in the same advisor turn; and again after a seat is released,
     * so a freed seat with ready work does not idle through an advisor turn to collect it.
     *
     * The concurrency ceiling has two readings here and the difference is deliberate. When
     * nothing is in flight, a breach means NOTHING can run and the run ends, which is what a
     * ceiling has always done and is exactly the N=1 behaviour (`concurrentSeats` is 0 at every
     * boundary the loop checks, so only `--max-concurrent-seats 0` breaches, and ending is the
     * only honest answer to "no seat may work"). When something IS in flight the same breach
     * means only "not yet": the limit is on simultaneity, so honouring it by leaving the task
     * ready IS obeying it, and ending a run that is progressing would be the ceiling doing
     * something nobody asked it to.
     */
    const dispatchReady = (): CeilingBreach | undefined => {
      for (;;) {
        // Before choosing anything, take out the work that can never run. A dependent of a
        // failed or cancelled task is not waiting -- `dependenciesMet` reads a persistent fact,
        // so its dependency keeps having failed and it can never become ready. Left in the
        // queue it is invisible: no seat holds it, nothing is outstanding, and the run reports
        // healthy while making no progress.
        //
        // Here rather than at the call sites: there are two of them now, and a sweep at one of
        // them is a sweep somebody has to remember at the other. This is the one place that
        // asks the queue what to do next, so it is the one place the question has to be asked
        // of a queue that holds nothing unrunnable.
        this.#cancelUnrunnable()
        const d = nextDispatch(this.#queue, this.#taskRuntime, [...this.#seatState.values()])
        if (!d) return undefined
        const wouldRun = this.#breachedNow({
          concurrentSeats: concurrentSeats([...this.#seatState.values()]) + 1,
        })
        if (wouldRun) return inflight.size > 0 ? undefined : wouldRun
        this.#assign(d.task, d.seat)
        launch(d.task, d.seat)
      }
    }

    // The dispatcher. One iteration is one ADVISOR TURN: the advisor's standing reply is read
    // as assignment decisions, every decision in it is admitted, everything the seat table can
    // take is sent, and then the FIRST turn to come back is processed and routed — while its
    // siblings are still running.
    //
    // At N=1 this produces exactly the turns the exchange loop it replaced produced, in the
    // same order and with the same routing log: one reply carries one instruction, one seat can
    // take it, and the set of things in flight is always that one task, so "the first to come
    // back" and "the one that was sent" are the same turn (D1). Nothing here counts seats.
    //
    // `maxAdvisorTurns` bounds these iterations. That is the thing it has always counted --
    // one pass through here has always cost the advisor exactly one turn -- so the bound is
    // named for what it measures rather than for the shape it used to sit inside.
    /**
     * The ending this run has settled on, once it has settled on one. Admission stops; the
     * turns already sent do NOT.
     *
     * D2's scopes are the reason this exists rather than a `return`. `advisor_escalated` stops
     * "admission of new tasks; in-flight seats drain", and a seat-scoped condition stops that
     * seat and no other — so a run that returned the moment it decided to end was applying a
     * conclave-wide scope to every condition, whatever the classification on the pause said.
     * The turns it abandoned had been paid for, their work was on disk, and the only record was
     * a note saying their reports were never received.
     *
     * Two arms because two kinds of ending arrive differently. `end` is a reason this loop
     * decides for itself and `#end` is deferred until the drain finishes, so `run_end` is the
     * last thing on the stream. `outcome` is an ending `#halt` already performed — it calls
     * `#end` itself, so `run_end` is emitted at the halt and the drain's messages follow it on
     * the routing log. That ordering is imperfect and it is the honest trade: the alternative is
     * predicting inside the dispatcher whether a halt will end the run.
     */
    type Closing =
      | { kind: 'end'; reason: RunReason; detail?: string }
      | { kind: 'outcome'; outcome: RunOutcome }
    let closing: Closing | undefined

    /**
     * Cross a task's boundary and act on what came back -- merge, judge the integrated tree,
     * escalate a repeat conflict. Exactly the logic that used to run unconditionally once a
     * turn was graded; factored out so a REVIEWED task can reach it too, on ACCEPT, deferred
     * until then (#72).
     *
     * Returns whether the caller must `continue advisor`. A labelled continue cannot cross a
     * function boundary, so the decision to take it has to come back to the loop that owns
     * the label rather than being taken here.
     */
    const crossAndSettle = async (
      boundaryTask: Task,
      seatId: string,
      boundaryExec: SeatExecution,
    ): Promise<boolean> => {
      const boundary = await this.#crossBoundary(boundaryTask, seatId)
      if (boundary.kind === 'blocked') this.#failBoundary(boundaryTask, boundaryExec)
      else this.#integrate(boundaryTask, boundaryExec)

      if (boundary.kind === 'integration_red') {
        if (closing) {
          this.#record({
            from: 'orchestrator',
            fromRank: 'human',
            to: [],
            kind: 'note',
            text:
              `the integration checkout is red after the final merge (${boundary.contributors
                .map((c) => c.taskId)
                .join(' + ')}) and no seat remains to repair it; the run reports it as its outcome`,
          })
        } else {
          this.#tellLeadIntegrationRed(boundary)
        }
      }

      if (boundary.kind === 'blocked' && boundary.escalate) {
        const halted = await this.#halt(handle, {
          subject: { reason: 'merge_blocked', participant: boundary.seatId },
          detail: boundary.detail,
          evidence: boundary.evidence,
        })
        if (halted) {
          closing ??= { kind: 'outcome', outcome: halted }
          return true
        }
        const block = this.#blocked.get(boundary.seatId)
        if (block) block.attempts = 1
      }
      return false
    }

    /**
     * Act on a reviewer's verdict for the task named by `reviewTask.parent` (#72).
     *
     * ACCEPT crosses that task's boundary for real -- deferred exactly until now, since
     * nothing before this point knew the work would be kept. REJECT admits the repair
     * automatically, addressed to the producing seat by name; a repair whose OWN parent is
     * itself a `review_resolution` task is the second rejection of the same work, and that
     * escalates instead of trying a third time. See `Task.parent`.
     *
     * Returns whether the caller must `continue advisor`, for the reason `crossAndSettle`
     * does.
     */
    const resolveReview = async (reviewTask: Task, prose: string): Promise<boolean> => {
      const reviewedId = reviewTask.parent!
      const reviewed = this.#queue.find((t) => t.id === reviewedId)!
      const producingSeatId = this.#taskRuntime.get(reviewedId)!.seat!
      const producingExec = this.#seatState.get(producingSeatId)!
      const verdict = parseReviewVerdict(prose)

      if (verdict.accepted) {
        this.#record({
          from: 'orchestrator',
          fromRank: 'human',
          to: [],
          kind: 'note',
          text: `review accepted ${producingSeatId}'s work for ${reviewedId}`,
        })
        return crossAndSettle(reviewed, producingSeatId, producingExec)
      }

      this.#failReview(reviewed, producingExec)
      const secondRejection = reviewed.purpose === 'review_resolution'
      this.#record({
        from: 'orchestrator',
        fromRank: 'human',
        to: [],
        kind: 'note',
        text: `review rejected ${producingSeatId}'s work for ${reviewedId}: ${verdict.reason}`,
      })
      if (secondRejection) {
        const halted = await this.#halt(handle, {
          subject: { reason: 'review_blocked', participant: producingSeatId },
          detail: `${producingSeatId}'s work was rejected by review a second time: ${verdict.reason}`,
          evidence: [
            `the first rejection produced an automatic repair, which was dispatched and returned`,
            `the repair was rejected again by the same reviewer`,
            // This line used to read "the work is committed and its tree is retained" (#158).
            // What is actually known here is narrower than that: NO BOUNDARY HAS RUN. A
            // rejection crosses none -- `#awaitReview` leaves the task `reported`, and
            // `#crossBoundary` runs from `crossAndSettle` only on ACCEPT -- so nothing this
            // orchestrator does has called `commitSeatWork` for this work.
            //
            // What the tree therefore holds is not something the relay determines, and the
            // old line was not a false claim so much as an UNOBSERVED one. It can happen to
            // be true: an implementer that commits its own work leaves the tree clean, and a
            // repair that changed nothing leaves it as it was. It can equally be false, which
            // is the ordinary case: a seat that reported without committing is holding the
            // rejected work uncommitted right now. The line said the same thing either way,
            // having read nothing -- and it said it at the one moment an operator is deciding
            // whether the tree is disposable, which is when being wrong costs them the work.
            //
            // So read the tree and say what is in it, the same way the merge-conflict and
            // boundary-error notices now do (#150, #151). Retention is kept, as a suffix,
            // because it is true on its own terms and the operator needs it: nothing removes
            // a seat worktree mid-run -- `#cleanupWorktrees` runs from `stop()`, after the
            // children are closed -- so the tree named above is on disk to be inspected while
            // this pause stands. What that later cleanup does is governed by `blockedFrom`,
            // which removes a tree only when it is present, clean, and holds no commit the
            // integration checkout lacks; anything the read above found is itself a reason to
            // keep it. The suffix therefore does not depend on the read, which is exactly why
            // it can be stated flatly next to a clause that does.
            `${uncommittedClause(this.#rootOf(producingSeatId))}; that worktree is retained`,
          ],
        })
        if (halted) {
          closing ??= { kind: 'outcome', outcome: halted }
          return true
        }
        return false
      }
      // The repair, addressed to the producing seat automatically -- review is a task the
      // scheduler dispatches, so this needs no advisor instruction to reach it, the same way
      // the review that rejected it needed none to be sent.
      this.#admit(
        `Review rejected this work: ${verdict.reason}\n\nOriginal instruction:\n${reviewed.instruction}`,
        { kind: 'seat', seat: producingSeatId },
        reviewTask.origin,
        'review_resolution',
        reviewedId,
      )
      return false
    }

    try {
      // Labelled, because several of the sites that set `closing` are inside the admission loop
      // and a bare `continue` there would go round the inner one.
      advisor: for (let advisorTurn = 1; ; advisorTurn++) {
        // The drain is over when nothing is outstanding. Everything below is skipped while
        // `closing` is set, so this is the only way out of a run that has decided to end.
        if (closing && outstanding() === 0) {
          return closing.kind === 'end'
            ? this.#end(closing.reason, closing.detail)
            : this.#redAware(closing.outcome)
        }
        if (!closing) {
        // What this turn did about assigning work, and the ONLY thing the instrument reads (#79).
        //
        // Declared out here and finalized in the `finally` below, so that every way out of this
        // block -- the ceilings, the halts, the re-asks, the `return`s, a throw, and whatever
        // exit is added next -- passes the one recording site. See `#finaliseTargeting`: the
        // denominator contract is kept by that placement and by nothing else.
        let attempt: AdvisorAttempt | undefined
        try {
        // Every ceiling at the dispatch boundary, before anything is admitted or assigned, and
        // never mid-turn. A run cannot be interrupted mid-turn without discarding that turn's
        // work -- the same reason #exchange has no timeout of its own.
        if (advisorTurn > maxAdvisorTurns) {
          // Named and quantified, never bare. `budget` alone is the same word a run gets when it
          // exhausts a ceiling the operator chose deliberately, so a run that stopped at a
          // default nobody knew they had reads as normal operation -- which is #119: eight
          // advisor turns spent against a `--max-turns 40` the operator believed had raised
          // them, and the early ending was then filed as a defect in something else. The reason
          // stays `budget` because that is what ended the run and every caller keys on it; the
          // detail says WHICH ceiling and WHAT it was set to, in the shape `breached` uses for
          // the ceilings that already carry one -- but saying `budget`, not `ceiling`. The two
          // words are held apart on purpose (see `report.test.ts`: a resource ceiling gets its
          // own reason), and this detail is what makes the distinction legible instead of
          // leaving `budget` to stand for whichever limit it happened to be.
          //
          // No flag is named here and no turn is called a round. The relay does not know which
          // front-end started it -- an embedder setting `maxAdvisorTurns` directly has no
          // `--rounds` to raise -- and "round" is the operator-facing word this option was
          // renamed away from (see `RelayOptions.maxRounds`). The flag belongs to the launch
          // banner, which is the surface that owns flags and now prints every ceiling with one.
          closing ??= {
            kind: 'end',
            reason: 'budget',
            detail: `advisor turn budget spent: ${maxAdvisorTurns} of a maximum ${maxAdvisorTurns}`,
          }
          continue advisor
        }
        const ceiling = this.#breachedNow()
        if (ceiling) {
          this.#record({
            from: 'orchestrator',
            fromRank: 'human',
            to: [],
            kind: 'note',
            text: ceiling.detail,
          })
          // The clock stops HERE, not at `#end`. The detail above quotes the reading the ceiling
          // was checked against, and the run then drains whatever seats are still working before
          // it can end -- so a terminal reading taken after the drain is a different number from
          // the one the operator is being shown, on a run whose whole claim is that `activeMs`
          // IS the value handed to `breached`. Two expressions that merely agree on a quiet run
          // is exactly what this change set out to stop having.
          //
          // Draining is teardown, not run time. The ceiling has already decided the run is over;
          // what follows is letting seats finish so their work is not discarded, and charging the
          // operator's allowance for it would be charging them for the ending itself. Raised by
          // an independent review, which found the two readings could differ only when seats were
          // still outstanding -- the case the equality test happened not to cover.
          this.#stopClock()
          closing ??= { kind: 'end', reason: 'ceiling', detail: ceiling.detail }
          continue advisor
        }
        // NOT drained, and the one exit that is not. `stop()` is closing the sessions out from
        // under these turns, so waiting for them is waiting for children that are being taken
        // away — the `finally` below names what was in flight instead.
        if (this.#stopped) return this.#end('stopped')

        if (this.#pauseRequested) {
          const reason = this.#pauseRequested
          this.#pauseRequested = undefined
          const halted = await this.#halt(handle, {
            subject: { reason: 'operator_requested' },
            detail: reason,
            evidence: [`advisor turn ${advisorTurn} of ${maxAdvisorTurns}; no turn is in flight`],
          })
          if (halted) {
            closing ??= { kind: 'outcome', outcome: halted }
            continue advisor
          }
        }

        // Lifted before anything else looks at the reply: a NOTE line is addressed to the
        // human, so it must not reach the implementer as part of the instruction, and it must
        // not make an otherwise-empty reply look like a real instruction either.
        const { notes, rest: withoutNotes } = splitNotes(next.prose)
        for (const note of notes) {
          this.#record({ from: lead.id, fromRank: 'advisor', to: [], kind: 'note', text: note })
        }

        let instruction = withoutNotes.trim()

        // A reply that was ONLY notes is not a failure to instruct -- it is the advisor using
        // the channel that was just given to it. Halting there would end a run because the
        // advisor said something useful, so it is asked once for the instruction that goes with
        // the note. Bounded: this happens inside the advisor turn, and the guard below still catches a
        // second empty reply.
        if (instruction === '' && notes.length > 0 && next.end.verdict.outcome === 'completed') {
          next = await this.#exchange(
            lead,
            this.#drain(lead.id) ||
              'Your note is recorded for the operator. Now give the implementer its next ' +
                'instruction, or reply exactly DONE.',
          )
          const second = splitNotes(next.prose)
          for (const note of second.notes) {
            this.#record({ from: lead.id, fromRank: 'advisor', to: [], kind: 'note', text: note })
          }
          next = { ...next, prose: second.rest }
          // Recomputed, not left stale: everything below -- the DONE check, the guard, the
          // routing -- reads `instruction`, and after a re-ask the old value is a different
          // turn's reply.
          instruction = second.rest.trim()
        }

        // The reply, read as assignment decisions. Fails closed: a reply that does not parse
        // cleanly -- including one naming a seat id or role the run does not have -- is treated
        // exactly as an empty instruction is treated today, by the guard immediately below.
        // Guessing at an ambiguous reply would let a parser invent work nobody authorised, and
        // guessing at an unrecognised target would let it invent a seat.
        const decisions = parseDecisions(instruction, [...this.#seatState.values()], untargetedTarget())

        // The advisor's verdict may already be stale by the time we read it, exactly as an
        // implementer's can be -- and until now only the implementer's was resolved.
        //
        // `#exchange` settles on the FIRST `turn_end`, and the late signal that withdraws it
        // lands during the transcript settle window that follows: the same window that exists
        // because a late `Stop` is expected. The implementer path has read through that
        // withdrawal since the pause it was written for; the advisor path read `next.end`
        // directly, so an advisor turn whose `timed_out` was retracted and replaced with
        // `completed` was still failed, halted on, re-asked, and -- since #79 put a recorder on
        // that path -- recorded as an `incomplete` targeting attempt. Every one of those is a
        // decision taken on a verdict the system had already talked itself out of, and the
        // targeting record is the one that outlives the run: a turn whose reply was whole and
        // whose adapter said so was filed as evidence that could not be trusted.
        //
        // Resolved BEFORE the guard, not beside it, so there is one answer rather than a
        // dispatch decision and a record that can disagree about which verdict this turn ended
        // on. With no revision -- every ordinary turn -- `supersessionOf` returns undefined and
        // `current` is `next.end`, so nothing about the common path moves.
        const superseded = supersessionOf(lead.events, next.end)
        const current = superseded?.replacement ?? next.end
        if (superseded) {
          this.#record({
            from: 'orchestrator',
            fromRank: 'human',
            to: [],
            kind: 'note',
            text:
              `${lead.id}'s ${next.end.verdict.outcome} verdict was withdrawn (${superseded.revision.reason})` +
              (superseded.replacement
                ? ` and replaced with ${formatVerdict(superseded.replacement.verdict)}`
                : ` with no replacement`),
          })
        }
        // A withdrawal with no replacement leaves any pause below resting on a verdict that is
        // already retracted, so it says so from the moment it is raised. The implementer path's
        // `pre`, and the same reasoning: the operator must not be asked to adjudicate a claim
        // the system has withdrawn without being told it was withdrawn.
        const preSuperseded: PauseSupersession | undefined =
          superseded && !superseded.replacement
            ? {
                at: Date.now(),
                note:
                  `the ${next.end.verdict.outcome} verdict this pause was raised on had already been ` +
                  `withdrawn (${superseded.revision.reason}) with no replacement`,
              }
            : undefined

        // Armed HERE, before anything below can pause, rather than beside the halt it was
        // written for. `#trackSupersession` keys off this field and nothing else, so a pause
        // raised while it is unset cannot be amended when the verdict behind it is withdrawn --
        // and "the halt is the next statement" is a property of today's code, not a rule. It is
        // cleared after that halt, as it always was: past the pause there is nothing left to
        // amend, and leaving it armed across the re-ask below would let the NEXT turn's
        // `turn_end` be read as this one's replacement.
        //
        // The verdict branch only. A completed turn has no verdict for a revision to withdraw,
        // and a pause raised on something else -- an adjudication, an escalation -- is not
        // resting on this verdict and must not be told that it is.
        if (handle && current.verdict.outcome !== 'completed') {
          this.#verdictPause = {
            handle,
            participant: lead.id,
            endSeq: current.seq,
            outcome: current.verdict.outcome,
            withdrawn: preSuperseded !== undefined,
          }
        }

        // The turn is an assignment attempt from here on, and the instrument's record of it
        // starts now -- before the guard that can fail it, before the ceiling that can refuse
        // it, and before anything that can end the run (#79).
        //
        // A DONE and an ESCALATE are not attempts: they assigned nothing and were never asked to
        // name a seat, so `attempt` stays undefined and the finalizer records nothing. A REFUSED
        // reply is an attempt whatever form it was in -- the parser decides the form before it
        // validates anything, so `@seat nobody-here: do the thing` is positive evidence that the
        // briefing elicited the syntax, and an empty reply is a turn the advisor was asked for an
        // instruction and spent. Both belong in the denominator; only the first is elicitation,
        // and `addressed` is what keeps them apart.
        //
        // Nothing here changes the failure. This observes: the reply still fails whole, the halt
        // below still happens on the same terms, the advisor is still re-asked, and no name taken
        // from this attempt is ever routed to.
        if (!decisions.ok || decisions.decisions.some((d) => d.kind === 'instruct')) {
          attempt = {
            turn: advisorTurn,
            end: next.end,
            heldVerdict: current.verdict.outcome,
            // Off `parseDecisions`, never re-read from the prose and never inferred from the
            // targets: an addressed `@role implementer:` and an unaddressed reply on a run whose
            // fallback is that same role produce identical targets, so the target cannot answer
            // this question and a second regex here would be a second answer.
            addressed: decisions.form === 'addressed',
            // What the reply ASKED FOR. `namedTargets` reads them off whichever shape this reply
            // has -- a refusal carries them on `named`, a reply that parsed carries them on the
            // decisions -- so there is one reader rather than one per site.
            targets: namedTargets(decisions),
            ...(decisions.ok ? {} : { refusal: decisions.why }),
            admitted: false,
          }
          // The SAME object, under a second name, and that is the point rather than an oversight.
          // The instrument's live view of an open turn cannot be a copy: a copy is a second store
          // of one fact, and this file has just finished removing the last of those. Everything
          // the projection reads off it -- the turn number, `addressed`, the names -- is fixed
          // here and never mutated; `ceiling` and `admitted` change below and are deliberately
          // not part of `TargetingPending`, because they are outcomes and this turn has none yet.
          //
          // Cleared in `#finaliseTargeting`, which is the same synchronous block that appends the
          // record, so the turn is never both pending and recorded and never neither. Not gated
          // on `applicable`: that rule lives at the recorder and in the renderers, and a second
          // copy of it here is a rule that gets relaxed once.
          this.targetingWatch.pending = attempt
        }

        // An advisor turn that ended badly, or produced nothing that can be admitted, must not be
        // forwarded.
        //
        // The `turn_incomplete` guard below covers the IMPLEMENTER only, so an advisor whose
        // turn errored was relayed as an empty instruction: the implementer received a routing
        // header with no body, asked for a resend, and the run churned advisor turns toward its budget
        // instead of failing with the real reason. Observed live when Codex returned
        // `usage_limit_exceeded` -- the workspace was out of credits (issue #35).
        //
        // Two conditions, because they fail differently. A bad verdict carries a reason worth
        // reporting; an empty body on a clean verdict does not, and is the minimum bar either
        // way -- there is no circumstance in which relaying nothing is the right move.
        if (current.verdict.outcome !== 'completed' || !decisions.ok) {
          const why =
            current.verdict.outcome !== 'completed'
              ? `${lead.id} turn ended ${formatVerdict(current.verdict)}`
              : // EVERY parse failure, not just the empty reply: one sentence, and it is the one
                // an empty instruction has always produced. D4 says an unparseable reply is
                // treated exactly as an empty instruction is treated today, and a second wording
                // would be a divergence in the operator-visible path -- the kind the guards can
                // only pin as an exact string. `ParseFailure` still carries `why` and `detail`
                // for whenever surfacing them is a change somebody declares on purpose.
                `${lead.id} produced no instruction`
          const evidence = current.verdict.provenance.map((v) => `${v.source}: ${v.detail}`)
          this.#record({
            from: 'orchestrator',
            fromRank: 'human',
            to: [],
            kind: 'note',
            text: [why, ...evidence].join(' — '),
          })

          // A reply that USED the syntax and did not dispatch, counted here rather than lost (#79).
          //
          // The instrument used to record only after validation and queue admission, and BOTH
          // ways a turn can fail leave through this path -- so `@seat nobody-here: do the
          // thing`, which is positive evidence that the briefing elicited `@seat`, was recorded
          // as nothing at all and the run could afterwards report "NONE used @seat/@role". That
          // is the instrument reporting the opposite of what happened, in the direction that
          // sends a reader to rewrite a briefing that is working when what is wrong is the seat
          // names in it.
          //
          // Both ways, with no exception for the verdict. A turn that timed out holding an
          // `@seat` line is weaker evidence -- it may have been cut between the directive and
          // its body -- but excluding it would let a run whose advisor targeted every turn and
          // finished none report `NONE`, which is the same false negative with a different
          // cause. So it is recorded as `incomplete` rather than as `invalid`, carrying the
          // verdict that ended it, and the summary says the reading is uncertain instead of
          // saying nothing.
          //
          // The parser has already decided the form, before it validated anything, so nothing
          // is re-read from the prose here, and `namedTargets` reads the names off whichever
          // shape this reply has -- a refusal carries them on `named`, a reply that parsed and
          // then lost its turn carries them on the decisions.
          //
          // Nothing about the failure changes. This observes; the reply still fails whole, the
          // halt below still happens on the same terms, and the advisor is still re-asked. The
          // names are rendered for the record and never routed to: on a refusal one of them is
          // usually why this failed.
          if (decisions.form === 'addressed') {
            const named = namedTargets(decisions)
            // The RESOLVED verdict. A turn whose `timed_out` was withdrawn and replaced with
            // `completed` is not an incomplete turn, and saying so here would tell a reader the
            // reply could not be trusted when the adapter had already said otherwise.
            const failed = current.verdict.outcome
            // And the same fact in the log, beside the failure it explains. The note above says
            // the advisor produced no instruction, which is true and is the whole of what a
            // reader used to get; it does not say that the advisor was TRYING to address a seat,
            // which is the part that decides what to fix.
            //
            // The note is contemporaneous and the RECORD is not: the record is written at the
            // finalization site at the end of this turn, so that a verdict withdrawn while the
            // operator reads the pause below is reconciled before anything permanent is written.
            // When the two end up disagreeing the finalizer says so in its own note rather than
            // this one being retracted -- a log is an account of what was believed when, and a
            // line edited after the fact is a line nobody can date.
            //
            // Gated on `applicable` rather than on the recorder's answer, which is the same
            // field the recorder itself gates on: one-seat runs say nothing about targeting
            // anywhere.
            if (this.targetingWatch.applicable) {
              this.#record({
                from: 'orchestrator',
                fromRank: 'human',
                to: [],
                kind: 'note',
                text:
                  `the advisor's reply DID use @seat/@role — it named ${named.join(', ') || 'a target'} — ` +
                  (failed === 'completed'
                    ? `and was refused before dispatch (${decisions.ok ? 'refused' : `${decisions.why}: ${decisions.detail}`}). ` +
                      `Nothing was queued and the advisor is being asked again. This is not an advisor that ` +
                      `ignored the briefing: the syntax reached it, so the repair is the target it named or ` +
                      `the form of the reply, not the briefing's prose.`
                    : `and its turn ended ${failed}, so nothing was queued. Read it as UNCERTAIN and as ` +
                      `evidence of NEITHER kind: a reply cut off mid-directive may not be the form it ` +
                      `looks like, so this turn does not count as the briefing having elicited the ` +
                      `syntax — and it does not count against the briefing either.`),
              })
            }
          }

          // The watch that lets a revision arriving mid-pause amend THIS pause is already
          // armed -- see the registration above, which happens before anything in this turn can
          // pause. It is cleared below, after the halt returns.
          const halted = await this.#halt(handle, {
            // The ADVISOR's turn. The scope is the seat whose turn ended badly, which is not
            // always the implementer -- and reading it off `verdictOf` would tie the axis to a
            // field that only exists on the verdict-backed pauses.
            subject: { reason: 'turn_incomplete', participant: lead.id },
            detail: why,
            evidence,
            liveness: { participant: lead, emittedBefore: next.emittedBefore },
            verdictOf: { participant: lead.id, endSeq: current.seq },
            // Raised already-superseded when the verdict behind it was withdrawn with nothing
            // put in its place, so the operator is never asked to adjudicate a claim the system
            // has retracted without being told it was retracted.
            ...(preSuperseded === undefined ? {} : { superseded: preSuperseded }),
            // The advisor's own seat, and it latches on the same terms the implementer's does
            // (#107). An advisor that keeps tripping the same deadline puts the same question
            // just as often, and the answer is no more informative the ninth time for being
            // about the other seat.
            //
            // The VERDICT branch only. This condition covers two faults sharing one reason, and
            // the other is a completed turn whose reply would not parse -- which is followed by
            // a RE-ASK a few lines down, so latching it would turn a visible stall into a silent
            // loop churning advisor turns at the ceiling. A latch may make a question quieter;
            // it may not make a spin invisible.
            ...(current.verdict.outcome === 'completed'
              ? {}
              : { latch: { seat: lead, outcome: current.verdict.outcome, provenance: current.verdict.provenance } }),
          })
          this.#verdictPause = undefined
          if (halted) {
            closing ??= { kind: 'outcome', outcome: halted }
            continue advisor
          }
          // Unattended, `#halt` ends the run. Reaching here means an operator resumed, so the
          // advisor is asked again rather than the empty instruction being sent anyway.
          next = await this.#exchange(
            lead,
            this.#drain(lead.id) ||
              'Your previous turn produced no instruction. Give the implementer its next one.',
          )
          continue
        }

        // DONE and ESCALATE are whole-reply decisions and `parseDecisions` guarantees each
        // arrives alone -- a reply that mixed one with an assignment is a `mixed_keyword`
        // failure handled above, so reading the first decision here cannot be dropping work.
        const decision = decisions.decisions[0]!

        // A run with seats still working is not finished, whatever the advisor thinks. The
        // outstanding report is handed over first and the advisor is asked again, which is the
        // same shape as the human-outranks-DONE rule below: DONE is a proposal to end, and a
        // fact that contradicts it wins. Ending here instead would discard a turn that has
        // already been paid for, and would send the closing question to a seat mid-turn.
        //
        // At N=1 unreachable: the only turn in flight is the one just processed.
        if (decision.kind === 'done' && outstanding() > 0) {
          this.#record({
            from: 'orchestrator',
            fromRank: 'human',
            to: [],
            kind: 'note',
            text:
              `advisor reported the work complete while ${outstanding()} seat turn(s) are still outstanding — ` +
              `their reports come first, and it is asked again after each one`,
          })
        } else if (decision.kind === 'done') {
          // §7a, first paragraph: "The advisor can end the session; the human outranks that
          // and can send them back to work." Returning here regardless let the advisor
          // terminate an outstanding human instruction out of existence -- the human message
          // is queued for the next exchange, and if the advisor ends the session there is no
          // next exchange. That inverts the rank order the whole design rests on.
          //
          // Found by the first live pause run: the drift probe was injected at the pause and
          // never delivered, because the advisor considered the task finished.
          const outstanding = this.participants.filter((p) => (this.#pending.get(p.id) ?? []).length > 0)
          if (outstanding.length > 0) {
            this.#record({
              from: 'orchestrator',
              fromRank: 'human',
              to: [],
              kind: 'note',
              text:
                `advisor reported the work complete, but the human has an outstanding instruction for ` +
                `${outstanding.map((p) => p.id).join(', ')} — the human outranks the advisor, so the ` +
                `session continues rather than ending`,
            })
            // Every seat holding a human message, not just one. `outstanding` above already
            // counts them all -- it is what decided the session continues -- so draining a
            // single seat would name several in the note and then answer for one, leaving the
            // rest queued behind an advisor that has been told the work is done.
            const answers: string[] = []
            for (const seat of seats) {
              if ((this.#pending.get(seat.id) ?? []).length === 0) continue
              const extra = await this.#exchange(seat, this.#drain(seat.id))
              this.#record({ from: seat.id, fromRank: 'implementer', to: [lead.id], kind: 'report', text: extra.prose })
              answers.push(envelope({ from: seat.id, fromRank: 'implementer', fromRole: seat.role, kind: 'report', text: extra.prose }))
            }
            next = await this.#exchange(lead, [this.#drain(lead.id), ...answers].filter(Boolean).join('\n\n'))
            // Bounded by the advisor-turn budget like everything else, so a human who keeps talking
            // extends the session rather than making it unstoppable.
            continue
          }
          this.#record({ from: lead.id, fromRank: 'advisor', to: [], kind: 'note', text: `advisor reports the work complete: ${instruction}` })
          // Asked of every seat, in join order. The guarantee is "the implementer's last word",
          // and a seat that worked and was never asked is exactly the silent loss this exists to
          // prevent -- `#closingQuestion` already returns immediately for a seat that never
          // worked, so at N=1 nothing about this changed.
          for (const seat of seats) await this.#closingQuestion(seat)
          return this.#end('done', instruction)
        } else if (decision.kind === 'escalate') {
          this.#record({ from: lead.id, fromRank: 'advisor', to: [], kind: 'note', text: instruction })
          const halted = await this.#halt(handle, {
            subject: { reason: 'advisor_escalated' },
            detail: instruction,
            evidence: [`the advisor asked for a human rather than issuing an instruction`],
          })
          // D2 gives this condition the scope "admission of new tasks; in-flight seats drain",
          // and that is exactly what setting `closing` does: nothing more is admitted, and the
          // seats already working finish, are graded and integrated, and have their reports
          // routed before the run returns.
          if (halted) {
            closing ??= { kind: 'outcome', outcome: halted }
            continue advisor
          }
          // Resumed. The advisor said its piece and the human decided otherwise, so it is
          // asked again rather than having its escalation replayed as an instruction.
          next = await this.#exchange(lead, this.#drain(lead.id) || 'The human has seen your escalation and asked you to continue. Give the implementer its next instruction.')
          continue
        } else {
          // EVERY decision the reply carried, admitted in the order it was written. Taking the
          // first and dropping the rest would be the dispatcher silently running a quarter of a
          // plan the advisor wrote as one -- and `parseDecisions` is atomic, so a list that got
          // here is a list that validated whole.
          // The queue ceiling, asked once for the WHOLE batch and before any of it is admitted.
          //
          // Projected, because the actual depth at every boundary the loop can check is the
          // depth before the advisor's decision is applied, and a ceiling that only ever saw
          // that would never see a queue at all. `+ incoming` rather than `+ 1` is the peak the
          // batch reaches: admission happens before any dispatch, so all of them are queued at
          // once, and at N=1 with one decision it is the `+ 1` this always asked.
          //
          // ALL OR NONE, and that is the point of moving it out of the loop. Checking per
          // decision meant a reply whose fourth task crossed the ceiling ended the run with
          // three tasks already admitted and nothing left running to dispatch them -- records
          // stuck at `admitted` forever, which is precisely the "leaves nothing behind" property
          // the check was placed before the mutation to get.
          const incoming = decisions.decisions.filter((d) => d.kind === 'instruct').length
          const wouldQueue = this.#breachedNow({
            queueDepth: queueDepth(this.#queue, this.#taskRuntime) + incoming,
          })
          if (wouldQueue) {
            this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: wouldQueue.detail })

            // A batch stopped by a ceiling, marked so the finalizer can classify it (#79).
            //
            // This was the last place the instrument recorded the opposite of what happened,
            // and the worst of them, because the evidence it threw away was the best it can
            // collect short of admission: the reply was written whole, `parseDecisions`
            // accepted it, every seat it named exists, and the only thing that stopped it is a
            // limit the operator set. Recording sat BELOW this check, and this check exits the
            // advisor loop, so a run that ended on the queue ceiling at its first addressed turn
            // reported that no turn had ever used the syntax. `NONE used @seat/@role` about the
            // one reply that proved the briefing works.
            //
            // The exit is why the mark is here and the write is not. `continue advisor` with
            // `closing` set is the end of this run's dispatching, and an instrument that has to
            // remember to write something above every such exit is an instrument that loses a
            // turn the next time one is added. So this sets a field, and the turn is recorded on
            // its way out whatever route it takes.
            //
            // BOTH forms, which is the change from the version that only marked the addressed
            // one. An unaddressed batch stopped here is a whole valid reply that named nobody,
            // and dropping it shrank the denominator that every ratio above is read against.
            // It is not credited as under-use either -- `unaddressedTurns` means one instruction
            // went out by fallback, and nothing went out here -- so it lands in
            // `unaddressedFailedTurns`, counted and credited to nothing.
            //
            // Nothing about the ceiling changes. This observes: the batch is still refused
            // whole, `closing` is still set, and nothing is routed to a name from this record.
            // WHICH ceiling, from the breach rather than from the call site. This projection
            // asks every ceiling, so a batch can be stopped here by the duration or the turn
            // ceiling with its instructions still unadmitted, and a record that hard-coded
            // `queue_depth` would name the wrong limit to raise.
            if (attempt) attempt.ceiling = wouldQueue.kind
            if (decisions.form === 'addressed') {
              const named = namedTargets(decisions)
              if (this.targetingWatch.applicable) {
                this.#record({
                  from: 'orchestrator',
                  fromRank: 'human',
                  to: [],
                  kind: 'note',
                  text:
                    `the advisor's reply DID use @seat/@role — it named ${named.join(', ') || 'a target'} — ` +
                    `and the ${wouldQueue.kind} ceiling refused the whole batch before any of it was ` +
                    `admitted, so nothing was queued. The reply was valid and the seats it named exist: ` +
                    `the briefing is working, and what stopped this run is the ceiling, not the advisor.`,
                })
              }
            }
            closing ??= { kind: 'end', reason: 'ceiling', detail: wouldQueue.detail }
            continue advisor
          }

          // The batch got past every gate, and the turn state says so (#79).
          //
          // Nothing is recorded here. This used to be one of three recording sites -- this one,
          // the ceiling above it and the failure path above that -- and being three is what kept
          // going wrong: each sat on a path the turn had to REACH, so every exit added between
          // them silently shrank the denominator. The ceiling cost this instrument a turn that
          // way, and the parse refusals did before it. So all three now only mark what happened,
          // and `#finaliseTargeting` at the foot of the turn writes the record once, on a path
          // no exit can miss.
          //
          // Nothing at all on a one-seat run: it has no second seat to name, its advisor was
          // never given `MULTI_SEAT_BRIEFING`, and every reply it can write is unaddressed by
          // construction. A counter that reported under-use there would be reporting on
          // something that cannot happen, and a line that is noise on the common run is a line
          // readers stop reading -- including on the run where it means something. The gate is
          // `applicable`, read here and inside `recordTargetingTurn` from the same field.
          {
            const w = this.targetingWatch
            // Everything below this line is admitted -- the all-or-none ceiling is above it --
            // so the batch's fate is settled here even though the record is not written until
            // the finalization site at the end of the turn.
            if (attempt) attempt.admitted = true

            // And the same fact where an operator reading the run in sequence will see it. The
            // counters answer "did the briefing work" after the fact; this answers "why is that
            // seat sitting still" during the run, which is the question actually being asked at
            // the time. Only the unaddressed case says anything: a note on every addressed turn
            // would be the orchestrator narrating the advisor doing exactly what it was asked.
            if (w.applicable && decisions.form === 'unaddressed') {
              // The target the DECISION carries, not a second call to `untargetedTarget()`. An
              // unaddressed reply is exactly one decision, and the fallback it was given at the
              // parse is the one the task is about to be admitted with -- recomputing it here
              // would be a second answer to a question already settled, and a note naming a
              // different seat than the work went to is worse than no note.
              const first = decisions.decisions[0]
              const to = first?.kind === 'instruct' ? first.target : untargetedTarget()
              this.#record({
                from: 'orchestrator',
                fromRank: 'human',
                to: [],
                kind: 'note',
                text:
                  `the advisor's reply named no seat: it carries no @seat/@role directive, so its ` +
                  `one instruction was admitted by fallback routing to ${describeTarget(to)}. This ` +
                  `run has ${w.seats} implementer seats, and a seat that is blocked takes only the ` +
                  `repair addressed to it BY NAME -- so a reply that never names one cannot start ` +
                  `work on a second seat and cannot unblock a stalled one.`,
              })
            }
          }

          for (const admitting of decisions.decisions) {
            // Narrowing, not filtering: `done` and `escalate` are handled above and cannot be
            // in a list alongside an instruction.
            if (admitting.kind !== 'instruct') continue

            // Admitted before anything is delivered, so the record of what the advisor decided
            // exists whether or not it survives adjudication. Admission logs nothing: the task
            // record is the dispatcher's account of the schedule, and the routing log stays the
            // account of what actually moved between participants.
            const task = this.#admit(admitting.instruction, admitting.target, next.end.seq, purposeFor(admitting.target))

            // BEFORE delivery, not after. The point of the pause is that the human adjudicates
            // while the instruction is still a proposal. Once per admission rather than once per
            // dispatch, which is why the task carries the restricted origins it was judged against.
            //
            // Keyed by the TASK's instruction rather than by the whole reply: at N=1 those are
            // the same string, and at N>1 a reply carrying two instructions has two adjudications
            // to make and one key would collapse them into whichever came first.
            const conflict = detectConflict(task.instruction, this.restrictedOrigins)
            if (conflict && !this.#adjudicated.has(`${conflict.origin.seq}:${task.instruction}`)) {
              this.#adjudicated.add(`${conflict.origin.seq}:${task.instruction}`)
              // Who this task can actually land on, read off its own target rather than off a rank
              // scan. At N=1 that is the one seat, so both the workstream name and the delivery
              // below are the values they have always been.
              const targeted = seatsFor([...this.#seatState.values()], task.target)
              const halted = await this.#halt(handle, {
                // The workstream carrying the instruction under adjudication. At N=1 there is one,
                // and it is the implementer's -- the seat id names it because at this size they
                // are the same thing (D1), not because a workstream is a seat. #57's task graph is
                // what gives them separate names.
                //
                // When the target resolves to more than one seat there is no seat that names it, and
                // picking one would be the guess this whole audit is against -- so the TASK names it.
                // A task id is a workstream identity that does not have to pretend to be a seat.
                subject: { reason: 'authority_conflict', workstream: targeted.length === 1 ? targeted[0]!.seat : task.id },
                detail:
                  `the advisor's instruction would reverse work traceable to your restricted ` +
                  `message #${conflict.origin.seq} (matched: ${conflict.matched.join(', ')})`,
                evidence: describeConflict(conflict).split('\n'),
                conflict,
              })
              if (halted) {
                closing ??= { kind: 'outcome', outcome: halted }
                continue advisor
              }
              // Resumed: the human saw both sides and let it through. That decision has to REACH
              // the implementer, or the pause buys a delay and nothing else.
              //
              // Found live. Adjudicated, delivered, and the implementer still declined --
              // correctly, on the standing rule it was given: "proceed unless a human overrules",
              // and a human had already overruled by asking for the file. Its words:
              //
              //   > What I won't do is delete it while the conflict is unacknowledged.
              //   > [...] You tell me the human's instruction was already accounted for and
              //   > you're overriding it deliberately with that knowledge -- I'll comply.
              //
              // It named the missing message. Continuing past the conflict IS the human
              // accounting for it; the implementer simply had no way to know.
              //
              // Delivered to every seat this task could be dispatched to, because which one takes it
              // is not decided until below and the adjudication has to be waiting wherever it lands.
              // The lead implementer used to be told regardless of who the task was for, which at
              // N=1 is the same seat and at N>1 is the wrong one.
              for (const seat of targeted) this.#adjudicate(seat.seat, conflict.origin.seq)
            }
          }

          // Everything the seat table can take, sent now and not awaited. At N=1 that is the one
          // task just admitted going to the one seat that can take it; at N>1 a reply naming two
          // seats puts both to work before either has replied, which is the whole point.
          const breach = dispatchReady()
          if (breach) {
            this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: breach.detail })
            closing ??= { kind: 'end', reason: 'ceiling', detail: breach.detail }
            continue advisor
          }
        }
        } finally {
          // The turn is over, however it ended.
          //
          // A `finally` that throws REPLACES the outcome the turn actually reached -- an
          // instrument's error standing in for the run's. So this one awaits nothing, touches no
          // I/O, and calls only `recordTargetingTurn` (an append to an array) and `#record`,
          // which this turn has already called several times by any route that gets here. Keep
          // it that way: anything fallible added below this line is a new way for an observer to
          // lose a real failure. Every number the instrument reports is derived from that array
          // afterwards, so nothing here computes anything that could fail.
          this.#finaliseTargeting(advisorTurn, lead, attempt)
        }
        }
        // Everything above is admission and dispatch, and none of it runs once the run has
        // decided to end. Everything below is the drain: turns already sent come back, are
        // graded, integrated and routed, and only then does the loop reach the exit at the top.

        // Nothing in flight and nothing dispatchable: the advisor asked for work that no seat can
        // ever take. Thrown rather than worked around, because there is no correct fallback --
        // waiting for a seat that nothing will free is a run that reports healthy forever.
        // `#loop` turns this into an outcome, so the operator gets the sentence rather than a
        // hang. Unreachable at N=1, where the seat that just reported is free again by here.
        if (outstanding() === 0) {
          const waiting = this.#queue.filter((t) => {
            const s = this.#taskRuntime.get(t.id)?.state
            return s === 'ready' || s === 'admitted'
          })
          throw new Error(
            `dispatcher has no free seat for ${waiting.map((t) => `${t.id} targeting ${t.target.kind === 'seat' ? t.target.seat : `role ${t.target.role}`}`).join(', ') || 'any admitted task'}`,
          )
        }

        // The first turn to come back, whichever seat it was on, and nothing else waited for.
        // `arrived` is arrival order by construction; the race is only how this sleeps until
        // there is something in it.
        while (arrived.length === 0) await Promise.race([...inflight.values()])
        const completion = arrived.shift()!
        // Re-raised HERE rather than where it happened, so a turn that threw ends the run
        // through the same path a serial one always did instead of surfacing as an unhandled
        // rejection from whichever seat happened to fail first.
        if ('error' in completion) {
          abandoned.push(completion.task.id)
          throw completion.error
        }
        const { task, seat, exec, report } = completion

        // A build-changing scope question is not a report the advisor can act on. The
        // implementer is the one that would choose an answer by continuing, so the loop stops
        // and records both the question and what has been done so far. This is the distinction
        // the briefing draws between a FLAG: (a result-qualifying concern) and an UNANSWERED:
        // line (something that has to be settled before the build can proceed).
        const questions = extractUnanswered(report.prose)
        if (questions.length > 0) {
          const question = questions[0]!
          const done = report.prose.replace(UNANSWERED_MARKER, '').trim().replace(/\n{3,}/g, '\n\n')
          const halted = await this.#halt(handle, {
            subject: { reason: 'implementer_unanswered', participant: seat.id },
            detail: `UNANSWERED: ${question}\n\nDone so far: ${done || '(nothing recorded)'}`,
            evidence: [
              `${seat.id} asked a build-changing scope question that the instruction did not settle`,
              report.prose,
            ],
          })
          // Seat-scoped, and the scope is honoured now: this ends the run, and the OTHER seats
          // still finish, are graded and integrated, and have their reports routed. The rest of
          // THIS completion is skipped exactly as the return skipped it, so N=1 is unchanged.
          if (halted) {
            closing ??= { kind: 'outcome', outcome: halted }
            continue advisor
          }
        }

        // Empty AND unverified is not a report. The turn completed — the hook proved it —
        // but the relay read the transcript before it settled and got nothing, so what would
        // be routed is a blank the advisor then reasons from. Observed live: an implementer
        // did the work, and its review findings reached the advisor as an empty message.
        //
        // Escalates rather than routes. A participant that says nothing has either failed or
        // been truncated, and neither should advance the loop silently. An empty body that
        // DID settle is left alone: that is a participant genuinely saying nothing, which is
        // a different fault and not one this can diagnose.
        if (report.unsettled && report.prose.trim() === '') {
          // Stated as what was LOST, not as what the transcript did. The first version read
          // as a routing detail -- "the transcript had not settled" -- when what it means is
          // that a completed turn's entire account of its work was discarded. Those are
          // different things to someone deciding whether to resume or restart, and the files
          // are the part that says which (#39).
          const changed = report.changedDuringTurn
          // Two phrasings, because the diff can only see paths that BECAME dirty. A file this
          // turn edited again, having been edited in an earlier one, is indistinguishable from
          // a file left alone -- so an empty diff must not be reported as "nothing happened".
          // A reader who trusts a false negative here restarts work that was already done.
          // The seat's own root, for the same reason the turn diff uses it: "how many paths are
          // dirty" is being offered as context for THIS seat's missing report, and counting the
          // integration checkout would answer a question nobody asked.
          const dirtyNow = dirtyPaths(this.#rootOf(seat.id)).length
          const lost =
            changed.length > 0
              ? `${changed.length} path(s) changed on disk during it: ${changed.slice(0, 8).join(', ')}` +
                `${changed.length > 8 ? `, and ${changed.length - 8} more` : ''}`
              : `no new paths appeared during it, though ${dirtyNow} are dirty in the tree — ` +
                `a file this turn edited again looks the same as one it never touched`
          const halted = await this.#halt(handle, {
            // `advisor_escalated` although it is the implementer's report that was lost: the
            // reason names who is being asked to take it, and the scope follows the reason.
            subject: { reason: 'advisor_escalated' },
            detail:
              `${seat.id}'s turn completed and its report could not be read, so there is ` +
              `nothing to route — ${lost}. The work is on disk; what is missing is the ` +
              `account of it, and a resume from this log starts with that turn saying nothing.`,
            evidence: [
              `turn_end was proven by the hook; the transcript never produced a body`,
              `waited the settle window, then a further salvage window, and it stayed empty`,
              `raising --settle may help — see transcriptSettleMs and transcriptSalvageMs`,
            ],
            // Wired here too, and it was not. Liveness went into the two `turn_incomplete`
            // paths only, so a live run's three pauses carried it once -- and the two that
            // missed out were these, where "the report could not be read" is exactly when
            // knowing whether the child is still writing changes what the operator does.
            liveness: { participant: seat, emittedBefore: report.emittedBefore },
          })
          // Seat-scoped, and the scope is honoured now: this ends the run, and the OTHER seats
          // still finish, are graded and integrated, and have their reports routed. The rest of
          // THIS completion is skipped exactly as the return skipped it, so N=1 is unchanged.
          if (halted) {
            closing ??= { kind: 'outcome', outcome: halted }
            continue advisor
          }
        }
        this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `${seat.id} turn: ${formatVerdict(report.end.verdict)}` })
        this.#attributeArtifacts(seat)

        // The verdict may already be stale by the time we read it. `#exchange` settles on the
        // FIRST `turn_end`, and the late signal that withdraws it can land during the
        // transcript settle window that follows — the same window that is there because a
        // late `Stop` is expected. Pausing on a verdict the system has already retracted asks
        // the human to adjudicate nothing at all, so the current one is used instead.
        const already = supersessionOf(seat.events, report.end)
        const current = already?.replacement ?? report.end
        if (already) {
          this.#record({
            from: 'orchestrator',
            fromRank: 'human',
            to: [],
            kind: 'note',
            text:
              `${seat.id}'s ${report.end.verdict.outcome} verdict was withdrawn (${already.revision.reason})` +
              (already.replacement
                ? ` and replaced with ${formatVerdict(already.replacement.verdict)}`
                : ` with no replacement`),
          })
        }
        // A withdrawal with no replacement leaves the pause resting on a verdict that is
        // already retracted, so it says so from the moment it is raised.
        const pre: PauseSupersession | undefined =
          already && !already.replacement
            ? {
                at: Date.now(),
                note:
                  `the ${report.end.verdict.outcome} verdict this pause was raised on had already been ` +
                  `withdrawn (${already.revision.reason}) with no replacement`,
              }
            : undefined

        // GRADED. The verdict has been resolved through supersession and judged, which is the
        // fact a seat's freedom rests on: a `timed_out (uncertain)` seat must not be handed more
        // work, and a seat freed on `turn_end` alone would be. Everything below this line may
        // halt the run; nothing below it may dispatch until `#integrate` has run.
        this.#grade(task, current, {
          outcome: current.verdict.outcome,
          superseded: already !== undefined,
        })

        // A turn that did not complete is the human's call, not the advisor's. Escalating
        // here rather than relaying the partial prose keeps the advisor from steering on a
        // report that never finished being written.
        if (current.verdict.outcome !== 'completed') {
          // Registered before the halt, so a revision arriving while the human reads the
          // pause can be matched to it; cleared after, so it cannot amend the next one.
          if (handle) {
            this.#verdictPause = {
              handle,
              participant: seat.id,
              endSeq: current.seq,
              outcome: current.verdict.outcome,
              withdrawn: pre !== undefined,
            }
          }
          const halted = await this.#halt(handle, {
            subject: { reason: 'turn_incomplete', participant: seat.id },
            detail: `${seat.id} turn ended ${formatVerdict(current.verdict)}`,
            evidence: current.verdict.provenance.map((p) => `${p.source}: ${p.detail}`),
            liveness: { participant: seat, emittedBefore: report.emittedBefore },
            verdictOf: { participant: seat.id, endSeq: current.seq },
            // The pause #107 counted nine of. `current` and not `report.end`, so a verdict the
            // adapter has already withdrawn and replaced is remembered as the one the operator
            // was actually shown -- the same value the detail and the grade above were taken
            // from. See `#incompleteAnswered`.
            latch: { seat, outcome: current.verdict.outcome, provenance: current.verdict.provenance },
            ...(pre === undefined ? {} : { superseded: pre }),
          })
          this.#verdictPause = undefined
          // Seat-scoped, and the scope is honoured now: this ends the run, and the OTHER seats
          // still finish, are graded and integrated, and have their reports routed. The rest of
          // THIS completion is skipped exactly as the return skipped it, so N=1 is unchanged.
          if (halted) {
            closing ??= { kind: 'outcome', outcome: halted }
            continue advisor
          }
        }

        // §7a. Assessed before the advisor sees the report, so a degraded implementer is
        // replaced rather than issued another instruction it cannot act on well.
        const rotated = await this.#considerRotation(seat, report.prose, handle)
        if (rotated) return rotated

        // The git side of the same boundary -- crossed now, or deferred to a reviewer's
        // verdict (#72). `crossAndSettle` is the boundary itself, unchanged in what it does;
        // what is new is that a run with a reviewer does not always call it immediately.
        //
        // Three cases, and `task.purpose` alone decides which: this completion IS a review
        // report, in which case the boundary it settles is the REVIEWED task's, not its own;
        // this completion is reviewable work and a reviewer exists, in which case the
        // boundary waits; or neither, in which case nothing about this run has changed and
        // the boundary crosses exactly as it always has.
        if (task.purpose === 'review') {
          // The review task's OWN boundary is always trivial -- it never mutates anything, so
          // there is nothing for `#crossBoundary` to find -- and this is what releases the
          // reviewer seat. `resolveReview` then acts on the verdict for the task it reviewed.
          if (await crossAndSettle(task, seat.id, exec)) continue advisor
          if (await resolveReview(task, report.prose)) continue advisor
        } else if (reviewerSeat && (task.purpose === 'work' || task.purpose === 'review_resolution')) {
          this.#awaitReview(exec)
          this.#admitReview(task, seat.id, reviewerSeat)
        } else {
          if (await crossAndSettle(task, seat.id, exec)) continue advisor
        }

        // The seat has just been released, so ready work it can take goes to it NOW rather than
        // after the advisor has been asked and answered. A seat idling through an advisor turn
        // to collect work already sitting in the queue is the lockstep this design exists to
        // remove, reached from the other end. At N=1 the queue is empty here -- one reply
        // admits one task and it was dispatched immediately -- so nothing happens.
        const filled = dispatchReady()
        if (filled) {
          this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: filled.detail })
          closing ??= { kind: 'end', reason: 'ceiling', detail: filled.detail }
          continue advisor
        }

        const leadAside = this.#drain(lead.id)
        next = await this.#exchange(
          lead,
          [leadAside, this.#drainLeadNotices(), envelope({ from: seat.id, fromRank: 'implementer', fromRole: seat.role, kind: 'report', text: report.prose })]
            .filter(Boolean)
            .join('\n\n'),
        )
        // The report has reached the advisor. Independent of integration above, and recorded
        // separately: at N>1 a task reaches the two in either order.
        this.#routed(task)
      }
      return this.#end('budget')
    } finally {
      // Turns still outstanding when the run ended, named rather than dropped.
      //
      // A backstop now rather than the normal case. Every ending the loop DECIDES on drains
      // first: `closing` stops admission and the loop keeps processing arrivals until nothing
      // is outstanding, so a ceiling, a budget, an escalation and a seat-scoped halt all let
      // the seats already working finish, be graded and integrated, and have their reports
      // routed. This is reached by the two endings that cannot drain -- `stop()`, which is
      // closing the sessions out from under those turns, and an exception -- and it exists
      // because a run that lost a report must say so: the routing log shows the instruction
      // going out and nothing coming back, and a reader cannot tell that from a seat that is
      // still thinking.
      const lost = [...inflight.keys(), ...arrived.map((c) => c.task.id), ...abandoned]
      if (lost.length > 0) {
        this.#record({
          from: 'orchestrator',
          fromRank: 'human',
          to: [],
          kind: 'note',
          text:
            `the run ended with ${lost.length} seat turn(s) unfinished: ${lost.join(', ')} — ` +
            `their reports never reached the advisor`,
        })
      }
    }
  }

  /** Unbacked complaints, per participant per topic. Feeds stall detection (§7). */
  readonly complaints = new ComplaintLedger()

  /**
   * Replace the implementer, carrying the work forward.
   *
   * The unnamed form, kept because it is what every existing caller has: an operator, a
   * console, an embedder. It resolves to the seat `RelayOptions.implementer` names -- which at
   * N=1 is the only seat there is -- and hands the work to `rotateSeat`.
   *
   * At N>1 it still REFUSES rather than picking. "The implementer" names nothing there, and
   * quietly rotating the lead would retire a session whose caller may have meant another one;
   * `rotateSeat` is the form that says which. This is a throw because it is a programming
   * error at the call site rather than a condition of the run -- and nothing inside the loop
   * reaches it any more, which is what #78 is about: `#considerRotation` names the degraded
   * seat, so the throw that used to surface as `transport_failed` (#74) is unreachable from it.
   */
  async rotateImplementer(reason: string): Promise<RotationResult> {
    const seats = this.#implementers()
    if (seats.length > 1) {
      throw new Error(
        `rotateImplementer names no seat, and this run has ${seats.length} (${seats.map((s) => s.id).join(', ')}). ` +
          `Rotation replaces one session and carries its work forward, so it needs to be told which: ` +
          `call rotateSeat(seatId, reason).`,
      )
    }
    return this.rotateSeat(this.#leadImplementer().id, reason)
  }

  /**
   * Replace ONE named seat's session, carrying that seat's work forward (#78).
   *
   * The transaction lives in `rotation/rotate.ts`; this supplies the things it cannot get for
   * itself: how to talk to a session, how to start a fresh implementer, which human constraints
   * to replay, where to write the notes -- and, since #78, WHICH TREE all of that is measured
   * in. Every step is scoped to the one seat: its session is retired, its record is captured,
   * its constraints are replayed, and the replacement proves itself in its worktree.
   *
   * The other seats are not told and do not stop. A rotation is not a run-wide event (#56's
   * scope rule: block the smallest scope whose continuation requires the decision), so their
   * turns carry on in flight while this one proves itself. What they cannot do is cross their
   * integration boundary in the middle of it -- the dispatcher processes one completion at a
   * time, and the check lane would serialise them even if it did not.
   *
   * Callable by the human as well as by the run loop. Nothing about it assumes the loop is
   * running -- an operator watching a session degrade should not have to wait for the
   * orchestrator to notice.
   *
   * ## Why no caller may state the intent (#75)
   *
   * This took an optional `intent` for one honest reason -- the detector's automatic path has no
   * pause to classify from -- and an optional argument is available to everybody. An embedder
   * could then label a rotation it chose for its own reasons `degradation_automatic`, and that
   * is not a mislabelled row: `degradation_automatic` is the population #10 counts as the proxy
   * predicting degradation, so forged rows are indistinguishable from evidence and confirm the
   * hypothesis by construction. The field exists to make the dataset trustworthy; a public way
   * to write it by hand would have removed exactly the property it was added for.
   *
   * So the classification is not a parameter here at all. Every public rotation is read from the
   * ACTIVE PAUSE, which is the one thing a caller cannot fabricate -- it is the question the
   * orchestrator itself put -- and the single call site that legitimately knows better reaches
   * `#rotateSeatDeclaring` instead, which is private to this class and cannot be reached from
   * outside it.
   */
  async rotateSeat(seatId: string, reason: string): Promise<RotationResult> {
    // Classified HERE, before the transaction runs, because the fact it is classified from does
    // not survive it: `rotate()` spends a full agent turn, and an operator can answer the pause
    // the moment it returns. Reading `handle.pause` afterwards would be reading whatever
    // question came next (#75).
    return this.#rotateSeatDeclaring(seatId, reason, rotationIntentFor(this.#handle?.pause, seatId))
  }

  /**
   * The transaction, with its population already decided.
   *
   * PRIVATE, and that is the whole of its design. Two callers may reach it: `rotateSeat` above,
   * which passes what the active pause says, and `#considerRotation`, which passes
   * `degradation_automatic` because `onDegradation: 'automatic'` asks nobody and there is no
   * pause to read -- the default reading would file the one unambiguously proxy-driven rotation
   * in the run as the operator's, which is #75's contamination running backwards.
   *
   * A `#` method rather than a naming convention: TypeScript's `private` is a compile-time
   * courtesy that a JavaScript embedder walks straight through, and the argument here is not
   * about tidiness. It is that no code outside this class may choose what a rotation record
   * says it was.
   */
  async #rotateSeatDeclaring(seatId: string, reason: string, intent: RotationIntent): Promise<RotationResult> {
    const impl = this.#participants.get(seatId)
    if (!impl || impl.rank !== 'implementer') {
      throw new Error(
        `'${seatId}' is not an implementer seat in this run ` +
          `(${this.#implementers().map((s) => s.id).join(', ')}); rotation replaces a seat's session ` +
          `and there is none to replace`,
      )
    }
    // ALREADY ROTATING, and this comes first because it is the most specific true thing that
    // can be said about the request.
    //
    // A second transaction against a seat that is mid-rotation would quiesce a session the first
    // has already committed to replacing, ask the advisor for a second handoff describing a state
    // that is being handed over as it reads it, and start a second replacement for one seat --
    // and then one of the two would promote its audition over the other's. The check lane does
    // eventually refuse the pair, because both take it for the same seat, but it refuses too late
    // and in the wrong words: too late because the `rotating <seat>` note is written, the session
    // is quiesced and the advisor has been asked before the lane is reached, and in the wrong
    // words because "its rotation section would wait for itself" describes a mutex to an operator
    // who asked to replace a seat twice.
    //
    // Relay-owned and keyed by seat id alone, so it holds where the dispatcher's bookkeeping does
    // not exist: at N=1, before any run has started, and for an operator rotating from a pause.
    // The reason the first caller gave is carried so the second is told what it is waiting for
    // rather than merely that it may not proceed.
    const rotating = this.#rotationsInFlight.get(seatId)
    if (rotating !== undefined) {
      throw new Error(
        `${seatId} is already being rotated (${rotating}). A second transaction would quiesce a ` +
          `session the first has already committed to replacing and start a second replacement ` +
          `for one seat. Wait for the rotation in progress: it either promotes a replacement or ` +
          `restores the original, and either way this seat has a session at the end of it.`,
      )
    }
    // A TURN IN PROGRESS IS NOT ROTATABLE, and this is checked before anything else because it
    // is the one refusal that protects a live child rather than a configuration.
    //
    // `rotate()` opens by quiescing the outgoing session and closes by terminating it. Quiescing
    // stops new work reaching a session; it does NOT wait for the turn already running to
    // finish, and no adapter offers a way to. So a caller that rotates a seat mid-turn retires a
    // session in the middle of an observed turn: the work is in flight, the verdict is never
    // graded, the report is lost, and the handoff the replacement is measured against was
    // captured from a tree the outgoing turn is still writing to.
    //
    // The test is the GRADE and not the state name, because the grade is the fact D4 already
    // makes freedom rest on: a seat is free when its turn ended AND its verdict is graded, and a
    // `timed_out (uncertain)` seat is neither. Reading `state === 'running'` instead would admit
    // exactly the seat whose turn ended and whose verdict is still being resolved through
    // supersession.
    //
    // What this deliberately still permits is every rotation that has a reason to happen:
    //
    //   - the loop's own point, immediately after `#grade` and before `#crossBoundary`. The seat
    //     is `integrating` there with its task graded, which is measured rather than assumed --
    //     see `seatRotation.test.ts`, which asserts the state and the grade from inside the
    //     transaction.
    //   - an operator at a pause, which is that same point suspended.
    //   - an idle, queued or `merge_blocked` seat, none of which holds a running turn.
    //
    // Thrown rather than returned as a `rolled_back` result: nothing has begun, so there is no
    // transaction to roll back, and a caller that has to remember to inspect a status is a
    // caller that will rotate over a live turn by forgetting to.
    const exec = this.#seatState.get(seatId)
    const inFlight = exec?.current
    if (inFlight !== undefined && this.#taskRuntime.get(inFlight)?.grade === undefined) {
      throw new Error(
        `${seatId} is still working on ${inFlight}: its turn has not been observed and graded, so ` +
          `rotating now would quiesce and retire a session in the middle of a turn. quiesce() ` +
          `stops new work reaching a session; it does not wait for the turn already running. ` +
          `Rotate once the turn has ended and its verdict is graded — which is where the run loop ` +
          `rotates, and where a pause holds the run.`,
      )
    }
    // The same refusal read off the relay's own exchange bookkeeping rather than off the
    // dispatcher's. Not redundant: the grade above answers for work the DISPATCHER placed, and
    // the relay also exchanges with a seat outside any task -- the opening briefing, a drained
    // aside, the closing question. None of those has a task id or a verdict to be graded, and
    // every one of them is a live turn.
    if (this.#busy(seatId)) {
      throw new Error(
        `${seatId} has an exchange in flight, so rotating it now would retire a session in the ` +
          `middle of a turn the relay is still reading. Rotate when it is idle.`,
      )
    }

    // AND THE ADVISOR, which is the half a seat-shaped guard cannot see.
    //
    // Rotation's second step asks the advisor to write the handoff, on the advisor's own session.
    // If the relay is already mid-exchange with it -- routing a report, taking the next
    // instruction -- that request is a SECOND concurrent send on one session, and both turns are
    // lost: the transcript interleaves two prompts, `#exchange` slices events from a mark the
    // other reader is already past, and whichever `turn_end` arrives first is attributed to
    // whichever call reads it. The handoff would then be assembled from an advisor turn that was
    // answering something else, and the replacement would be measured against it.
    //
    // Refused rather than queued behind the advisor's turn. Waiting would look kinder and would
    // mean the caller's rotation begins at an unbounded later moment, against a seat whose state
    // has moved on -- and the transaction's own first act is to quiesce that seat. A caller told
    // "not now" can ask again; a caller silently parked cannot un-ask.
    //
    // This never fires from inside the run: the loop awaits its advisor exchanges one at a time
    // and rotates from the completion path, where none is open. It is reachable exactly where the
    // hazard is -- `rotateSeat` is public and does not require a paused run.
    const advisor = this.participants.find((p) => p.rank === 'advisor')!
    if (this.#busy(advisor.id)) {
      throw new Error(
        `the advisor (${advisor.id}) has a turn in flight, so rotating ${seatId} now would issue ` +
          `the handoff request as a second concurrent send on that session: two turns would ` +
          `interleave on one transcript and neither could be attributed. Rotate when the advisor ` +
          `is idle — the run loop's own rotation point and every pause are.`,
      )
    }
    // The policy THIS seat is under: the run's, as amended by its own entry (D7). Resolved
    // before anything is quiesced, because a seat whose policy disarms it must be refused with
    // its session untouched.
    const cfg = rotationFor(this.#opts.rotation, seatId)
    if (!cfg || cfg.checks.length === 0) {
      throw new Error(
        `rotation needs verification commands: set \`rotation.checks\` so a replacement has ` +
          `something to reproduce${cfg ? ` (${seatId}'s own policy configures none)` : ''}. ` +
          `Rotating without them would be a transfer nobody demonstrated.`,
      )
    }
    // Claimed HERE: past every refusal, and before the first thing a second caller could
    // observe or collide with -- the `rotating` note, the quiesce, the advisor's handoff turn,
    // the lane. Released in the `finally` below whatever the transaction returns or throws, so a
    // rotation that fails leaves the seat rotatable again; a latch that outlived its transaction
    // would be a seat nobody could ever replace, which is worse than the race it prevents.
    this.#rotationsInFlight.set(seatId, reason)
    try {
      return await this.#rotateSeatTransaction(impl, advisor, cfg, reason, intent)
    } finally {
      this.#rotationsInFlight.delete(seatId)
    }
  }

  /**
   * Seats with a rotation transaction open, and the reason each was given for it.
   *
   * Relay-owned, like `#exchanges`, and for the same reason: the sessions cannot answer this.
   * Mid-transaction the outgoing session is `quiesced` or `rotating` -- but so is a session
   * whose rotation has already failed and is being restored, and the audition is not in the
   * participant map at all, so nothing about the child processes distinguishes "a rotation is
   * running" from "a rotation just ended".
   */
  #rotationsInFlight = new Map<string, string>()

  /**
   * The transaction itself, with the seat claimed. See `rotateSeat` for every refusal above it.
   *
   * Split out so the claim's release sits in a `finally` that no later edit inside this method
   * can slip past -- the same shape as `#exchange`/`#exchangeTurn`, and for the same reason.
   */
  async #rotateSeatTransaction(
    impl: RelayParticipant,
    advisor: RelayParticipant,
    cfg: EffectiveRotation,
    reason: string,
    /**
     * Which population this rotation belongs to (#75), decided by `rotateSeat` BEFORE the
     * transaction opened. Passed rather than re-derived here: the transaction spends a full
     * agent turn, and the pause it was classified from can be answered the moment that turn
     * ends -- so a reading taken at the end would be a reading of whatever came next.
     */
    intent: RotationIntent,
  ): Promise<RotationResult> {
    const seatId = impl.id
    const spec = implementerSeats(this.#opts).find((s) => s.id === seatId)!
    /**
     * This seat's own tree, and what the whole transfer is measured against.
     *
     * At N=1 it is the run cwd, by `#rootOf` rather than by a seat-count branch -- so the
     * default run's rotation reads exactly the directory it always read.
     */
    const root = this.#rootOf(seatId)
    /** The replacement while it is proving itself, before it is anyone's session. */
    let audition: RelayParticipant | undefined

    this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `rotating ${impl.id}: ${reason}` })

    // Named rather than passed inline only so the lane can wrap the call; the annotation is
    // what keeps `deps.exchange` and `deps.note` contextually typed once it is not an argument.
    const rotation: Parameters<typeof rotate>[0] = {
      old: impl.session,
      advisor: advisor.session,
      reason,
      deps: {
        root,
        exchange: async (session, text) => {
          // The replacement is not in the participant map yet -- it is being auditioned --
          // but it gets the same exchange as everyone else. A second path here would be a
          // second set of failure modes on the least-tested code in the system.
          const p = [...this.participants, audition].find((q) => q?.session === session)
          if (!p) throw new Error('exchange requested for a session the relay does not hold')
          return (await this.#exchange(p, text)).prose
        },
        // Asked for only when the replacement produced nothing at all, and answered from what
        // the relay watched rather than from what the replacement said -- which is the point:
        // the claim being evidenced is that the transport is not working, and a claim about a
        // silent child cannot rest on anything the child produced (#76).
        transportEvidence: (session) => {
          const p = [...this.participants, audition].find((q) => q?.session === session)
          return [
            `${p?.id ?? session.sessionId} emitted ${p?.events.length ?? 0} event(s) since it was started`,
            `its session state is '${session.state}'`,
            `the outgoing session ${impl.session.sessionId} is '${impl.session.state}' and was restored`,
          ]
        },
        startReplacement: async () => {
          // THIS SEAT'S tree, so the replacement is launched where its predecessor worked. A
          // replacement started in the integration checkout would prove itself against files
          // the seat it is replacing never wrote to. At N=1 `root` is the run cwd.
          const ctx = { cwd: root, watchdogMs: this.#opts.turnWatchdogMs }
          const session = await this.#opts.registry.createParticipant(spec, ctx)
          // Same spec, so the same role: a replacement that changed what the seat is FOR
          // would be a different seat wearing the id, and the handoff it just proved was
          // measured against the outgoing session's job. Same spec means the same launch as
          // well, and it is composed rather than copied from the outgoing participant so a
          // replacement started differently could never be reported as the one it replaced.
          audition = { id: `${spec.id}~replacement`, agent: spec.agent, rank: 'implementer', role: spec.role, launch: launchRecordFor(this.#opts.registry.resolve(spec), ctx), session, events: [], baselineGeneration: 0, degradationCursor: 0 }
          // The audition's id is not the seat's, so the worktree manifest cannot answer for it
          // and `#rootOf` would fall back to the run cwd -- reporting the integration checkout's
          // dirty paths as what the acceptance turn changed, and missing everything it actually
          // wrote. Recorded rather than inferred from the id's shape, because a suffix is a
          // string and this is a fact.
          this.#rootOverride.set(audition.id, root)
          this.#attach(audition)
          return session
        },
        checks: cfg.checks,
        ...(cfg.files === undefined ? {} : { files: cfg.files }),
        ...(cfg.checkTimeoutMs === undefined ? {} : { checkTimeoutMs: cfg.checkTimeoutMs }),
        ...(cfg.hooks === undefined ? {} : { hooks: cfg.hooks }),
        // Human messages only. Advisor instructions are the old session's history and
        // belong in the handoff narrative; constraints outrank it and are replayed intact.
        constraints: this.log.filter((m) => m.fromRank === 'human' && m.kind === 'constraint' && m.to.includes(impl.id)),
        note: (text) => {
          this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text })
        },
      },
    }

    // The whole transfer, behind the lane, and the window is the reason rather than the CPU.
    // `rotate()` captures the repository, spends a full agent turn proving a replacement
    // against that capture, and captures again -- a merge landing between the two rolls the
    // rotation back as `repository_diverged` and names the repository for what was a race.
    // Holding the lane across the acceptance turn is expensive and is the point: a boundary
    // that waits is late, a rotation rolled back by a race is work thrown away.
    //
    // One acquire, at the outermost point. `rotate()` and `record.ts` know nothing about the
    // lane, so the checks they run inside this cannot queue for it a second time.
    //
    // Since #78 this is a station that genuinely runs at N>1, which is the configuration that
    // has boundaries to contend with. See `checkLane.ts` for what is and is not reachable.
    const result = await this.#rotating(seatId, () =>
      this.#checkLane.run({ seat: impl.id, station: 'rotation', detail: reason }, () => rotate(rotation)),
    )
    // The audition either became the seat or is gone; either way its root is no longer anyone's.
    if (audition) this.#rootOverride.delete(audition.id)

    /**
     * Promotion, on both outcomes that produced a proven replacement.
     *
     * `rotated_cleanup_failed` differs from `rotated` in exactly one respect: whether the
     * OUTGOING session could be confirmed disposed of. Nothing in this block is about the
     * outgoing session -- it swaps a proven replacement into the seat, moves the audition's
     * flags and events onto it, and clears the answers that belonged to the session leaving.
     * Every one of those is as necessary when the loser would not die as when it did.
     *
     * Branching here instead would leave the seat holding a session whose transport this
     * transaction has already torn down, with a live, proven, unreferenced replacement beside
     * it -- the shape the whole rollback protocol exists to make impossible, reintroduced by
     * the code that reports the protocol worked. The cleanup failure is recorded below, beside
     * the rotation note, where it is a fact about the run rather than a reason to lose a seat.
     */
    if ((result.status === 'rotated' || result.status === 'rotated_cleanup_failed') && audition) {
      // Swap the session in place, so the participant id, rank and routing history survive
      // the replacement. A rotation that changed the implementer's id would break every
      // reference to it in the log that already exists.
      //
      // The audition's reader is kept rather than restarted: it is already the single
      // consumer of that session's queue, and attaching a second one would split the
      // stream. Retargeting it means giving it the promoted identity and the one events
      // array both objects now share -- the old session's reader retires itself on its
      // next event, because `#attach` checks that it still owns `p.session`.
      audition.events.unshift(...impl.events)
      // Flags raised while the replacement was AUDITIONING were recorded against
      // `<seat>~replacement`, because `#raiseFlag` stores whichever id the participant had at
      // the time. Rewriting the object's id below does not move them, and the closing question
      // selects a seat's flags by the stable id -- so without this they are never shown to the
      // seat, never superseded, and if the seat happens to restate one it becomes a SECOND
      // outstanding entry. That is #131's inflated-duplicate defect reappearing by another
      // route, inside the change that fixes it.
      //
      // Rewritten rather than filtered at the read site, for the reason the id is rewritten at
      // all: an audition that is promoted IS this seat, retrospectively, and every other record
      // of it already says so. Found by an independent review of this change, not by a test --
      // there was none for a flag raised during an audition, and there is one now.
      for (const f of this.flags) if (f.participant === audition.id) f.participant = impl.id
      audition.id = impl.id
      impl.session = result.replacement
      impl.events = audition.events
      impl.baselineGeneration = 0
      impl.degradationCursor = impl.events.length
      // The declines were about the session that just left the seat (#118). A replacement that
      // then compacts is a question nobody has been asked, and carrying the answer across the
      // swap would suppress the first candidate raised against a brand new session.
      this.#declinedClasses.delete(impl.id)
      // And the deadline answers, for exactly the same reason (#107). "The child is working, let
      // it run" was a judgement about a session that has just been retired; a replacement that
      // then trips the watchdog is a question nobody has been asked, and the count goes with it
      // so the note on the far side of a rotation is not still counting its predecessor's.
      this.#incompleteAnswers.delete(impl.id)
      this.#suppressedIncompletes.delete(impl.id)
      this.complaints.progressed(impl.id)
      // Counted HERE, where a replacement has been accepted -- not where one was proposed.
      //
      // The field was initialised to 0 and incremented nowhere, so every run ever reported
      // `0 rotations` whatever happened, including the first successful rotation this
      // project ever performed. Its own comment claims the distinction the code never made:
      // "Candidates raised. Distinct from rotations, which are candidates ACTED on."
      //
      // Worse than a wrong number. That zero was read as evidence that rotation had never
      // fired -- by me, repeatedly, across a day of runs -- and an instrument that cannot
      // report the thing it is watching for makes every reading of it worthless, including
      // the readings that happened to be right.
      this.rotationWatch.rotations += 1
      // And WHY, in the same breath as the count, because a count on its own is what #75 is
      // about: rotations taken because a proxy fired and rotations taken because the operator
      // wanted a blind reader both arrive carrying a compaction generation, and a dataset that
      // cannot separate them confirms #10's hypothesis with rotations that had nothing to do
      // with degradation. Written here rather than beside the classification above so a
      // rolled-back transaction leaves no record -- `records.length` means `rotations`.
      this.rotationWatch.records.push({
        seat: impl.id,
        intent,
        reason,
        replacement: result.replacement.sessionId,
        // Recorded on the record rather than only in the routing log, because this array is what
        // an analysis outside the process reads (`rotationRecords()`, and the run report through
        // it). A run whose rotations all left a child behind and one whose rotations were clean
        // read identically without it.
        ...(result.status === 'rotated_cleanup_failed'
          ? { cleanupFailure: { detail: result.detail, outgoingState: result.oldState } }
          : {}),
        at: Date.now(),
      })
      this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `${impl.id} rotated into ${result.replacement.sessionId} (${intent})` })
      if (result.status === 'rotated_cleanup_failed') {
        // Recorded at human rank like the rotation itself, and in its own note rather than as a
        // clause on the line above. What it asks for is an action -- go and look for an orphaned
        // child -- and an operator scanning the log for rotations should not have to read to the
        // end of a success line to find out that something is still running. The disposal is
        // genuinely unknown rather than known-bad: `state` is the only evidence there is, and it
        // says how far `close()` got, not whether a process survived it. See #146 for why the
        // adapters cannot currently answer that.
        this.#record({
          from: 'orchestrator',
          fromRank: 'human',
          to: [],
          kind: 'note',
          text:
            `the outgoing session could NOT be confirmed disposed of: ${result.detail}. Its state ` +
            `reads '${result.oldState}' and the child may still be running -- check for an orphaned ` +
            `process holding this seat's tree. The rotation itself stands: the replacement proved ` +
            `it could reproduce the record and is in service.`,
        })
      }
      // A replacement proved itself, so whatever made an earlier acceptance unobservable is
      // not holding now. Cleared on the evidence rather than on a timer: the latch's whole
      // claim is "no replacement can pass while this holds", and one just did.
      this.#rotationUnobservable = undefined
    } else if (result.status === 'rolled_back') {
      this.#record({
        from: 'orchestrator',
        fromRank: 'human',
        to: [],
        kind: 'note',
        text: `rotation rolled back (${result.reason}): ${result.detail}. ${impl.id} is back in service.`,
      })
      if (result.reason === 'acceptance_unobservable') {
        // Latched, and this is the whole of #76's remedy on this side: the rollback was already
        // correct, and what was missing was that the operator could not tell a bad draw from a
        // state in which no draw can win. The note above says which case this is; the latch is
        // what stops the run from asking the same question again every advisor turn and
        // teaching the reader that rotation notes mean nothing.
        this.#rotationUnobservable = {
          seat: impl.id,
          detail: result.detail,
          evidence: result.evidence ?? [],
        }
        for (const line of this.#rotationUnobservable.evidence) {
          this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `rotation transport evidence: ${line}` })
        }
      }
    }
    return result
  }

  /**
   * The rotation this run stopped attempting, and why. Unset unless acceptance went unobserved.
   *
   * A run-level latch for a run-level fault. The fault it records is one every replacement
   * inherits -- hook trust, the provider, the CLI -- so scoping it to the seat that happened to
   * hit it first would let the next seat spend another full transaction rediscovering it (#76).
   * Cleared by a rotation that succeeds, which is the only evidence that would settle it.
   */
  #rotationUnobservable: { seat: string; detail: string; evidence: string[] } | undefined

  /**
   * Hold the seat in `rotation_pending` for the duration of the transfer.
   *
   * At the loop's rotation point the seat is `integrating` with its task already graded -- it
   * sits between `#reported`, which flips it out of `running` the moment the report is recorded,
   * and `#crossBoundary`. So it is undispatchable before this runs and this changes no
   * scheduling decision. Measured rather than reasoned: `seatRotation.test.ts` reads the seat
   * table from inside the transaction and asserts both the state and the grade, because "the
   * seat is not running here" is exactly the kind of claim a later reordering would falsify
   * silently, and it is what the mid-turn refusal in `rotateSeat` leans on.
   *
   * What it changes is what an operator watching `status --json` is told: a seat sitting in
   * `integrating` for two agent turns while its session is replaced is a seat whose state is
   * describing the wrong thing, and `rotation_pending` has been in `SchedulerState` since D4
   * waiting for a production path to construct it. This is that path.
   *
   * The previous state is restored rather than assumed, because the caller may not be the loop:
   * an operator rotating an idle seat at a pause must get an idle seat back, and the loop's own
   * `#integrate`/`#failBoundary` overwrite it a moment later either way.
   */
  async #rotating<T>(seatId: string, section: () => Promise<T>): Promise<T> {
    const exec = this.#seatState.get(seatId)
    const was = exec?.state
    if (exec) exec.state = 'rotation_pending'
    try {
      return await section()
    } finally {
      if (exec && was !== undefined) exec.state = was
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true
    // A run that already ended keeps the reason it ended for; teardown is not a second
    // outcome. Only a relay stopped without ever finishing a run reports 'stopped'.
    this.#end('stopped')
    // And the HANDLE is settled here rather than left to the loop, which is #142.
    //
    // `start()` settles from `#loop`'s completion callbacks, so a supervised run's ending
    // depended on the loop running to completion -- and the loop does not always get there. At a
    // pause it is parked on the promise `RunHandle.pauseAt` returned, which nothing was going to
    // resolve; mid-turn it is polling for a `turn_end` from a session this method is closing, and
    // `#exchange` has no timeout of its own by design. In both cases the RUN was over --
    // `run_end` is on the stream, the clock has stopped, the sessions are going -- while
    // `run.state` still said `paused` or `running` and `result()` never settled. A caller
    // awaiting the end of a run it had itself just stopped waited for an event that could not
    // come, and since #112 the handle's suspension ledger stayed open with it, so the reported
    // `pausedMs` went on growing on a run that had ended.
    //
    // Before the sessions are closed, so the ledger closes at the instant the run stopped rather
    // than at the end of teardown, and `#firstEnd` rather than a fresh outcome so a run that had
    // already ended keeps the reason it ended for. `settle()` is first-outcome-wins from the
    // other side too: the loop unwinding a moment later cannot overwrite this, which is what
    // stops a stop from being reported as the transport fault its own teardown provoked.
    //
    // Settling also RELEASES a parked pause -- with no decision, because there was none -- so the
    // `#halt` frame unwinds instead of holding this relay for the life of the process. See
    // `RunHandle.pauseAt` for why that is not spelled as an abort.
    if (this.#firstEnd) this.#handle?.settle(this.#firstEnd)
    for (const p of this.participants) {
      // The signal fires whatever the close did, including throwing (#143). A `close()` that fails
      // has still taken the session away, and leaving the signal unfired would park a polling turn
      // on a session nobody is coming back to -- which is the leak, reinstated on the path least
      // able to afford it.
      try {
        await p.session.close('graceful')
      } finally {
        // The forwarding barrier, and it is in the `finally` on purpose. `close()` returning means
        // the adapter has said everything it is going to; this means the relay has HEARD it.
        // Between the two sits `#attach`, and a `turn_end` established by the close is in flight
        // across it for as long as the reader takes to hand it on -- which is not a duration
        // anything here should be guessing at.
        //
        // A close that THROWS has still said whatever it managed to say before it threw, and a
        // reconcile that established a verdict and then failed to terminate the pty is exactly
        // that shape. Draining only on the happy path discarded it, and discarding a verdict is
        // worse than the leak this whole change is about -- raised by an independent review.
        //
        // This terminates because `AgentSession.events()` is required to end once `close()` has
        // returned, and every adapter now closes its queue in a `finally` of its own so a
        // throwing close still ends the iteration (#143). Without that half, awaiting here on the
        // exceptional path would replace a discarded verdict with a hang. `catch` because a
        // reader that threw has still stopped reading, and teardown is not where that gets
        // reported.
        await this.#forwarding.get(p.id)?.catch(() => {})
        this.#closeSignal(p.id).fire()
      }
    }
    // And now the loop is waited for, which is the rest of #143.
    //
    // #142 settled the handle from here precisely so a caller was not left depending on the loop
    // unwinding. That still holds: the handle is settled above, before this line, so `result()`
    // has already resolved and nothing a caller awaits is gated on what follows. This is a
    // narrower guarantee laid on top of it -- that by the time `stop()` returns, the run has
    // finished SAYING what it lost. The unfinished-turn note in `#runLoop`'s `finally` names the
    // seat turns whose reports never reached the advisor, and it is written as the loop unwinds;
    // a `stop()` that returned first would let a front end assemble its report, or a test assert
    // on the log, in the window before the run had accounted for itself.
    //
    // It can only wait as long as the loop takes to unwind, because every place the loop can be
    // parked is now released before this line: a pause by `settle()` above (#142), a turn's
    // `turn_end` poll and the send precondition by the close signals just fired, and everything
    // else the loop does between those is bounded already. `catch` because the outcome is not
    // wanted here and a rejection is `start()`'s business, not teardown's.
    await this.#looped?.catch(() => {})
    // Between closing the sessions and releasing the claim, in that order and for a reason.
    // Cleanup reads each seat's tree, so it must happen after the writers are gone; and
    // releasing the claim while a seat worktree still holds uncommitted work would report the
    // run cleanly finished with work stranded outside the integration checkout.
    this.#cleanupWorktrees()
    release(this.#opts.cwd)
  }

  /**
   * Remove the trees that are safe to remove, and account for every one that is not.
   *
   * "Safe" is narrow and deliberately so: merged, clean, present, and with nothing on its
   * branch the integration checkout lacks. Everything else is RETAINED with its path, its
   * branch, and the commands to inspect, merge or discard it — the same posture `guard()`
   * takes towards a lock left by a dead pid, which tells the operator what to run once they
   * have accounted for the files rather than clearing it for them.
   *
   * The recovery lines go into the routing log rather than to stdout: `stop()` can be called
   * from a console that owns the screen, and a print from here would land in the middle of
   * whatever it was drawing.
   */
  #cleanupWorktrees(): void {
    const manifest = this.#worktrees
    if (!manifest) return
    try {
      const report = cleanupSeatWorktrees(manifest)
      for (const line of recoveryLines(report)) {
        this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: line })
      }
    } catch (e) {
      this.#record({
        from: 'orchestrator',
        fromRank: 'human',
        to: [],
        kind: 'note',
        text:
          `seat worktree cleanup did not complete: ${(e as Error).message}. ` +
          `The trees under ${manifest.integrationRoot}/.conclave/worktrees/${manifest.runId} are ` +
          `still there and the manifest names what each one holds.`,
      })
    }
  }
}
