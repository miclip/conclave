/**
 * One lane per run for the commands that measure a tree. INERT TODAY, and kept on purpose.
 *
 * ## Read this before believing the lane does anything
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
 * one check running, and **serialisation is already guaranteed by the synchronous call rather
 * than by this or any other mutex**. There is no contention to prevent.
 *
 * It is narrower still than that. The two stations that run checks cannot even be live at the
 * same time: at N=1 there is no merge boundary, and at N>1 `rotateImplementer` refuses, so no
 * rotation runs. So this lane is never contended in any configuration the code can reach, no
 * seat can ever wait for it, and nothing an operator can observe changes because it exists.
 *
 * ## Why it is kept anyway
 *
 * The second station is per-seat rotation (#78). When it lands, `rotate()` will run in a seat's
 * own tree while other seats' boundaries merge into the integration checkout -- and the hazard
 * then is not CPU contention but correctness. A rotation's verification window is not an
 * instant: `rotate()` captures the repository, spends a full agent turn proving a replacement
 * against that capture, and captures AGAIN, rolling the transfer back as `repository_diverged`
 * if the two disagree. `integrateSeat` merges into the integration checkout and then
 * `reset --hard`s the seat worktrees onto the new HEAD, which is exactly the change those two
 * captures would read as divergence. A good rotation would be rolled back because someone
 * else's work merged while it was proving itself, and the recorded reason would name the
 * repository for what was a race.
 *
 * That is what this mutex is for, and it is the reason it is held across the WHOLE window
 * rather than around each `spawnSync`. It is retained now because a mechanism that is correct
 * and directly unit-tested is cheaper to keep than to rebuild, NOT because it is doing work
 * today. Nothing here should be read as behaviour #64 currently exercises.
 *
 * What is NOT here, deliberately: a slot count. One slot, fixed. A `--check-concurrency` flag
 * was built and removed on the operator's ruling -- a control that is accepted and plumbed and
 * cannot have any effect is worse than an absent one, because someone will set it and believe
 * something changed. Making the lane observable would mean building an asynchronous check
 * runner or a second station for it to serialise against, which is building the problem in
 * order to keep the solution; #78 is where that station comes from.
 *
 * ## Waiting would not be blocking
 *
 * If a wait ever becomes reachable, it is not a verdict about a seat: `merge_blocked` means git
 * refused a merge and `failed` means a boundary did not complete, and a queue position is
 * neither. This module therefore changes no scheduler state at all, and does not narrate
 * itself -- a seat cannot wait here yet, and logging for a state nothing constructs is the
 * same mistake as a flag for a control nobody has.
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
