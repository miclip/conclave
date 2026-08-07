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
import {
  RunHandle,
  type PauseReason,
  type PauseSupersession,
  type RunOutcome,
  type RunPause,
} from './run.ts'
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

export type {
  ObserveOptions,
  RelayActivityEvent,
  RelayEvent,
  RelayMessageEvent,
  RelayRunEndEvent,
  RunReason,
} from './observe.ts'

export interface RelayParticipant {
  id: string
  rank: Rank
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
  /** Per-turn deadline, handed to each adapter's watchdog rather than kept here. */
  turnWatchdogMs?: number
  /**
   * How long to wait for the transcript to catch up with a turn the hook says has ended.
   * NOT a turn deadline; see `#exchange`. Default 15s.
   */
  transcriptSettleMs?: number
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
exactly ESCALATE: followed by why.`

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
anyone actually reads.`

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

  async #join(spec: ParticipantSpec, rank: Rank): Promise<void> {
    const session = await this.#opts.registry.createParticipant(spec, {
      cwd: this.#opts.cwd,
      watchdogMs: this.#opts.turnWatchdogMs,
    })
    const p: RelayParticipant = { id: spec.id, rank, session, events: [], baselineGeneration: 0, degradationCursor: 0 }
    this.#participants.set(spec.id, p)
    this.#attach(p)
    this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `${spec.id} joined as ${rank} (${spec.agent})` })
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
      this.#supersede(
        pending,
        `the ${pending.outcome} verdict this pause was raised on was withdrawn and replaced ` +
          `with ${formatVerdict(e.verdict)}; the run is still paused, and the decision is still yours`,
        e.verdict,
      )
      this.#verdictPause = undefined
    }
  }

  #supersede(pending: VerdictPause, note: string, verdict?: Verdict): void {
    const info: PauseSupersession = { at: Date.now(), note, ...(verdict === undefined ? {} : { verdict }) }
    // Recorded only if the pause was still there to amend. Logging a supersession for a
    // pause the operator has already resolved would put a decision in the log that nobody made.
    if (pending.handle.supersede(info)) {
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
    if (w.assessments === 0) {
      return (
        `rotation: armed — 0 assessments, the run ended before any were made ` +
        `(nothing was measured; this is not a negative result)`
      )
    }
    return (
      `rotation: armed — ${w.assessments} assessments, ${w.degradationsSeen} degraded, ` +
      `${w.complaintsSeen} complaints, ${w.rotations} rotations, ` +
      `peak compaction generation ${w.peakGeneration}`
    )
  }

  async #exchange(
    p: RelayParticipant,
    text: string,
  ): Promise<{ prose: string; end: TurnEndEvent; unsettled: boolean }> {
    // Counted here, where a turn actually starts, so the ceiling measures work done rather
    // than rounds entered -- a round can contain one turn or several.
    this.#turnsTaken += 1
    const before = p.events.length
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
    this.#collectEvidence(p, snap)
    // The report, not the narration. A participant that receives "I'll start by finding the
    // relevant code" answers the intention rather than the result, which is how an advisor
    // ends up re-asking for work already done. The narration reaches the human live, as
    // `message` events; see repl/session.ts.
    const turn = snap.turns.at(-1)
    const prose = turn?.report ?? turn?.assistantText ?? ''
    for (const text of extractFlags(prose)) {
      this.flags.push({ participant: p.id, text, seq: this.log.length })
    }
    return { prose, end, unsettled }
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
      reason: PauseReason
      detail: string
      evidence: string[]
      conflict?: AuthorityConflict
      verdictOf?: { participant: string; endSeq: number }
      superseded?: PauseSupersession
    },
  ): Promise<RunOutcome | undefined> {
    this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `paused (${p.reason}): ${p.detail}` })
    if (!handle) {
      return this.#end(
        'escalated',
        `${p.detail} Nobody is attending this run, so it ends here — use relay.start(goal) ` +
          `to pause at this point and decide instead.`,
      )
    }
    const decision = await handle.pauseAt({
      reason: p.reason,
      detail: p.detail,
      evidence: p.evidence,
      options: ['continue', 'rotate', 'constrain', 'abort'],
      ...(p.conflict === undefined ? {} : { conflict: p.conflict }),
      ...(p.verdictOf === undefined ? {} : { verdictOf: p.verdictOf }),
      ...(p.superseded === undefined ? {} : { superseded: p.superseded }),
      atSeq: this.#seq,
    })
    if (decision.kind === 'abort') return this.#end('stopped', decision.detail)
    this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `resumed from ${p.reason}` })
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
      // nothing yet shows that compaction and degradation coincide, so acting on it
      // unattended would be inferring quality from a proxy that has never been checked
      // against quality. An attended run stops here and asks; an unattended one ends.
      const halted = await this.#halt(handle, {
        reason: 'rotation_candidate',
        detail: `${detail}. Recorded as a rotation candidate, not acted on.`,
        evidence: verdict.evidence,
      })
      return halted ?? this.#acknowledge(impl, snap.compactionGeneration)
    }

    const result = await this.rotateImplementer(detail)
    if (result.status === 'rotated') return undefined
    const halted = await this.#halt(handle, {
      reason: 'rotation_candidate',
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
    for (let round = 1; round <= maxRounds; round++) {
      // At the boundary rather than on a timer. A run cannot be interrupted mid-turn without
      // discarding that turn's work -- the same reason #exchange has no timeout of its own.
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
          reason: 'operator_requested',
          detail: reason,
          evidence: [`round ${round} of ${maxRounds}; no turn is in flight`],
        })
        if (halted) return halted
      }

      const instruction = next.prose.trim()
      if (/^DONE\b/i.test(instruction)) {
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
              [this.#drain(lead.id), envelope({ from: impl.id, fromRank: 'implementer', kind: 'report', text: extra.prose })]
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
        return this.#end('done', instruction)
      }
      if (/^ESCALATE\b/i.test(instruction)) {
        this.#record({ from: lead.id, fromRank: 'advisor', to: [], kind: 'note', text: instruction })
        const halted = await this.#halt(handle, {
          reason: 'advisor_escalated',
          detail: instruction,
          evidence: [`the advisor asked for a human rather than issuing an instruction`],
        })
        if (halted) return halted
        // Resumed. The advisor said its piece and the human decided otherwise, so it is
        // asked again rather than having its escalation replayed as an instruction.
        next = await this.#exchange(lead, this.#drain(lead.id) || 'The human has seen your escalation and asked you to continue. Give the implementer its next instruction.')
        continue
      }

      // BEFORE delivery, not after. The point of the pause is that the human adjudicates
      // while the instruction is still a proposal.
      const conflict = detectConflict(instruction, this.restrictedOrigins)
      if (conflict && !this.#adjudicated.has(`${conflict.origin.seq}:${instruction}`)) {
        this.#adjudicated.add(`${conflict.origin.seq}:${instruction}`)
        const halted = await this.#halt(handle, {
          reason: 'authority_conflict',
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

      this.#record({ from: lead.id, fromRank: 'advisor', to: [impl.id], kind: 'instruction', text: instruction })
      const aside = this.#drain(impl.id)
      const report = await this.#exchange(
        impl,
        [aside, envelope({ from: lead.id, fromRank: 'advisor', kind: 'instruction', text: instruction })]
          .filter(Boolean)
          .join('\n\n'),
      )
      this.#record({
        from: impl.id,
        fromRank: 'implementer',
        to: [lead.id],
        kind: 'report',
        text: report.prose,
        ...(report.unsettled ? { unsettled: true } : {}),
      })

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
        const halted = await this.#halt(handle, {
          reason: 'advisor_escalated',
          detail:
            `${impl.id} completed its turn but the transcript had not settled and the ` +
            `report came back empty, so there is nothing to route`,
          evidence: [
            `turn_end was proven by the hook; the body was captured before the transcript settled`,
            `raising the settle window may help — see transcriptSettleMs`,
          ],
        })
        if (halted) return halted
      }
      this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `${impl.id} turn: ${formatVerdict(report.end.verdict)}` })
      this.#attributeArtifacts()

      // The verdict may already be stale by the time we read it. `#exchange` settles on the
      // FIRST `turn_end`, and the late signal that withdraws it can land during the
      // transcript settle window that follows — the same window that is there because a
      // late `Stop` is expected. Pausing on a verdict the system has already retracted asks
      // the human to adjudicate nothing at all, so the current one is used instead.
      const already = supersessionOf(impl.events, report.end)
      const current = already?.replacement ?? report.end
      if (already) {
        this.#record({
          from: 'orchestrator',
          fromRank: 'human',
          to: [],
          kind: 'note',
          text:
            `${impl.id}'s ${report.end.verdict.outcome} verdict was withdrawn (${already.revision.reason})` +
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

      // A turn that did not complete is the human's call, not the advisor's. Escalating
      // here rather than relaying the partial prose keeps the advisor from steering on a
      // report that never finished being written.
      if (current.verdict.outcome !== 'completed') {
        // Registered before the halt, so a revision arriving while the human reads the
        // pause can be matched to it; cleared after, so it cannot amend the next one.
        if (handle) {
          this.#verdictPause = {
            handle,
            participant: impl.id,
            endSeq: current.seq,
            outcome: current.verdict.outcome,
            withdrawn: pre !== undefined,
          }
        }
        const halted = await this.#halt(handle, {
          reason: 'turn_incomplete',
          detail: `${impl.id} turn ended ${formatVerdict(current.verdict)}`,
          evidence: current.verdict.provenance.map((p) => `${p.source}: ${p.detail}`),
          verdictOf: { participant: impl.id, endSeq: current.seq },
          ...(pre === undefined ? {} : { superseded: pre }),
        })
        this.#verdictPause = undefined
        if (halted) return halted
      }

      // §7a. Assessed before the advisor sees the report, so a degraded implementer is
      // replaced rather than issued another instruction it cannot act on well.
      const rotated = await this.#considerRotation(impl, report.prose, handle)
      if (rotated) return rotated

      const leadAside = this.#drain(lead.id)
      next = await this.#exchange(
        lead,
        [leadAside, envelope({ from: impl.id, fromRank: 'implementer', kind: 'report', text: report.prose })]
          .filter(Boolean)
          .join('\n\n'),
      )
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
          audition = { id: `${spec.id}~replacement`, rank: 'implementer', session, events: [], baselineGeneration: 0, degradationCursor: 0 }
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
