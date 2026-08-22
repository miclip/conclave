/**
 * A single-flight job with a wall-clock bound, and a token that tells an over-running job that
 * nobody is listening any more.
 *
 * Extracted rather than duplicated: both pty adapters run the deadline's transcript re-check
 * through exactly this, the two copies had already been edited in lockstep twice, and the
 * property it enforces is one a reader has to be able to check in one place.
 *
 * ## What "bounded" can and cannot mean here
 *
 * It bounds how long a CALLER waits, and it bounds which of the job's effects are allowed to
 * reach the outside world. It does not bound the job. There is no cancellation: the filesystem
 * read the job is inside keeps running to completion, and the synchronous parsing and view
 * rebuilding that follow it keep the event loop to themselves for as long as they take.
 *
 * So the LATENCY bound is soft, and irreducibly so. A job that blocks for four seconds in one
 * synchronous stretch runs for four seconds; nothing here can interrupt it, and no caller of
 * this learns anything sooner than the timer that has been waiting behind the blocked loop.
 *
 * The OBSERVABILITY bound is not soft, and that is the one this class actually guarantees: once
 * control resumes, a result older than the bound is discarded rather than acted on.
 *
 * ## Why abandonment is read from a clock and not from the timer
 *
 * The two are not interchangeable, and assuming they were left a hole worth naming. Node drains
 * the microtask queue before it runs the timers phase, so after a long synchronous block the
 * job's own promise continuations -- the `await` resuming inside it, the `.then()` attached to
 * it -- all run BEFORE the overdue `setTimeout` callback gets a turn. A token whose `abandoned`
 * flag is written by that callback therefore still reads `false` at exactly the moment the job
 * inspects it, and the adapter goes on to act on a result the bound had already disowned. The
 * blocking parse is not a hypothetical here: it is the 57,493-record transcript.
 *
 * So `abandoned` is computed when READ, against a deadline captured at the start of the run. It
 * needs no turn of the loop to become true, which means it is already true the instant a
 * blocked job resumes. The timer is kept, and does a different job: releasing the callers who
 * are waiting and freeing the single-flight slot, neither of which a getter can do by itself.
 */

/** Handed to the job. Read it after every await, before doing anything anyone can see. */
export interface Abandonment {
  /**
   * The bound has expired. The job may still finish work already in flight -- including work
   * whose only effect is on state it owns privately -- but must not act on its result.
   *
   * A live reading, not a stored flag: see the note above on why a timer-written flag is
   * unsafe. Reading it twice either side of a slow synchronous stretch can legitimately give
   * two different answers, which is the point.
   */
  readonly abandoned: boolean
  /**
   * Resolves when this run is abandoned, and never otherwise.
   *
   * The getter above is the AUTHORITY on whether the job may act; this is how something the
   * job is merely WAITING ON gets told to stop holding it up. A queue cannot poll a getter,
   * and the difference matters: `TranscriptSessionView` hands a caller whose lease is spent back
   * only at its own lease, which is far longer than this bound, so without an announcement the
   * next attempt inherits the rest of a stranger's lease and blows its own bound before it
   * reaches the filesystem.
   *
   * Announced by the same timer that releases the callers, so it is subject to the same delay
   * a blocked loop imposes on any timer -- which is exactly why it is not the authority. It is
   * a liveness signal and nothing more. A run that finishes inside its bound never resolves
   * this, so anything attached to it must tolerate never being called, and must re-check that
   * what it wanted to do is still the right thing when it is.
   */
  readonly whenAbandoned: Promise<void>
}

export class BoundedSingleFlight {
  readonly #boundMs: number
  #inFlight: { done: Promise<void>; token: Abandonment } | undefined

  constructor(boundMs: number) {
    this.#boundMs = boundMs
  }

  /** True while a run is admitted and not yet finished or abandoned. Diagnostic. */
  get busy(): boolean {
    return this.#inFlight !== undefined
  }

  /**
   * Run `job`, or join the run already in flight.
   *
   * The bound belongs to the RUN, not to the caller: it starts when the run starts, and past it
   * the token reads abandoned -- immediately, from the clock, with no turn of the loop required.
   * The timer does the two things a getter cannot: it hands back every caller waiting on this
   * run, and it frees the single-flight slot. Releasing the slot at that moment is the point --
   * a later caller must be able to start a fresh attempt rather than attach to one that has
   * already been written off, which is what a completion-scoped slot did: one slow read
   * swallowed every retry behind it for as long as it ran.
   *
   * The consequence is that an abandoned run and its replacement are in flight together, so
   * whatever they both touch has to tolerate that. For the transcript re-check it does, and by
   * a stronger route than tolerance: a `TranscriptSessionView` has at most ONE filesystem
   * operation outstanding, and the replacement's read attaches to that one rather than starting
   * a rival. So the two runs cannot interleave over the transcript however they overlap.
   *
   * What the replacement does NOT get is a way past a read that is not answering. It attaches,
   * waits its own bound, and is very likely told it got no answer in its turn -- which is
   * honest: a retry that cannot outrun the thing it is retrying still reports the truth, which
   * is that the transcript is not answering in time. Freeing the slot remains worth doing, since
   * the bound is what lets this class report that on time rather than parking, and the same
   * mechanism is what lets `close()` and Codex's post-cancel wait come back at all. See
   * `TranscriptSessionView`'s `#inflight`.
   *
   * A job that rejects is treated as a run that produced no answer: the rejection is swallowed
   * here, because every caller of this is a path where "could not tell" must leave existing
   * evidence alone rather than propagate an error.
   */
  run(job: (token: Abandonment) => Promise<void>): Promise<void> {
    const existing = this.#inFlight
    if (existing) return existing.done

    // Captured once, and the authority on whether this run is still wanted. `released` is ORed
    // in so that the instant the timer hands the callers back and frees the slot, the token
    // agrees -- a timer firing a hair early must not leave a window where the slot is gone and
    // the job still believes it may act.
    const deadlineAt = Date.now() + this.#boundMs
    let released = false
    let announce!: () => void
    const whenAbandoned = new Promise<void>((resolve) => {
      announce = resolve
    })
    const token: Abandonment = {
      get abandoned(): boolean {
        return released || Date.now() >= deadlineAt
      },
      whenAbandoned,
    }
    let settle!: () => void
    const done = new Promise<void>((resolve) => {
      settle = resolve
    })

    // Only if this run still holds the slot: an abandoned run releases at its bound, a later run
    // takes the slot, and the abandoned one must not evict its successor when it finally lands.
    const release = (): void => {
      if (this.#inFlight?.token === token) this.#inFlight = undefined
    }

    const timer = setTimeout(() => {
      released = true
      release()
      settle()
      // Last, and after the slot is free: whatever this run is stuck behind hears about it
      // only now, and the point of telling it is that the NEXT run can get through.
      announce()
    }, this.#boundMs)
    timer.unref?.()

    this.#inFlight = { done, token }

    void job(token)
      .catch(() => undefined)
      .then(() => {
        clearTimeout(timer)
        release()
        settle()
      })

    return done
  }
}
