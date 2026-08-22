/**
 * The clock behind the deadline rule.
 *
 * `classify()` has always had rule 7: past the watchdog with no Stop, the turn is
 * `timed_out`. Nothing ever fired it. `observeElapsed()` existed and had no caller, so a
 * hung turn stayed `in_progress` forever -- the one case the rule was written for.
 *
 * The reason the gap survived is worth stating, because it dictates the shape of the fix:
 * every other piece of evidence in this system arrives. A hook is delivered, a transcript
 * record is written, a process exits. The adapters are built entirely out of reactions to
 * arrivals, and a hang is defined by nothing arriving. So there is no signal to hang
 * `observeElapsed()` off, and folding it into the existing hook handlers -- the obvious
 * small fix -- would leave the bug exactly where it is: it would update elapsed time only
 * on turns that were demonstrably not hung.
 *
 * A deadline needs its own clock. This owns one timer per armed turn and nothing else.
 *
 * Two decisions worth knowing about:
 *
 *   it does not check `settled`   Firing on a turn that already has a verdict is safe and
 *                                deliberate: rule 7 is last in `classify()`, so any real
 *                                terminal evidence outranks the deadline and the tracker
 *                                returns no update. Guarding here would be this module
 *                                deciding what the tracker is for deciding.
 *   it re-arms on an early fire  Timers may fire a hair before their delay. Reporting an
 *                                elapsed time that has not actually passed the deadline
 *                                would classify as `in_progress` -- no update, and the
 *                                timer spent. The deadline would silently never fire
 *                                again, which is the bug this module exists to fix.
 *
 * Handles are unref'd. A 10-minute watchdog must not be the reason a process stays alive
 * for 10 minutes after its work is done.
 */

import type { TurnVerdictTracker, VerdictUpdate } from './tracker.ts'

export interface WatchdogTarget {
  /** When the turn began, by the same clock the deadline is measured against. */
  startedAt: number
  /**
   * When this turn last produced SUBSTANTIVE content, by the same clock.
   *
   * Maintained by the adapter through `touch()`, which it calls only for output that came
   * from the child. Absent until the child has spoken at all, in which case silence is
   * measured from `startedAt` -- a turn that never says a word is still measured by something,
   * and which clock measures it must not depend on the adapter having happened to touch it
   * once. Measured, not stopped: neither clock ends a turn. See `#nextDelay`.
   */
  lastActivityAt?: number
  tracker: TurnVerdictTracker
}

/**
 * How often to tail the transcript while a turn is running.
 *
 * Fast enough that narration feels live, slow enough that a long turn does not spend its
 * time re-reading a file. The tail is incremental — it reads from the last byte offset —
 * so the cost is a stat plus whatever was appended.
 */
export const TAIL_INTERVAL_MS = 400

/**
 * Default per-turn deadline.
 *
 * Was ten minutes, which is a probe budget rather than a work budget. A live session's
 * implementer edited two parsers, reconciliation, the detector and the relay, wrote two
 * test files and ran the full suite in one turn; the watchdog fired at 600s and declared
 * `timed_out (uncertain)` on a turn that then completed and was corrected by a
 * `late_signal` revision. The evidence model recovered, but the run had already paused and
 * asked a human to adjudicate a turn that was merely long.
 *
 * Forty-five minutes still bounds the wait a genuinely hung turn imposes on this run -- which
 * is all this is for; the turn itself it does not bound, and cannot -- and stops manufacturing
 * pauses out of ordinary work. Override with `--turn-timeout <seconds>`,
 * on either front-end. It is a default of THIS clock rather than of the system: the adapters
 * that run no absolute deadline unless asked never reach it, which is why the terminal record
 * reports each seat's resolved clocks instead of this number.
 *
 * It bounds the WHOLE turn, a busy one included -- and what it bounds is what this RUN waits
 * for, not the turn. Nothing here reaches the child: the deadline emits a `timed_out` verdict,
 * the relay stops awaiting that exchange, and the child goes on doing whatever it was doing.
 * The seat stays unsendable afterwards until something makes it sendable -- a cancellation,
 * terminal evidence in the transcript or a hook, or the process exiting.
 *
 * Retiring it at the child's first output was tried and reverted, and the released wait is why:
 * `--max-turns` and `--max-minutes` are checked at TURN BOUNDARIES and nowhere else
 * (`guardrails.breached`), and the relay reaches one only when it stops awaiting an exchange.
 * So a turn no clock will stop waiting for is a run no ceiling can end, and one child talking
 * forever takes the whole run with it. Forty-five minutes is the concession to the false
 * positive instead -- long enough that ordinary work does not reach it, and what it produces is
 * `timed_out (uncertain)`, which a `late_signal` revision supersedes if the turn does finish.
 */
export const DEFAULT_WATCHDOG_MS = 45 * 60 * 1000

/**
 * How long a turn may produce NOTHING before it is called hung.
 *
 * The absolute deadline answers "has this run too long", which is the wrong question. A turn
 * that edits five files and runs a suite is legitimately long and busy; a turn that received
 * a tool result and then said nothing is hung after a minute, and waiting another forty-four
 * tells you nothing you did not know at minute two.
 *
 * That is not hypothetical. On claude 2.1.224 an implementer took a tool result, produced no
 * further output and no `Stop`, and the session sat idle for ~44 minutes until the absolute
 * deadline fired (issue #36). Every second of that wait was information-free.
 *
 * Twelve minutes, because the thing being bounded is silence rather than work, and a
 * participant CAN be silent legitimately -- a long build, a slow test suite, a model
 * thinking. Twelve is comfortably past those and far short of forty-five.
 */
export const DEFAULT_IDLE_MS = 12 * 60 * 1000

export class TurnWatchdog<T extends WatchdogTarget> {
  readonly #ms: number
  readonly #idleMs: number
  readonly #onUpdate: (target: T, update: VerdictUpdate | undefined) => void
  readonly #timers = new Map<string, NodeJS.Timeout>()
  /** Retained so `touch()` can re-arm without the caller passing the target again. */
  readonly #targets = new Map<string, T>()

  constructor(
    ms: number,
    onUpdate: (target: T, update: VerdictUpdate | undefined) => void,
    idleMs: number = DEFAULT_IDLE_MS,
  ) {
    this.#ms = ms
    this.#idleMs = idleMs
    this.#onUpdate = onUpdate
  }

  /** Start the deadline for a turn. Re-arming a key replaces its pending timer. */
  arm(key: string, target: T): void {
    this.disarm(key)
    this.#targets.set(key, target)
    this.#armIn(key, target, this.#nextDelay(target))
  }

  /**
   * Record that the CHILD produced something, and push the SILENCE deadline out.
   *
   * That deadline only. Nothing here moves the absolute one, which is measured from
   * `startedAt` and refreshed by nothing -- so what the run WAITS for is bounded even on a turn
   * that keeps talking forever, and has to be, because the run's ceilings are only ever checked
   * between turns. Bounding the wait is not ending the turn; see `#nextDelay`.
   *
   * Callers must still reserve this for substantive child output -- `message`, `tool_use`,
   * `permission_requested`. It is not a liveness ping: anything an adapter can emit about
   * ITSELF (arming a clock, a revision, an error) or anything a stalled child still produces
   * (a repainted spinner, a keepalive byte, a poll that found nothing) would hold the silence
   * clock open on a turn that stopped working, and silence is the clock that catches a hang
   * in twelve minutes rather than forty-five.
   *
   * Cheap on purpose: adapters call this from their event path, which is hot. It does no work
   * beyond a timestamp and a timer reset.
   */
  touch(key: string): void {
    // Keyed, and unknown keys are a no-op. This was a blanket `touchAll()` for a while, because
    // adapters emit events keyed by whatever produced them and those keys do NOT agree: on
    // Claude Code the watchdog is armed under the hook's `prompt_id` while transcript-sourced
    // events carry `claude-transcript-turn-N`, so a keyed touch silently matched nothing and
    // every Claude turn was capped at the idle deadline however busy it was. The fix belonged
    // in the adapter rather than here: it knows which turn is live and which key it armed under,
    // and `send()` now refuses to open a second turn, so "the live turn" names exactly one.
    // Blanket-refreshing every armed turn was a guess that happened to be right.
    const target = this.#targets.get(key)
    if (!target || !this.#timers.has(key)) return
    target.lastActivityAt = Date.now()
    this.disarm(key)
    this.#targets.set(key, target)
    this.#armIn(key, target, this.#nextDelay(target))
  }

  /**
   * Whichever deadline comes first: silence, or the absolute cap. Both run all turn.
   *
   * Silence is the useful one, and the one nearly every hang meets first. It is measured from
   * `lastActivityAt ?? startedAt`, so a turn the child never spoke in is bounded by the twelve
   * minutes rather than the forty-five, and there is no state in which it has no base to
   * measure from.
   *
   * The absolute cap sits behind it, refreshed by nothing. Its job is not to judge whether a
   * busy turn has run too long -- at forty-five minutes it rarely gets the chance, and "has
   * this run long" does not distinguish working from hung. Its job is to guarantee this run
   * STOPS WAITING, which is a different claim and worth keeping separate from the obvious
   * misreading of it: what fires here produces a `timed_out` verdict and releases the exchange
   * the relay was awaiting. It does not end the turn, close the transport, force the child or
   * observe it stopping, and the seat is still unsendable one line later -- until a
   * cancellation, terminal transcript or hook evidence, or process exit says otherwise.
   *
   * A released wait is nevertheless the whole point: `--max-turns` and `--max-minutes` are
   * checked at turn boundaries and nowhere else (`guardrails.breached`), and the relay reaches
   * a boundary only by ceasing to await an exchange. So a turn that output can extend without
   * limit is a run whose ceilings can never fire. Retiring this clock at the child's first
   * output was tried, and it traded a false positive on one long turn for a run nothing could
   * stop -- the worse of the two, and the one an operator has no way to see coming.
   */
  #nextDelay(target: T): number {
    const now = Date.now()
    const absolute = this.#ms - (now - target.startedAt)
    const idle = this.#idleMs - (now - (target.lastActivityAt ?? target.startedAt))
    return Math.max(0, Math.min(absolute, idle))
  }

  disarm(key: string): void {
    const t = this.#timers.get(key)
    if (t) {
      clearTimeout(t)
      this.#timers.delete(key)
    }
  }

  /** Forget a turn entirely. `disarm` alone leaves the target retained for `touch`. */
  forget(key: string): void {
    this.disarm(key)
    this.#targets.delete(key)
  }

  /**
   * Teardown. Releases the retained targets as well as the timers.
   *
   * `disarm` deliberately keeps the target so `touch` can still re-arm a live turn, which
   * means something has to release them or every TurnState ever armed -- with its tracker,
   * provenance and assistant text -- is held for the whole session. A long interactive
   * session accumulates one per turn.
   */
  disarmAll(): void {
    for (const key of [...this.#timers.keys()]) this.disarm(key)
    this.#targets.clear()
  }

  /** Test and diagnostic access. */
  get armed(): number {
    return this.#timers.size
  }

  #armIn(key: string, target: T, delay: number): void {
    const timer = setTimeout(() => this.#fire(key, target), delay)
    timer.unref?.()
    this.#timers.set(key, timer)
  }

  #fire(key: string, target: T): void {
    this.#timers.delete(key)
    const now = Date.now()

    const elapsedMs = now - target.startedAt
    const idleMs = now - (target.lastActivityAt ?? target.startedAt)

    // Which deadline has ACTUALLY passed, checked before either is acted on.
    //
    // A timer may fire a hair before its delay. An earlier version tested the idle deadline
    // first and, when it had not quite passed, fell through to the absolute branch -- which
    // re-armed for the whole remaining absolute budget and therefore SKIPPED the idle
    // deadline for the rest of the turn. That is the same silent-never-fires-again failure
    // this module's header describes, reintroduced by the fix for it, and it reproduced only
    // on Linux where timers ran early.
    const idlePassed = idleMs >= this.#idleMs
    const absolutePassed = elapsedMs > this.#ms

    if (!idlePassed && !absolutePassed) {
      // Fired early against BOTH. Wait out whichever remains nearer, rather than reporting a
      // duration that has not yet passed or abandoning the nearer clock.
      this.#armIn(key, target, Math.max(1, this.#nextDelay(target)))
      return
    }

    // Silence first when BOTH have passed. A turn that stopped talking an hour ago and also
    // ran past its cap is diagnosed by the more specific finding: "no output for 720s" says
    // where it stopped, "3600s with no Stop" only says it was long.
    if (idlePassed) {
      this.#onUpdate(target, target.tracker.observeIdle(idleMs / 1000))
      return
    }

    // Real measured duration, not the nominal deadline: the provenance string quotes this
    // number, and a turn whose watchdog was delayed should say how long it actually ran.
    this.#onUpdate(target, target.tracker.observeElapsed(elapsedMs / 1000))
  }
}
