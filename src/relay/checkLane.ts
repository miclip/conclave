/**
 * One lane per run for the commands that measure a tree.
 *
 * Two stations run the operator's configured checks, and they are the same commands against
 * different trees asking different questions: `rotation/rotate.ts` asks whether a replacement
 * reproduces what the original did, and `integrate.ts` asks whether the tree the seats built
 * together works (#80). Both were designed without reference to each other, and at N>1 both
 * want the machine at once.
 *
 * ## Why a lane rather than nothing
 *
 * D7's argument is contention: `npm test` in four worktrees at once is four test runners, four
 * `node_modules` resolutions and direct collision for anything binding a port. This project
 * already learned it about its own suite -- `--test-concurrency=4` in `package.json`, and the
 * note in `session.tty.test.ts` recording that raising a timeout was the wrong fix for
 * contention and capping concurrency was the right one.
 *
 * There is a second reason, and it is the stronger one because it is about correctness rather
 * than speed. A rotation's verification window is not an instant: `rotate()` captures the
 * repository, starts a replacement, spends a full agent turn on acceptance, and captures the
 * repository AGAIN -- then rolls the whole transfer back as `repository_diverged` if the two
 * captures disagree. A merge landing inside that window changes the tree under it, and
 * `integrateSeat` does exactly that: it merges into the integration checkout and then
 * `reset --hard`s the seat worktrees onto the new HEAD. A perfectly good rotation would be
 * rolled back because a different seat's work merged while it was proving itself, and the
 * recorded reason would name the repository rather than the race. So the lane is held across
 * the WHOLE window, not around each `spawnSync`.
 *
 * The cost is stated rather than hidden: a rotation holds the lane for as long as its
 * replacement takes to answer, and other seats' merge boundaries wait behind it. That is the
 * intended trade -- a boundary that waits is late, and a rotation rolled back by a race is
 * work thrown away.
 *
 * ## What this cannot do, today
 *
 * Both runners are `spawnSync` -- `runCheck` in `src/rotation/record.ts` and
 * `runIntegrationChecks` in `src/relay/integrate.ts` -- in the one orchestrator process, and
 * cited by symbol because a line number here would rot the first time either moves. Two check
 * commands therefore cannot overlap in wall-clock time however
 * many slots this lane hands out, so `--check-concurrency` above 1 is a statement of policy
 * that nothing can act on until those runners become asynchronous. It is wired anyway, because
 * the alternative is a flag that appears at the same moment as the code that would need it and
 * is therefore untested when it matters.
 *
 * ## Waiting is not blocking
 *
 * A seat waiting for the lane is `assigned` -- it holds its task, its work is intact, and
 * nothing about it is a question for a human. `merge_blocked` means git refused a merge and
 * `failed` means a boundary did not complete; a queue position is neither, and recording it as
 * either would put a seat in front of an operator to answer a question that answers itself in
 * a few seconds. This module therefore changes no scheduler state at all: it hands out slots
 * and gets out of the way, and `onWait` exists so the wait is VISIBLE without being a verdict.
 *
 *   node --test src/relay/checkLane.test.ts
 */

/** Which station wants the lane. Diagnostics, and the reentrancy message. */
export type CheckStation = 'rotation' | 'integration'

/** Who is asking, and what for. */
export interface LaneClaim {
  /** The seat whose work is being measured. */
  seat: string
  station: CheckStation
  /** A task id, or a rotation reason. Carried into the record; never read for a decision. */
  detail?: string | undefined
}

/** One completed section, as it actually ran. */
export interface LaneRecord extends LaneClaim {
  /** Milliseconds spent queued. `0` when the lane was free, which is every default run. */
  waitedMs: number
  /** Milliseconds the section held its slot. */
  heldMs: number
}

export interface CheckLaneOptions {
  /**
   * How many check sections may hold the lane at once. Default 1, which is D7's ruling.
   *
   * `--check-concurrency` is the escape for suites known to be isolated. It is an integer
   * because half a slot is not a thing, and it is refused rather than clamped: a run told to
   * use `0` was told something its operator meant, and guessing which thing is worse than
   * saying the value is not one.
   */
  concurrency?: number | undefined
  /**
   * Called when a claim is about to queue, with the claims already holding.
   *
   * Only when it actually waits. A run whose lane is never contended -- every default run, and
   * every run at N=1 -- produces no notes at all, so this cannot change what an existing
   * operator reads.
   */
  onWait?: ((claim: LaneClaim, holders: readonly LaneClaim[]) => void) | undefined
  /** Injectable clock, so a test can assert on waits without sleeping through them. */
  now?: (() => number) | undefined
}

/** A queued claim and the resolver that admits it. */
interface Waiter {
  claim: LaneClaim
  admit: () => void
}

export class CheckLane {
  readonly concurrency: number
  readonly #now: () => number
  readonly #onWait: ((claim: LaneClaim, holders: readonly LaneClaim[]) => void) | undefined
  /** Live sections. Identity is the internal copy, never the caller's object. */
  readonly #holders = new Set<LaneClaim>()
  /** FIFO. A lane that admitted out of order would starve the seat that asked first. */
  readonly #queue: Waiter[] = []
  readonly #history: LaneRecord[] = []

  constructor(opts: CheckLaneOptions = {}) {
    const concurrency = opts.concurrency ?? 1
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(
        `check concurrency must be a whole number of slots, at least 1; got ${String(concurrency)}`,
      )
    }
    this.concurrency = concurrency
    this.#now = opts.now ?? (() => Date.now())
    this.#onWait = opts.onWait
  }

  /** The sections running right now. */
  held(): readonly LaneClaim[] {
    return [...this.#holders].map((c) => ({ ...c }))
  }

  /** The sections waiting, in the order they will be admitted. */
  queued(): readonly LaneClaim[] {
    return this.#queue.map((w) => ({ ...w.claim }))
  }

  /**
   * Every section that has finished, in completion order.
   *
   * One record per merge boundary and per rotation, so it is bounded by the run's task count
   * rather than by time. It exists because "the lane was never contended" and "the lane was
   * never reached" are the same log otherwise, which is the failure `rotationWatch` was built
   * to stop being possible for rotation.
   */
  history(): readonly LaneRecord[] {
    return this.#history.map((r) => ({ ...r }))
  }

  /**
   * Run one check section with the lane held.
   *
   * The section may be synchronous -- both of today's runners are -- and is awaited either
   * way, so a caller cannot accidentally release the lane before its checks have finished by
   * forgetting to return a promise.
   *
   * The slot is released in a `finally`, so a section that throws does not strand the lane. A
   * check that fails is an ordinary answer and a check that explodes is a fault, and neither
   * is a reason for every later boundary in the run to wait forever.
   *
   * ## Double-queuing is refused rather than deadlocked
   *
   * Each station acquires ONCE, at its outermost point: `#crossBoundary` wraps the whole
   * boundary including the checks `integrateSeat` runs for itself, and `rotateImplementer`
   * wraps the whole of `rotate()`. Neither reaches into the other. If a future caller nests
   * them, a lane of one slot would deadlock permanently and silently -- a run that stops with
   * no error and no ending -- so a seat that already holds a slot is told so instead. A throw
   * from a station that has not begun is recoverable; a hang is not.
   */
  async run<T>(claim: LaneClaim, section: () => T | Promise<T>): Promise<T> {
    const already = [...this.#holders].find((h) => h.seat === claim.seat)
    if (already) {
      throw new Error(
        `${claim.seat} already holds the check lane for its ${already.station} section, so its ` +
          `${claim.station} section would wait for itself. Each station takes the lane once, at ` +
          `its outermost point; nesting them deadlocks a lane of one slot.`,
      )
    }
    // The caller's object is never the identity: two calls passing the same literal would
    // otherwise share a Set entry and the first release would free both.
    const hold: LaneClaim = { ...claim }
    const requestedAt = this.#now()

    if (this.#holders.size >= this.concurrency) {
      this.#onWait?.({ ...claim }, this.held())
      await new Promise<void>((resolve) => this.#queue.push({ claim: hold, admit: resolve }))
      // The slot was handed straight to this claim by `#release`, which already added it to
      // `#holders`. Re-adding here is what would let a claim arriving during the handover jump
      // the queue.
    } else {
      this.#holders.add(hold)
    }

    const startedAt = this.#now()
    try {
      return await section()
    } finally {
      this.#history.push({
        ...hold,
        waitedMs: startedAt - requestedAt,
        heldMs: this.#now() - startedAt,
      })
      this.#release(hold)
    }
  }

  /**
   * Hand the slot on, rather than free it and let anyone take it.
   *
   * The next waiter is put into `#holders` synchronously, before its promise resolves. A lane
   * that simply decremented would leave a window -- one microtask, but a real one -- in which
   * a claim arriving fresh sees a free slot and overtakes a section that has been queued since
   * before it existed.
   */
  #release(hold: LaneClaim): void {
    this.#holders.delete(hold)
    const next = this.#queue.shift()
    if (!next) return
    this.#holders.add(next.claim)
    next.admit()
  }
}
