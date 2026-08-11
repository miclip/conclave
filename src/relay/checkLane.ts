/**
 * One lane per run for the commands that measure a tree. The second station has now landed.
 *
 * ## What this is for, and what it is not for
 *
 * #64 asked for the configured checks to be serialised across seats behind a run-scoped mutex,
 * on the grounds that `npm test` in four worktrees at once means four test runners and direct
 * collision for anything binding a port. **That premise is false in this codebase**, and the
 * operator who filed it withdrew it rather than having it argued away.
 *
 * Both check runners are `spawnSync` -- `runCheck` in `src/rotation/record.ts` and
 * `runIntegrationChecks` in `src/relay/integrate.ts`, cited by symbol because a line number
 * here would rot the first time either moves -- in the one orchestrator process. A synchronous
 * spawn blocks the whole process for the duration of the command, so there is never more than
 * one check running, and **CPU serialisation is already guaranteed by the synchronous call
 * rather than by this or any other mutex**. That is not what this protects.
 *
 * What it protects is a WINDOW, and the hazard is correctness rather than contention. A
 * rotation's verification window is not an instant: `rotate()` captures the repository, spends
 * a full agent turn proving a replacement against that capture, and captures AGAIN, rolling the
 * transfer back as `repository_diverged` if the two disagree. `integrateSeat` merges into the
 * integration checkout and then `reset --hard`s the seat worktrees onto the new HEAD, which is
 * exactly the change those two captures would read as divergence. A good rotation rolled back
 * because someone else's work merged while it was proving itself would name the repository for
 * what was a race. That is why the lane is held across the whole window rather than around each
 * `spawnSync`.
 *
 * ## What changed with #78, stated narrowly
 *
 * This module used to say the lane was INERT, and it was: at N=1 there is no merge boundary, and
 * at N>1 rotation refused outright, so the two stations could not both exist in one run. Per-seat
 * rotation removes that -- `rotateSeat` runs the transaction in one seat's worktree at any N, so
 * a run that merges is now also a run that can rotate, and both stations reach this lane.
 *
 * Being live in the same run is not the same as being live at the same instant, and the
 * difference is worth writing down rather than glossing:
 *
 *   - The dispatcher processes ONE completion at a time. `#considerRotation` and
 *     `#crossBoundary` are awaited in that serial path, so a rotation the LOOP starts cannot
 *     overlap a boundary the loop starts. Between them the lane is uncontended and its
 *     `history()` simply records both stations passing through.
 *   - A rotation started from OUTSIDE the loop can overlap one: `Relay.rotateSeat` is public and
 *     does not require a paused run. That is the case a wait is reachable from. The console is
 *     not it -- `/rotate` refuses unless the run is already paused, and a paused loop is not
 *     merging anything.
 *
 * So the wait below is reachable rather than hypothetical, and it is still rare. It is narrated
 * for the reason it is rare: a rotation holds this across a full agent turn, so a boundary that
 * queues behind one waits minutes, and an unexplained gap in the log is the failure this project
 * keeps naming in its own diagnostics.
 *
 * What is NOT here, deliberately: a slot count. One slot, fixed. A `--check-concurrency` flag
 * was built and removed on the operator's ruling -- a control that is accepted and plumbed and
 * cannot have any effect is worse than an absent one, because someone will set it and believe
 * something changed. Nothing about #78 revives it: the reason to serialise is a shared tree, and
 * a second slot would be permission to race for it.
 *
 * ## Waiting is not blocking
 *
 * A queue position is not a verdict about a seat: `merge_blocked` means git refused a merge and
 * `failed` means a boundary did not complete. This module therefore still changes no scheduler
 * state -- a seat waiting here is `integrating`, which is exactly what it is doing, and D7's
 * "waiting seats are `assigned`" remains unbuilt because no seat waits before its work is
 * integrated. It reports the wait and decides nothing.
 *
 *   node --test src/relay/checkLane.test.ts
 */

/** Which station wants the lane. Diagnostics, and the already-held message. */
export type CheckStation = 'rotation' | 'integration'

/** Who is asking, and what for. */
export interface LaneClaim {
  /** The seat whose work is being measured. */
  seat: string
  station: CheckStation
  /** A task id, or a rotation reason. Carried into the record; never read for a decision. */
  detail?: string | undefined
}

export class CheckLane {
  /**
   * Told when a section actually waits, with the claim it waited behind.
   *
   * Optional, and silent by construction: nothing is emitted unless a section really queued, so
   * a run in which the lane is never contended produces exactly the log it produced before. That
   * is the condition under which reporting this is honest rather than decorative -- the note
   * describes an event, not a possibility.
   */
  onWait: ((waiting: LaneClaim, holder: LaneClaim) => void) | undefined

  /**
   * The live section, or none. One slot, so this is the whole of the lane's state.
   *
   * Identity is an internal copy of the caller's claim, never the caller's own object: two
   * calls passing the same literal would otherwise be indistinguishable here.
   */
  #holder: LaneClaim | undefined
  /** FIFO. A lane that admitted out of order would starve the section that asked first. */
  readonly #queue: { claim: LaneClaim; admit: () => void }[] = []
  readonly #history: LaneClaim[] = []

  /** The section running right now, if any. */
  held(): LaneClaim | undefined {
    return this.#holder ? { ...this.#holder } : undefined
  }

  /**
   * Every section that has finished, in completion order.
   *
   * One record per merge boundary and per rotation, so it is bounded by the run's task count
   * rather than by time. It exists because "the lane was never contended" and "the lane was
   * never reached" are the same log otherwise -- and because it is the only way to assert that
   * a station acquires ONCE, which is the property that would deadlock this lane if it broke.
   */
  history(): readonly LaneClaim[] {
    return this.#history.map((r) => ({ ...r }))
  }

  /**
   * Run one check section with the lane held.
   *
   * The section may be synchronous -- both of today's runners are -- and is awaited either way,
   * so a caller cannot release the lane before its checks have finished by forgetting to return
   * a promise.
   *
   * The slot is released in a `finally`, so a section that throws does not strand the lane. A
   * check that fails is an ordinary answer and a check that explodes is a fault, and neither is
   * a reason for every later boundary in the run to wait forever.
   *
   * ## Acquiring twice is refused rather than deadlocked
   *
   * Each station acquires ONCE, at its outermost point: `#crossBoundary` wraps the whole
   * boundary including the checks `integrateSeat` runs for itself, and `rotateImplementer`
   * wraps the whole of `rotate()`. Neither reaches into the other, which is why `integrate.ts`
   * and `rotate.ts` know nothing about this module. If a future caller nests them, a lane of
   * one slot would deadlock permanently and silently -- a run that stops with no error and no
   * ending -- so a seat that already holds the slot is told so instead. A throw from a station
   * that has not begun is recoverable; a hang is not.
   */
  async run<T>(claim: LaneClaim, section: () => T | Promise<T>): Promise<T> {
    if (this.#holder?.seat === claim.seat) {
      throw new Error(
        `${claim.seat} already holds the check lane for its ${this.#holder.station} section, so ` +
          `its ${claim.station} section would wait for itself. Each station takes the lane once, ` +
          `at its outermost point; nesting them deadlocks a lane of one slot.`,
      )
    }
    const hold: LaneClaim = { ...claim }

    if (this.#holder) {
      // Announced before the wait rather than after it. A note that arrives when the wait ENDS
      // is a note that arrives after the silence it was meant to explain.
      this.onWait?.({ ...hold }, { ...this.#holder })
      await new Promise<void>((resolve) => this.#queue.push({ claim: hold, admit: resolve }))
      // The slot was handed straight to this claim by `#release`, which already installed it.
      // Installing it here is what would let a claim arriving during the handover jump the
      // queue.
    } else {
      this.#holder = hold
    }

    try {
      return await section()
    } finally {
      this.#history.push(hold)
      this.#release()
    }
  }

  /**
   * Hand the slot on, rather than free it and let anyone take it.
   *
   * The next waiter is installed synchronously, before its promise resolves. A lane that simply
   * cleared the holder would leave a window -- one microtask, but a real one -- in which a claim
   * arriving fresh sees a free slot and overtakes a section queued since before it existed.
   */
  #release(): void {
    const next = this.#queue.shift()
    this.#holder = next?.claim
    next?.admit()
  }
}
