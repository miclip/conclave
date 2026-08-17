/**
 * A run you can hold onto.
 *
 * `Relay.run()` is a single call that returns an outcome, which is the right shape for an
 * unattended run and the wrong one the moment a human is meant to decide something. When
 * the loop reaches a rotation candidate it has to stop, and a call that has already
 * returned cannot be continued — so the only recovery was to call `run()` again from the
 * original goal. That is not resuming. It replays work, loses the topic boundary the
 * session had reached, and hands already-consumed state to participants that have moved
 * past it.
 *
 * So a pause is a *state*, not a return value:
 *
 *   const run = relay.start(goal)
 *   const pause = await run.untilPause()
 *   await run.rotateImplementer()
 *   await run.continue()
 *
 * The loop suspends at the pause point holding everything it had — the advisor-turn counter, the
 * advisor's last instruction, the implementer's report — and picks up from there. Rotation
 * is safe at exactly that moment and nowhere else: no turn is in flight, so replacing the
 * implementer cannot race a send.
 *
 * Lifecycle logic lives here rather than in the future REPL. A console that owned the
 * transitions would be the only thing that could drive a session, and everything else --
 * tests, scripts, a daemon -- would have to reimplement them.
 */

import type { AuthorityConflict } from './authority.ts'
import type { Audience, RelayMessage } from './message.ts'
import type { RunReason } from './observe.ts'
import type { Verdict } from '../contract/outcome.ts'
import type { ChildLiveness, LivenessReading } from '../outcomes/liveness.ts'
import type { RotationResult } from '../rotation/rotate.ts'
import type { ResolutionRequest } from './resolution.ts'
import { requiresStatedReason } from './rotationIntent.ts'

export type RunState = 'running' | 'paused' | 'ended'

export type PauseReason =
  /** Mechanical degradation observed. The proxy is measured; the human decides. */
  | 'rotation_candidate'
  /** The advisor asked for a human. */
  | 'advisor_escalated'
  /**
   * The implementer asked a build-changing scope question that the instruction does not settle.
   *
   * A flag qualifies the result; an unanswered question blocks the build, because continuing
   * would choose an answer on the implementer's authority rather than the human's. The pause
   * carries the question and what has been done so far.
   */
  | 'implementer_unanswered'
  /** A turn ended as something other than `completed`. */
  | 'turn_incomplete'
  /**
   * An advisor instruction would reverse work traceable to a restricted human message.
   *
   * The orchestrator neither adjudicates nor prohibits: prohibition would make an aside an
   * invisible veto over legitimate correction. It notices, and hands the case to the only
   * party holding both sides. See `authority.ts`.
   */
  | 'authority_conflict'
  /**
   * A seat's work could not be merged, and the seat could not repair it either.
   *
   * NOT raised by the first conflict. A conflict is ordinary at N>1 and is handled inside the
   * run: the merge is aborted, that one seat is marked `merge_blocked`, and the advisor is
   * asked for an instruction that resolves it in the seat's own worktree. Every other seat
   * keeps working, because blocking a run on one seat's conflict is lockstep reached from a
   * different direction.
   *
   * This is the SECOND failure against the same integration parent — the repair was dispatched,
   * came back, and the merge still will not go. Nothing has changed that another turn could
   * change, so continuing would spend the advisor's budget re-asking a question the seat has
   * already failed to answer. The work is committed on the seat's branch and its tree is
   * retained; what the operator gets is a decision point rather than a run that quietly stops
   * making progress.
   */
  | 'merge_blocked'
  /**
   * A reviewer rejected a seat's work twice against the same original task (#72).
   *
   * NOT raised by the first rejection: that becomes an ordinary `review_resolution` task,
   * dispatched back to the seat automatically, exactly as a merge conflict's repair is. This
   * is the SECOND rejection of the SAME work -- nothing has changed that another repair turn
   * could change, so the operator gets a decision point instead of a run that quietly keeps
   * dispatching repairs a reviewer keeps refusing.
   */
  | 'review_blocked'
  /**
   * The operator asked to stop at the next advisor-turn boundary.
   *
   * Not in the original set, and added for a reason worth recording: without it the only
   * way to reach a pause is to wait for the orchestrator to raise one, so "does a real
   * session survive a human-scale pause" could not be tested without first provoking a
   * real compaction — which is the precondition of the *other* live question. Two proofs
   * that can only be run together are one proof.
   *
   * It is also the plainer operator need: intervening in a session already in progress.
   */
  | 'operator_requested'

/**
 * What the operator can do from here — filtered to what would actually change something.
 *
 * It used to be "descriptive: the methods exist regardless", and that cost a real run. An
 * operator whose ADVISOR had gone silent was offered `rotate`, chose it, and nothing
 * happened: rotation replaces the implementer, always. They found out by reading `rotations`
 * in the status JSON afterwards, having spent a turn on it.
 *
 * A menu is a claim about what will help. Listing an option that cannot apply here is the
 * same fault as a diagnostic that recommends the wrong remedy — see the pause options built
 * in `Relay.#halt`.
 */
export type PauseOption = 'continue' | 'wait' | 'rotate' | 'constrain' | 'abort'

/**
 * The claim a pause was raised on, withdrawn by the system after the fact.
 *
 * A pause is an ASSERTION the orchestrator makes to a human, and the evidence model is
 * explicitly allowed to keep working on a turn after reporting a verdict — that is what a
 * `revision` is for. So the two can diverge: a run pauses on `timed_out`, a late `Stop`
 * proves the turn completed, and the human is left adjudicating a verdict nothing stands
 * behind any more.
 *
 * The run STAYS PAUSED when this arrives. Withdrawing the reason for a decision is not the
 * same as making it, and resuming on the system's own behalf would take the choice away at
 * exactly the moment it became easy to make. The orchestrator surfaces; the human decides.
 */
export interface PauseSupersession {
  at: number
  /** Assembled from the revision rather than narrated, per §9: what the human should read. */
  note: string
  /**
   * The replacement verdict, once the adapter has issued one.
   *
   * Most outcomes are terminal: the turn has ended one way or another. `timed_out` is the
   * exception — a repeatedly firing watchdog can re-report the same still-running turn. The
   * replacement `outcome` is what distinguishes "the turn ended" from "the turn is still
   * running".
   */
  verdict?: Verdict | undefined
}

/**
 * The operator looked, judged the child healthy, and chose to keep waiting.
 *
 * Distinct from an unanswered pause, which is what it was indistinguishable from. A status
 * file saying `paused` could not tell "waiting on someone who has not looked" from "someone
 * looked and decided", and neither could a monitor polling `state` -- which never changes
 * across the whole episode, because the run stays paused through the supersession too.
 *
 * It is NOT a watchdog re-arm. By the time a pause exists the turn has already settled: the
 * adapter fired, issued a verdict, and `#exchange` returned. There is no clock left to
 * extend. What this extends is the PAUSE -- how long the operator is prepared to sit here
 * before being told again -- which is the thing they were actually deciding.
 */
export interface PauseWait {
  at: number
  /** When to say something if the verdict has still not been superseded. */
  until: number
  /** The operator's stated reason, when they gave one. */
  detail?: string | undefined
}

/**
 * A `/continue` refused because the child was mid-turn.
 *
 * The run stays paused, so a watcher polling `state` sees no change. The refusal is the only
 * durable record that a decision was attempted and rejected, and it carries what it was decided
 * on so the reason is inspectable later rather than being a transient console line.
 *
 * `reason` is now the TURN, not the CPU: `describeActiveTurn` over the child's own
 * `turn_start`/`turn_end` events. `liveness` is optional and always was colour -- it is absent
 * when the adapter names no child process, and present when it does, but nothing decided on it
 * either way. It stays on the record because an operator reading a refusal afterwards is
 * entitled to the measurement that was taken beside it.
 */
export interface PauseContinueRefusal {
  at: number
  reason: string
  liveness?: ChildLiveness | undefined
}

/**
 * The liveness measurement behind this pause's evidence, as a fact rather than as prose.
 *
 * `evidence` is a `string[]` an operator reads. An AGENT operator — which the run this was
 * reported from was — has to regex it, and the thing it most needs out of that line is the one
 * thing the line never carried: when the measurement was taken. So the fact is published
 * alongside the sentence, and the sentence is rendered from the fact.
 *
 * REFRESHED IN PLACE while the pause lasts, boundedly. `#refreshPauseLiveness` in `relay.ts`
 * re-samples the child, rewrites `evidence[index]` and updates this block, so a poller reading
 * `status.json` twenty seconds apart gets two different readings rather than one replayed
 * forever. That was #101: the pause's liveness line said `is still working (cpu 3.3%, 5.1%,
 * 3.5%)` for minutes after the child had dropped to 0.2% and the turn had ended, and an
 * operator waited out a turn that was already over on the strength of it.
 *
 * NOT what `/continue` decides on, and that is deliberate rather than an oversight. The guard
 * samples the child itself, at the instant of the decision, because continuing SENDS and a
 * reading up to `LIVENESS_REFRESH_EVERY_MS` old is not a reading of now. This block makes the
 * evidence honest about its age; it does not make it fresh enough to act on unseen. See
 * `resumeRun` in `src/repl/session.ts` and #43.
 */
export interface PauseLiveness {
  /** The seat whose child was measured. */
  participant: string
  /** Which entry of `evidence` this block is the fact behind. */
  index: number
  /** The most recent measurement. `sample.measuredAt` is when. */
  sample: ChildLiveness
  /** What that sample supports, so a machine reader need not parse the sentence. */
  reading: LivenessReading
  /** When the FIRST measurement was taken — the one the pause was raised carrying. */
  firstAt: number
  /** Re-measurements since. Bounded by `LIVENESS_REFRESH_LIMIT`. */
  refreshes: number
  /**
   * Why no further measurement will be taken, once that is true.
   *
   * Present means this reading is now fixed and only ages. Absent means it is still being
   * refreshed — which a reader must be able to tell apart, because a refresher that fell
   * silent at its bound and said nothing is the original defect wearing a newer number.
   */
  final?: string | undefined
}

export interface RunPause {
  reason: PauseReason
  /**
   * The condition this pause is the EFFECT of, classified on both axes (#56, D2).
   *
   * Computed at the halt site from the reason and the run's configuration, never stored or
   * declared by the condition itself -- see `resolution.ts`. Recorded rather than acted on:
   * a request whose authority is `mechanical` or `advisor` still produces this pause today,
   * because nothing exists yet that could resolve one, and dropping the pause first would
   * lose the decision point rather than automate it.
   *
   * `reason` above is the same value as `resolution.reason`; both are kept because this
   * field is the whole classification and the loose one is what every existing reader,
   * status file and rendering is written against.
   */
  resolution: ResolutionRequest
  detail: string
  /**
   * Why the orchestrator believes what it believes, in the project's provenance idiom.
   * A pause the operator cannot interrogate is a pause they will dismiss by reflex.
   */
  evidence: string[]
  options: PauseOption[]
  /** Present only on `authority_conflict`: both sides, so the human can adjudicate. */
  conflict?: AuthorityConflict | undefined
  /**
   * Present on `turn_incomplete`: the `turn_end` this pause rests on. Adapters withdraw a
   * verdict BY SEQUENCE NUMBER, so this is what lets a later revision be matched to this
   * pause exactly, rather than guessed at from timing.
   */
  verdictOf?: { participant: string; endSeq: number } | undefined
  /** Set once the verdict named above has been withdrawn. See `PauseSupersession`. */
  superseded?: PauseSupersession | undefined
  /** Set when the operator chose to keep waiting rather than answer. See `PauseWait`. */
  waiting?: PauseWait | undefined
  /** Set when `/continue` was refused because the child was still working. See `PauseContinueRefusal`. */
  refusal?: PauseContinueRefusal | undefined
  /**
   * The liveness measurement behind one of the `evidence` lines, and its age. See
   * `PauseLiveness`. Absent where the pause carries no liveness line -- an adapter with no
   * child pid to name, or a halt site that measures nothing.
   */
  liveness?: PauseLiveness | undefined
  /** Position in the routing log when the run paused, for lining up against `audit()`. */
  atSeq: number
  at: number
}

export interface RunOutcome {
  reason: RunReason
  detail?: string | undefined
}

export type Decision = { kind: 'continue' } | { kind: 'abort'; detail: string }

/**
 * What the handle is allowed to do to the relay.
 *
 * Deliberately four verbs rather than the relay itself: a handle holding the whole relay
 * would let an operator start a second run from inside a paused first one, and there is no
 * sensible meaning for that.
 */
export interface RunControl {
  rotate(reason: string): Promise<RotationResult>
  /**
   * The seat `rotate` would act on, or `undefined` when the current pause names none.
   *
   * Only so the handle can ask whether a reason must be STATED before it starts a transaction
   * (#75). Deliberately a read of the relay's own target rather than a second derivation from
   * the pause: a handle that resolved the seat differently would demand a reason for one seat
   * and then rotate another.
   */
  rotationTarget(): string | undefined
  constrain(text: string, audience: Audience): RelayMessage
  /** Ask the loop to stop at its next advisor-turn boundary. */
  requestStop(): void
  /** Ask the loop to pause at its next advisor-turn boundary. */
  requestPause(reason: string): void
}

/** What a handle needs besides its control surface. Exists for the clock; see `RunHandle`. */
export interface RunHandleOptions {
  /**
   * The clock the suspension ledger is read from. Defaults to `Date.now`.
   *
   * Injected only so a test can drive a duration ceiling without sleeping. The relay passes
   * ITS clock in, because the ledger below is subtracted from the relay's own elapsed reading
   * and two clocks would make that subtraction meaningless.
   */
  now?: (() => number) | undefined
}

export class RunHandle {
  #control: RunControl
  #now: () => number
  #state: RunState = 'running'
  #pause: RunPause | undefined
  #outcome: RunOutcome | undefined
  /**
   * How long this run has spent SUSPENDED at a pause, waiting for a human to decide.
   *
   * Kept here because this class is the only thing that knows: `pauseAt` opens the interval and
   * every way out of a pause -- `continue`, `rotate`-then-`continue`, `abort`, and a `settle`
   * that ends the run while it is still paused -- closes it. A ledger kept beside the halt site
   * instead would have to be closed in four places and would miss the fourth.
   *
   * It exists because `--max-minutes` was measuring two different things with one number (#112).
   * A run suspended here is not running away: nothing is dispatched, no child is spending quota,
   * and the only thing advancing is a human's deliberation -- which may be a night's sleep. See
   * `Relay#pausedMs` for what is done with it and why that cannot unbound a stuck run.
   */
  #suspendedMs = 0
  /** When the current suspension began, or `undefined` while the run is not paused. */
  #suspendedSince: number | undefined

  /** Resolves the loop's `pauseAt()` once the operator decides. */
  #decide: ((d: Decision) => void) | undefined
  /** Waiting `untilPause()` callers. Resolved with the pause, or `undefined` if it ended. */
  #watchers: ((p: RunPause | undefined) => void)[] = []
  #settled: { resolve: (o: RunOutcome) => void; reject: (e: Error) => void }[] = []
  /**
   * Wait decisions the operator has made, keyed by the verdict they were made against.
   *
   * The current pause is mutated in place, so the memory is not needed for it. It is kept so
   * a later, distinct pause object raised for the same `verdictOf` can carry the same
   * unexpired decision forward — otherwise a repeatedly firing watchdog `timed_out` would
   * re-ask the same judgement, which is what issue #49 is about.
   */
  #waitMemory = new Map<string, PauseWait>()

  constructor(control: RunControl, opts: RunHandleOptions = {}) {
    this.#control = control
    this.#now = opts.now ?? Date.now
  }

  #verdictKey(v: { participant: string; endSeq: number }): string {
    return `${v.participant}:${v.endSeq}`
  }

  get state(): RunState {
    return this.#state
  }

  /** The current pause, or `undefined` when the run is not paused. */
  get pause(): RunPause | undefined {
    return this.#pause
  }

  get outcome(): RunOutcome | undefined {
    return this.#outcome
  }

  /**
   * Total time suspended at pauses, INCLUDING the pause currently in front of the operator.
   *
   * Reads live rather than only on release, because the ceiling that consults it is checked
   * while the run is going and a pause that has not been answered yet is the longest one there
   * is. A reader taking this after the run ends gets the same total either way.
   */
  get suspendedMs(): number {
    const open = this.#suspendedSince === undefined ? 0 : this.#now() - this.#suspendedSince
    return this.#suspendedMs + open
  }

  /** Close the open suspension, if there is one. Idempotent; every exit from a pause calls it. */
  #resumeClock(): void {
    if (this.#suspendedSince === undefined) return
    this.#suspendedMs += this.#now() - this.#suspendedSince
    this.#suspendedSince = undefined
  }

  /**
   * Wait for the next pause.
   *
   * Resolves immediately if the run is already paused — an operator that attaches a moment
   * late must not wait forever for an event that has already happened. Resolves with
   * `undefined` if the run ends instead of pausing; `result()` then has the outcome.
   */
  untilPause(): Promise<RunPause | undefined> {
    if (this.#state === 'paused') return Promise.resolve(this.#pause)
    if (this.#state === 'ended') return Promise.resolve(undefined)
    return new Promise((resolve) => this.#watchers.push(resolve))
  }

  /**
   * The final outcome, for a run expected to finish without intervention.
   *
   * REJECTS if the run pauses while nothing is waiting for pauses. That is not a timeout
   * and not a heuristic: at the moment of a pause with no watcher, this promise provably
   * cannot settle without an operator action that the caller has demonstrably not
   * arranged, so the wait is unsatisfiable and saying so immediately beats hanging.
   *
   * The first live rotation deadlocked exactly here. Promotion succeeded, the loop paused
   * again, and the test sat on this promise until a 25-minute harness timeout reported it
   * as `timed_out` -- misfiling an orchestration deadlock as an agent turn overrunning,
   * with both agents idle and nothing scheduled.
   *
   * Drive pauses with `settled()` instead. Do not hold this promise while separately
   * looping on pauses: between iterations nothing is watching, and this would reject.
   */
  result(): Promise<RunOutcome> {
    if (this.#outcome) return Promise.resolve(this.#outcome)
    return new Promise((resolve, reject) => this.#settled.push({ resolve, reject }))
  }

  /**
   * The next thing that happens: a pause, or the end.
   *
   * One await covering both is what a supervising caller actually wants, and its absence
   * is what made the deadlock above possible -- `untilPause()` and `result()` are separate
   * promises, and a caller can only await one of them first.
   */
  async settled(): Promise<{ kind: 'paused'; pause: RunPause } | { kind: 'ended'; outcome: RunOutcome }> {
    if (this.#outcome) return { kind: 'ended', outcome: this.#outcome }
    if (this.#state === 'paused' && this.#pause) return { kind: 'paused', pause: this.#pause }
    const pause = await this.untilPause()
    return pause ? { kind: 'paused', pause } : { kind: 'ended', outcome: this.#outcome! }
  }

  /** Resume from a pause. Throws if the run is not paused — silence would be worse. */
  async continue(): Promise<void> {
    this.#release({ kind: 'continue' })
  }

  /**
   * Replace the implementer, then stay paused.
   *
   * Separate from `continue()` on purpose: rotating and resuming are two decisions, and an
   * operator may well want to read the handoff and the acceptance report before letting the
   * session carry on.
   *
   * ## Why an omitted reason is now sometimes refused (#75)
   *
   * This used to fall back to `pause.detail` whatever the pause was about, so an operator who
   * rotated for a reason of their own -- to get a fresh reader onto a just-committed criterion,
   * say -- had that rotation recorded in the words of whatever compaction happened to be on
   * screen. The record then said the proxy fired and the operator agreed, which is precisely
   * the correlation #10 is trying to measure, and it said it because rotating was cheap rather
   * than because it was true.
   *
   * The fallback survives where it is honest: at a `rotation_candidate` pause about the seat
   * being rotated, the proxy IS what spoke and agreeing with it is the whole of the operator's
   * contribution. Everywhere else the reason is the only thing distinguishing the two
   * populations, so it is asked for rather than invented.
   *
   * A THROW rather than a silent default, because the caller is a front end with an operator in
   * front of it and the remedy is one sentence from them. `src/repl/session.ts` prompts on the
   * same predicate rather than provoking this.
   *
   * ## Why an accepted candidate carries the PROXY's words even when the operator typed some
   *
   * The pause decides the reason, not the argument. `RotationRecord.reason` is defined as "the
   * proxy's detail when a candidate was accepted, the operator's own sentence otherwise", and
   * that is not a stylistic preference: it is what makes `intent` and `reason` describe the same
   * event. A record reading `candidate_accepted` beside a sentence the proxy never said is a
   * record where the two fields disagree, and an analysis reading either one alone gets a
   * different answer about the same rotation.
   *
   * So the branch is chosen by `rotationNeedsReason()` FIRST and the argument is consulted only
   * inside the branch where it is the only thing there is. `/rotate the session is wedged` at a
   * `rotation_candidate` pause about this seat is still agreement with the proxy -- the operator
   * added a gloss, not a different reason -- and the gloss is dropped rather than recorded as
   * the cause. The console says so out loud (`src/repl/session.ts`), because an operator who
   * typed a sentence and saw it vanish would reasonably assume it had been kept.
   *
   * ## And why a candidate with no detail is refused rather than papered over
   *
   * A sentence composed here would be the only text in the record and no participant would have
   * said it. That is worse than the borrowed detail this whole change exists to stop: borrowed
   * words are at least words somebody wrote about something. A blank detail on a
   * `rotation_candidate` is a malformed pause -- the relay always writes one -- so it is reported
   * as the defect it is rather than smoothed into a record that reads as evidence.
   */
  async rotateImplementer(reason?: string): Promise<RotationResult> {
    if (this.#state !== 'paused') {
      throw new Error(`can only rotate from a paused run; this one is '${this.#state}'`)
    }
    if (!this.rotationNeedsReason()) {
      // An accepted candidate. The proxy is what spoke, so the proxy's detail is what the record
      // carries -- whatever was passed.
      const detail = this.#pause?.detail?.trim()
      if (!detail) {
        throw new Error(
          `this pause is a rotation candidate about ` +
            `${this.#control.rotationTarget() ?? 'this seat'} but carries no detail, so there is ` +
            `nothing the proxy said to record as why the seat is being replaced. Composing one ` +
            `here would put text in the record that no participant wrote -- and a reason you pass ` +
            `is not it either, because accepting a candidate is agreement with the proxy and the ` +
            `record has to say what was agreed with. Fix the pause that raised this.`,
        )
      }
      return this.#control.rotate(detail)
    }
    const stated = reason?.trim()
    if (!stated) {
      throw new Error(
        `this rotation needs a reason. The pause in front of you is ` +
          `${this.#pause ? `'${this.#pause.reason}'` : 'absent'}, not a rotation candidate about ` +
          `${this.#control.rotationTarget() ?? 'this seat'}, so nothing here says why the seat is ` +
          `being replaced -- and borrowing the pause's own words would record a rotation you ` +
          `chose as one the degradation proxy prompted. Pass one: rotateImplementer('why').`,
      )
    }
    return this.#control.rotate(stated)
  }

  /**
   * Would a bare `rotateImplementer()` here be recorded in words nobody chose? (#75)
   *
   * Exposed so a front end can ASK before it commits an operator to a transaction it would have
   * to abandon -- the console prompts on this, and never provokes the throw above. Both read the
   * same predicate against the same target, so the console cannot prompt for one seat while the
   * handle rotates another.
   *
   * `true` when the target seat cannot be named at all. That is a pause offering no rotation
   * subject, and it is the case where borrowing a detail is least defensible: there is not even
   * a seat to say the borrowed words were about.
   */
  rotationNeedsReason(): boolean {
    const target = this.#control.rotationTarget()
    return target === undefined || requiresStatedReason(this.#pause, target)
  }

  /**
   * Ask the run to pause at its next advisor-turn boundary.
   *
   * Not immediate, and cannot be: neither child CLI ingests input mid-turn (§5c), so the
   * earliest safe point is after the turn in flight ends. Returns the pause once it is
   * reached, or `undefined` if the run finished first.
   */
  async requestPause(reason = 'the operator asked to pause'): Promise<RunPause | undefined> {
    if (this.#state === 'ended') return undefined
    if (this.#state === 'paused') return this.#pause
    this.#control.requestPause(reason)
    return this.untilPause()
  }

  /**
   * Add a human constraint. Carried into the next exchange at human rank.
   *
   * Usable while paused *and* while running, because the case that motivated the whole
   * intervention-gap discussion is a human reacting to something mid-session.
   */
  injectConstraint(text: string, audience: Audience = 'all'): RelayMessage {
    if (this.#state === 'ended') throw new Error('the run has ended')
    return this.#control.constrain(text, audience)
  }

  /** End the run. Safe from either state. */
  async abort(detail = 'aborted by the operator'): Promise<RunOutcome> {
    if (this.#state === 'ended') return this.#outcome!
    this.#control.requestStop()
    if (this.#state === 'paused') this.#release({ kind: 'abort', detail })
    return this.result()
  }

  #release(d: Decision): void {
    if (this.#state !== 'paused' || !this.#decide) {
      throw new Error(`the run is '${this.#state}', not paused`)
    }
    const decide = this.#decide
    this.#decide = undefined
    this.#pause = undefined
    this.#state = 'running'
    // Before the loop is let go, so no part of the interval that follows can be charged to the
    // suspension. `abort` comes through here too and closes the ledger the same way.
    this.#resumeClock()
    decide(d)
  }

  // ---------------------------------------------------------------------------
  // Called by the relay's loop, not by the operator. TypeScript has no way to say
  // that, so it is said here instead.
  // ---------------------------------------------------------------------------

  /** Suspend the loop until the operator decides. */
  pauseAt(pause: Omit<RunPause, 'at'>): Promise<Decision> {
    const full = { ...pause, at: Date.now() }
    // The suspension starts HERE, at the same instant the state flips, and on the ledger's own
    // clock rather than on `full.at` -- the pause is a document with a wall-clock timestamp on
    // it, and the two only have to agree in production. Nothing between this line and the
    // `await` the caller does can run for long, but the interval is opened first anyway: the
    // reading that matters is taken by whoever asks while the run is parked.
    this.#suspendedSince = this.#now()
    // A later pause for the same turn inherits an unexpired wait decision so the operator
    // is not asked again until their stated deadline. Different turns or expired waits do not.
    if (full.verdictOf) {
      const stored = this.#waitMemory.get(this.#verdictKey(full.verdictOf))
      if (stored && stored.until > Date.now()) {
        full.waiting = stored
      }
    }
    this.#pause = full
    this.#state = 'paused'
    const watchers = this.#watchers
    this.#watchers = []
    for (const w of watchers) w(this.#pause)

    // Nobody is waiting for pauses, but somebody is waiting for the end. That wait cannot
    // now be satisfied: the run will not advance until an operator decides, and a caller
    // holding only `result()` has shown it is not going to. Fail it here, where the reason
    // is known, rather than leaving it to whatever timeout notices much later and
    // attributes the stall to an agent.
    if (watchers.length === 0 && this.#settled.length > 0) {
      const waiting = this.#settled
      this.#settled = []
      const err = new Error(
        `the run paused (${pause.reason}: ${pause.detail}) and nothing is waiting for pauses. ` +
          `await settled() to handle pauses and the end together, or untilPause() before result().`,
      )
      for (const s of waiting) s.reject(err)
    }

    return new Promise<Decision>((resolve) => {
      this.#decide = resolve
    })
  }

  /**
   * Record that the verdict this pause was raised on has been withdrawn.
   *
   * MUTATES the pause in place rather than replacing it. Everyone who is ever going to hear
   * about this pause already holds the object — `untilPause()` resolved with it before the
   * revision existed, and there is no second resolution to give them — so a fresh object
   * would be an amendment nobody receives.
   *
   * Returns false when there is nothing to amend, which is the ordinary race and not an
   * error: the operator decided while the revision was in flight.
   */
  /**
   * Keep waiting, without deciding and without sending anything.
   *
   * Returns false when there is no pause to wait on, so a caller cannot record a decision
   * about nothing. Deliberately does NOT resolve `#decide`: the run stays paused, which is
   * the whole point -- this is a decision to defer, not a decision.
   */
  wait(info: PauseWait): boolean {
    if (this.#state !== 'paused' || !this.#pause) return false
    this.#pause.waiting = info
    if (this.#pause.verdictOf) {
      this.#waitMemory.set(this.#verdictKey(this.#pause.verdictOf), info)
    }
    return true
  }

  supersede(info: PauseSupersession): boolean {
    if (this.#state !== 'paused' || !this.#pause) return false
    this.#pause.superseded = info
    // MUTATES the current pause in place, preserving the existing contract. The stored wait
    // decision is also kept keyed by `verdictOf`, so a later distinct pause for the same turn
    // can carry it forward.
    //
    // A `completed` replacement means the turn ended, so the wait is no longer about this turn.
    // Another `timed_out` is the only case where the turn is still running; an unexpired wait
    // carries across, but one that has lapsed is not a decision any more. Any other terminal
    // outcome also ends the turn, so the wait is cleared.
    if (this.#pause.verdictOf && info.verdict) {
      const key = this.#verdictKey(this.#pause.verdictOf)
      if (info.verdict.outcome === 'timed_out') {
        if (this.#pause.waiting && this.#pause.waiting.until <= Date.now()) {
          this.#pause.waiting = undefined
          this.#waitMemory.delete(key)
        }
      } else {
        this.#pause.waiting = undefined
        this.#waitMemory.delete(key)
      }
    }
    return true
  }

  /** Record the terminal outcome and wake everyone waiting on anything. */
  settle(outcome: RunOutcome): void {
    if (this.#outcome) return
    this.#outcome = outcome
    this.#state = 'ended'
    // The fourth exit, and the one a ledger kept at the halt site would have missed:
    // `relay.stop()` ends a run WITHOUT resolving the pause it is sitting in, so `#halt` never
    // returns and never closes anything. Left open, the total would grow for as long as the
    // object lived and a report read afterwards would claim a suspension still running.
    this.#resumeClock()
    this.#pause = undefined
    this.#waitMemory.clear()
    const watchers = this.#watchers
    this.#watchers = []
    for (const w of watchers) w(undefined)
    const settled = this.#settled
    this.#settled = []
    for (const s of settled) s.resolve(outcome)
  }
}
