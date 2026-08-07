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
   * When this turn last showed any sign of life, by the same clock.
   *
   * Maintained by the adapter through `touch()`. Absent on a target that predates the idle
   * deadline, in which case only the absolute one applies.
   */
  lastActivityAt?: number
  tracker: TurnVerdictTracker
}

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
 * Forty-five minutes still bounds a genuinely hung turn -- which is all this is for -- and
 * stops manufacturing pauses out of ordinary work. Override with `--turn-timeout <seconds>`.
 */
/**
 * How often to tail the transcript while a turn is running.
 *
 * Fast enough that narration feels live, slow enough that a long turn does not spend its
 * time re-reading a file. The tail is incremental — it reads from the last byte offset —
 * so the cost is a stat plus whatever was appended.
 */
export const TAIL_INTERVAL_MS = 400

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
   * Record that the turn showed a sign of life, and push the idle deadline out.
   *
   * Cheap on purpose: adapters call this from their event path, which is hot. It does no
   * work beyond a timestamp and a timer reset, and it never extends the ABSOLUTE deadline --
   * a turn that keeps talking forever is still bounded.
   */
  touch(key: string): void {
    const target = this.#targets.get(key)
    if (!target || !this.#timers.has(key)) return
    target.lastActivityAt = Date.now()
    this.disarm(key)
    this.#targets.set(key, target)
    this.#armIn(key, target, this.#nextDelay(target))
  }

  /**
   * Whichever deadline comes first: silence, or the absolute cap.
   *
   * Both are kept. The idle deadline is the useful one, and the absolute one still bounds a
   * turn that emits a heartbeat forever without ever finishing.
   */
  #nextDelay(target: T): number {
    const now = Date.now()
    const absolute = this.#ms - (now - target.startedAt)
    const idle =
      target.lastActivityAt === undefined
        ? Number.POSITIVE_INFINITY
        : this.#idleMs - (now - target.lastActivityAt)
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

  disarmAll(): void {
    for (const key of [...this.#timers.keys()]) this.disarm(key)
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
    const idleMs = target.lastActivityAt === undefined ? undefined : now - target.lastActivityAt

    // Which deadline has ACTUALLY passed, checked before either is acted on.
    //
    // A timer may fire a hair before its delay. An earlier version tested the idle deadline
    // first and, when it had not quite passed, fell through to the absolute branch -- which
    // re-armed for the whole remaining absolute budget and therefore SKIPPED the idle
    // deadline for the rest of the turn. That is the same silent-never-fires-again failure
    // this module's header describes, reintroduced by the fix for it, and it reproduced only
    // on Linux where timers ran early.
    const idlePassed = idleMs !== undefined && idleMs >= this.#idleMs
    const absolutePassed = elapsedMs > this.#ms

    if (!idlePassed && !absolutePassed) {
      // Fired early against BOTH. Wait out whichever remains nearer, rather than reporting a
      // duration that has not yet passed or abandoning the nearer clock.
      this.#armIn(key, target, Math.max(1, this.#nextDelay(target)))
      return
    }

    if (idlePassed) {
      this.#onUpdate(target, target.tracker.observeIdle(idleMs! / 1000))
      return
    }

    // Real measured duration, not the nominal deadline: the provenance string quotes this
    // number, and a turn whose watchdog was delayed should say how long it actually ran.
    this.#onUpdate(target, target.tracker.observeElapsed(elapsedMs / 1000))
  }
}
