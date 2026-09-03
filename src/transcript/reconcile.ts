/**
 * The reconciliation loop:
 *
 *   read new records
 *     -> detect compaction boundary
 *     -> invalidate affected derived turns
 *     -> rebuild the canonical view from surviving history
 *     -> emit replacement events carrying provenance
 *
 * This is why `events()` and `snapshot()` are separate. `events()` is a live,
 * provisional stream that is allowed to be wrong and to say so afterwards.
 * `snapshot()` is rebuilt from whatever the transcript currently contains and is
 * always authoritative. Consumers use the first for responsiveness and reconcile
 * against the second after compaction, restart, or known delivery loss.
 *
 * A compaction is not an error and not a gap; it is the source of truth changing its
 * mind about the past. Anything derived from the old bytes is void.
 */

import type {
  AgentEvent,
  Guarantees,
  SessionSnapshot,
  TurnRecord,
} from '../contract/session.ts'
import type { Provenance } from '../contract/outcome.ts'
import { isTerminal } from '../contract/outcome.ts'
import { RewriteAwareTail, parseJsonLine, type ReadLease } from './tail.ts'
import { parserFor, type ParsedTranscript } from './parse.ts'

/**
 * A record's identity independent of how it was written down: key order normalised
 * recursively, so `{a:1,b:2}` and `{b:2,a:1}` compare equal. Whitespace never reaches here --
 * these are already-parsed objects.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val as Record<string, unknown>)
            .sort()
            .map((k) => [k, (val as Record<string, unknown>)[k]]),
        )
      : val,
  )
}

interface EmittedTurn {
  seqs: number[]
  textLength: number
  toolCount: number
  /** How many thinking blocks this turn has already been reported for (#198). */
  thinkingCount: number
  ended: boolean
}

/**
 * How long a caller waits on the view's read before it is told it got no answer, and the read
 * it.
 *
 * Not a latency target, and not the adapters' `DEADLINE_TRANSCRIPT_MS`. That one bounds how
 * long a CALLER waits for an answer, and is set on the timescale a slow filesystem legitimately
 * takes. This one bounds how long a single read may hold up every OTHER read on the view --
 * `poll()`, `snapshot()`, the deadline re-check, a cancellation waiting for `turn_aborted`, and
 * the close path -- so it has to sit far above any read that is merely slow.
 *
 * ## The measurement it is set against
 *
 * The largest transcript in evidence is 57,493 records and 128MB. Parsing the whole of it --
 * the rewrite path, where the prefix digest changed and every record is re-read and re-parsed
 * -- takes 517ms. A poll that finds the prefix intact takes 54-69ms, and that is the ordinary
 * case: it stats, digests and consumes only the appended suffix.
 *
 * Ten seconds is about nineteen times the worst of those, and short enough that a shutdown or a
 * cancellation waits it out instead of parking on it forever. The failure it exists for is not
 * slowness, it is a read that is never coming back.
 *
 * ## It is not a hard wall-clock guarantee, and cannot be
 *
 * A read that overruns is not interrupted here, because there is nothing at this layer able to
 * interrupt it. `RewriteAwareTail.poll` consults the lease for the last time immediately BEFORE
 * it commits its offset and prefix digest, and runs `#parseAll` after that commit -- and this
 * view then runs its own `#parse` over the accumulated records, also after the commit. Both are
 * synchronous. A parse that ran past ten seconds would hold the event loop for the whole of it,
 * so the lease's `setTimeout` could not fire, the queue could not advance, and the read would
 * commit and return after its nominal lease had passed.
 *
 * The ordering is deliberate and is not a defect to be fixed by moving the check: once the
 * offset has advanced, those records exist nowhere else, and abandoning the read at a later
 * checkpoint would lose them permanently rather than merely re-read them. See `#pollAdmitted`.
 *
 * So what the lease actually promises is what `BoundedSingleFlight` promises about its own
 * bound: not that the work stops, but that once control returns to the loop the CALLER is told
 * it got no answer. The read carries on and commits when it lands -- there is no second reader
 * for it to conflict with, and see `#inflight` for why that is the one thing the view will not
 * allow. The 19x margin above is why the overrun case is not expected to arise, not a claim
 * that it is impossible.
 */
export const READ_LEASE_MS = 10_000

/**
 * A caller that stopped waiting on the view's read before that read produced an answer.
 *
 * A rejection rather than an empty result, deliberately. Every caller of `poll()` and
 * `snapshot()` already has a path for "the transcript could not be read", and that path leaves
 * existing evidence alone rather than guessing. An empty poll or a stale snapshot would instead
 * be an ANSWER -- "nothing has changed", "here is the session" -- and this read is in no
 * position to make either claim: it does not know what it did not get to read.
 */
/**
 * A lease that also ANNOUNCES its expiry, so something merely WAITING on a read can stop
 * waiting instead of polling a getter it has no turn of the loop to consult.
 *
 * `adapters/boundedReconcile.ts`'s `Abandonment` satisfies this shape, which is the point: a
 * bounded caller's expiry has to reach the view, or it waits out the view's much longer lease
 * instead of its own and cannot free its single-flight slot on time.
 */
export interface AnnouncedReadLease extends ReadLease {
  /** Resolves when the caller's bound is spent. Never resolves if the caller finishes first. */
  readonly whenAbandoned: Promise<void>
}

/**
 * One caller attached to a view's read, and the means to stop it waiting.
 *
 * It has no way to affect the read itself, which is the point: see `#inflight`.
 */
interface Waiter {
  expire: () => void
}

/** The single filesystem operation a view may have outstanding. */
interface InflightRead {
  done: Promise<void>
}

export class TranscriptReadAbandoned extends Error {
  constructor(afterMs: number) {
    super(`transcript read abandoned after ${afterMs}ms without answering; this caller stopped waiting`)
    this.name = 'TranscriptReadAbandoned'
  }
}

export interface SessionViewOptions {
  path: string
  agent: string
  sessionId: string
  cwd: string
  guarantees: Guarantees
  /** Overrides `READ_LEASE_MS` for this view. */
  readLeaseMs?: number
}

export class TranscriptSessionView {
  readonly #tail: RewriteAwareTail<Record<string, any>>
  readonly #parse: (r: Record<string, any>[]) => ParsedTranscript
  readonly #opts: SessionViewOptions

  #records: Record<string, any>[] = []
  #view: ParsedTranscript = { turns: [], declaredCompaction: false, compactions: 0 }
  #emitted = new Map<string, EmittedTurn>()
  #seq = 0
  #compactionGeneration = 0
  /**
   * Compaction markers already counted, so an append is not re-counted every poll.
   *
   * The generation used to increment ONLY when the tail reported a rewritten prefix. Claude
   * Code does not rewrite: it APPENDS `compact_file_reference` attachments and leaves the
   * history in place -- verified against a real 57,493-line transcript with five markers at
   * lines 2194 through 12184 and records intact either side.
   *
   * So on Claude Code the counter could never move, and it never did: 34 assessments across
   * four live oath-lang runs, peak generation pinned at exactly 0. Every negative result from
   * the degradation experiment was unfalsifiable, because a true null and an instrument that
   * cannot fire are indistinguishable from outside.
   *
   * "Does not rewrite" is about the MARKER, and is narrower than it reads: Claude Code
   * transcripts do get their prefix rewritten (#122), just never as the way a compaction is
   * recorded. See `#rewriteGeneration`.
   */
  #countedCompactions = 0
  /**
   * Prefix rewrites with no compaction marker behind them, counted separately and read by
   * nobody who rotates.
   *
   * These are not compactions. Across four runs, 13 child transcripts carried zero
   * `compact_file_reference` attachments and zero boundary records while the generation
   * counter reported nine compactions (#122). What those transcripts did carry was ordinary
   * activity -- hook results, reminders, tool-listing deltas.
   *
   * Their FINAL state kept every UUID-bearing record, in order, with no duplicates. That is
   * an end-state check and no more: it cannot say what the file looked like between two
   * polls, so it rules out permanent loss and not mutation in flight. `#reserialized` is what
   * decides that question, and it decides it per poll on the records themselves.
   *
   * What rewrote the prefix is not established, and cannot be recovered from those
   * transcripts: a final state cannot say which earlier bytes moved, so reserialization,
   * mutation, deletion and reordering are all still on the table for the historical nine.
   * All that is known is that something changed bytes we had already consumed.
   *
   * Ordinary activity is not the cause. A live capture of this project's own session grew
   * 485,646 -> 659,600 bytes across a turn with an unchanged prefix hash -- append-only, and
   * an append cannot move a digest that covers only the bytes before it.
   *
   * Future occurrences do not need the history: `#reserialized` classifies each one from the
   * records at the moment it happens. This counter records what is left after that -- a real
   * change to consumed records -- and a revision is still emitted for it, because whatever we
   * derived from those records may now be false. What changed is that it no longer claims the
   * participant lost context.
   */
  #rewriteGeneration = 0
  #builtAt = 0
  /**
   * When a read last came back with an answer -- any answer, including "nothing was appended".
   *
   * Distinct from `#builtAt`, which moves only when records are actually applied. A view over a
   * transcript the child has not written to yet reads successfully every time and never builds,
   * so `#builtAt` stays 0 while the view is nonetheless in a position to say what the transcript
   * contains. `lastBuilt()` needs the second fact, not the first: "have we ever read this file"
   * is what decides whether an empty projection is evidence or a guess.
   */
  #lastReadAt = 0
  /**
   * Reads that were handed back to their caller as `TranscriptReadAbandoned`. Diagnostic.
   *
   * Counted once per caller that is told it got no answer, at the single point where it is --
   * not at each of the three places the rejection can originate, which correspond to the same
   * read reaching the same conclusion at different moments.
   */
  #abandonedReads = 0

  readonly #leaseMs: number

  constructor(opts: SessionViewOptions) {
    this.#opts = opts
    this.#tail = new RewriteAwareTail(opts.path, parseJsonLine)
    this.#parse = parserFor(opts.agent)
    this.#leaseMs = opts.readLeaseMs ?? READ_LEASE_MS
  }

  get compactionGeneration(): number {
    return this.#compactionGeneration
  }

  /** Unexplained rewrites. Diagnostic: see `#rewriteGeneration`. */
  get rewriteGeneration(): number {
    return this.#rewriteGeneration
  }

  /** Reads abandoned so far. Diagnostic: see `#abandonedReads`. */
  get abandonedReads(): number {
    return this.#abandonedReads
  }

  /**
   * This view has a read outstanding that it has already given up on, and cannot start another.
   *
   * Not a diagnostic: it is the answer to "is there any point waiting". Every read asked for
   * while this is true is refused on arrival, and will go on being refused until the operation
   * in flight returns -- which nothing here can hurry, cancel, or predict. A caller polling for
   * evidence on a budget can read this and stop, instead of spending the rest of that budget
   * asking an instrument that has said it cannot answer. Nothing is given up by stopping: the
   * records are unconsumed, and the next read that lands delivers them by the ordinary road.
   *
   * False whenever a read could be attempted, including while one is merely in flight and still
   * inside its lease. See `#stalled`.
   */
  get readsStalled(): boolean {
    return this.#stalled
  }

  /** When a read last answered, or 0 if none ever has. See `#lastReadAt`. */
  get lastReadAt(): number {
    return this.#lastReadAt
  }

  #next(): number {
    return ++this.#seq
  }

  /**
   * The one filesystem operation this view will ever have outstanding, or `undefined`.
   *
   * ## Why reads are serialised at all
   *
   * `#records`, `#view`, `#emitted` and `#seq` are mutated by the poll body AFTER the tail
   * returns, so two bodies interleaved duplicate or skip records: both consume the same range,
   * or one advances the offset while the other believes it has caught up. Serialising inside
   * the tail would not fix it -- the mutations are out here.
   *
   * ## Waiters and reads are different things, and only one of them can be given up on
   *
   * A read that never comes back used to be a permanent wedge on the whole view: `close()`
   * reconciles with no bound and parked forever, Codex's cancel wait never reached its second
   * iteration, and a bounded deadline re-check spent its bound queued rather than reading. So
   * callers must be able to stop waiting.
   *
   * What they must not be able to do is stop the READ, or start another. Nothing at this layer
   * can cancel a filesystem operation -- there is no `close(fd)` that unblocks a hung `read`,
   * and the promise the tail is sitting on is not interruptible. A queue that "advanced past"
   * its head therefore authorised a SECOND operation against the same file while the first was
   * still outstanding, once per lease interval, for as long as the condition lasted. A process
   * meeting an unresponsive filesystem must not answer by asking it for more.
   *
   * So there is exactly one operation, and callers ATTACH to it. An attached caller that runs
   * out of patience -- its own lease, or the bound it passed in -- is rejected and leaves. The
   * operation carries on untouched, because it was never the caller's to abandon, and the next
   * caller attaches to the same one rather than starting a rival.
   *
   * ## The operation always commits, and its events are never lost
   *
   * The old design had the abandoned read commit nothing, and it had to: its replacement was
   * already reading the same range, so a half-committed abandonment would either hand those
   * records to nobody or hand them to two readers. With no replacement there is no such race,
   * and throwing away a completed read would be pure waste -- the records would have to be read
   * again, by the very filesystem that has just proved slow.
   *
   * So it commits, whether or not anyone is still listening. What it produces goes to
   * `#undelivered`, and the next `poll()` drains it. That is what makes committing safe for a
   * caller that has gone: the offset advances exactly once, and the events those records
   * generated are handed to a reader rather than dropped on the floor with the caller.
   */
  #inflight: InflightRead | undefined

  /**
   * Events committed by a read and not yet handed to a `poll()` caller.
   *
   * `#emitFor` is a watermark: once it has produced an event for a turn it will not produce it
   * again, so an event that is computed and then dropped is gone for good. That used to happen
   * on two paths -- a read whose caller had been detached, and every `snapshot()`, which runs
   * the same body and discards what it returns. Both are now deposits here instead.
   *
   * Drained destructively by `poll()`, which is what keeps delivery exactly-once across any
   * number of readers: the first to ask takes them, and everybody else gets what arrived after.
   */
  #undelivered: AgentEvent[] = []

  /** Callers currently attached to `#inflight`. */
  #attached = new Set<Waiter>()

  /**
   * A caller has declared that nothing should wait on the read in flight.
   *
   * Set only by `abandonReads()` and cleared when the operation settles. While it holds, a new
   * caller is refused on arrival rather than attached: the point of the declaration is that
   * somebody could not afford to wait, and making the next caller discover that by waiting is
   * the wait it was called to avoid.
   *
   * A lease expiring does NOT set this. That caller ran out of patience; it did not learn
   * anything about the read that the next caller should be bound by, and the next caller may
   * well be more patient. This is the difference between "I gave up" and "give up".
   */
  #stalled = false

  /**
   * Stop anything from waiting on the read in flight.
   *
   * For `close()` on its way out and for Codex's cancel wait after the ESC. Both have no bound
   * of their own and neither can afford to sit behind a read that may never answer, so every
   * attached caller is rejected at once and arrivals are refused until the operation settles.
   *
   * What it does not do -- and the name used to promise -- is abandon the read. The operation
   * carries on, lands when it lands, and commits what it found: `close()` gains nothing by that
   * work being thrown away, and the records would only have to be read again. What it costs is
   * that a caller reading immediately afterwards is refused rather than served, which for
   * `close()` is a reconcile that does not happen when it collides with a read already in
   * flight, and for a caller that polls is one iteration.
   */
  abandonReads(): void {
    if (!this.#inflight) return
    this.#stalled = true
    for (const waiter of [...this.#attached]) waiter.expire()
  }

  /**
   * The shared operation: read, commit, and bank whatever events that produced.
   *
   * Started at most once at a time. Every caller that arrives while one is running gets the
   * same promise, so `RewriteAwareTail.poll` is entered once per operation however many callers
   * there are -- which is the whole invariant, and what the call-count tests measure.
   *
   * It never rejects for a caller's sake. A caller that stops waiting is rejected by its own
   * waiter; this promise settles only when the filesystem answers, and it is allowed to reject
   * only for the reasons a read genuinely fails -- an unreadable file, a parse that threw.
   */
  #read(): Promise<void> {
    const running = this.#inflight
    if (running) return running.done
    const op: InflightRead = { done: undefined as unknown as Promise<void> }
    op.done = (async () => {
      try {
        this.#undelivered.push(...(await this.#pollAdmitted()))
      } finally {
        this.#inflight = undefined
        // Cleared with the operation, not with the caller who declared it. Until it settles,
        // there is still nothing anyone can be given.
        this.#stalled = false
      }
    })()
    this.#inflight = op
    // Nobody may be attached when it settles, and an unhandled rejection takes the process down.
    op.done.catch(() => undefined)
    return op.done
  }

  /**
   * Wait for the shared operation, for as long as this caller is willing to.
   *
   * The lease is armed HERE, when the caller attaches, rather than when the operation started.
   * A caller that arrives nine seconds into somebody else's read has not itself waited nine
   * seconds, and is entitled to say how long it will give it; the read is not on trial.
   *
   * `until` is the caller's own bound, when it has one -- the adapters' deadline re-check
   * through `BoundedSingleFlight`. It rejects this caller when its bound is spent, which is what
   * frees its single-flight slot for the next attempt. It does not buy it a read: there is one
   * operation in flight and nothing here can hurry it.
   */
  async #attach(until?: AnnouncedReadLease): Promise<void> {
    if (this.#stalled) {
      this.#abandonedReads++
      throw new TranscriptReadAbandoned(this.#leaseMs)
    }

    let expire!: (reason: unknown) => void
    const expired = new Promise<never>((_resolve, reject) => {
      expire = reject
    })
    // When the read wins the race below this promise has no consumer at all.
    expired.catch(() => undefined)

    let done = false
    const waiter: Waiter = {
      expire: (): void => {
        if (done) return
        expire(new TranscriptReadAbandoned(this.#leaseMs))
      },
    }
    this.#attached.add(waiter)
    const lease = setTimeout(waiter.expire, this.#leaseMs)
    lease.unref?.()
    // The caller's own bound, when it has one. It reaches this waiter and stops there: what it
    // buys is the caller being told on time, which frees its single-flight slot for the next
    // attempt. It does not reach the read, and there is nothing useful it could do if it did.
    if (until) void until.whenAbandoned.then(waiter.expire)

    // Started AFTER the waiter is registered, so a synchronous `abandonReads()` from anywhere
    // this read reaches cannot leave a caller attached to nothing.
    const op = this.#read()

    try {
      await Promise.race([op, expired])
    } catch (err) {
      if (err instanceof TranscriptReadAbandoned) this.#abandonedReads++
      throw err
    } finally {
      done = true
      clearTimeout(lease)
      this.#attached.delete(waiter)
    }
  }

  /**
   * Take the events banked by whatever reads have committed, and leave none behind.
   *
   * Destructive, and that is the delivery guarantee: two `poll()` callers attached to the same
   * operation do not each get a copy of its events, because a record announced twice is a turn
   * the relay believes happened twice.
   */
  #drain(): AgentEvent[] {
    if (this.#undelivered.length === 0) return []
    const events = this.#undelivered
    this.#undelivered = []
    return events
  }

  /**
   * Read new records and say what changed.
   *
   * Shares the view's single read with every other caller -- see `#inflight`. `#pollAdmitted`
   * is the read itself and must never be called from outside `#read()`, which is what makes it
   * the only writer of the view's state.
   *
   * Rejects with `TranscriptReadAbandoned` if the read outlives its lease. That is a non-answer
   * and not an empty poll: callers must not read it as "nothing changed".
   */
  async poll(): Promise<AgentEvent[]> {
    // Deliver before reading. Events reach `#undelivered` because a read committed them while
    // the caller that would have taken them was already gone, and until they are handed to
    // somebody they exist nowhere else -- `#emitFor` is a watermark and will not produce them
    // again. Reading first puts that delivery behind a filesystem call that may not come back:
    // the events are safe, but nobody can get at them for as long as the wedge lasts, which for
    // an adapter emitting from `events()` is a turn that appears to have gone silent.
    //
    // What is skipped is one poll's worth of new records, on a view that already has records to
    // hand over. The next poll reads.
    const banked = this.#drain()
    if (banked.length > 0) return banked
    await this.#attach()
    return this.#drain()
  }

  /**
   * The read itself. Runs inside `#read()` and nowhere else, so it is the only writer of
   * `#records`, `#view`, `#emitted` and `#seq`, and there is never a second one to race.
   *
   * No lease is handed to the tail. The tail takes one so that a caller who might have a RIVAL
   * reader can bar a late read from committing -- see `RewriteAwareTail.poll` -- and this view
   * has no rivals to bar: it never starts a second read while the first is unresolved. A read
   * that overruns here is simply a slow read whose records nobody else has, and discarding them
   * would mean asking the same filesystem for them again.
   */
  async #pollAdmitted(): Promise<AgentEvent[]> {
    const res = await this.#tail.poll()
    // This read has an answer, whether or not that answer contains any records. Stamped before
    // the branches below so every one of them counts, including the `appended.length === 0`
    // early return, which is the ordinary case on a quiet transcript.
    //
    // There is no abandonment case to check. `res.abandoned` is the tail's answer to a lease it
    // was given, and this view gives it none: a read it cannot cancel is a read it should have
    // the value of.
    this.#lastReadAt = Date.now()
    const events: AgentEvent[] = []

    if (res.rewritten) {
      const all = res.all ?? []

      // A changed digest is a claim about BYTES. Before acting on it, ask the records: if
      // everything we already consumed is still there, unchanged and in the same order, then
      // the file was re-serialised and possibly appended to, and nothing we told anyone has
      // become false. Emitting a revision there withdraws evidence that is still good, and
      // withdrawal is not free -- it clears `#emitted`, so the whole history is re-emitted
      // and every consumer must reconcile against a snapshot for nothing.
      //
      // This is the guard that closes #122 at the seam rather than at the label. The counter
      // fix stops an unexplained rewrite being *called* a compaction; this stops the common
      // case being an event at all.
      const suffix = this.#reserialized(all)
      if (suffix) {
        this.#records = all
        this.#view = this.#parse(this.#records)
        this.#builtAt = Date.now()
        // Deliberately identical to the append path from here: `#emitted` is kept, so only
        // the suffix produces events, and a compaction marker arriving in that suffix counts
        // exactly as it would have without the reserialization.
        events.push(...this.#noteDeclaredCompactions())
        events.push(...this.#emitFor(this.#view.turns))
        return events
      }

      // Everything we said about the past may now be false. Withdraw it explicitly
      // rather than letting consumers hold contradicting state.
      const replaced = [...this.#emitted.values()].flatMap((e) => e.seqs)
      this.#records = all
      this.#view = this.#parse(this.#records)
      this.#emitted.clear()
      this.#builtAt = Date.now()

      // A rewrite is how the bytes changed; a compaction is what the transcript SAYS
      // happened. They coincide on Codex and almost never on Claude Code, so they are
      // counted apart. Markers already counted are not counted again -- the rewritten view
      // still contains them, and re-counting them on every rewrite is how a byte-level digest
      // turned into nine imaginary compactions (#122).
      const declared = this.#view.compactions
      const fresh = Math.max(0, declared - this.#countedCompactions)
      // Down as well as up: a rewrite that drops the prefix drops its markers with it, and
      // leaving the high-water mark behind would silently swallow the next real compaction.
      this.#countedCompactions = declared
      this.#compactionGeneration += fresh
      if (fresh === 0) this.#rewriteGeneration++

      const provenance: Provenance[] = [
        { source: 'transcript', detail: 'transcript prefix changed; history was rewritten' },
        fresh > 0
          ? { source: 'transcript', detail: 'transcript declares a compaction' }
          : {
              source: 'transcript',
              detail: 'rewrite detected by prefix digest; no compaction marker recognised',
              caveat: true,
            },
        fresh > 0
          ? { source: 'transcript', detail: `compaction generation ${this.#compactionGeneration}` }
          : {
              source: 'transcript',
              detail:
                `transcript rewrite ${this.#rewriteGeneration}; compaction generation ` +
                `unchanged at ${this.#compactionGeneration} -- a changed digest is not ` +
                `evidence that context was lost`,
            },
      ]

      events.push({
        type: 'revision',
        // Say what was seen. Naming an unexplained rewrite `compaction` is what made routine
        // churn look like a seat losing its context, all the way through to rotation.
        reason: fresh > 0 ? 'compaction' : 'rewrite',
        replaces: replaced,
        provenance,
        seq: this.#next(),
        at: this.#builtAt,
        provisional: false,
      })
      // Re-emit the surviving history so a consumer that only follows events() ends up
      // agreeing with snapshot() -- marked as REPLAY, because that is what it is.
      //
      // `#emitted` was just cleared, so this re-emits the whole transcript: every message and
      // every tool call the child has ever made, arriving in one burst, at whatever moment the
      // file happened to be rewritten. To a consumer reading the stream for signs of life that
      // is indistinguishable from a child that suddenly produced all of it, and two of them
      // read it that way -- the watchdog's silence clock and #82's launch diagnosis. A turn
      // stalled for ten minutes would have both cleared by a rewrite it had no part in.
      //
      // The flag is set HERE rather than filtered by the consumers because this is the only
      // place that knows: past this line an event carrying five-hour-old text is shaped
      // exactly like one carrying text written this second. Anything genuinely new in the same
      // poll is marked too -- it is inside the same rebuilt history and cannot be separated
      // from it -- which costs one tail interval of liveness credit on a turn that is
      // producing, and buys the guarantee in the direction that matters: a replay never
      // extends a deadline.
      events.push(...this.#emitFor(this.#view.turns, { replay: true }))
      return events
    }

    if (res.appended.length === 0) return events

    this.#records.push(...res.appended)
    this.#view = this.#parse(this.#records)
    this.#builtAt = Date.now()
    events.push(...this.#noteDeclaredCompactions())
    events.push(...this.#emitFor(this.#view.turns))
    return events
  }

  /**
   * The records we already consumed, still an ordered prefix of the reread file?
   *
   * Returns the appended suffix (possibly empty) when so, and `undefined` when any consumed
   * record was mutated, deleted or reordered -- which is a real rewrite and keeps the
   * revision path.
   *
   * Semantic, not textual, on purpose: the whole point is that the bytes changed. Two
   * serialisations of the same record differing only in whitespace or key order are the same
   * record, and the JSON we hold has already lost the whitespace, so key order is what
   * `canonicalJson` normalises.
   *
   * Cost is a full canonicalisation of both sides, paid only on a rewrite. On the largest
   * transcript in evidence -- 57,493 records -- that is one pass, against the alternative of
   * re-emitting 57,493 records' worth of history and calling it a compaction.
   */
  #reserialized(all: Record<string, any>[]): Record<string, any>[] | undefined {
    if (all.length < this.#records.length) return undefined
    for (let i = 0; i < this.#records.length; i++) {
      if (canonicalJson(this.#records[i]) !== canonicalJson(all[i])) return undefined
    }
    return all.slice(this.#records.length)
  }

  /**
   * Raise the generation for compactions the transcript DECLARES, however they were recorded.
   *
   * A DECLARED compaction is the same event from the participant's point of view however it
   * reached the file -- context was discarded -- and rotation is watching for that event, not
   * for a particular way of writing it down. Counting only rewrites made the trigger a
   * property of Codex's file format; counting every rewrite made it a property of Claude
   * Code's flushing behaviour (#122). The marker is the thing.
   *
   * No `replaces`: the history is still there, so nothing previously emitted is withdrawn.
   * That is the honest difference from the rewrite path, and it is why this is a separate
   * method rather than a flag on that one.
   */
  #noteDeclaredCompactions(): AgentEvent[] {
    const declared = this.#view?.compactions ?? 0
    if (declared <= this.#countedCompactions) return []
    const fresh = declared - this.#countedCompactions
    this.#countedCompactions = declared
    this.#compactionGeneration += fresh

    return [
      {
        type: 'revision',
        reason: 'compaction',
        replaces: [],
        provenance: [
          { source: 'transcript', detail: 'transcript declares a compaction' },
          {
            source: 'transcript',
            detail: `compaction generation ${this.#compactionGeneration}`,
          },
          {
            source: 'transcript',
            detail: 'history was appended to rather than rewritten, so nothing is withdrawn',
            caveat: true,
          },
        ],
        seq: this.#next(),
        at: this.#builtAt,
        provisional: false,
      },
    ]
  }

  /**
   * Diff the rebuilt view against what we have already told consumers.
   *
   * `replay` marks the output as history rather than news. It is the caller's to decide because
   * the difference is not visible from a turn record: the append path emits only what is new by
   * construction -- `#emitted` remembers how far each turn had been reported -- while the
   * rewrite path clears that memory first and therefore re-derives everything. See
   * `EventBase.replay`.
   */
  #emitFor(turns: TurnRecord[], opts: { replay?: boolean } = {}): AgentEvent[] {
    const out: AgentEvent[] = []
    for (const turn of turns) {
      const key = String(turn.key)
      let seen = this.#emitted.get(key)

      if (!seen) {
        seen = { seqs: [], textLength: 0, toolCount: 0, thinkingCount: 0, ended: false }
        this.#emitted.set(key, seen)
        const seq = this.#next()
        seen.seqs.push(seq)
        out.push({
          type: 'turn_start',
          prompt: turn.prompt,
          turnKey: turn.key,
          seq,
          at: this.#builtAt,
          provisional: true,
        })
      }

      for (let i = seen.toolCount; i < turn.toolCalls.length; i++) {
        const seq = this.#next()
        seen.seqs.push(seq)
        out.push({
          type: 'tool_use',
          tool: turn.toolCalls[i]!.tool,
          // The serialized input, not the parsed object: this is the only channel through
          // which a consumer watching events -- rather than polling snapshots -- can see
          // which files a participant touched.
          input: turn.toolCalls[i]!.args,
          failed: turn.toolCalls[i]!.failed,
          turnKey: turn.key,
          seq,
          at: this.#builtAt,
          provisional: true,
        })
      }
      seen.toolCount = turn.toolCalls.length

      // #198: one event per newly-seen thinking block, on the same seen-count diff every other
      // derivation here uses. Emitted BEFORE the text below for the same reason the tool loop is:
      // the child reasons and then speaks, and a stream that reports it the other way round
      // describes a turn that did not happen.
      const thinking = turn.thinkingCount ?? 0
      for (let i = seen.thinkingCount; i < thinking; i++) {
        const seq = this.#next()
        seen.seqs.push(seq)
        out.push({ type: 'thinking', turnKey: turn.key, seq, at: this.#builtAt, provisional: true })
      }
      seen.thinkingCount = thinking

      const text = turn.assistantText ?? ''
      if (text.length > seen.textLength) {
        const seq = this.#next()
        seen.seqs.push(seq)
        out.push({
          type: 'message',
          role: 'assistant',
          text: text.slice(seen.textLength),
          turnKey: turn.key,
          seq,
          at: this.#builtAt,
          provisional: true,
        })
        seen.textLength = text.length
      }

      if (!seen.ended && isTerminal(turn.state)) {
        seen.ended = true
        const seq = this.#next()
        seen.seqs.push(seq)
        out.push({
          type: 'turn_end',
          verdict: {
            outcome: turn.state,
            confidence: turn.confidence ?? 'inferred',
            provenance: turn.provenance ?? [
              { source: 'transcript', detail: 'derived from transcript state' },
            ],
          },
          // Nothing announced this to us; we concluded it by reading the file.
          synthesized: true,
          turnKey: turn.key,
          seq,
          at: this.#builtAt,
          provisional: true,
        })
      }
    }
    // Stamped in one place on the way out rather than at each of the four pushes above: the
    // property belongs to the CALL, not to any particular kind of event, and a fifth event
    // added below would otherwise have to remember.
    return opts.replay ? out.map((e) => ({ ...e, replay: true })) : out
  }

  /**
   * Canonical. Rebuilt from the transcript as it currently exists.
   *
   * Attaches to the view's single read, starting it if none is running, and projects what it
   * committed. Building is synchronous from the moment that read settles, so no other read can
   * advance `#view` in between and hand back a snapshot of a state that never existed -- and
   * there is no other read to do it, which is the stronger reason. See `#inflight`.
   *
   * Rejects with `TranscriptReadAbandoned` if this CALLER runs out of patience -- a non-answer,
   * not a stale snapshot. The read is untouched by that and carries on.
   *
   * `until` is the caller's own bound, when it has one, and it reaches the waiter and stops
   * there. A caller bounded at two seconds is then told at two seconds instead of waiting out
   * the view's ten-second lease, which is what frees its single-flight slot for the next
   * attempt. What it does not get is a read: there is one operation in flight and nothing here
   * can hurry it.
   */
  async snapshot(until?: AnnouncedReadLease): Promise<SessionSnapshot> {
    await this.#attach(until)
    return this.#buildSnapshot()
  }

  /**
   * The canonical snapshot, falling back to the last one this view was in a position to build.
   *
   * For the ORDINARY, unbounded consumers of a session -- the report, the seat record, the
   * relay's compaction checks, the record rotation takes at quiesce. Every one of them asks
   * "what does this session look like", none of them has a bound of its own, and none of them
   * has anywhere to go when the answer is a rejection: they are on paths where a throw either
   * strands a transaction (rotation, mid-quiesce) or takes down the thing that was supposed to
   * be observing (the report). A transcript that will not answer is a condition of the
   * INSTRUMENT, and it should not become a failure of the run being instrumented.
   *
   * What comes back instead is not a guess. `#view` is the last projection built from records
   * that were actually read, and the snapshot is stamped `builtAt` from that build rather than
   * from now, and flagged `containedFallback` -- so a consumer that cares how fresh this is can
   * still tell, one that must not treat an unverified number as evidence can tell too, and one
   * that only wants a description gets the truth as of the last time the file could be read.
   * Nothing is invented: no turn is added, no state is advanced, no compaction is counted.
   *
   * ## When there is nothing to fall back ON
   *
   * A view that has never completed a read has an empty `#view` for the same reason it has an
   * empty transcript -- it does not know -- so handing back "this session has no turns" is the
   * fabrication the rejection exists to prevent, and is never done. It WAITS instead, for as
   * long as it takes, on the read already running. `TranscriptReadAbandoned` never reaches a
   * caller of this method; a read that genuinely FAILED does, because that is an answer.
   *
   * Retrying is right here and wrong once a fallback exists, and what separates them is that a
   * fallback is an ANSWER. With one in hand, spending a whole lease to improve on something at
   * most one tail interval stale is not worth a report or a rotation standing still. With none,
   * there is nothing to weigh the wait against: the alternatives are a lifecycle exception
   * about somebody's lease, thrown at a consumer that only asked what the session looks like
   * and has no handler for it, or an invented empty session.
   *
   * ## What an unbounded retry does and does not cost
   *
   * It parks THIS caller for as long as the filesystem refuses to answer, which is precisely
   * what it did before the lease existed -- so nothing that worked before is made worse.
   *
   * What it must not do is spend the wait asking again. It holds on to the operation its own
   * attempt was waiting on and builds from what that operation commits, so the wait ends with
   * the read that was always going to end it and no second call is ever made. The count of
   * underlying operations across an arbitrarily long wedge is one, whether this method is
   * called once or in a loop.
   *
   * Nobody else is parked behind it either. `close()`, a cancellation and the bounded deadline
   * re-checks are all answered rather than queued -- immediately once the view is stalled, and
   * at their own bound before that. What they are not given is a read, because there is not one
   * to give: see `#reads`.
   *
   * The wait is not silent: `abandonedReads` climbs once per attempt, so a view being read in a
   * loop is visible from outside rather than looking like one very slow read.
   *
   * ## What still rejects, and must
   *
   * `snapshot(until)` is unchanged. A caller that passed a bound in -- the adapters' deadline
   * re-check through `BoundedSingleFlight` -- wants the rejection: it is what frees its slot so
   * the NEXT deadline can retry, and a stale snapshot there would be read as fresh evidence
   * about a turn that is being judged right now. Same for `poll()`, whose non-answer must never
   * be mistaken for "nothing changed". Containment is for the consumers who are describing a
   * session, not for the ones deciding a turn.
   */
  async snapshotOrLastBuilt(): Promise<SessionSnapshot> {
    for (;;) {
      try {
        return await this.snapshot()
      } catch (err) {
        // A read that FAILED is not a read that was given up on. An unreadable file, a parse
        // that threw -- those are answers of a kind, they are what they will be on the next
        // attempt too, and retrying them is a spin rather than a recovery.
        if (!(err instanceof TranscriptReadAbandoned)) throw err
        // Re-asked every time round rather than hoisted: a poll or another snapshot may have
        // landed while this attempt was queued, and if one did, this view now has something
        // authoritative to say and there is no reason to read again to find it out.
        const last = this.lastBuilt()
        if (last) return last

        // Nothing to fall back ON, so the only thing that can answer this caller is a read --
        // and there is already one running. Wait for THAT one.
        //
        // What expired is this caller's patience, not the operation: it is still going, it is
        // still the only one this view will have, and when it lands it commits. Looping back to
        // `snapshot()` here would have been correct only if the operation were gone; while it is
        // outstanding, `snapshot()` either attaches to it again (a second lease spent waiting on
        // the identical thing) or, on a view somebody has called `abandonReads()` on, is refused
        // outright and spins. Awaiting it and building from what it committed answers the caller
        // from the read that was always going to answer it, and costs no second call.
        const outstanding = this.#inflight
        if (outstanding) {
          // Not swallowed. This rejects only if the READ failed -- an unreadable file, a parse
          // that threw -- which is an answer of a kind and the same one the next attempt would
          // get. Catching it here would turn a broken transcript into an unbounded retry.
          await outstanding.done
          return this.#buildSnapshot()
        }

        // No fallback and no operation: the attempt was refused before one could start. A
        // macrotask, not a backoff -- that path settles on microtasks alone, so a loop with none
        // in it would starve the timers phase and hang the very leases and tailers that are
        // supposed to end this wait.
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
  }

  /**
   * The most recent authoritative projection, with no read at all, or `undefined` if this view
   * has never completed one.
   *
   * Not a cache of a previous `snapshot()` return: it is built from the same `#view` that
   * `snapshot()` projects, so it picks up anything a `poll()` has applied since. Safe to build
   * outside the read because it only READS `#view`, and the one writer of `#view` is inside the
   * view's single read operation and synchronous from the point it assigns.
   */
  lastBuilt(): SessionSnapshot | undefined {
    if (this.#lastReadAt === 0) return undefined
    // `#buildSnapshot()` stamps `Date.now()` when nothing has ever been parsed, which is right
    // for a read that just succeeded and wrong here: this snapshot is as of the last read that
    // answered, and saying otherwise would make a stale answer look current.
    //
    // `containedFallback` is stamped HERE rather than in `snapshotOrLastBuilt()` because it is
    // a property of this projection, not of the caller that asked for it: every way of getting
    // this object is a way of getting an answer no read confirmed, and a direct caller is owed
    // that fact as much as the fallback path is.
    return { ...this.#buildSnapshot(), builtAt: this.#builtAt || this.#lastReadAt, containedFallback: true }
  }

  /** The snapshot projection. Assumes the caller already holds the queue. */
  #buildSnapshot(): SessionSnapshot {
    return {
      sessionId: this.#opts.sessionId,
      agent: this.#opts.agent,
      cwd: this.#opts.cwd,
      turns: this.#view.turns.map((t) => ({ ...t, toolCalls: t.toolCalls.map((c) => ({ ...c })) })),
      guarantees: this.#opts.guarantees,
      compactionGeneration: this.#compactionGeneration,
      rewriteGeneration: this.#rewriteGeneration,
      builtAt: this.#builtAt || Date.now(),
    }
  }
}
