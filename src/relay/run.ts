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

import type { Audience, RelayMessage } from './message.ts'
import type { RunReason } from './observe.ts'
import type { RotationResult } from '../rotation/rotate.ts'

export type RunState = 'running' | 'paused' | 'ended'

export type PauseReason =
  /** Mechanical degradation observed. The proxy is measured; the human decides. */
  | 'rotation_candidate'
  /** The advisor asked for a human. */
  | 'advisor_escalated'
  /** A turn ended as something other than `completed`. */
  | 'turn_incomplete'

/** What the operator can do from here. Descriptive: the methods exist regardless. */
export type PauseOption = 'continue' | 'rotate' | 'constrain' | 'abort'

export interface RunPause {
  reason: PauseReason
  detail: string
  /**
   * Why the orchestrator believes what it believes, in the project's provenance idiom.
   * A pause the operator cannot interrogate is a pause they will dismiss by reflex.
   */
  evidence: string[]
  options: PauseOption[]
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
  #settled: ((o: RunOutcome) => void)[] = []

  constructor(control: RunControl) {
    this.#control = control
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

  /** The final outcome. Resolves once, whenever the run ends. */
  result(): Promise<RunOutcome> {
    if (this.#outcome) return Promise.resolve(this.#outcome)
    return new Promise((resolve) => this.#settled.push(resolve))
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
    this.#pause = { ...pause, at: Date.now() }
    this.#state = 'paused'
    const watchers = this.#watchers
    this.#watchers = []
    for (const w of watchers) w(this.#pause)
    return new Promise<Decision>((resolve) => {
      this.#decide = resolve
    })
  }

  /** Record the terminal outcome and wake everyone waiting on anything. */
  settle(outcome: RunOutcome): void {
    if (this.#outcome) return
    this.#outcome = outcome
    this.#state = 'ended'
    this.#pause = undefined
    const watchers = this.#watchers
    this.#watchers = []
    for (const w of watchers) w(undefined)
    const settled = this.#settled
    this.#settled = []
    for (const s of settled) s(outcome)
  }
}
