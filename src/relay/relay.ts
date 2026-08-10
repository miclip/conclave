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
  unwindSeatWorktrees,
  writeManifest,
  type WorktreeManifest,
} from '../workspace/worktrees.ts'
import { integrateSeat, integrationHead } from './integrate.ts'
import {
  envelope,
  type Audience,
  type MessageKind,
  type Rank,
  type RelayMessage,
  type Visibility,
} from './message.ts'
import { RelayEventStream, type ObserveOptions, type RelayEvent, type RunReason } from './observe.ts'
import { describeLiveness, sampleLiveness } from '../outcomes/liveness.ts'
import {
  RunHandle,
  type PauseOption,
  type PauseReason,
  type PauseSupersession,
  type RunOutcome,
  type RunPause,
} from './run.ts'
import { actorFor, resolutionFor, type ResolutionSubject } from './resolution.ts'
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
import { assess, ComplaintLedger, topicOf } from '../rotation/degradation.ts'
import { rotate, type RotationResult } from '../rotation/rotate.ts'
import type { CheckSpec } from '../rotation/record.ts'
import { resumeBriefing } from './resume.ts'
import { breached, type CeilingBreach, type CeilingState, type Ceilings } from './guardrails.ts'
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
   * `RoleId` is open on purpose (`registry/roles.ts:15`) — project configuration assigns
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
 * What a replacement must reproduce.
 *
 * Rotation without verification commands would be a transfer nobody demonstrated, which
 * is the thing §7a exists to prevent -- so leaving this unset does not disable the
 * *detection* of degradation, only the automatic response to it. A degraded implementer
 * with nothing to verify against escalates to the human instead.
 */
export interface RotationConfig {
  /**
   * Commands the replacement must run and reproduce. Without these, no rotation.
   *
   * A bare string is `required`: a mismatch rolls the rotation back. Pass
   * `{command, relevance}` for a check that should be run and reported without gating the
   * transfer. Relevance is declared HERE, by the orchestrator, and never by a participant.
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
}

/**
 * How long to keep re-reading a completed turn whose report came back empty.
 *
 * Generous on purpose: reaching it means the choice is between waiting and discarding a
 * turn's entire account of work already done. It is bounded rather than unbounded because
 * an unrecoverable transcript must still end in a decision rather than a hang.
 */
const DEFAULT_SALVAGE_MS = 90_000

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
   * Routing-log entries as they are recorded. Kept for callers that only want the log and
   * only want it pushed at them; `observe()` is the fuller surface, and carries the
   * participant activity this does not.
   */
  onLog?: (m: RelayMessage) => void
  /** Enables automatic rotation on mechanical degradation. See `RotationConfig`. */
  rotation?: RotationConfig
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
  | { kind: 'listed'; agents: string[] }
  | { kind: 'refused'; reason: string }

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
  const agents = listed.split(',').map((a) => a.trim())
  const bad = agents.find((a) => a === '' || a.startsWith('-'))
  if (bad !== undefined) {
    const detail = bad === '' ? 'an empty entry' : `an entry that looks like a flag ("${bad}")`
    return {
      kind: 'refused',
      reason:
        `--implementers "${raw.implementers}" has ${detail}. It is a comma-separated list of ` +
        `agents, one per seat: --implementers "claude,claude".`,
    }
  }
  if (raw.implementerNamed && agents[0] !== raw.implementer) {
    return {
      kind: 'refused',
      reason:
        `--implementer ${raw.implementer} and --implementers "${raw.implementers}" name different agents ` +
        `for the same seat. The first entry of --implementers IS the seat --implementer names ` +
        `('${seatIdFor(0)}'), so drop one or make them agree.`,
    }
  }
  return { kind: 'listed', agents }
}

/**
 * One `ParticipantSpec` per seat, ids assigned by `seatIdFor` and args resolved per agent.
 *
 * `argsFor` is a callback rather than a list because launch arguments are a property of the
 * AGENT -- `.conclave/config.json` keys them that way -- and two seats can be filled by
 * different ones. At N=1 this returns exactly the object both front-ends built inline before it
 * existed, which is what keeps the default run's spec unchanged.
 */
export function implementerSpecsFor(
  agents: string[],
  argsFor: (agent: string) => string[],
): ParticipantSpec[] {
  return agents.map((agent, i) => {
    const args = argsFor(agent)
    return {
      id: seatIdFor(i),
      agent,
      role: 'implementer',
      ...(args.length > 0 ? { args } : {}),
    }
  })
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
  /** The whole turn, however busy. */
  absolute: DeadlineClock
  /** How long the turn may say NOTHING. A different question, not a tighter version. */
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

/** A pause in front of a human that rests on a turn verdict, and can therefore go stale. */
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
  /** When the run began, for the wall-clock ceiling. Set on the first turn taken. */
  #startedAt = Date.now()
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
  /** Turns taken across all participants, which is what a ceiling counts. */
  #turnsTaken = 0
  #participants = new Map<string, RelayParticipant>()
  #seq = 0
  #opts: RelayOptions
  #stopped = false
  /** Set by `RunHandle.requestPause()`; consumed at the next advisor-turn boundary. */
  #pauseRequested: string | undefined
  /** The pause currently in front of a human, when it rests on a verdict. See `#trackSupersession`. */
  #verdictPause: VerdictPause | undefined
  #stream = new RelayEventStream()
  #ended = false
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

  private constructor(opts: RelayOptions) {
    this.#opts = opts
    // Set here and nowhere else. Whether rotation was configured cannot depend on how far
    // the run got -- see rotationWatch.armed and issue #31.
    this.rotationWatch.armed = opts.rotation !== undefined
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
    for (const spec of [opts.lead, ...seats]) {
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
    const relay = new Relay(opts)

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
   */
  #implementers(): RelayParticipant[] {
    return this.participants.filter((p) => p.rank === 'implementer')
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
    return this.#worktrees?.seats.find((s) => s.seatId === participantId)?.worktreePath ?? this.#opts.cwd
  }

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
   * `cwd` is where this participant's adapter is launched, and it is fixed at launch.
   *
   * Defaulting to the run cwd is the whole of the N=1 case and the whole of the advisor's case
   * at any N: the integration checkout is where they belong. An implementer seat at N>1 is
   * handed its own linked worktree instead, and it has to be handed it HERE -- an adapter's
   * working directory cannot be changed afterwards, so a session started in the shared
   * checkout is a seat that shares the checkout for the rest of the run.
   */
  async #join(spec: ParticipantSpec, rank: Rank, cwd: string = this.#opts.cwd): Promise<void> {
    const session = await this.#opts.registry.createParticipant(spec, {
      cwd,
      watchdogMs: this.#opts.turnWatchdogMs,
    })
    const p: RelayParticipant = { id: spec.id, agent: spec.agent, rank, role: spec.role, session, events: [], baselineGeneration: 0, degradationCursor: 0 }
    this.#participants.set(spec.id, p)
    this.#attach(p)
    // The role is named only when it says something the rank has not. At N=1 it repeats it,
    // and the join note is the line an operator reads at startup -- so the default run's log
    // is the same log it has always been.
    const as = spec.role === rank ? `${rank}` : `${rank} in role ${spec.role}`
    this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `${spec.id} joined as ${as} (${spec.agent})` })
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
    void (async () => {
      for await (const e of session.events()) {
        if (p.session !== session) return
        p.events.push(e)
        this.#trackPermission(p, e)
        this.#trackSupersession(p, e)
        this.#stream.emit({ type: 'activity', participant: p.id, rank: p.rank, event: e })
      }
    })()
  }

  /**
   * Which participants are stopped at a permission prompt, and for what.
   *
   * Both adapters implement `decidePermission` down to the keystroke, and nothing above
   * them ever called it: the console rendered `awaiting a permission decision` and offered
   * no way to answer, so the turn sat there until a watchdog ended it. The event was
   * already on the stream — what was missing was somewhere to remember it and something
   * able to reply.
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

  /** Terminal, and emitted exactly once however the run and `stop()` interleave. */
  #end(reason: RunReason, detail?: string): { reason: RunReason; detail?: string } {
    if (!this.#ended) {
      this.#ended = true
      this.#stream.emit({ type: 'run_end', reason, detail })
      this.#stream.close()
    }
    return detail === undefined ? { reason } : { reason, detail }
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

    try {
      const reply = await this.#exchange(
        impl,
        'The advisor considers this work complete and the session is about to end.\n\n' +
          'Before it does: is anything unresolved, unverified, or unanswered? A test you did ' +
          'not run, a belief you took from a comment rather than confirmed, a question you ' +
          'asked that was not answered, or a disagreement with how this was closed.\n\n' +
          'Reply with one FLAG: line per item, or exactly NONE if there is nothing. This is ' +
          'carried into the run summary; it does not reopen the work.',
      )

      const prose = reply.prose.trim()
      // A `note`, not a `report`. It is not relayed to the advisor and answers nobody's
      // instruction -- it is the participant's closing statement to the RECORD. Filing it as a
      // report made it the last thing `kind === 'report'` queries returned, which is how the
      // relayed-report assertions started reading it instead of the actual last report.
      this.#record({
        from: impl.id,
        fromRank: 'implementer',
        to: [],
        kind: 'note',
        text: `closing statement: ${prose || '(no reply)'}`,
      })
      if (!prose || /^NONE\b/i.test(prose)) return

      // `#exchange` already lifted any FLAG: lines. Anything else is carried whole rather than
      // dropped for want of a prefix.
      const already = this.flags.filter((f) => f.seq >= this.log.length - 1)
      if (already.length === 0) {
        this.flags.push({ participant: impl.id, text: prose, seq: this.log.length })
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

  /** Lines naming everything left unresolved. Empty when there is nothing to carry. */
  flagSummary(): string[] {
    if (this.flags.length === 0) return []
    const head = `${this.flags.length} flagged item${this.flags.length === 1 ? '' : 's'} carried:`
    return [head, ...this.flags.map((f) => `  ${f.participant} [msg ${f.seq}] — ${f.text}`)]
  }

  /** One line an operator can read to know whether the detector was live and what it saw. */
  rotationSummary(): string {
    const w = this.rotationWatch
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
        `(nothing was measured; this is not a negative result)`
      )
    }
    return (
      `rotation: armed — ${w.assessments} assessments, ${w.degradationsSeen} degraded, ` +
      `${w.complaintsSeen} complaints, ${w.candidates} candidates, ${w.rotations} rotations, ` +
      `peak compaction generation ${w.peakGeneration}`
    )
  }

  async #exchange(p: RelayParticipant, text: string): Promise<TurnResult> {
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
    let end: TurnEndEvent | undefined
    while (!end) {
      end = p.events.slice(before).find((e) => e.type === 'turn_end') as TurnEndEvent | undefined
      if (!end) await new Promise((r) => setTimeout(r, 250))
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
      }
    }
    for (const text of extractFlags(prose)) {
      this.flags.push({ participant: p.id, text, seq: this.log.length })
    }
    return { prose, end, unsettled, emittedSinceSend: p.events.length - before, changedDuringTurn: dirtyPaths(turnRoot).filter((f) => !treeBeforeTurn.has(f)) }
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
   */
  async #livenessEvidence(p: RelayParticipant, emittedSinceSend: number): Promise<string[]> {
    const pid = p.session.childPid
    if (pid === undefined) return []
    try {
      return [describeLiveness(await sampleLiveness(pid), emittedSinceSend)]
    } catch {
      return []
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
      conflict?: AuthorityConflict
      verdictOf?: { participant: string; endSeq: number }
      superseded?: PauseSupersession
    },
  ): Promise<RunOutcome | undefined> {
    const reason: PauseReason = p.subject.reason
    // Rotation checks are the operator pre-delegating rotation authority (D2), and they are
    // read here rather than passed in: a condition that could declare its own authority
    // would eventually declare the wrong one.
    const armed = (this.#opts.rotation?.checks.length ?? 0) > 0
    const resolution = resolutionFor(p.subject, { rotationArmed: armed })
    // Every request that reaches here must have somebody routed to answer it. Total today --
    // every authority falls back to the operator -- so this cannot throw and changes nothing.
    // It is here rather than with the routing it guards because this is the one place every
    // pause passes through, and because the day a `mechanical` authority is wired to a
    // resolver that does not exist, the alternative to throwing is silence.
    actorFor(resolution)
    this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `paused (${reason}): ${p.detail}` })
    if (!handle) {
      return this.#end(
        'escalated',
        `${p.detail} Nobody is attending this run, so it ends here — use relay.start(goal) ` +
          `to pause at this point and decide instead.`,
      )
    }
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
    // And `rotate` only where it names something. `rotateImplementer` takes a reason and no
    // seat, so at N>1 there is no seat it could mean -- offering it would put back the exact
    // inert choice the paragraph above is about, one release after taking it out.
    const rotatable = implIds.size === 1
    const options: PauseOption[] = ['continue', 'constrain', 'abort']
    if (armed && rotatable && aboutImplementer) options.splice(1, 0, 'rotate')
    // `wait` only where it is the right answer: the child is measurably alive, so the turn
    // is still happening and every other option is destructive. Offering it always would
    // invite waiting on a child that has already exited, which is a decision to sit
    // indefinitely on something that will never arrive.
    //
    // The evidence carrying the liveness reading is the same one the operator reads, so the
    // option and the reason for it cannot disagree.
    if (p.evidence.some((e) => /is still working \(cpu/.test(e))) options.splice(1, 0, 'wait')

    const deciding = handle.pauseAt({
      reason,
      resolution,
      detail: p.detail,
      evidence: p.evidence,
      options,
      ...(p.conflict === undefined ? {} : { conflict: p.conflict }),
      ...(p.verdictOf === undefined ? {} : { verdictOf: p.verdictOf }),
      ...(p.superseded === undefined ? {} : { superseded: p.superseded }),
      atSeq: this.#seq,
    })
    // Set by the line above; nothing runs between the two that could clear it.
    const pause = handle.pause!
    this.#stream.emit({ type: 'pause', pause })

    const decision = await deciding
    // No `resume` on an abort. The run does not continue, and `run_end` is what says so --
    // a resume followed immediately by the end would read as a session that carried on.
    if (decision.kind === 'abort') return this.#end('stopped', decision.detail)
    // Before the note, so the two events bracket the suspension itself as tightly as the
    // loop can see it; the note is the log's account of the same moment.
    this.#stream.emit({ type: 'resume', pause })
    this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `resumed from ${reason}` })
    return undefined
  }

  /**
   * Start a run you can hold onto.
   *
   * The supervised form. Pauses suspend the loop rather than ending it, so a rotation
   * candidate is a decision point rather than a dead end -- see `run.ts` for why restarting
   * `run()` is not the same as resuming.
   */
  start(goal: string): RunHandle {
    const handle = new RunHandle({
      rotate: (reason) => this.rotateImplementer(reason),
      constrain: (text, audience) => this.say(text, audience),
      requestStop: () => {
        this.#stopped = true
      },
      requestPause: (reason) => {
        this.#pauseRequested = reason
      },
    })
    void this.#loop(goal, handle).then(
      (outcome) => handle.settle(outcome),
      // Retained as a backstop only. #loop now converts a throw into a `transport_failed`
      // outcome, so this fires only for something #loop itself could not handle.
      (err: Error) => handle.settle(this.#end('transport_failed', `the run threw: ${err.message}`)),
    )
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
    // Counted before the decision, so the tally proves the detector RAN regardless of what
    // it concluded. That is the whole point: a zero here means "looked and saw nothing",
    // and its absence would mean "never looked".
    this.rotationWatch.assessments += 1
    this.rotationWatch.peakGeneration = Math.max(
      this.rotationWatch.peakGeneration,
      snap.compactionGeneration,
    )
    const verdict = assess({
      participant: impl.id,
      prose,
      baselineGeneration: impl.baselineGeneration,
      currentGeneration: snap.compactionGeneration,
      events: impl.events.slice(impl.degradationCursor),
      ledger: this.complaints,
      at: Date.now(),
    })

    if (verdict.degraded) this.rotationWatch.degradationsSeen += 1
    if (verdict.complained) this.rotationWatch.complaintsSeen += 1

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

    const detail = `${impl.id} is degraded: ${verdict.evidence.join('; ')}${verdict.complained ? ' (and said so)' : ' (and did not say so)'}`
    if (!this.#opts.rotation) {
      // Detection does not depend on configuration; the response does. Rotating with
      // nothing to verify against would be a transfer nobody demonstrated, so this goes to
      // the human instead of proceeding on an unverifiable handoff.
      return this.#end('escalated', `${detail}. No rotation checks are configured, so this needs a human.`)
    }
    if ((this.#opts.rotation.onDegradation ?? 'candidate') === 'candidate') {
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
      if (handle) {
        const halted = await this.#halt(handle, {
          subject: { reason: 'rotation_candidate', participant: impl.id },
          detail: `${detail}. Recorded as a rotation candidate, not acted on.`,
          evidence: verdict.evidence,
        })
        if (halted) return halted
      } else {
        this.#record({
          from: 'orchestrator',
          fromRank: 'human',
          to: [],
          kind: 'note',
          text: `rotation candidate recorded, run continues (unattended): ${detail}`,
        })
      }
      return this.#acknowledge(impl, snap.compactionGeneration)
    }

    const result = await this.rotateImplementer(detail)
    if (result.status === 'rotated') return undefined
    const halted = await this.#halt(handle, {
      subject: { reason: 'rotation_candidate', participant: impl.id },
      detail: `rotation failed (${result.reason}): ${result.detail}`,
      evidence: [...verdict.evidence, 'the original implementer is back in service'],
    })
    return halted ?? this.#acknowledge(impl, (await impl.session.snapshot()).compactionGeneration)
  }

  /**
   * The human saw this evidence and chose to carry on. Stop re-raising it.
   *
   * Without this, declining a candidate pauses again on the very next advisor turn, on the same
   * compaction, forever -- the operator either abandons the feature or stops reading the
   * pauses, and the second is worse. Moving the baseline means a *later* compaction is new
   * evidence and does pause again, which is the distinction that makes the signal worth
   * surfacing at all.
   *
   * Found by three tests hanging rather than by design.
   */
  #acknowledge(impl: RelayParticipant, generation: number): undefined {
    impl.baselineGeneration = generation
    impl.degradationCursor = impl.events.length
    this.#record({
      from: 'orchestrator',
      fromRank: 'human',
      to: [],
      kind: 'note',
      text: `rotation candidate declined at compaction generation ${generation}; a later compaction will raise it again`,
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
    return this.#loop(goal, undefined)
  }

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
  #admit(instruction: string, target: TaskTarget, origin: number, purpose: TaskPurpose): Task {
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
   * branch and tree are untouched, its work is committed and intact, and resolution is work
   * the advisor has to dispatch back to that seat. Blocking every other seat on one seat's
   * conflict would be lockstep again, reached from a different direction. Making the blocked
   * seat undispatchable, and raising this onto a decision queue the advisor services, is the
   * seat-block machinery — not built here.
   */
  #crossBoundary(task: Task, seatId: string): BoundaryOutcome {
    const manifest = this.#worktrees
    if (!manifest) return { kind: 'clear' }
    const tree = manifest.seats.find((s) => s.seatId === seatId)
    if (!tree) return { kind: 'clear' }
    const note = (text: string): void => {
      this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text })
    }
    try {
      const result = integrateSeat(manifest, tree, {
        taskId: task.id,
        seq: task.seq,
        advisorTurn: task.origin,
      })
      if (result.status !== 'blocked') {
        if (result.status === 'nothing_to_merge') {
          note(`${seatId} changed nothing for ${task.id}; nothing to integrate`)
        } else {
          note(`${seatId}'s work for ${task.id} merged into ${manifest.integrationRoot} at ${result.integrationSha.slice(0, 12)}`)
          for (const n of result.notes) note(n)
        }
        // A boundary that got through IS the repair, whatever the instruction that produced it
        // was called. Nothing else clears a block: not a turn, not an advisor saying so.
        if (this.#blocked.delete(seatId)) {
          const cleared = `${seatId}'s merge conflict is resolved and its work is in the integration checkout. It takes ordinary work again.`
          note(cleared)
          this.#tellLead(cleared)
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
      note(
        `${seatId}'s work for ${task.id} could not be merged and the integration checkout was ` +
          `left as it was. Its work is committed on ${tree.branch} and nothing has been discarded.` +
          `${conflicting} ${result.detail}`,
      )
      if (!repeat) {
        // The advisor is told because resolution is WORK, and work is dispatched. It is told in
        // the terms it has to act in: the conflict is the seat's to resolve, in the seat's own
        // tree, and the next instruction goes there whether or not the advisor names it.
        this.#tellLead(
          `${seatId}'s work is committed on ${tree.branch} but will not merge into the integration ` +
            `checkout.${conflicting} It is blocked and takes no other work until this clears. Your next ` +
            `instruction goes to ${seatId}: tell it to merge the current integration HEAD into its own ` +
            `branch, resolve the conflict IN ITS OWN WORKTREE, verify whatever you think that needs, and ` +
            `report. Nothing has been lost and no other seat is affected.${this.#addressBlocked(seatId)}`,
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
          `the work is committed on ${tree.branch} and its worktree ${tree.worktreePath} is retained`,
          `no other seat is blocked by this`,
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
      note(`${seatId}'s boundary for ${task.id} did not complete: ${detail}`)
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
          `${seatId}'s work could not be integrated: the boundary itself failed (${detail}). Its work is ` +
            `on ${tree.branch} and nothing has been discarded. It is blocked and takes no other work ` +
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
          `${tree.worktreePath} is retained and its branch ${tree.branch} is untouched`,
        ],
      }
    }
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
      elapsedMs: Date.now() - this.#startedAt,
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
    let next = await this.#exchange(
      lead,
      `${LEAD_BRIEFING}\n\n${SUBAGENT_BRIEFING}\n\n` +
        // Only when there is more than one seat to address. See MULTI_SEAT_BRIEFING: an advisor
        // that never hears the syntax never writes it, and the default run's briefing is
        // byte-identical to what it has always been.
        `${seats.length > 1 ? `${MULTI_SEAT_BRIEFING}\n\n` : ''}` +
        `${this.#opts.operator === 'agent' ? `${AGENT_OPERATOR_NOTICE}\n\n` : ''}` +
        `${prior}The goal for this session:\n\n${goal}\n\nGive the implementer its first instruction.`,
    )

    const maxAdvisorTurns = boundOf(this.#opts)
    this.#startedAt = Date.now()
    this.#worktreesAtStart = worktreePaths(this.#opts.cwd)
    this.#worktreesSeen = new Set(this.#worktreesAtStart)
    this.#seatState = new Map(
      seats.map((p): [string, SeatExecution] => [
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
    try {
      for (let advisorTurn = 1; ; advisorTurn++) {
        // Every ceiling at the dispatch boundary, before anything is admitted or assigned, and
        // never mid-turn. A run cannot be interrupted mid-turn without discarding that turn's
        // work -- the same reason #exchange has no timeout of its own.
        if (advisorTurn > maxAdvisorTurns) break
        const ceiling = this.#breachedNow()
        if (ceiling) {
          this.#record({
            from: 'orchestrator',
            fromRank: 'human',
            to: [],
            kind: 'note',
            text: ceiling.detail,
          })
          return this.#end('ceiling', ceiling.detail)
        }
        if (this.#stopped) return this.#end('stopped')

        if (this.#pauseRequested) {
          const reason = this.#pauseRequested
          this.#pauseRequested = undefined
          const halted = await this.#halt(handle, {
            subject: { reason: 'operator_requested' },
            detail: reason,
            evidence: [`advisor turn ${advisorTurn} of ${maxAdvisorTurns}; no turn is in flight`],
          })
          if (halted) return halted
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
        if (next.end.verdict.outcome !== 'completed' || !decisions.ok) {
          const why =
            next.end.verdict.outcome !== 'completed'
              ? `${lead.id} turn ended ${formatVerdict(next.end.verdict)}`
              : // EVERY parse failure, not just the empty reply: one sentence, and it is the one
                // an empty instruction has always produced. D4 says an unparseable reply is
                // treated exactly as an empty instruction is treated today, and a second wording
                // would be a divergence in the operator-visible path -- the kind the guards can
                // only pin as an exact string. `ParseFailure` still carries `why` and `detail`
                // for whenever surfacing them is a change somebody declares on purpose.
                `${lead.id} produced no instruction`
          const evidence = next.end.verdict.provenance.map((v) => `${v.source}: ${v.detail}`)
          this.#record({
            from: 'orchestrator',
            fromRank: 'human',
            to: [],
            kind: 'note',
            text: [why, ...evidence].join(' — '),
          })
          const halted = await this.#halt(handle, {
            // The ADVISOR's turn. The scope is the seat whose turn ended badly, which is not
            // always the implementer -- and reading it off `verdictOf` would tie the axis to a
            // field that only exists on the verdict-backed pauses.
            subject: { reason: 'turn_incomplete', participant: lead.id },
            detail: why,
            evidence: [...evidence, ...(await this.#livenessEvidence(lead, next.emittedSinceSend))],
            verdictOf: { participant: lead.id, endSeq: next.end.seq },
          })
          if (halted) return halted
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
          if (halted) return halted
          // Resumed. The advisor said its piece and the human decided otherwise, so it is
          // asked again rather than having its escalation replayed as an instruction.
          next = await this.#exchange(lead, this.#drain(lead.id) || 'The human has seen your escalation and asked you to continue. Give the implementer its next instruction.')
          continue
        } else {
          // EVERY decision the reply carried, admitted in the order it was written. Taking the
          // first and dropping the rest would be the dispatcher silently running a quarter of a
          // plan the advisor wrote as one -- and `parseDecisions` is atomic, so a list that got
          // here is a list that validated whole.
          for (const admitting of decisions.decisions) {
            // Narrowing, not filtering: `done` and `escalate` are handled above and cannot be
            // in a list alongside an instruction.
            if (admitting.kind !== 'instruct') continue

            // The queue ceiling, asked BEFORE the admission it would forbid. The reading is
            // projected -- what the queue becomes if this task is admitted -- because the actual
            // depth at every boundary the loop can check is the depth before the advisor's
            // decision is applied, and a ceiling that only ever saw that would never see a queue
            // at all.
            //
            // Before rather than after so a breach leaves nothing behind: no `Task` record that
            // nothing will dispatch, and no runtime entry stuck at `admitted` forever. Inside the
            // loop rather than once for the batch, because the depth this bounds is the depth
            // after each admission, and a reply carrying five decisions crosses the ceiling on
            // whichever one crosses it.
            const wouldQueue = this.#breachedNow({ queueDepth: queueDepth(this.#queue, this.#taskRuntime) + 1 })
            if (wouldQueue) {
              this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: wouldQueue.detail })
              return this.#end('ceiling', wouldQueue.detail)
            }

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
              if (halted) return halted
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
            return this.#end('ceiling', breach.detail)
          }
        }

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
        if ('error' in completion) throw completion.error
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
          if (halted) return halted
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
              // Wired here too, and it was not. Liveness went into the two `turn_incomplete`
              // paths only, so a live run's three pauses carried it once -- and the two that
              // missed out were these, where "the report could not be read" is exactly when
              // knowing whether the child is still writing changes what the operator does.
              ...(await this.#livenessEvidence(seat, report.emittedSinceSend)),
            ],
          })
          if (halted) return halted
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
            evidence: [
              ...current.verdict.provenance.map((p) => `${p.source}: ${p.detail}`),
              ...(await this.#livenessEvidence(seat, report.emittedSinceSend)),
            ],
            verdictOf: { participant: seat.id, endSeq: current.seq },
            ...(pre === undefined ? {} : { superseded: pre }),
          })
          this.#verdictPause = undefined
          if (halted) return halted
        }

        // §7a. Assessed before the advisor sees the report, so a degraded implementer is
        // replaced rather than issued another instruction it cannot act on well.
        const rotated = await this.#considerRotation(seat, report.prose, handle)
        if (rotated) return rotated

        // The git side of the same boundary, and only when this run has seat worktrees. The
        // seat's work is invisible to everyone else until it is committed and merged, so this is
        // where it stops being the seat's and starts being the run's. At N=1 `#worktrees` is
        // undefined and nothing here runs -- one tree, one branch, and no merge to do.
        const boundary = this.#crossBoundary(task, seat.id)

        // The integration boundary, and the release it earns -- or the release it does NOT earn.
        // Ahead of the advisor turn rather than after it: a seat whose work is integrated, with
        // ready work waiting for it, must not idle through an advisor turn to collect it. At N=1
        // `#crossBoundary` is a no-op and this is always `#integrate`, which is where the seat
        // simply becomes free again.
        //
        // A boundary that did not merge takes the other branch. It must not record `integrated`:
        // that fact is what dependents are released against, and a conflicted task claiming it
        // would let work run on a base that never absorbed the thing it depends on.
        if (boundary.kind === 'blocked') this.#failBoundary(task, exec)
        else this.#integrate(task, exec)

        // The second failure against the same integration parent. The repair was dispatched, it
        // came back, and the merge still will not go -- so another advisor turn is another turn
        // spent on a question the seat has already failed to answer.
        if (boundary.kind === 'blocked' && boundary.escalate) {
          const halted = await this.#halt(handle, {
            subject: { reason: 'merge_blocked', participant: boundary.seatId },
            detail: boundary.detail,
            evidence: boundary.evidence,
          })
          if (halted) return halted
          // Resumed. The operator may have resolved it by hand or may simply want another
          // round, and either way the count starts again -- an escalation on every subsequent
          // boundary would make resuming pointless.
          const block = this.#blocked.get(boundary.seatId)
          if (block) block.attempts = 1
        }

        // The seat has just been released, so ready work it can take goes to it NOW rather than
        // after the advisor has been asked and answered. A seat idling through an advisor turn
        // to collect work already sitting in the queue is the lockstep this design exists to
        // remove, reached from the other end. At N=1 the queue is empty here -- one reply
        // admits one task and it was dispatched immediately -- so nothing happens.
        const filled = dispatchReady()
        if (filled) {
          this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: filled.detail })
          return this.#end('ceiling', filled.detail)
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
      // Turns that were still running when the run ended, named rather than dropped.
      //
      // Every exit from the loop above can happen with siblings in flight -- a ceiling, a
      // pause the operator did not resume, an escalation, a stop. Their sessions are closed by
      // `stop()` and their reports are lost, which is a real cost and one no other record
      // carries: the routing log shows the instruction going out and nothing coming back, and
      // a reader has no way to tell that from a seat that is still thinking. At N=1 nothing is
      // ever in flight here, because the one turn the loop is waiting on is the one it just
      // finished processing.
      if (outstanding() > 0) {
        const lost = [...inflight.keys(), ...arrived.map((c) => c.task.id)]
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
   * The transaction lives in `rotation/rotate.ts`; this supplies the four things it cannot
   * get for itself: how to talk to a session, how to start a fresh implementer, which
   * human constraints to replay, and where to write the notes.
   *
   * Callable by the human as well as by the run loop. Nothing about it assumes the loop is
   * running -- an operator watching a session degrade should not have to wait for the
   * orchestrator to notice.
   */
  async rotateImplementer(reason: string): Promise<RotationResult> {
    const cfg = this.#opts.rotation
    if (!cfg) {
      throw new Error(
        'rotation needs verification commands: set `rotation.checks` so a replacement has ' +
          'something to reproduce. Rotating without them would be a transfer nobody demonstrated.',
      )
    }
    // Genuinely singular, and refused rather than guessed at. This method takes a reason and no
    // seat: at N>1 "the implementer" names nothing, and quietly rotating the first seat would
    // retire a session whose operator asked about another one. Rotating a NAMED seat is a
    // different method with a different signature, and it does not exist yet.
    const seats = this.#implementers()
    if (seats.length > 1) {
      throw new Error(
        `rotateImplementer names no seat, and this run has ${seats.length} (${seats.map((s) => s.id).join(', ')}). ` +
          `Rotation replaces one session and carries its work forward, so it needs to be told which.`,
      )
    }
    const advisor = this.participants.find((p) => p.rank === 'advisor')!
    const impl = this.#leadImplementer()
    const spec = this.#opts.implementer
    /** The replacement while it is proving itself, before it is anyone's session. */
    let audition: RelayParticipant | undefined

    this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `rotating ${impl.id}: ${reason}` })

    const result = await rotate({
      old: impl.session,
      advisor: advisor.session,
      reason,
      deps: {
        root: this.#opts.cwd,
        exchange: async (session, text) => {
          // The replacement is not in the participant map yet -- it is being auditioned --
          // but it gets the same exchange as everyone else. A second path here would be a
          // second set of failure modes on the least-tested code in the system.
          const p = [...this.participants, audition].find((q) => q?.session === session)
          if (!p) throw new Error('exchange requested for a session the relay does not hold')
          return (await this.#exchange(p, text)).prose
        },
        startReplacement: async () => {
          const session = await this.#opts.registry.createParticipant(spec, {
            cwd: this.#opts.cwd,
            watchdogMs: this.#opts.turnWatchdogMs,
          })
          // Same spec, so the same role: a replacement that changed what the seat is FOR
          // would be a different seat wearing the id, and the handoff it just proved was
          // measured against the outgoing session's job.
          audition = { id: `${spec.id}~replacement`, agent: spec.agent, rank: 'implementer', role: spec.role, session, events: [], baselineGeneration: 0, degradationCursor: 0 }
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
    })

    if (result.status === 'rotated' && audition) {
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
      audition.id = impl.id
      impl.session = result.replacement
      impl.events = audition.events
      impl.baselineGeneration = 0
      impl.degradationCursor = impl.events.length
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
      this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `${impl.id} rotated into ${result.replacement.sessionId}` })
    } else if (result.status === 'rolled_back') {
      this.#record({
        from: 'orchestrator',
        fromRank: 'human',
        to: [],
        kind: 'note',
        text: `rotation rolled back (${result.reason}): ${result.detail}. ${impl.id} is back in service.`,
      })
    }
    return result
  }

  async stop(): Promise<void> {
    this.#stopped = true
    // A run that already ended keeps the reason it ended for; teardown is not a second
    // outcome. Only a relay stopped without ever finishing a run reports 'stopped'.
    this.#end('stopped')
    for (const p of this.participants) await p.session.close('graceful')
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
