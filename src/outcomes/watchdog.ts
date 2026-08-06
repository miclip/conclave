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
  tracker: TurnVerdictTracker
}

export class TurnWatchdog<T extends WatchdogTarget> {
  readonly #ms: number
  readonly #onUpdate: (target: T, update: VerdictUpdate | undefined) => void
  readonly #timers = new Map<string, NodeJS.Timeout>()

  constructor(ms: number, onUpdate: (target: T, update: VerdictUpdate | undefined) => void) {
    this.#ms = ms
    this.#onUpdate = onUpdate
  }

  /** Start the deadline for a turn. Re-arming a key replaces its pending timer. */
  arm(key: string, target: T): void {
    this.disarm(key)
    this.#armIn(key, target, Math.max(0, this.#ms - (Date.now() - target.startedAt)))
  }

  disarm(key: string): void {
    const t = this.#timers.get(key)
    if (t) {
      clearTimeout(t)
      this.#timers.delete(key)
    }
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

    const elapsedMs = Date.now() - target.startedAt
    if (elapsedMs <= this.#ms) {
      // Fired early. Wait out the remainder rather than report a duration that is not yet
      // past the deadline; see the header.
      this.#armIn(key, target, this.#ms - elapsedMs + 1)
      return
    }

    // Real measured duration, not the nominal deadline: the provenance string quotes this
    // number, and a turn whose watchdog was delayed should say how long it actually ran.
    this.#onUpdate(target, target.tracker.observeElapsed(elapsedMs / 1000))
  }
}
