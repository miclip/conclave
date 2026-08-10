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
import { resolutionFor, type ResolutionSubject } from './resolution.ts'
import {
  attributable,
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
import { breached, type Ceilings } from './guardrails.ts'
import {
  dependenciesMet,
  nextDispatch,
  parseDecisions,
  recordCompletion,
  refuseDispatch,
  type SeatExecution,
  type Task,
  type TaskEvent,
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
   * retired session's compaction events would be re-read every round and the replacement
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
   * Distinct from `maxRounds`, which bounds the ADVISOR/IMPLEMENTER exchange structure. A
   * ceiling bounds the run as a resource: it is what stops a run that is progressing but has
   * been progressing for two hours, which `maxRounds` cannot express because a single round
   * can contain an arbitrarily long turn.
   *
   * Also a recording device. The rotation experiments need "it ran for two hours" to be a
   * deliberate setting rather than an accident, and a ceiling that must be raised on purpose
   * puts the intended length into the record.
   */
  ceilings?: Ceilings | undefined
  /** The advisor. Steers, and cannot see the implementer's tools. */
  lead: ParticipantSpec
  implementer: ParticipantSpec
  /** Exchanges before the relay stops and hands back to the human. */
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
  /** Set by `RunHandle.requestPause()`; consumed at the next round boundary. */
  #pauseRequested: string | undefined
  /** The pause currently in front of a human, when it rests on a verdict. See `#trackSupersession`. */
  #verdictPause: VerdictPause | undefined
  #stream = new RelayEventStream()
  #ended = false
  /** True while `#loop` owns the participants. `ask` refuses rather than racing it. */
  #looping = false

  private constructor(opts: RelayOptions) {
    this.#opts = opts
    // Set here and nowhere else. Whether rotation was configured cannot depend on how far
    // the run got -- see rotationWatch.armed and issue #31.
    this.rotationWatch.armed = opts.rotation !== undefined
  }

  static async start(opts: RelayOptions): Promise<Relay> {
    const relay = new Relay(opts)
    // Sequential rather than parallel: two CLIs negotiating terminals and hook trust at
    // once produces interleaved failures that are miserable to attribute.
    await relay.#join(opts.lead, 'advisor')
    await relay.#join(opts.implementer, 'implementer')
    // Records what the tree looked like before the participants touched it, so the
    // operator's own tooling can refuse to sweep their work into an unrelated commit.
    acquire(opts.cwd, [
      { id: opts.lead.id, agent: opts.lead.agent },
      { id: opts.implementer.id, agent: opts.implementer.agent },
    ])
    return relay
  }

  /** The repository the run works in. Read by the terminal record; see relay/report.ts. */
  get cwd(): string {
    return this.#opts.cwd
  }

  /** Who answers escalations. Default `'human'`; see RelayOptions.operator. */
  get operator(): 'human' | 'agent' {
    return this.#opts.operator ?? 'human'
  }

  get participants(): RelayParticipant[] {
    return [...this.#participants.values()]
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

  async #join(spec: ParticipantSpec, rank: Rank): Promise<void> {
    const session = await this.#opts.registry.createParticipant(spec, {
      cwd: this.#opts.cwd,
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

  async #exchange(
    p: RelayParticipant,
    text: string,
  ): Promise<{ prose: string; end: TurnEndEvent; unsettled: boolean; emittedSinceSend: number; changedDuringTurn: string[] }> {
    // Counted here, where a turn actually starts, so the ceiling measures work done rather
    // than rounds entered -- a round can contain one turn or several.
    this.#turnsTaken += 1
    // Sampled per turn: a worktree created and removed inside one turn is still evidence the
    // rule was followed, and only a repeated sample can see it.
    if (this.#worktreesAtStart) for (const w of worktreePaths(this.#opts.cwd)) this.#worktreesSeen.add(w)
    const before = p.events.length
    // What the tree looked like before this turn. Only ever used to say what a LOST report
    // would have described: an escalation that says "the report came back empty" and one
    // that says "the report came back empty; 3 files changed on disk" ask very different
    // things of whoever reads it (#39).
    const treeBeforeTurn = new Set(dirtyPaths(this.#opts.cwd))
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
    return { prose, end, unsettled, emittedSinceSend: p.events.length - before, changedDuringTurn: dirtyPaths(this.#opts.cwd).filter((f) => !treeBeforeTurn.has(f)) }
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
  #treeAtOrigin: string[] | undefined

  say(text: string, audience: Audience = 'all', kind: MessageKind = 'constraint'): RelayMessage {
    const to = this.#resolve(audience)
    const m = this.#record({ from: 'human', fromRank: 'human', to, kind, text })
    if (m.visibility === 'restricted') {
      this.restrictedOrigins.push(originOf(m))
      // Snapshot the tree so paths appearing after this message can be attributed to it.
      this.#treeAtOrigin = dirtyPaths(this.#opts.cwd)
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
   * The relay itself decides nothing beyond the round budget: DONE and ESCALATE are the
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

  #attributeArtifacts(): void {
    const origin = this.restrictedOrigins.at(-1)
    if (!origin || !this.#treeAtOrigin) return
    const before = new Set(this.#treeAtOrigin)
    const candidates = dirtyPaths(this.#opts.cwd).filter((p) => !before.has(p))
    if (candidates.length === 0) return

    // Only the participants that were told. One kept from the aside cannot have acted on
    // it, so its tool calls are not evidence of what the aside caused.
    const evidence = origin.informed.flatMap((id) =>
      (this.#evidence.get(id) ?? []).slice(this.#evidenceAtOrigin.get(id) ?? 0),
    )
    for (const path of attributable(candidates, evidence)) {
      origin.artifactSupport[path] = supportFor(path, evidence)
      if (!origin.artifacts.includes(path)) origin.artifacts.push(path)
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
    const implId = this.participants.find((x) => x.rank === 'implementer')?.id
    const aboutImplementer = p.verdictOf === undefined || p.verdictOf.participant === implId
    const options: PauseOption[] = ['continue', 'constrain', 'abort']
    if (armed && aboutImplementer) options.splice(1, 0, 'rotate')
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
   * Called every round, because a session may compact without saying so and a session
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
   * Without this, declining a candidate pauses again on the very next round, on the same
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
  #admit(instruction: string, target: TaskTarget, origin: number): Task {
    const task: Task = {
      id: `t-${++this.#taskSeq}`,
      seq: this.#taskSeq,
      origin,
      instruction,
      target,
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
    const refusal = refuseDispatch(seat, this.#taskRuntime)
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

  async #runLoop(goal: string, handle: RunHandle | undefined): Promise<RunOutcome> {
    const lead = this.participants.find((p) => p.rank === 'advisor')!
    const impl = this.participants.find((p) => p.rank === 'implementer')!

    // `to` is the whole of it. `#record` derives `restricted` and `excluded` from the gap
    // between recipients and participants, so a goal the implementer does not get is
    // audited as a withheld human message without any special casing here.
    this.#record({ from: 'human', fromRank: 'human', to: [lead.id], kind: 'goal', text: goal })

    // A prior run's routing log, replayed. Both seats get it: the implementer needs the
    // work already done, and the advisor needs to know what it already decided -- an advisor
    // that re-issues an instruction the log shows as completed is the failure this prevents.
    const prior = this.#opts.resume?.length ? `${resumeBriefing(this.#opts.resume)}\n\n` : ''

    await this.#exchange(
      impl,
      `${IMPLEMENTER_BRIEFING}\n\n${SUBAGENT_BRIEFING}\n\n${WITHHELD_GOAL_NOTICE}\n\n${prior}Acknowledge briefly; do not start work yet.`,
    )
    let next = await this.#exchange(
      lead,
      `${LEAD_BRIEFING}\n\n${SUBAGENT_BRIEFING}\n\n` +
        `${this.#opts.operator === 'agent' ? `${AGENT_OPERATOR_NOTICE}\n\n` : ''}` +
        `${prior}The goal for this session:\n\n${goal}\n\nGive the implementer its first instruction.`,
    )

    const maxRounds = this.#opts.maxRounds ?? 6
    this.#startedAt = Date.now()
    this.#worktreesAtStart = worktreePaths(this.#opts.cwd)
    this.#worktreesSeen = new Set(this.#worktreesAtStart)
    this.#seatState = new Map(
      this.participants
        .filter((p) => p.rank === 'implementer')
        .map((p): [string, SeatExecution] => [
          p.id,
          { seat: p.id, role: p.role, state: 'idle', idleSince: this.#startedAt, dispatched: 0 },
        ]),
    )
    // The target for an instruction that names none, which is every instruction the advisor can
    // currently write: there is no target syntax in its briefing, and inventing one here would
    // change what the advisor is asked to produce rather than how the relay schedules it. The
    // ROLE rather than the seat id, because the rule that resolves it -- longest-idle seat
    // filling the role -- is the same rule at any N, and at N=1 it has exactly one answer.
    const untargeted: TaskTarget = { kind: 'role', role: impl.role }

    // The dispatcher. One iteration is one ADMISSION CYCLE: the advisor's standing reply is
    // read as assignment decisions, at most one task is admitted, and that task runs to a
    // graded verdict and a released seat before the next cycle can admit anything.
    //
    // At N=1 this IS the round loop it replaced -- same turns, in the same order, producing the
    // same routing log -- because a queue that admits one task at a time and a table with one
    // dispatchable seat is a round (D1). Nothing here counts seats.
    //
    // `maxRounds` survives as the bound on admission cycles rather than being reinterpreted or
    // removed. It stops describing the structure the day a second seat exists and D8 removes it
    // then; doing it here would change `RelayOptions` and both front-ends for no behaviour.
    for (let cycle = 1; ; cycle++) {
      // Every ceiling at the dispatch boundary, before anything is admitted or assigned, and
      // never mid-turn. A run cannot be interrupted mid-turn without discarding that turn's
      // work -- the same reason #exchange has no timeout of its own.
      if (cycle > maxRounds) break
      const ceiling = this.#opts.ceilings
        ? breached(this.#opts.ceilings, {
            elapsedMs: Date.now() - this.#startedAt,
            turns: this.#turnsTaken,
          })
        : undefined
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
          evidence: [`round ${cycle} of ${maxRounds}; no turn is in flight`],
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
      // the note. Bounded: this happens inside the round, and the guard below still catches a
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
      const decisions = parseDecisions(instruction, [...this.#seatState.values()], untargeted)

      // An advisor turn that ended badly, or produced nothing that can be admitted, must not be
      // forwarded.
      //
      // The `turn_incomplete` guard below covers the IMPLEMENTER only, so an advisor whose
      // turn errored was relayed as an empty instruction: the implementer received a routing
      // header with no body, asked for a resend, and the run churned rounds toward its budget
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

      // Exactly one decision per reply today: the advisor emits one instruction per turn and
      // has no syntax for more. `parseDecisions` is where a reply becomes several, and this is
      // the line that has to change with it -- silently taking the first of a longer list would
      // be the dispatcher dropping work the advisor asked for.
      const decision = decisions.decisions[0]!

      if (decision.kind === 'done') {
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
          if ((this.#pending.get(impl.id) ?? []).length > 0) {
            const extra = await this.#exchange(impl, this.#drain(impl.id))
            this.#record({ from: impl.id, fromRank: 'implementer', to: [lead.id], kind: 'report', text: extra.prose })
            next = await this.#exchange(
              lead,
              [this.#drain(lead.id), envelope({ from: impl.id, fromRank: 'implementer', fromRole: impl.role, kind: 'report', text: extra.prose })]
                .filter(Boolean)
                .join('\n\n'),
            )
          } else {
            next = await this.#exchange(lead, this.#drain(lead.id))
          }
          // Bounded by the round budget like everything else, so a human who keeps talking
          // extends the session rather than making it unstoppable.
          continue
        }
        this.#record({ from: lead.id, fromRank: 'advisor', to: [], kind: 'note', text: `advisor reports the work complete: ${instruction}` })
        await this.#closingQuestion(impl)
        return this.#end('done', instruction)
      }
      if (decision.kind === 'escalate') {
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
      }

      // Admitted before anything is delivered, so the record of what the advisor decided exists
      // whether or not it survives adjudication. Admission logs nothing: the task record is the
      // dispatcher's account of the schedule, and the routing log stays the account of what
      // actually moved between participants.
      const task = this.#admit(decision.instruction, decision.target, next.end.seq)

      // BEFORE delivery, not after. The point of the pause is that the human adjudicates
      // while the instruction is still a proposal. Once per admission rather than once per
      // dispatch, which is why the task carries the restricted origins it was judged against.
      const conflict = detectConflict(task.instruction, this.restrictedOrigins)
      if (conflict && !this.#adjudicated.has(`${conflict.origin.seq}:${instruction}`)) {
        this.#adjudicated.add(`${conflict.origin.seq}:${instruction}`)
        const halted = await this.#halt(handle, {
          // The workstream carrying the instruction under adjudication. At N=1 there is one,
          // and it is the implementer's -- the seat id names it because at this size they
          // are the same thing (D1), not because a workstream is a seat. #57's task graph is
          // what gives them separate names.
          subject: { reason: 'authority_conflict', workstream: impl.id },
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
        this.#adjudicate(impl.id, conflict.origin.seq)
      }

      // The lowest-`seq` ready task whose target seat is free -- at N=1 the task just admitted
      // and the one seat that can take it. Read out of the queue rather than used directly, so
      // the scan that lets a later task overtake a blocked one is the code that runs today
      // rather than the code that will be written when there is something to overtake.
      const dispatch = nextDispatch(this.#queue, this.#taskRuntime, [...this.#seatState.values()])
      if (!dispatch) {
        // Unreachable while admission is serial: the previous cycle graded its verdict and
        // released its seat before the advisor was asked for this instruction. Thrown rather
        // than worked around, because there is no correct fallback -- waiting for a seat that
        // nothing will ever free is a run that reports healthy forever. `#loop` turns this into
        // an outcome, so the operator gets the sentence rather than a hang.
        throw new Error(
          `dispatcher has no free seat for ${task.id} targeting ` +
            `${task.target.kind === 'seat' ? task.target.seat : `role ${task.target.role}`}`,
        )
      }
      const seat = this.#participants.get(dispatch.seat.seat)!
      this.#assign(dispatch.task, dispatch.seat)

      this.#record({ from: lead.id, fromRank: 'advisor', to: [seat.id], kind: 'instruction', text: dispatch.task.instruction })
      const aside = this.#drain(seat.id)
      this.#sending(dispatch.task)
      const report = await this.#exchange(
        seat,
        [aside, envelope({ from: lead.id, fromRank: 'advisor', fromRole: lead.role, kind: 'instruction', text: dispatch.task.instruction })]
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
      // The seat is now `integrating`: not running, and not available. Its verdict has not been
      // graded yet, and until it has, nothing can be dispatched to it.
      this.#reported(dispatch.task, dispatch.seat, recorded.seq, report.unsettled)

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
        const dirtyNow = dirtyPaths(this.#opts.cwd).length
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
      this.#attributeArtifacts()

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
      this.#grade(dispatch.task, current, {
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

      // The integration boundary, and the release it earns. Ahead of the advisor turn rather
      // than after it: a seat whose work is integrated, with ready work waiting for it, must
      // not idle through an advisor turn to collect it. At N=1 there is nothing waiting and
      // nothing to commit, so this is where the seat simply becomes free again.
      this.#integrate(dispatch.task, dispatch.seat)

      const leadAside = this.#drain(lead.id)
      next = await this.#exchange(
        lead,
        [leadAside, envelope({ from: seat.id, fromRank: 'implementer', fromRole: seat.role, kind: 'report', text: report.prose })]
          .filter(Boolean)
          .join('\n\n'),
      )
      // The report has reached the advisor. Independent of integration above, and recorded
      // separately: at N>1 a task reaches the two in either order.
      this.#routed(dispatch.task)
    }
    return this.#end('budget')
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
    const advisor = this.participants.find((p) => p.rank === 'advisor')!
    const impl = this.participants.find((p) => p.rank === 'implementer')!
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
    release(this.#opts.cwd)
  }
}
