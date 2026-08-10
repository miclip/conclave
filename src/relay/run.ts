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
 * The loop suspends at the pause point holding everything it had — the round counter, the
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
import type { ChildLiveness } from '../outcomes/liveness.ts'
import type { RotationResult } from '../rotation/rotate.ts'
import type { ResolutionRequest } from './resolution.ts'

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
   * The operator asked to stop at the next round boundary.
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
 * A `/continue` refused because the child was still working.
 *
 * The run stays paused, so a watcher polling `state` sees no change. The refusal is the only
 * durable record that a decision was attempted and rejected, and it carries the measurement
 * so the reason is inspectable later rather than being a transient console line.
 */
export interface PauseContinueRefusal {
  at: number
  reason: string
  liveness: ChildLiveness
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
  constrain(text: string, audience: Audience): RelayMessage
  /** Ask the loop to stop at its next round boundary. */
  requestStop(): void
  /** Ask the loop to pause at its next round boundary. */
  requestPause(reason: string): void
}

export class RunHandle {
  #control: RunControl
  #state: RunState = 'running'
  #pause: RunPause | undefined
  #outcome: RunOutcome | undefined

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

  constructor(control: RunControl) {
    this.#control = control
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
   */
  async rotateImplementer(reason?: string): Promise<RotationResult> {
    if (this.#state !== 'paused') {
      throw new Error(`can only rotate from a paused run; this one is '${this.#state}'`)
    }
    return this.#control.rotate(reason ?? this.#pause?.detail ?? 'operator requested rotation')
  }

  /**
   * Ask the run to pause at its next round boundary.
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
    decide(d)
  }

  // ---------------------------------------------------------------------------
  // Called by the relay's loop, not by the operator. TypeScript has no way to say
  // that, so it is said here instead.
  // ---------------------------------------------------------------------------

  /** Suspend the loop until the operator decides. */
  pauseAt(pause: Omit<RunPause, 'at'>): Promise<Decision> {
    const full = { ...pause, at: Date.now() }
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
