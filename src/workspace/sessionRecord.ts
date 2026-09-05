/**
 * A running session, as something outside the process can read.
 *
 * Conclave's console is a rendering with no interface underneath it. An agent driving a run
 * — which is most of them now — launched into a background file, read it with `tail`,
 * grepped a transcript to reconstruct what a participant had done, and watched a rising
 * clock to guess whether the session was still alive. One of those nearly produced a filed
 * bug, because a retry could not be told from a double start. See #26: the workarounds are
 * the requirement.
 *
 * ## Files, not a socket
 *
 * Status is a file the run rewrites, not an endpoint the run answers. The reasoning is the
 * same one `resume.ts` gives for recording continuously: **a record that exists only inside
 * a live process is exactly the record a crash destroys**, and "did it crash" is the first
 * question status has to answer. A socket that stops responding cannot distinguish a dead
 * run from a busy one; a file plus a pid can.
 *
 * It also costs nothing to inspect. `cat .conclave/sessions/<id>/status.json` works from any
 * language, over ssh, and after the process is gone — which is when an operator most wants
 * it.
 *
 * ## Liveness is never read from the file
 *
 * A status saying `running` proves only that the process was running when it last wrote.
 * Every read reconciles the claim against the pid, and the two are reported SEPARATELY —
 * `state` is what the session last said, `alive` is whether anyone is still there. Collapsing
 * them would invent the very reading the issue describes: a session that looks busy because
 * nothing has updated it, which is indistinguishable from one that is busy.
 *
 * `sessionLock` already draws this distinction for the workspace guard, and for the same
 * reason: a crash-proof mechanism that misreports after a crash gets abandoned in a day.
 *
 * ## ...and neither is whether the record is current
 *
 * Two fields were not enough. `state` and `alive` can BOTH be honest about a run nobody is
 * describing any more: the process exists, the file says what it last managed to say, and the
 * gap between them is invisible. #126 is that gap, at its worst — an agent operator polled for
 * 73 minutes and was told `running`, `pause: none`, while the run sat at a pause whose write
 * had failed on a full disk and whose writer had then latched off for good.
 *
 * So there is a third reading, and it needs no third field. A live recording rewrites the
 * record every `SESSION_HEARTBEAT_MS` whether or not anything changed, which makes `updatedAt`
 * a heartbeat rather than a change log; `sessionStaleness` turns a missed beat into the fact a
 * reader actually wants. And no write is ever final: both files retry, independently, so a disk
 * that fills for ten seconds costs ten seconds of record rather than the rest of the run.
 *
 * ## Two files per session
 *
 *   status.json    the current state, rewritten on every change AND on a heartbeat. Small,
 *                  whole, atomic.
 *   events.ndjson  the observation stream, appended. Every routing message and every
 *                  adapter event, in the order the relay saw them.
 *
 * The split is between a question with one answer now ("what is it doing") and a question
 * whose answer is the whole history ("what did it do"). Serving both from one file would
 * mean either rewriting the history on every change or scanning it to answer the first.
 */

import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Confidence, Provenance } from '../contract/outcome.ts'
import type { RunCeilings } from '../relay/guardrails.ts'
import type { RunDeadlines } from '../relay/deadlines.ts'
import type { RelayEvent } from '../relay/observe.ts'
import type { ForceRecord, PauseReason, RunOutcome, RunPause } from '../relay/run.ts'
import type { ResolutionAuthority } from '../relay/resolution.ts'
import type { RotationRecord } from '../relay/rotationIntent.ts'
import { reportedTargeting, type ReportedTargeting, type TargetingWatch } from '../relay/targeting.ts'
// The two accessors, not a third copy of them. A check is a bare string or a pair, and a
// reader that re-implemented that fork would eventually disagree with the one the checks are
// actually RUN through.
import { checkCommand, checkRelevance, type CheckRelevance, type CheckSpec } from '../rotation/record.ts'

/** Bumped when a consumer would break. Present from the first version, as in `report.ts`. */
export const SESSION_SCHEMA = 1

export const SESSIONS_RELATIVE = '.conclave/sessions'

/**
 * How often a live recording rewrites `status.json` even when nothing has changed.
 *
 * This is what makes `updatedAt` mean "the writer is still there" rather than "the state last
 * changed", and the difference is the whole of #126. A run halted at a pause changes nothing
 * for as long as nobody answers it, so a record that only moved on change was indistinguishable
 * from one whose writer had died -- and in the incident that produced this, the writer HAD died,
 * silently, on a full disk, while the pause it had failed to publish waited 73 minutes for an
 * operator who was being told there was nothing to do.
 *
 * Cheap: one small file rewritten twice a minute. Deliberately not tied to anyone's poll
 * interval, which the run cannot know.
 */
export const SESSION_HEARTBEAT_MS = 30_000

/**
 * How old a live record may get before a reader is told it has stopped moving.
 *
 * Three missed beats, which is the ordinary heartbeat-timeout rule and is chosen for the
 * ordinary reason: one missed beat is a slow disk or a busy machine, and three is a writer that
 * is not coming back. Reported rather than acted on -- nothing here kills a run for being quiet.
 */
export const SESSION_STALE_AFTER_MS = SESSION_HEARTBEAT_MS * 3

/**
 * The whole budget for what the recorder says about its own writes, per minute.
 *
 * ACROSS OUTAGES, not within one, and that distinction is the point. A rule that always
 * announced the first failure of each outage would be silent about a disk that stays full and
 * loud about one that flickers -- and flickering is the ordinary case: contention, a sync, a
 * snapshot, anything that makes one write fail and the next succeed. At one write per beat plus
 * one per event, "announce every episode" is a warning and a recovery line per event on a
 * contended volume, which buries the run's own output under the recorder's complaint. That is
 * its own way of making the failure invisible.
 *
 * So the clock is not reset by recovering. Whether an outage was ANNOUNCED is tracked
 * separately, and only an announced outage gets a recovery line -- because the recovery line
 * exists to close a loop with the operator, and there is no loop to close if they were never
 * told. A failure that outlasts the window is always announced eventually.
 *
 * Exported so a test can assert against the window rather than against the number 60000. A test
 * that hardcoded it would keep passing if this changed, while asserting something that was no
 * longer true.
 */
export const STATUS_WARN_EVERY_MS = 60_000

/**
 * What the session last said about itself.
 *
 * Named `SessionRunState` rather than `SessionState`, which the adapter contract already
 * uses for something else entirely -- a participant's lifecycle. Two types with one name in
 * one codebase is a mistake waiting for whoever imports the wrong one.
 *
 * `starting` is a real state and not a nicety: participants are spawned before the first
 * turn, launching a CLI takes seconds, and a status that appeared only once a run was
 * underway would leave the exact window an agent operator polls into.
 */
export type SessionRunState = 'starting' | 'running' | 'paused' | 'ended'

/**
 * One turn as the status file reports it: the verdict AND how strongly it is evidenced.
 *
 * The same four fields `report.ts` puts in `ReportedTurn`, deliberately named and typed the
 * same way. A run report and a status file that disagreed about what a turn was would give
 * an operator two answers and no way to tell which was wrong -- and the two are read by the
 * same kind of consumer, often minutes apart.
 *
 * The tools and timings `ReportedTurn` also carries are left out. A status file is polled,
 * sometimes every second, and it is rewritten whole on every change; the per-turn tool list
 * is the part that grows without bound. It is in the report, and the arguments are in the
 * events stream.
 */
export interface SessionTurnStatus {
  /** Opaque; the adapter's own key. Never parse it. */
  key: string
  state: string
  confidence?: Confidence | undefined
  /** Ordered, most decisive first. The reason a verdict is believed, not just the verdict. */
  provenance?: Provenance[] | undefined
}

/**
 * Where one implementer seat's work IS: which task, which tree, which branch, and what the
 * scheduler thinks of it.
 *
 * Only meaningful once a run has more than one seat, and only emitted then -- see the note on
 * `SessionParticipantStatus.seat`. Every field is projected from what the relay already holds
 * (`seats()`, `tasks()`, `worktrees`); nothing here is a second copy of state the dispatcher
 * would have to keep in step.
 *
 * The four together are what a poller cannot reconstruct from anything else in this file. `id`
 * says which seat, and at N>1 that is where the resemblance to a default run ends: the seats
 * hold different tasks, on different branches, in different checkouts, and an operator or an
 * agent asking "what is seat-beta doing" has no other place to read the answer. `activity`
 * beside it is the last adapter event -- what the child is doing this second -- which is a
 * different question from what it was ASKED to do.
 */
export interface SessionSeatStatus {
  /**
   * The dispatcher's scheduler state: idle, queued, running, integrating, rotation_pending
   * or merge_blocked.
   *
   * A string rather than the `SchedulerState` union, like every other state in this file: the
   * record is JSON and a consumer parses strings. Importing the union would also point the
   * dependency the wrong way -- the relay knows nothing about being recorded.
   */
  state: string
  /** Tasks dispatched to this seat so far. Diagnostic; the events stream is the record. */
  dispatched: number
  /**
   * The task in flight, or absent when the seat is holding none.
   *
   * Absent rather than null for the reason the file gives about `pause`: JSON cannot spell
   * undefined, and a consumer's `if (seat.task)` must mean "there is one".
   */
  task?: { id: string; state: string; instruction: string } | undefined
  /**
   * The linked worktree this seat works in, and the branch its commits land on.
   *
   * Absent when the seat has no worktree of its own. That is every seat of a run started
   * without them, and it is the honest answer rather than a repetition of `cwd`: a seat
   * sharing the operator's checkout has no branch that is ITS branch, and reporting one
   * would tell a recovering operator to look somewhere nothing was written.
   */
  worktree?: { path: string; branch: string } | undefined
}

/**
 * One implementer seat's rotation policy, resolved, as an observer can read it.
 *
 * Whether rotation is armed is a run-configuration fact that changes WHAT THE OPTIONS ARE.
 * Unarmed, a `rotation_candidate` pause offers `continue, constrain, abort`; armed, `rotate`
 * is spliced in and the seat can be adjudicated instead of merely tolerated or abandoned.
 * Since #96 that is the only difference at a compaction WHEN THE ARMED POLICY IS `candidate`,
 * which is the default and every configuration either front-end can produce: such a run
 * pauses when attended and carries on when not, exactly as an unarmed one does, so `--checks`
 * widens the choice rather than deciding whether there is a run left to choose for.
 *
 * `onDegradation: 'automatic'` is the case that equivalence does NOT cover, and it is why
 * that field is reported beside `armed` rather than left implicit: an automatic seat takes
 * neither pause branch. It rotates on detection, attended or not, so there may be no question
 * put to the operator at all. Programmatic today -- no flag sets it -- which is a fact about
 * the CLI and not about what a poller can encounter.
 *
 * An operator deciding how to answer had no way to tell these regimes apart except by
 * reading the console this interface exists to replace, and a mistyped `--checks` was
 * therefore invisible: the run behaved as unarmed and nothing queryable said why (#103).
 *
 * PER SEAT, not per run, and that is the decision. Rotation policy is a run-level default a
 * seat may amend (D7, #78), so `--checks` can be replaced on one seat and left alone on the
 * others; a single run-wide `rotation` block would be right about the run and wrong about
 * exactly the seat whose pause is being answered. At N=1 it degenerates to the run's policy,
 * which is the honest answer there and the one #103 asked for.
 *
 * On seats whose ROLE is `implementer`, which is what `Relay#implementers()` means and what
 * the pause gate reads: `rotate` is offered only when the seat it would act on is in that
 * set, so a reviewer -- rank `implementer`, role `reviewer` (D5, #72) -- is never offered
 * rotation and is never assessed for degradation. Reporting a policy on it would describe
 * something that cannot happen to it.
 *
 * Every field is present whenever the block is, including when nothing is configured. A block
 * that appeared only on armed runs would reproduce the bug it fixes -- the reporter's probe
 * read a key that did not exist and got a falsy value, which is indistinguishable from a build
 * that does not report this at all.
 */
export interface SessionRotationStatus {
  /**
   * Whether this seat is under any rotation policy: the run's, or its own amendment of it.
   *
   * `false` is a run that never configured rotation. Distinct from `armed: false` with
   * `configured: true`, which is a policy that says THIS SEAT is not rotatable -- a seat entry
   * with `checks: []`. Both refuse to rotate; only the second was asked for, and an operator
   * chasing a flag that did not take effect needs to know which one they are looking at.
   */
  configured: boolean
  /**
   * Whether `rotate` is available on this seat's pauses: `checks` is non-empty.
   *
   * Derived once here rather than left to each consumer, because it is the same predicate the
   * relay itself gates on (`rotationFor(...)?.checks.length > 0`), and a consumer re-deriving
   * it from `checks` is a consumer that will eventually derive it differently.
   */
  armed: boolean
  /**
   * The commands themselves, and what each is allowed to decide.
   *
   * Normalized out of `CheckSpec`, whose bare-string form means `required`: a structured
   * interface that handed a consumer two shapes for one field would make every reader
   * re-implement `checkCommand`. Relevance is carried for the reason the console banner
   * carries it -- three checks of which one can block a transfer is not three armed checks.
   */
  checks: { command: string; relevance: CheckRelevance }[]
  /**
   * What a detected degradation does on this seat, or `null` when nothing is configured.
   *
   * `armed` alone does not answer the operator's actual question at a pause, because
   * `automatic` means there may be no pause to answer: the seat is replaced without asking.
   * `null` rather than an invented `'candidate'`, the way `launch.model` is null when the argv
   * named no model -- reporting the default as though it had been chosen would claim a policy
   * this run does not have.
   */
  onDegradation: 'candidate' | 'automatic' | null
}

export interface SessionParticipantStatus {
  id: string
  agent: string
  rank: string
  /**
   * What this seat is for, as opposed to what it can overrule.
   *
   * A poller deciding where to look — which seat is building the api — cannot get that from
   * `rank`, which is the authority ordering and is identical across seats doing different
   * jobs. Present and equal to `implementer` at N=1 rather than omitted, for the reason given
   * about `turns` below: a field that disappears when it agrees with the default forces a
   * reader to tell "no role" apart from "this build does not report roles".
   */
  role: string
  /**
   * How this seat was launched: the whole argv, and the model that argv names.
   *
   * Present at every N and on every seat, unlike `seat` below, because it says something at
   * every N: `agent: opencode` is any of dozens of models at a ~30x price spread (#71), so a
   * poller reading a one-seat run cannot tell an expensive run from a cheap one, nor repeat
   * either. `model` is `null` when the argv named none -- a fact about the run, and
   * deliberately not an empty string.
   *
   * Structural, like every other type in this file: the relay knows nothing about being
   * recorded, and importing `ParticipantLaunch` would point the dependency the wrong way.
   *
   * There is no token count and no cost here, and there is not going to be one. Conclave
   * drives the operator's own CLI on the operator's own subscription; what it can honestly
   * offer is the join key for the billing export their provider already holds.
   */
  launch: { args: string[]; model: string | null }
  /**
   * This seat's turns, from `snapshot()` -- the canonical side of the adapter seam.
   *
   * Required and empty rather than absent before anything has run, for the reason
   * `report.ts` gives about `flags`: a field that vanishes when it has nothing to say
   * forces a reader to distinguish "no turns yet" from "this build does not report turns",
   * and only one of those is a fact about the run.
   *
   * This is the one part of the participant block that is NOT provisional. `activity`
   * below is the last adapter event and is revisable; these are graded verdicts, and an
   * operator confirming a finished run reads them rather than the prose.
   */
  turns: SessionTurnStatus[]
  /**
   * What this seat is doing, from its most recent adapter event.
   *
   * PROVISIONAL, in the seam's own sense: adapter events are the revisable side, and
   * `snapshot()` is canonical. That is the right trade here — a status file answers "what
   * is happening now", and the canonical answer is not available until the turn is over.
   * The `events.ndjson` stream carries the same events for a reader that wants to judge
   * them, and the run report at the end carries the graded verdicts.
   */
  activity?: { kind: string; tool?: string | undefined; since: number } | undefined
  /**
   * Stopped at a permission prompt, for what, and since when. Read from
   * `relay.permissionsPending()`, with the timestamp of the `permission_requested` event.
   *
   * `since` is here so the top-level `blocked` roll-up can be DERIVED from this document
   * rather than computed alongside it -- see `SessionBlockedStatus`. Without it the roll-up
   * would need its own clock, and two clocks measuring one wait is how they come to disagree.
   */
  awaitingPermission?: { tool: string; since: number } | undefined
  /**
   * This seat's effective rotation policy. See `SessionRotationStatus`.
   *
   * On seats whose ROLE is `implementer`, at every N. The advisor holds no seat and a REVIEWER
   * holds one that rotation never acts on, so neither carries a block that would report a
   * policy which could never apply -- the same reason `seat` below is absent on the advisor.
   * Role rather than rank is the load-bearing part: a reviewer's RANK is `implementer`.
   * Unlike `seat`, this IS present on a default one-seat run:
   * D1 keeps a key off the N=1 document when it has nothing to say at N=1, and this one has
   * the whole of #103 to say there. That is a departure from D1's usual reading and it is
   * deliberate; the shape pins in `defaultUnchanged.test.ts` record it.
   */
  rotation?: SessionRotationStatus | undefined
  /**
   * This seat's place in the dispatcher, at N>1 only.
   *
   * ABSENT on every participant of a default run, and that omission is the point rather than
   * an oversight. D1: the default run must not change, and a key appearing on the one
   * implementer of a one-seat run is a key every existing consumer of `status --json` would
   * start seeing. The rest of this file argues the opposite way about fields that vanish when
   * they agree with a default -- `role` and `turns` are present and empty for exactly that
   * reason -- and the two rules genuinely conflict here. D1 wins because this field has
   * nothing to say at N=1: with one seat there is no task to tell from another seat's, no
   * branch that is not the operator's own, and a scheduler state whose only reader is the
   * dispatcher that wrote it.
   *
   * Present on the ADVISOR of no run at any N: the advisor holds no seat, takes no task and
   * has no worktree, and inventing an idle block for it would report a queue position it can
   * never occupy.
   *
   * Emitted from the moment the dispatcher knows its seats, which is when the run starts --
   * so a two-seat session polled while it is still `starting` carries no seat blocks yet, the
   * same way it carries no `activity` yet. A field that is not there because the fact does not
   * exist yet is the honest report of a run that has not begun.
   */
  seat?: SessionSeatStatus | undefined
}

/**
 * The one place that says this run is waiting on somebody, and what KIND of question it is.
 *
 * It exists because the two blocking conditions were reported in two different parts of this
 * document, and nothing said a reader had to watch both (#234):
 *
 *   an escalation      `state: 'paused'` with a `pause`
 *   a permission prompt `state` stays `running`; the only trace is one participant's
 *                      `awaitingPermission`, several levels down a list
 *
 * Two agent operators, on two repos, wrote a watcher against the obvious one and lost time to
 * the other. The first watched `pause` and a permission decision is not a pause: a prompt sat
 * 42 minutes. The second answered permission prompts within 15 seconds, and having got that
 * working stopped watching -- so the escalation that paused later, the one that paused
 * PRECISELY BECAUSE judgement was required, sat instead.
 *
 * DERIVED, never stored: computed from `pause` and `participants[].awaitingPermission` on every
 * write, so it cannot come to disagree with either. A reader that prefers the underlying fields
 * keeps reading them and sees exactly the same thing.
 *
 * DESCRIPTIVE, never prescriptive. It says what is being waited on; it does not say whether a
 * machine may answer it, because conclave does not know that. A permission prompt for
 * `gh pr view` and one for `rm -rf` arrive here identically, and the driving agent is the one
 * with the context to tell them apart -- the same argument the README makes about why conclave
 * does not turn pauses into notifications. Publishing a `machineAnswerable: true` would be
 * conclave asserting a safety property it cannot check.
 *
 * A PAUSE OUTRANKS A PERMISSION PROMPT when both are true at once. The pause stops the whole
 * conclave and the prompt stops one seat, so the pause is the fact about the run.
 */
export type SessionBlockedStatus =
  /** One seat is stopped at a permission prompt. Answered with `/allow` or `/deny`. */
  | { kind: 'permission'; since: number; participant: string; tool: string }
  /**
   * The run is paused. `reason` is the pause's own reason and `authority` its classification
   * from `resolution.ts` -- both copied rather than re-derived, so this block and `pause`
   * cannot say different things about one halt.
   */
  | { kind: 'pause'; since: number; reason: PauseReason; authority: ResolutionAuthority }

/**
 * A document with its roll-up brought up to date. The only writer of `blocked`.
 *
 * Spread-away rather than `blocked: undefined`, so a document with nothing blocked carries no
 * key at all -- the rule the rest of this file follows for facts that do not exist.
 */
function withBlocked(status: SessionStatus): SessionStatus {
  const blocked = blockedFrom(status)
  const { blocked: _dropped, ...rest } = status
  return blocked ? { ...rest, blocked } : rest
}

/**
 * Derive the roll-up from the document that carries it.
 *
 * Exported so the rule can be tested directly on a document, without a relay: what this
 * returns is a pure function of the two fields it reads, and that is the property the
 * "cannot disagree" claim above rests on.
 */
export function blockedFrom(
  status: Pick<SessionStatus, 'pause' | 'participants'>,
): SessionBlockedStatus | undefined {
  const pause = status.pause
  // Pause first: see the ranking note above.
  if (pause) {
    return {
      kind: 'pause',
      since: pause.at,
      reason: pause.reason,
      authority: pause.resolution.authority,
    }
  }
  // First in participant order rather than earliest, deliberately. Two seats can be stopped at
  // once and this block reports ONE; a reader that needs every prompt reads the participant
  // list, which is where they all are. Participant order is stable across writes, so a driver
  // polling this does not see the answer flip between two equally blocked seats.
  for (const p of status.participants) {
    const waiting = p.awaitingPermission
    if (waiting) return { kind: 'permission', since: waiting.since, participant: p.id, tool: waiting.tool }
  }
  return undefined
}

export interface SessionStatus {
  schema: number
  id: string
  /** The orchestrator process. What `alive` is decided from; never trusted from the file. */
  pid: number
  cwd: string
  goal: string
  /** Which front-end opened it. A detached run and a console are not the same thing to drive. */
  front: 'relay' | 'session'
  operator: 'human' | 'agent'
  state: SessionRunState
  startedAt: number
  /**
   * When this file was last WRITTEN — not when the state last changed.
   *
   * The distinction is load-bearing since #126. A live recording rewrites the record every
   * `SESSION_HEARTBEAT_MS` whether anything changed or not, so this field is a heartbeat: a
   * reader comparing it against the clock is asking "is the writer still there", and a record
   * older than `SESSION_STALE_AFTER_MS` on a process that still exists means the writer stopped
   * while the run did not. `sessionStaleness` makes that reading for them.
   *
   * It read as "last change" before, and that is exactly what made a 73-minute-old record
   * indistinguishable from a run that had simply been sitting at a pause. A run sitting at a
   * pause now beats; a run whose disk filled does not.
   */
  updatedAt: number
  /** Entries in the routing log. The same count the console prints at the end. */
  messages: number
  participants: SessionParticipantStatus[]
  /**
   * The current pause, verbatim from the handle.
   *
   * The whole pause rather than its reason: a caller deciding whether to intervene needs
   * the evidence and the options, and an agent operator has no console to read them from.
   */
  pause?: RunPause | undefined
  /**
   * Whether this run is waiting on somebody, in one place. See `SessionBlockedStatus`.
   *
   * Absent when nothing is blocked, which is the same rule `pause` and `outcome` follow: a key
   * that is not here because the fact does not exist is the honest report. Written by the
   * recorder on every write and derived by `blockedFrom` -- never set by a caller, because a
   * second writer is how it would come to disagree with the fields it summarises.
   */
  blocked?: SessionBlockedStatus | undefined
  outcome?: RunOutcome | undefined
  /** Where the streams are, so a reader never has to reconstruct a path. */
  eventsPath: string
  /** The resumable routing log, when one is being written. */
  logPath?: string | undefined
  /**
   * The build string that produced this session.
   *
   * `conclave version` reports the package version and, in a checkout, the commit. A status
   * file read after the fact must be able to say which build wrote it, and recomputing at
   * read time would borrow whatever git state exists then -- which in a release archive is
   * none. Captured at startup and recorded once.
   */
  build: string
  /**
   * Every ceiling this run is bound by, with `null` where nothing was configured.
   *
   * The same class of gap as the rotation block above, and #119 is its second instance: an
   * agent operator cannot confirm a flag it passed took effect, so a mistyped or misunderstood
   * ceiling is invisible to the interface that exists to replace the console. The run that
   * prompted this stopped at an advisor budget of 8 while `--max-turns 40` sat in its argv
   * doing something else entirely, and no surface anywhere said either number.
   *
   * Present on a default run, like `rotation` and unlike `seat`. D1 keeps a key off the default
   * document when it has nothing to say there, and this one has the most to say exactly then: a
   * run with no ceilings configured is the run whose operator most needs to read that the only
   * thing bounding it is an advisor budget they never chose.
   *
   * Written by BOTH producers of a status document, which is the part worth stating: the
   * recorder writes it from `RecordableRelay.ceilings`, and the detached parent writes it into
   * the placeholder it records for a child that does not exist yet. A detached run is the form
   * an agent operator uses and the window before the child records itself is exactly when it
   * polls, so a block that appeared only once the relay was up would be missing at the one
   * moment #119 is about -- and for a child that dies during startup, missing permanently.
   *
   * OPTIONAL nonetheless, for one case: a `RecordableRelay` stand-in that predates this and
   * answers nothing. Absent there means "this relay was never asked", which is not the fact
   * `null` states -- `null` is "no limit, on a run that was asked". A reader must not take the
   * first for the second, which is why the unset limits are spelled out rather than left off.
   */
  ceilings?: RunCeilings | undefined
  /**
   * What each seat's TURNS are measured against -- both clocks, resolved per seat.
   *
   * `ceilings` above bounds the run; this bounds a turn, and the two are answered by different
   * machinery to different readers. An agent operator polling this document is the caller with
   * no console to read, and the fact it could not previously get here is the one that decides
   * whether waiting is worth anything: a seat whose adapter declares no silence clock produces
   * NO verdict when it goes quiet, so a poller watching for `timed_out` on that seat is
   * watching for something that cannot arrive.
   *
   * Per seat rather than per run, because the verdict is -- two seats can be on different
   * clocks or on none. `configuredSilenceMs` and `configuredAbsoluteMs` carry what the
   * invocation ASKED for beside what the seats resolved to, `null` where nothing was asked, so
   * the gap between a request and its effect is readable rather than inferred. That gap is the
   * whole reason `--silence-timeout` is accepted on a seat that cannot honour it: the setting
   * is kept for the seats that can, and this block is where the rest say `unsupported`.
   *
   * Written by the recorder from `RecordableRelay.deadlines`, resolved by the relay because
   * the relay holds both halves -- the registry's support table and this run's configuration.
   * NOT rebuilt from the front-end's flags, for the reason `ceilings` gives: a document built
   * from what the caller believes it passed agrees with the caller rather than with the run.
   *
   * OPTIONAL for the same single case as `ceilings`: a `RecordableRelay` stand-in that predates
   * it and answers nothing. Absent means "never asked", which is not what an `unsupported`
   * clock states, and the two must not be read as one.
   */
  deadlines?: RunDeadlines | undefined
  /**
   * Every accepted rotation this run has made, and WHY each one happened.
   *
   * The live half of #75. A rotation is the one event in a run that replaces the thing doing
   * the work, and until now the only queryable trace of it was a COUNT -- so an operator, or an
   * analysis, could see that a seat had been replaced and not why. That gap is not cosmetic:
   * #10 asks whether compaction predicts degradation strongly enough to act on unattended, and
   * a rotation the operator took for a reason of their own arrives carrying a compaction
   * generation regardless, because compaction happens anyway. Counted alone it reads as "the
   * proxy fired and the operator agreed", which is exactly the correlation being measured.
   *
   * Present and EMPTY on a run that has rotated nothing, for the reason `rotation` above is
   * present on an unarmed seat: #103 was a probe reading a key that did not exist and getting a
   * falsy value it could not tell from a build that does not report the field. An empty array
   * is a run that has not rotated; an absent key is a producer that was never asked.
   *
   * Written by BOTH producers, like `ceilings`: the recorder from `RecordableRelay`, and the
   * detached parent into the placeholder it records for a child that does not exist yet. The
   * placeholder's empty array is not a guess -- a child that has not started has rotated
   * nothing -- and a detached run is the form an agent operator polls.
   *
   * OPTIONAL for the same one case as `ceilings`: a `RecordableRelay` stand-in that predates
   * this and answers nothing. Absent there means "never asked", which is a different fact from
   * the empty array's "asked, and nothing has rotated".
   */
  rotations?: RotationRecord[] | undefined
  /**
   * Every forced `/continue` and what the guard read at the moment it was applied.
   *
   * The live half of #125. A force clears the pause, so without this field the refusal it
   * answered evaporates from the record. The entry carries the per-seat evidence the guard had
   * at the time and whether the operator had already been refused, so the two populations stay
   * separable afterwards.
   *
   * Present and EMPTY on a run that has forced nothing, for the same reason `rotations` above is
   * present and empty: a probe reading a missing key cannot tell an empty record from a build
   * that does not report the field.
   *
   * OPTIONAL for the same one case as `rotations`: a `RecordableRelay` stand-in that predates
   * this and answers nothing. Absent there means "never asked", which is a different fact from
   * the empty array's "asked, and nothing has forced".
   */
  forces?: ForceRecord[] | undefined
  /**
   * Whether the advisor has been using the assignment syntax this run's concurrency depends on.
   *
   * The live half of #79, and the reason it is here rather than only in the final report: the
   * failure it detects is one an operator can still do something about. An advisor that names
   * no seat dispatches to one seat at a time and cannot send a repair to a blocked one, and
   * until now that presented as a seat sitting idle -- a symptom with three or four causes, none
   * of which the status document could tell apart. `unaddressedTurns` climbing while
   * `addressedTurns` stays at zero says which one it is, while the run is still going.
   *
   * And `invalidTurns` or `ceilingTurns` climbing there instead says something else again: the
   * advisor IS writing `@seat`/`@role`, whole and readably, and nothing is reaching a seat --
   * which is repaired in the seat names or the ceilings rather than in the briefing.
   * `incompleteTurns` climbing alone is a fourth reading and settles nothing: the turns that
   * would have answered were cut off, so the live line calls it INCONCLUSIVE rather than
   * picking a side. Four zero-dispatched readings, and an operator deciding whether to intervene
   * needs the one that is actually happening.
   *
   * ABSENT on a one-seat run, which is the one key in this file whose absence is not the
   * "producer was never asked" that `ceilings` and `rotations` argue for. The argument is in
   * `targeting.ts` and turns on this: how many implementer seats a run has is stated by
   * `participants` in this same document, so a reader who finds no `targeting` can settle what
   * that means by counting, rather than having to assume. Nothing else here is recoverable that
   * way, which is why nothing else here vanishes.
   *
   * Present with zeros on a MULTI-seat run that has not instructed yet, and that is the state an
   * agent operator polls in most: `{applicable: true, addressedTurns: 0}` on a run that has been
   * going an hour is the finding; on a run thirty seconds old it is nothing at all, and the two
   * are told apart by `unaddressedTurns` beside it, not by the key's presence.
   *
   * Written by BOTH producers, like `ceilings` and `rotations`: the recorder from
   * `RecordableRelay.targeting`, and the detached parent into the placeholder it records for a
   * child that does not exist yet. The parent has resolved the seat list by then, so it knows
   * whether the key belongs at all, and its zeros are honest -- a child that has not started has
   * taken no advisor turns.
   */
  targeting?: ReportedTargeting | undefined
}

/** A status plus what could only be learned from outside it. */
export interface ReadSession {
  status: SessionStatus
  /**
   * Whether the orchestrator process still exists.
   *
   * Not folded into `state`. A reader wants both: `state: 'running', alive: false` is a
   * crashed run and says so, where a single field would have to choose which lie to tell.
   */
  alive: boolean
  /**
   * Claimed to be going, and nobody is home. The condition that made a retry
   * indistinguishable from a double start.
   */
  abandoned: boolean
}

export function sessionsDir(repoRoot: string): string {
  return join(repoRoot, SESSIONS_RELATIVE)
}

export function sessionDir(repoRoot: string, id: string): string {
  return join(sessionsDir(repoRoot), id)
}

/**
 * A readable, chronological, collision-free id.
 *
 * Not a pid: pids are reused, and an id that can refer to two different sessions is worse
 * than a long one. Not random: an operator has to type it, and a directory listing sorted
 * by name should be sorted by time. The pid suffix separates two sessions started in the
 * same second, which two shells in two worktrees do.
 */
export function newSessionId(now: number, pid: number): string {
  const d = new Date(now)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `${stamp}-${pid}`
}

function alive(pid: number): boolean {
  try {
    // Signal 0 tests for existence and permission without delivering anything.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Writes both files for one session.
 *
 * A failure is never fatal to the run: recording must not be able to kill the work it exists
 * to describe, exactly as `RunLogWriter` reasons. But a failure is not final either, and that
 * is the correction #126 forced. A single flag used to latch on the first failed write or
 * failed append and silence BOTH writers for the life of the process, so a full disk lasting
 * ten seconds stopped the record permanently -- and left the last good copy in place, reading
 * as current, which is worse than an obviously missing file.
 *
 * So: every write is attempted, every time, and the two files fail independently. Failed status
 * writes are reported to stderr at most once per `STATUS_WARN_EVERY_MS` COUNTING ACROSS
 * OUTAGES, with a matching recovery line only for an outage that was announced -- see that
 * constant for why recovering must not buy a fresh warning. An event append that fails is
 * silent, for the reason it always was: the status IS the interface, and a gap in an appended
 * stream is visible in the stream itself.
 */
export class SessionRecorder {
  readonly id: string
  readonly dir: string
  readonly statusPath: string
  readonly eventsPath: string
  #status: SessionStatus
  /** Consecutive failed status writes, zeroed by a success. */
  #statusFailures = 0
  /**
   * When stderr was last told about a failed status write, and whether the CURRENT outage was
   * one of the ones it was told about.
   *
   * The timestamp deliberately survives recovery -- see `STATUS_WARN_EVERY_MS`. The flag is what
   * keeps the two lines paired: an outage nobody was told about must not produce a recovery line
   * announcing the end of something nobody knew had started.
   */
  #statusWarnedAt: number | undefined
  #outageAnnounced = false
  /** Consecutive failed event appends. Counted so the directory can be retried; never reported. */
  #eventFailures = 0

  constructor(repoRoot: string, status: Omit<SessionStatus, 'schema' | 'eventsPath' | 'updatedAt'>) {
    this.id = status.id
    this.dir = sessionDir(repoRoot, status.id)
    this.statusPath = join(this.dir, 'status.json')
    this.eventsPath = join(this.dir, 'events.ndjson')
    this.#status = withBlocked({
      ...status,
      schema: SESSION_SCHEMA,
      eventsPath: this.eventsPath,
      updatedAt: status.startedAt,
    })
    try {
      mkdirSync(this.dir, { recursive: true })
    } catch {
      // Not fatal and not remembered: the write below will fail too, and a failed write is
      // what puts this back on the retry path.
    }
    this.write()
  }

  get status(): SessionStatus {
    return this.#status
  }

  /** Merge a change and rewrite. Fields not named keep their current value. */
  update(patch: Partial<Omit<SessionStatus, 'schema' | 'id' | 'eventsPath'>>): void {
    // Re-derived AFTER the merge, so `blocked` describes the document as it is about to be
    // written rather than as it was. A patch that clears a pause clears the roll-up with it,
    // and one that names a new pause renames it, without either caller knowing this field
    // exists -- which is what keeps it from drifting.
    this.#status = withBlocked({ ...this.#status, ...patch, updatedAt: Date.now() })
    this.write()
  }

  /**
   * Rewrite the record unchanged, stamping `updatedAt`.
   *
   * The heartbeat, and it does two things at once. It tells a reader the writer is still there
   * -- which is what lets `sessionStaleness` say the opposite -- and it republishes whatever
   * the last successful write missed, because `#status` is current in memory whether or not it
   * ever reached the disk. A pause lost to a full disk therefore comes back on its own once the
   * disk does, with nobody re-reporting it. In the incident, nobody did.
   */
  beat(): void {
    this.#status = { ...this.#status, updatedAt: Date.now() }
    this.write()
  }

  /**
   * Rewrite via a temporary file and a rename.
   *
   * A reader polling this file would otherwise eventually catch a partial write and get a
   * JSON parse error it can do nothing about — and the caller most likely to be polling is
   * an agent, which will report the crash rather than retry. `rename` within a directory is
   * atomic on every platform this runs on.
   */
  private write(): void {
    const tmp = `${this.statusPath}.tmp`
    try {
      // Only on the way back from a failure. The directory can be absent because the
      // constructor's own mkdir failed or because something removed it underneath a live run,
      // and neither is worth a syscall on a path that runs for every event.
      if (this.#statusFailures > 0) mkdirSync(this.dir, { recursive: true })
      writeFileSync(tmp, `${JSON.stringify(this.#status, null, 2)}\n`)
      renameSync(tmp, this.statusPath)
      if (this.#statusFailures > 0) {
        const failures = this.#statusFailures
        this.#statusFailures = 0
        // Only for an outage the operator was actually told about. They were told the record
        // had stopped and are owed the other half -- without it, a run that recovered looks
        // exactly like one that did not. A silent outage has no loop to close.
        if (this.#outageAnnounced) {
          this.#outageAnnounced = false
          console.error(
            `conclave: session status at ${this.statusPath} is being written again ` +
              `after ${failures} failed attempt(s)`,
          )
        }
      }
    } catch (err) {
      this.#statusFailures += 1
      const now = Date.now()
      // `#statusWarnedAt` is not cleared by recovering, so this is a budget for the CHANNEL and
      // not for the episode: a volume that fails one write in ten produces one pair a minute,
      // not one pair per contended write.
      // `undefined` rather than 0 for "never warned": 0 is a real instant a mocked or badly set
      // clock can return, and this must not depend on never being at the epoch.
      if (this.#statusWarnedAt === undefined || now - this.#statusWarnedAt >= STATUS_WARN_EVERY_MS) {
        this.#statusWarnedAt = now
        this.#outageAnnounced = true
        console.error(
          `conclave: could not write session status at ${this.statusPath} ` +
            `(${err instanceof Error ? err.message : String(err)}); ` +
            `\`conclave status\` is reading a record from before this failure, and will say so`,
        )
      }
    }
  }

  /** Append one observation event. One JSON object per line, in relay order. */
  event(e: RelayEvent): void {
    try {
      if (this.#eventFailures > 0) mkdirSync(this.dir, { recursive: true })
      appendFileSync(this.eventsPath, `${JSON.stringify(e)}\n`)
      this.#eventFailures = 0
    } catch {
      // Deliberately quieter than the status failure above, and deliberately not final: the
      // events lost to a full disk stay lost, and the ones after it do not.
      this.#eventFailures += 1
    }
  }
}

/**
 * Whether a record has stopped moving, for a reader who should not have to work it out.
 *
 * Derived here rather than written into the file, and that is the point: the fact a reader
 * needs is that this record is old NOW, which the record cannot know when it is written -- and
 * a run whose writer has died is precisely the run that cannot add a field saying so. So this
 * is computed at read time from two things the reader already has, `updatedAt` and the clock.
 *
 * Three conditions, and each excludes a case that is already reported honestly:
 *
 *   alive        a dead process is `abandoned`, which is the existing flag for a record that
 *                cannot be trusted. Saying `stale` as well would be a second name for it.
 *   not ended    a finished run stops writing on purpose. Its record is old and correct, and a
 *                warning there would fire on every archived session anyone ever reads.
 *   past three   see `SESSION_STALE_AFTER_MS`.
 *   beats
 *
 * Note what this does NOT claim: that the writer is broken. A record can be stale because the
 * disk is full, because the process is wedged, or because the machine was suspended. It claims
 * only that the file is not being kept up, which is the fact `state` and `alive` between them
 * could not express -- `state` is what the session last said, `alive` is that someone is there,
 * and #126 is the gap where both are true and neither is current.
 */
export function sessionStaleness(
  s: ReadSession,
  now: number,
): { ageMs: number; thresholdMs: number } | undefined {
  if (!s.alive || s.status.state === 'ended') return undefined
  const ageMs = now - s.status.updatedAt
  if (ageMs <= SESSION_STALE_AFTER_MS) return undefined
  return { ageMs, thresholdMs: SESSION_STALE_AFTER_MS }
}

/** Read one session, reconciling what it claims against whether it is there. */
export function readSession(repoRoot: string, id: string): ReadSession | undefined {
  const p = join(sessionDir(repoRoot, id), 'status.json')
  if (!existsSync(p)) return undefined
  let status: SessionStatus
  try {
    status = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    // A status caught mid-write is the one case, and `write()` renames to make it
    // impossible. Treated as absent rather than thrown: a corrupt record for one session
    // must not take down a listing of all of them.
    return undefined
  }
  const running = status.state !== 'ended'
  const there = alive(status.pid)
  return { status, alive: there, abandoned: running && !there }
}

/**
 * Every readable record, paired with the directory it was read from.
 *
 * The pairing is kept because the two are not the same fact: the id inside a status file is
 * whatever the file says, and the directory NAME is the only thing that locates the record on
 * disk. Every record conclave writes agrees on both, but a caller that deletes reads the name
 * and a caller that reports reads the id, and quietly using one for the other is how the
 * wrong directory gets removed.
 */
function scanSessions(repoRoot: string): { name: string; session: ReadSession }[] {
  const dir = sessionsDir(repoRoot)
  if (!existsSync(dir)) return []
  const out: { name: string; session: ReadSession }[] = []
  for (const name of readdirSync(dir)) {
    const found = readSession(repoRoot, name)
    if (found) out.push({ name, session: found })
  }
  return out.sort((a, b) => b.session.status.startedAt - a.session.status.startedAt)
}

/** Every session this project has a record of, newest first. */
export function listSessions(repoRoot: string): ReadSession[] {
  return scanSessions(repoRoot).map((s) => s.session)
}

/**
 * Turn what the operator typed into one session.
 *
 * Nothing typed means the most recent, which is what an operator driving one run at a time
 * always means. A prefix is accepted because the ids are timestamps and nobody should have
 * to type twenty characters to ask what their session is doing — but an AMBIGUOUS prefix is
 * refused rather than resolved to the newest match, since picking one silently is how a
 * status command ends up describing the wrong run.
 */
export function resolveSession(
  repoRoot: string,
  id?: string,
): { session: ReadSession } | { error: string } {
  const all = listSessions(repoRoot)
  if (all.length === 0) return { error: 'no sessions have been recorded in this project' }
  if (!id) return { session: all[0]! }
  const exact = all.find((s) => s.status.id === id)
  if (exact) return { session: exact }
  const matches = all.filter((s) => s.status.id.startsWith(id))
  if (matches.length === 1) return { session: matches[0]! }
  if (matches.length > 1) {
    return {
      error:
        `"${id}" matches ${matches.length} sessions: ` +
        `${matches.map((s) => s.status.id).join(', ')}`,
    }
  }
  return { error: `no session "${id}" in this project` }
}

/**
 * The sessions old enough to delete, chosen but not yet touched.
 *
 * Three conditions, all of them required, and the reason is the same one the module opens
 * with: `state` is what the session SAID and `alive` is whether anyone is still there, so
 * neither alone is grounds for deleting anything. A record saying `ended` whose pid is still
 * running is a run that reported its finish and has not exited; a live process whose files
 * vanish underneath it loses the only account of itself that survives a crash.
 *
 * An ABANDONED session -- `running` and nobody home -- is deliberately not a candidate,
 * however old. That is the exact condition #26 was filed about, and it is the one an operator
 * comes looking for days later to find out what happened. Sweeping it up would delete the
 * evidence and leave the tidy runs behind.
 *
 * Directories with no readable `status.json` are also left alone. `readSession` cannot say
 * whether one belongs to a run that is still starting, and the CLI already treats "started
 * but never recorded its state" as its own condition rather than as absence.
 */
export function prunableSessions(repoRoot: string, olderThan: number): ReadSession[] {
  return scanSessions(repoRoot)
    .map((s) => s.session)
    .filter((s) => prunable(s, olderThan))
}

function prunable(s: ReadSession, olderThan: number): boolean {
  return s.status.state === 'ended' && !s.alive && s.status.updatedAt < olderThan
}

/** What a prune chose, and what it managed to do about it. */
export interface SessionPruning {
  /**
   * Every id that met the conditions, whatever then became of it.
   *
   * The sum of the three lists below, and reported separately from all of them so a partial
   * result reads as a partial result rather than as a shorter candidate list than there
   * really was.
   */
  candidates: string[]
  removed: string[]
  /**
   * A candidate that stopped qualifying between the scan and its own removal.
   *
   * Not a failure -- the prune did the right thing -- but not silence either: an operator
   * told "3 candidates" and shown two removals is owed the third line.
   */
  skipped: { id: string; reason: string }[]
  /** One entry per candidate whose directory would not go. The rest are still removed. */
  failed: { id: string; error: string }[]
}

/**
 * Delete the records `prunableSessions` chose.
 *
 * `announce` is called ONCE with the whole candidate list before the first directory is
 * touched, and it is the only way to make good on "here is what I am about to delete". The
 * returned `candidates` cannot do it: by the time a synchronous return is in the caller's
 * hands every removal has already happened, so a CLI printing from it would be describing
 * the past in the future tense -- and if the process died mid-prune the operator would have
 * been shown nothing at all about the records that did go.
 *
 * Re-reading the candidate list instead would not work either, because the two scans need
 * not agree: a session can end, or a pid can exit, between them.
 *
 * Every candidate is re-read through `readSession` immediately before its own removal, and
 * one that no longer qualifies is spared. The scan and the delete are separated by an
 * announcement, an operator reading it, and however long the earlier removals took -- and a
 * pid that came back in that window belongs to a process whose only durable account of
 * itself is the directory about to be deleted. The check is cheap and the loss is not
 * recoverable.
 *
 * Every path removed is rebuilt from an id via `sessionDir` and then checked to be inside the
 * sessions directory, rather than trusted. The ids come from a directory listing today, but
 * this function's whole job is recursive deletion, and a containment check costs nothing
 * against the one mistake here that cannot be undone.
 */
export function pruneSessions(
  repoRoot: string,
  olderThan: number,
  opts?: { announce?: (candidates: readonly string[]) => void },
): SessionPruning {
  const root = resolve(sessionsDir(repoRoot))
  // The directory name, not the id each file claims. They agree in every record conclave
  // writes; where they do not, the name is the one that says what is being deleted.
  const candidates = scanSessions(repoRoot)
    .filter((s) => prunable(s.session, olderThan))
    .map((s) => s.name)
  const out: SessionPruning = { candidates, removed: [], skipped: [], failed: [] }

  // Before the loop, deliberately. Everything after this line is destructive.
  opts?.announce?.(candidates)

  for (const id of candidates) {
    const dir = resolve(sessionDir(repoRoot, id))
    if (dir === root || !dir.startsWith(root + sep)) {
      out.failed.push({ id, error: `${dir} is not inside ${root}` })
      continue
    }
    const now = readSession(repoRoot, id)
    if (!now) {
      // Gone or unreadable since the scan. Nothing here is worth deleting a directory over
      // that we can no longer confirm the contents of.
      out.skipped.push({ id, reason: 'its record could no longer be read' })
      continue
    }
    if (!prunable(now, olderThan)) {
      out.skipped.push({
        id,
        reason: now.alive ? 'its process is alive' : 'it no longer meets the conditions',
      })
      continue
    }
    try {
      // `force` so a record another prune already removed is not an error: two operators
      // tidying the same project should not produce a failure report between them.
      rmSync(dir, { recursive: true, force: true })
      out.removed.push(id)
    } catch (err) {
      // One unremovable directory must not abandon the rest. A prune that stopped at the
      // first permission error would leave the operator to run it again and hit the same one.
      out.failed.push({ id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

/**
 * The repository root, for locating `.conclave/`.
 *
 * A session started in a subdirectory must be findable from the top and vice versa, or the
 * id an operator was handed stops working when they change directory. Falls back to the
 * directory given, so this works outside a repository too.
 */
export function projectRootFor(dir: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out || dir
  } catch {
    return dir
  }
}

/**
 * What recording needs from a relay.
 *
 * Structural rather than importing `Relay`, so a test can drive this with a stand-in and so
 * the dependency runs one way: the relay knows nothing about being recorded.
 */
export interface RecordableRelay {
  readonly cwd: string
  readonly operator: 'human' | 'agent'
  /** Whether the session has been stopped, as opposed to a run within it having ended (#189). */
  readonly stopped: boolean
  /** Resolves when another run opens the stream, or when the session ends. See `whenObservable`. */
  whenObservable(): Promise<void>
  readonly participants: readonly {
    id: string
    rank: string
    role: string
    /**
     * The argv this seat was launched with and the model it names, composed once by the
     * relay at join. Required rather than optional: a stand-in that omitted it would produce
     * a status document missing a key the real one has, which is the drift this contract is
     * structural in order to catch.
     */
    launch: { args: readonly string[]; model: string | null }
    session: {
      readonly agent: string
      /**
       * Just enough of `SessionSnapshot` to grade the turns, structurally. An adapter
       * satisfies this by satisfying `AgentSession`; a test satisfies it with an object
       * literal, which is the point of not importing the interface.
       */
      snapshot(): Promise<{
        turns: readonly {
          key: string
          state: string
          confidence?: Confidence | undefined
          provenance?: Provenance[] | undefined
        }[]
      }>
    }
  }[]
  readonly log: readonly unknown[]
  permissionsPending(): { id: string; tool: string }[]
  observe(opts?: { replay?: boolean }): AsyncIterable<RelayEvent>
  /**
   * The dispatcher's per-seat state, the queue, and the seat worktrees -- the three reads the
   * seat block is projected from.
   *
   * OPTIONAL, all three, and structural like everything else here. A `Relay` satisfies them by
   * having them; a stand-in written before they existed satisfies them by omission, and gets
   * the document it got before -- which is what makes this additive to the recorder's contract
   * rather than a break in it. `Relay` populates `seats()` when a run STARTS, so all three are
   * empty on a session that has not run yet, and the projection says nothing rather than
   * guessing.
   */
  /**
   * This seat's resolved rotation policy, or `undefined` when the run configured none.
   *
   * Structural like the rest, and deliberately shaped as `EffectiveRotation` rather than as the
   * document: the relay resolves the policy (`Relay.rotationOf`, which is `rotationFor`), and
   * this file decides how it is REPORTED. A relay that returned the finished JSON block would
   * be a relay that knows about being recorded.
   *
   * OPTIONAL, so a stand-in written before rotation was reported still satisfies the contract
   * and gets the document it got before -- no block rather than a block claiming nothing is
   * configured, because a stand-in that cannot answer has not said the run is unarmed.
   */
  rotationOf?(
    seatId: string,
  ): { checks: readonly CheckSpec[]; onDegradation: 'candidate' | 'automatic' } | undefined
  /**
   * What bounds this run, resolved by the relay because the relay is what obeys them.
   *
   * NOT read from the front-end's own flags, though both front-ends have them in hand. A
   * document built from what the caller believes it passed is a document that agrees with the
   * caller and not with the loop -- and the whole of #119 is an operator whose belief about the
   * bound was wrong. `Relay.ceilings` is `boundOf` plus the configured ceilings, which is the
   * same answer the dispatcher checks against.
   *
   * OPTIONAL and structural, like `rotationOf`: a stand-in written before this existed still
   * satisfies the contract and gets the document it got before, with no `ceilings` key rather
   * than one claiming a run is unbounded when it was never asked.
   */
  readonly ceilings?: RunCeilings | undefined
  /**
   * What each seat's turns are measured against, resolved by the relay.
   *
   * Read whole, like `ceilings`, and for the same reason: the relay is what holds the registry's
   * support table AND this run's configuration, so it is the only thing that can resolve one
   * against the other. A document built from the front-end's own flags would agree with the
   * caller instead of with the run -- and on this field the disagreement has a specific shape,
   * because a flag can be accepted and still not reach a seat whose adapter has no such clock.
   *
   * OPTIONAL and structural, like `rotationOf` and `ceilings`: a stand-in written before this
   * existed still satisfies the contract and gets the document it got before, with no
   * `deadlines` key rather than one claiming a run measures nothing when it was never asked.
   */
  readonly deadlines?: RunDeadlines | undefined
  /**
   * Every accepted rotation and WHY, as the relay recorded it at the moment it accepted one.
   *
   * A method rather than a property because it grows during the run, and the recorder rewrites
   * the document on every event -- a property would be a live array the recorder serialises,
   * which is the shared-state hazard `report.ts` copies to avoid.
   *
   * OPTIONAL and structural, like `rotationOf` and `ceilings`: a stand-in written before #75
   * still satisfies the contract and gets the document it got before, with no `rotations` key
   * rather than an empty one claiming this run rotated nothing when it was never asked.
   */
  rotationRecords?(): readonly RotationRecord[]
  /**
   * Every forced `/continue` and the evidence the guard read at the moment it was applied.
   *
   * A method for the same reason `rotationRecords` is one: it GROWS during the run, and a
   * property would be a live array the recorder serialises -- the shared-state hazard
   * `report.ts` copies to avoid. `RunHandle.forceRecords()` already returns a copy.
   *
   * OPTIONAL and structural like the rest: a stand-in written before #125 still satisfies the
   * contract and gets the document it got before, with no `forces` key rather than an empty one
   * claiming this run forced nothing when it was never asked.
   */
  forceRecords?(): readonly ForceRecord[]
  /**
   * Whether the advisor has been addressing its instructions, as the relay has counted them.
   *
   * A method for the same reason `rotationRecords` is one: it GROWS during the run, and a
   * property would be a live object the recorder serialises -- the shared-state hazard
   * `report.ts` copies to avoid. `Relay.targeting()` already returns a copy.
   *
   * OPTIONAL and structural like the rest: a stand-in written before #79 still satisfies the
   * contract and gets the document it got before, with no `targeting` key rather than one
   * claiming this run's advisor addressed nothing when it was never asked.
   */
  targeting?(): TargetingWatch
  seats?(): readonly { seat: string; state: string; current?: string | undefined; dispatched: number }[]
  tasks?(): readonly { task: { id: string; instruction: string }; runtime: { state: string } }[]
  readonly worktrees?: { seats: readonly { seatId: string; worktreePath: string; branch: string }[] } | undefined
}

/** Live recording, and the handle the front-end uses to report state changes. */
export interface SessionRecording {
  readonly id: string
  readonly recorder: SessionRecorder
  /** Report a lifecycle change. Participants and counters are refreshed on every call. */
  set(state: SessionRunState, extra?: { pause?: RunPause | undefined; outcome?: RunOutcome | undefined }): void
  /**
   * Re-read every participant's snapshot and rewrite the status.
   *
   * Exposed because the caller sometimes knows something the event stream does not -- and
   * because a test asserting on graded turns should be able to say WHEN they were read
   * rather than sleep and hope. `close()` awaits one of these last.
   */
  refresh(): Promise<void>
  /** Stop following the stream. The files stay; only the subscription ends. */
  close(): Promise<void>
}

/**
 * Record a relay to disk for the lifetime of the process.
 *
 * Wired here rather than in either front-end, because "a capability wired into one
 * front-end and not the other" is the mistake this codebase has now made six times. Both
 * `relay` and `session` call this, and neither owns the format.
 *
 * The stream is followed in a detached loop that is deliberately NOT awaited: a recorder
 * that had to be pumped by the run loop would make recording a step in the critical path,
 * and a slow disk would then slow the session down rather than merely lag the file.
 */
export function recordSession(
  relay: RecordableRelay,
  opts: {
    repoRoot: string
    id: string
    goal: string
    front: 'relay' | 'session'
    startedAt: number
    logPath?: string | undefined
    build: string
    /**
     * How often the record is rewritten when nothing has changed. `SESSION_HEARTBEAT_MS` by
     * default; injectable ONLY so a test can watch a beat land without sleeping thirty seconds.
     * Neither front-end passes it.
     */
    heartbeatMs?: number | undefined
  },
): SessionRecording {
  /** The last adapter event per seat, which is what "what is it doing" means live. */
  const activity = new Map<string, { kind: string; tool?: string | undefined; since: number }>()
  /**
   * When each seat's outstanding permission prompt was RAISED.
   *
   * Kept separately from `activity` although the same event feeds both, because `activity` is
   * the LAST event and this one has to survive later ones. Nothing stops a seat emitting after
   * it has asked -- and if it does, `activity` moves on while the prompt is still outstanding,
   * so reading the timestamp off `activity` would report a wait that had reset itself. That is
   * exactly the reading a driver is bounding its patience against (#234).
   *
   * Never cleared. A stale entry cannot be read: it is only consulted for a seat that
   * `permissionsPending()` currently names, and every prompt raises the event that overwrites
   * it. Clearing on answer would need the answer to be observable here, which it is not.
   */
  const permissionSince = new Map<string, number>()
  /**
   * The last snapshot's turns per seat.
   *
   * Cached rather than read at write time because `seats()` is synchronous and `snapshot()`
   * is not -- and it is not for a real reason: it rebuilds from the transcript on disk. A
   * status file that awaited one on every event would make recording a slow step on a path
   * that is deliberately detached from the run.
   */
  const turns = new Map<string, SessionTurnStatus[]>()

  const seats = (): SessionParticipantStatus[] => {
    // Read ONCE per document rather than once per participant: `seats()` and `tasks()` both
    // deep-copy what they return, so a call inside the map would clone the whole queue N
    // times to answer N questions about it.
    const execs = relay.seats?.() ?? []
    // The gate, and the only one: more than one seat in the dispatcher. Not "the run has
    // worktrees" (a seat can share a checkout), not "the participant list has two
    // implementers" (that is true before the dispatcher has any state to report), and not a
    // flag the front-end passes down (a recorder that had to be TOLD the shape of the run
    // would be a second place the seat count is decided).
    const multi = execs.length > 1
    const queue = multi ? (relay.tasks?.() ?? []) : []
    return relay.participants.map((p) => {
      const pending = relay.permissionsPending().find((x) => x.id === p.id)
      const seen = activity.get(p.id)
      // ROLE, not rank, matching `Relay#implementers()` -- which is what rotation eligibility
      // means inside the relay: the seats degradation is assessed on, and the seats its refusal
      // lists. Rank would be wrong by exactly one seat: a REVIEWER is rank `implementer` and
      // role `reviewer` (D5, #72), so a rank test would report a rotation policy on a seat no
      // pause ever names as a rotation subject and no assessment ever visits. A stand-in that
      // cannot resolve a policy (`rotationOf` absent) gets no block at all -- see the contract.
      const reportsRotation = p.role === 'implementer' && relay.rotationOf !== undefined
      const rot = reportsRotation ? relay.rotationOf?.(p.id) : undefined
      const rotation: SessionRotationStatus | undefined = reportsRotation
        ? {
            configured: rot !== undefined,
            armed: (rot?.checks.length ?? 0) > 0,
            checks: (rot?.checks ?? []).map((c) => ({
              command: checkCommand(c),
              relevance: checkRelevance(c),
            })),
            onDegradation: rot?.onDegradation ?? null,
          }
        : undefined
      const exec = multi ? execs.find((s) => s.seat === p.id) : undefined
      const current = exec?.current === undefined ? undefined : queue.find((e) => e.task.id === exec.current)
      const tree = exec && relay.worktrees?.seats.find((w) => w.seatId === p.id)
      return {
        id: p.id,
        agent: p.session.agent,
        rank: p.rank,
        role: p.role,
        // Copied, like everything else this function returns: the status document is written
        // repeatedly from a live relay, and handing out its own array would let a later reader
        // of an earlier document see a list that had moved underneath it.
        launch: { args: [...p.launch.args], model: p.launch.model },
        turns: turns.get(p.id) ?? [],
        ...(seen ? { activity: seen } : {}),
        // `?? Date.now()` is the floor for a pending prompt whose event this recorder never
        // saw -- a relay stand-in, or a recorder attached after the prompt was raised. It
        // reports the wait as starting now, which understates it; the alternative is omitting
        // the whole block and reporting a blocked seat as unblocked, which is the failure this
        // issue is about.
        ...(pending
          ? { awaitingPermission: { tool: pending.tool, since: permissionSince.get(p.id) ?? Date.now() } }
          : {}),
        ...(rotation ? { rotation } : {}),
        ...(exec
          ? {
              seat: {
                state: exec.state,
                dispatched: exec.dispatched,
                // The instruction WHOLE, not a first line. A truncation in a field named
                // `instruction` is a lie a consumer cannot detect, and there is at most one
                // of these per seat -- the growth this file worries about is per-turn tool
                // lists, which are unbounded, not a task the seat is holding right now.
                ...(current
                  ? { task: { id: current.task.id, state: current.runtime.state, instruction: current.task.instruction } }
                  : {}),
                ...(tree ? { worktree: { path: tree.worktreePath, branch: tree.branch } } : {}),
              },
            }
          : {}),
      }
    })
  }

  /**
   * The rotation records, re-read on every write rather than captured once.
   *
   * Unlike `ceilings`, which is fixed for a run's whole life, this GROWS: a rotation happens
   * mid-run, and the whole point of putting it in the status file is that an operator watching
   * a live run can see it there (#75). So it is a call, made wherever the document is rewritten.
   *
   * `undefined` when the relay does not answer, spread away rather than written as an empty
   * array: a stand-in that was never asked has not said this run rotated nothing.
   */
  const rotations = (): { rotations: RotationRecord[] } | Record<string, never> => {
    const records = relay.rotationRecords?.()
    return records === undefined ? {} : { rotations: [...records] }
  }

  /**
   * The force ledger, re-read on every write rather than captured once.
   *
   * Grows during the run exactly as `rotations` does -- a force is recorded the moment it is
   * applied -- so it is a call made wherever the document is rewritten, and it is spread in
   * at every one of those places rather than only at construction. A block written once would
   * report no forces for the whole life of a run where one happened early and that is the
   * indistinguishability #125 exists to fix.
   *
   * `undefined` when the relay does not answer, spread away rather than written as an empty
   * array: a stand-in that was never asked has not said this run forced nothing.
   */
  const forces = (): { forces: ForceRecord[] } | Record<string, never> => {
    const records = relay.forceRecords?.()
    return records === undefined ? {} : { forces: [...records] }
  }

  /**
   * The same, for what the advisor has been addressing (#79).
   *
   * Grows during the run exactly as `rotations` does -- the counters move on every advisor turn
   * that produces work -- so it is a call made wherever the document is rewritten, and it is
   * spread in at every one of those places rather than only at construction. A block written
   * once would report `0 addressed` for the whole life of a run whose advisor addressed every
   * turn, which is worse than not reporting it.
   *
   * `undefined` when the relay does not answer, spread away rather than written as zeros: a
   * stand-in that was never asked has not said this run's advisor named nobody.
   */
  const targeting = (): { targeting: ReportedTargeting } | Record<string, never> => {
    const w = relay.targeting?.()
    // TWO reasons to write nothing, and they are different facts that happen to look alike from
    // outside. `w === undefined` is a stand-in that was never asked. A `w` that is not
    // `applicable` is a one-seat run, where the question does not arise -- and `reportedTargeting`
    // owns that second decision so this file and `report.ts` cannot come to disagree about when
    // the key exists.
    const block = w === undefined ? undefined : reportedTargeting(w)
    return block === undefined ? {} : { targeting: block }
  }

  const recorder = new SessionRecorder(opts.repoRoot, {
    id: opts.id,
    pid: process.pid,
    cwd: relay.cwd,
    goal: opts.goal,
    front: opts.front,
    operator: relay.operator,
    state: 'starting',
    startedAt: opts.startedAt,
    messages: relay.log.length,
    participants: seats(),
    build: opts.build,
    ...(opts.logPath ? { logPath: opts.logPath } : {}),
    // Written once at construction rather than refreshed alongside the participants: a run's
    // ceilings are fixed for its whole life, so re-deriving them on every event would be work
    // that can only ever produce the same answer. Last among the fields this passes, so the
    // key is appended to the document rather than inserted among the ones already there.
    ...(relay.ceilings ? { ceilings: relay.ceilings } : {}),
    // Beside `ceilings` and written once for the same reason: a seat's clocks are fixed for
    // the run's whole life, so re-resolving them on every event could only ever produce the
    // same answer. Appended after it so the key lands at the end of the document rather than
    // among the ones already there.
    ...(relay.deadlines ? { deadlines: relay.deadlines } : {}),
    // After `ceilings`, so the key is appended to the document rather than inserted among the
    // ones already there -- the same rule, for the same reason.
    ...rotations(),
    // After `rotations`, for the same reason it comes after `ceilings`: appended to the
    // document rather than inserted among the keys already there.
    ...forces(),
    // After `forces`, for the same reason it comes after `rotations`: appended to the
    // document rather than inserted among the keys already there.
    ...targeting(),
  })

  /**
   * The last outcome seen, carried forward.
   *
   * A pause and an outcome are not the same kind of fact. A pause is a state the run is IN,
   * so it has to be clearable -- a resumed run still carrying its last pause would tell a
   * poller to intervene in a decision already made. An outcome is something that HAPPENED,
   * and it does not un-happen because the front-end later reported another state. The
   * console proved this immediately: it reports `ended` on teardown, which erased the very
   * outcome the run had just produced.
   */
  let lastOutcome: RunOutcome | undefined

  /**
   * Which refresh a result belongs to, and which one has already landed.
   *
   * A snapshot is a read of a file that is still being written, so two of them do not
   * necessarily come back in the order they were asked for. Without this counter a slow
   * read of an early transcript could return AFTER a fast read of a later one and overwrite
   * the newer turns with older ones -- and the status file would go backwards while the run
   * went forwards, which is the one thing a polled file must never do.
   */
  let issued = 0
  let applied = 0

  const refreshOnce = async (): Promise<void> => {
    const gen = ++issued
    const fresh: [string, SessionTurnStatus[]][] = []
    for (const p of relay.participants) {
      try {
        const snap = await p.session.snapshot()
        fresh.push([
          p.id,
          snap.turns.map((t) => ({
            key: String(t.key),
            state: t.state,
            confidence: t.confidence,
            provenance: t.provenance,
          })),
        ])
      } catch {
        // A snapshot that cannot be rebuilt right now keeps the last one that could. The
        // final refresh runs AFTER `relay.stop()`, when a session may already be gone, and
        // dropping the turns there would lose them at exactly the moment they matter most.
      }
    }
    if (gen < applied) return
    applied = gen
    for (const [id, ts] of fresh) turns.set(id, ts)
    recorder.update({ messages: relay.log.length, participants: seats(), ...rotations(), ...forces(), ...targeting() })
  }

  /**
   * Refreshes run one at a time. Two concurrent reads of the same transcript are waste
   * rather than safety, and serialising them means the counter above is a backstop instead
   * of the only thing standing between a poller and a status file that moves backwards.
   */
  let queue: Promise<void> = Promise.resolve()
  const refresh = (): Promise<void> => {
    queue = queue.then(refreshOnce).catch(() => {})
    return queue
  }

  const set: SessionRecording['set'] = (state, extra) => {
    if (extra?.outcome) lastOutcome = extra.outcome
    recorder.update({
      state,
      messages: relay.log.length,
      participants: seats(),
      pause: extra?.pause,
      outcome: lastOutcome,
      ...rotations(),
      ...forces(),
      ...targeting(),
    })
    // Detached: `set` is called from the run loop and a lifecycle change must not wait on a
    // transcript read. The state above is written immediately; the turns catch up.
    void refresh()
  }

  /**
   * The heartbeat. See `SessionRecorder.beat` for what one does and `SESSION_HEARTBEAT_MS` for
   * why it exists at all.
   *
   * Bounded twice over. It is UNREFERENCED, so recording can never be the reason a process
   * refuses to exit -- the same rule the follow loop obeys by being detached. And it skips an
   * `ended` record rather than stamping it forever: a finished run has stopped saying anything,
   * `close()` is meant to clear this immediately afterwards, and a beat that outlived it would
   * push the record's prune eligibility (`updatedAt < olderThan`) out by one interval at a time,
   * forever.
   */
  const heartbeat = setInterval(() => {
    if (recorder.status.state === 'ended') return
    recorder.beat()
  }, opts.heartbeatMs ?? SESSION_HEARTBEAT_MS)
  heartbeat.unref()

  let stop: (() => void) | undefined
  const following = (async () => {
    // The record is per SESSION; a subscription is per RUN. Those were the same thing until a
    // console could start a second run on the same relay, at which point this loop returned
    // with the session still going and everything after it went unrecorded -- while
    // `relay.log` kept collecting, so the two files disagreed about the same session (#189).
    //
    // So it re-attaches. `written` is how far the record has got, and a re-attach replays the
    // whole retained history and skips that many: what is left is exactly the gap, including
    // anything said BETWEEN runs, which reaches the history but no live subscriber.
    let detached = false
    let written = 0
    let skip = 0
    let it = relay.observe({ replay: true })[Symbol.asyncIterator]()
    stop = () => {
      detached = true
      void it.return?.()
    }
    for (;;) {
      const next = await it.next()
      if (next.done) {
        if (detached || relay.stopped) return
        // Parked rather than polled: nothing is observable until another run starts, and a
        // recorder spinning between runs is worse than one waiting to be told.
        await relay.whenObservable()
        if (detached || relay.stopped) return
        skip = written
        it = relay.observe({ replay: true })[Symbol.asyncIterator]()
        continue
      }
      const e = next.value
      if (skip > 0) {
        skip--
        continue
      }
      written++
      recorder.event(e)
      if (e.type === 'activity') {
        // `turn_end` is left in place deliberately: between turns the interesting fact is
        // how the last one ended, and blanking it would show an idle seat as doing nothing
        // when it has just reported a verdict.
        activity.set(e.participant, {
          kind: e.event.type,
          ...('tool' in e.event ? { tool: e.event.tool } : {}),
          since: e.at,
        })
        // The moment the prompt was raised, kept where a later event cannot move it.
        if (e.event.type === 'permission_requested') permissionSince.set(e.participant, e.at)
        // The two events that change a VERDICT, as opposed to what a seat is doing. A turn
        // ending produces the grade; a revision withdraws or replaces one. Snapshotting on
        // every event would re-read the transcript for every tool call the child makes, and
        // snapshotting only at the end would leave a long run with nothing to read until it
        // was over -- which for the runs most worth watching is the whole point.
        if (e.event.type === 'turn_end' || e.event.type === 'revision') void refresh()
      }
      // Every event refreshes the participant block, so a permission prompt appears in the
      // status file at the moment it appears in the stream rather than at the next
      // lifecycle change -- which for a seat stopped at a prompt would be never.
      recorder.update({ messages: relay.log.length, participants: seats(), ...rotations(), ...forces(), ...targeting() })
    }
  })()

  return {
    id: opts.id,
    recorder,
    set,
    refresh,
    /**
     * Wait for the stream to end on its own, then detach.
     *
     * CALL THIS AFTER `relay.stop()`, never before. `Relay.#end` is what emits the terminal
     * `run_end`, and `stop()` is what calls it -- so a front-end that closed the recorder
     * first detached before the event existed, and the recorded stream simply stopped with
     * no line saying the run had finished. Both front-ends did exactly that, and it was
     * found by reading a recorded file rather than by any test.
     *
     * The race is a backstop for a caller that never stops the relay at all: teardown that
     * hangs is worse than teardown that gives up.
     *
     * Then one last snapshot, AWAITED and taken after the stream is done. Both front-ends
     * report `ended` before closing the recorder, and the last turn of a run is graded at
     * the very end -- so a recorder that detached without re-reading would leave the final
     * verdicts out of the only file anyone can read once the process is gone. Last, rather
     * than first, because the follow loop can still queue refreshes while it drains and the
     * final one has to be the one that wins.
     */
    close: async () => {
      // First, before anything that can take time. Teardown writes the final record itself, and
      // a heartbeat still ticking during a two-second race would stamp a record the caller is
      // about to replace.
      clearInterval(heartbeat)
      // Detach FIRST, then drain. This used to wait for the stream to end on its own and only
      // then detach, which was right while a stream ending meant the session was over. It no
      // longer does: between runs the follow loop is parked waiting for the next one, so
      // waiting for it is waiting for something this call is the end of (#189). Every test that
      // closed a stream without stopping its relay paid the full two seconds for that.
      //
      // Nothing is lost by the order. `it.return()` closes the subscriber's queue, and a closed
      // `AsyncQueue` still drains what is already in it before reporting done -- and in
      // production `relay.stop()` has already run, so there is nothing further coming.
      stop?.()
      await Promise.race([following, new Promise((r) => setTimeout(r, 2_000).unref())])
      await refresh()
    },
  }
}
