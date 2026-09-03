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
  /**
   * Subagents this turn has started and not yet been told finished, when the adapter counts
   * them at all (#214).
   *
   * STRUCTURAL, and deliberately not the adapter's class: `outcomes/` describing a type from
   * `adapters/` to read one number would be a dependency this direction has never had. Claude's
   * turn state satisfies it as it stands; Codex's has no subagent bookkeeping, so the field is
   * absent there and that seat behaves exactly as it did.
   *
   * What it is FOR is `#fire`. A delegating parent sits in a single tool call while another
   * model works and produces nothing the tailer can see -- `isChildOutput` already counts the
   * start and the stop, which pushes the silence deadline at each END of the delegation and
   * leaves the middle unmeasured. So what the silence clock actually times across a delegated
   * stretch is the SUBAGENT'S OWN DURATION, against a budget argued for builds and test suites.
   */
  subagents?: { readonly outstanding: number }
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
 * TRIPLED TO 135 MINUTES as an interim (#213), and the number is not the point. What this
 * clock catches is nothing: a turn cannot REACH it without having produced child output inside
 * every `DEFAULT_IDLE_MS` window, or the silence deadline would have fired first. So every turn
 * it ends is, by construction, one that was demonstrably working. It is not a hang detector --
 * `idleMs` is -- and its remaining job is the ceiling argument below.
 *
 * `/goal` sharpened this into a defect rather than an inefficiency (#204). An advisor can now
 * tell a seat not to stop until a condition holds, so a turn running long is a DESIGNED outcome
 * rather than a symptom; the first run to use it paused on this clock while the transport was
 * reporting three descendants working and output still arriving. Forty-five minutes was chosen
 * a month before that was possible.
 *
 * Widening is a stopgap, not the fix: it moves the point at which a healthy turn gets a wrong
 * verdict. The fix is to stop ending turns that are working -- either by letting activity
 * evidence veto the verdict, or by making ceilings checkable during a turn so this can default
 * to off. Override with `--turn-timeout <seconds>`, on either front-end. It is a default of THIS clock rather than of the system: the adapters
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
 * forever takes the whole run with it. That argument is why this constant still exists at all,
 * and it survives every objection above intact -- which is why the answer is #208 (ceilings
 * that can be evaluated mid-turn) rather than deleting this line. Until then the number is the
 * concession to the false positive, and what it produces is `timed_out (uncertain)`, which a
 * `late_signal` revision supersedes if the turn does finish.
 */
export const DEFAULT_WATCHDOG_MS = 135 * 60 * 1000

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

/**
 * Whether this turn has work delegated to a subagent that has not been seen to finish (#214).
 *
 * `false` for every target that does not count subagents, which is the honest answer rather
 * than a conservative one: a seat with no subagent bookkeeping has no evidence of delegation,
 * and inventing some would suspend a clock on a turn that might simply have stopped.
 */
function delegating(target: WatchdogTarget): boolean {
  return (target.subagents?.outstanding ?? 0) > 0
}

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
    // #214: no idle deadline to wake for while a subagent is outstanding. Waking anyway would
    // be harmless -- `#fire` refuses to report idle for the same reason -- but it would arm a
    // timer per idle budget for the length of the delegation, and the honest spelling of "this
    // clock does not apply right now" is not scheduling it.
    if (delegating(target)) return Math.max(0, absolute)
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
    // #214: SILENCE IS NOT EVIDENCE WHILE WORK IS DELEGATED. The turn holds positive proof that
    // something is running -- a subagent started and has not been seen to stop -- so quiet is
    // what a delegating parent looks like rather than what a hung one does.
    //
    // Re-armed on the absolute clock rather than falling through to it, because falling through
    // is the exact bug this function's own comment above describes: the absolute branch re-arms
    // for the whole remaining budget and the idle deadline is then skipped for the rest of the
    // turn. When the subagent stops, `subagent_stop` is child output, `touch()` sets
    // `lastActivityAt`, and silence begins timing again from the STOP.
    //
    // THE COST, because it is real and belongs here rather than in a commit message: a subagent
    // that hangs and never reports leaves the parent quiet with nothing to catch it but the
    // absolute deadline. That is deliberate. Today this clock kills legitimate delegation at
    // twelve minutes; after this it tolerates a hung one for as long as the absolute budget --
    // and it is why that budget must keep existing (#213).
    // `!absolutePassed` is load-bearing, not defensive. Re-arming on a remainder that has
    // already gone negative would schedule 1ms, fire, take this branch again and spin -- so a
    // delegating turn that has ALSO outrun the absolute cap falls through to `observeElapsed`
    // below, which is the correct diagnosis anyway: what caught it was the cap, not the quiet.
    if (idlePassed && !absolutePassed && delegating(target)) {
      this.#armIn(key, target, Math.max(1, this.#ms - elapsedMs))
      return
    }

    if (idlePassed && !delegating(target)) {
      this.#onUpdate(target, target.tracker.observeIdle(idleMs / 1000))
      return
    }

    // Real measured duration, not the nominal deadline: the provenance string quotes this
    // number, and a turn whose watchdog was delayed should say how long it actually ran.
    this.#onUpdate(target, target.tracker.observeElapsed(elapsedMs / 1000))
  }
}
