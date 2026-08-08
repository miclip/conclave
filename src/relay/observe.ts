/**
 * Watching a relay while it runs.
 *
 * The routing log is the complete account of a session, but it is only complete once the
 * session is over, and `onLog` — a single callback fixed at construction — cannot serve a
 * consumer that attaches later or a second consumer alongside the first. This is the same
 * account as a stream: attach at any point, receive everything that already happened, then
 * follow live until the run ends.
 *
 * Two things move through it, and the difference matters:
 *
 *   message   an entry in the routing log. What the orchestrator ROUTED.
 *   activity  an adapter event from one participant. What a child is DOING right now.
 *
 * Only the second makes a live view worth having. A relay round records an instruction,
 * then waits — with no deadline, deliberately (see `Relay.#exchange`) — for the turn to
 * end, and that wait is where the work happens. A view fed only by the routing log shows
 * nothing at all for the whole of it.
 *
 * OBSERVATION IS NOT INTERVENTION. See the brief, "Streaming to the human, and the
 * intervention gap": neither child CLI ingests input mid-turn, so seeing a turn as it
 * happens does not mean a reaction to it can land while it is still happening. A human
 * message written against activity seen here is still delivered at the next turn boundary,
 * where it reads as context for the NEXT action. Anchoring such a message to the point it
 * was written against is not implemented, and this stream does not solve it.
 */

import type { AgentEvent } from '../contract/session.ts'
import { AsyncQueue } from '../adapters/asyncQueue.ts'
import type { Rank, RelayMessage } from './message.ts'
import type { RunPause } from './run.ts'

/** Why a run stopped. The relay decides none of these beyond `budget`. */
export type RunReason =
  | 'done'
  | 'escalated'
  | 'budget'
  | 'stopped'
  /**
   * The transport under a participant failed, so the run could not continue.
   *
   * A distinct reason rather than `escalated` because the two ask different things of a
   * reader: an escalation means the agents wanted a human, while this means Conclave lost
   * the ability to observe a turn at all. Conflating them hides a defect inside a normal
   * outcome.
   */
  | 'transport_failed'
  /**
   * A configured ceiling was reached: wall clock or total turns.
   *
   * Its own reason rather than `budget`, which means the ROUND structure was exhausted. The
   * two answer different questions -- "the exchange ran its course" versus "this run was
   * still going and was stopped" -- and an operator deciding whether to resume needs to know
   * which happened.
   */
  | 'ceiling'

export interface RelayEventBase {
  /**
   * Position in this stream. Its own counter, NOT `RelayMessage.seq` -- the message
   * numbering is what `audit()` and `asymmetryAt()` are defined over, and interleaving
   * activity into it would silently change what those mean.
   */
  seq: number
  at: number
}

/** An entry was added to the routing log. */
export interface RelayMessageEvent extends RelayEventBase {
  type: 'message'
  message: RelayMessage
}

/** A participant's adapter emitted an event. Provisional and revisable, as ever. */
export interface RelayActivityEvent extends RelayEventBase {
  type: 'activity'
  participant: string
  rank: Rank
  event: AgentEvent
}

/**
 * The loop suspended at a decision point, and is not going to advance until a human acts.
 *
 * The routing log already records a `paused (...)` note, but a note is prose: a viewer
 * reading it has to match a string to know the run stopped, and gets nothing structured to
 * render the reason, the evidence, or the options with. This says it as state.
 *
 * The payload is the SAME OBJECT `RunHandle.pause` returns, not a copy. `supersede()`
 * mutates a pause in place — deliberately, because everyone who will ever hear about that
 * pause already holds the object — so a subscriber given a copy would be holding a pause
 * that can never learn its verdict was withdrawn. Serialising consumers (the session
 * recorder) snapshot it at emit time and are unaffected either way; in-process consumers
 * are the ones that need the identity.
 */
export interface RelayPauseEvent extends RelayEventBase {
  type: 'pause'
  pause: RunPause
}

/**
 * The operator decided, and the loop is moving again.
 *
 * Carries the pause it is leaving — the same object the matching `pause` event carried — so
 * a subscriber can pair the two by identity rather than by guessing from adjacency. Emitted
 * only when the run actually continues: an abort ends the run instead, and `run_end` is the
 * event that says so.
 */
export interface RelayResumeEvent extends RelayEventBase {
  type: 'resume'
  pause: RunPause
}

/** Terminal. Nothing follows it, and every subscriber's iteration completes. */
export interface RelayRunEndEvent extends RelayEventBase {
  type: 'run_end'
  reason: RunReason
  detail?: string | undefined
}

/**
 * ## The compatibility rule for consumers
 *
 * **A reader of this stream must ignore event types it does not recognise.** New members
 * are added to this union as the orchestrator learns to say more -- `pause` and `resume`
 * were added after `events.ndjson` already had readers -- and a consumer that treats `type`
 * as a closed set breaks on every such addition.
 *
 * Stated here rather than versioned, deliberately. Bumping a schema for an additive change
 * would oblige every consumer to react to something that cannot affect them, which teaches
 * them to bump blindly; the version would then say nothing on the day a field really does
 * change meaning. What IS breaking -- a field removed, or its meaning altered -- gets a
 * version, and there is nothing of that kind here yet.
 *
 * Raised by the session that added `pause` and `resume`, which noticed it had no way to
 * know whether an out-of-repo consumer existed and flagged it rather than assuming.
 */
/**
 * A pause's verdict was withdrawn while the operator was still deciding.
 *
 * Carries the pause, whose `superseded` is now set. Emitted rather than left to polling
 * because the run STAYS PAUSED through it by design -- so `state` is unchanged before and
 * after, and a watcher observing state alone is silent through the one event a waiting
 * operator is waiting for.
 */
export interface RelaySupersedeEvent extends RelayEventBase {
  type: 'supersede'
  pause: RunPause
}

export type RelayEvent =
  | RelayMessageEvent
  | RelayActivityEvent
  | RelayPauseEvent
  | RelayResumeEvent
  | RelaySupersedeEvent
  | RelayRunEndEvent

/** Distributes over the union; a plain Omit would collapse it to the common keys. */
type WithoutEnvelope<T> = T extends unknown ? Omit<T, 'seq' | 'at'> : never
export type RelayEventInput = WithoutEnvelope<RelayEvent>

export interface ObserveOptions {
  /**
   * Replay everything already emitted before following live. Default true: a subscriber
   * that attaches mid-run and silently misses the goal and the briefings is worse than
   * one that cannot attach at all, because the gap is invisible to it.
   */
  replay?: boolean | undefined
}

/**
 * Fan-out to any number of independent subscribers.
 *
 * One queue per subscriber rather than one shared queue: `AsyncQueue` delivers each item
 * to exactly one reader, which is right for an adapter's event stream and exactly wrong
 * for a broadcast. Sharing one would have subscribers stealing each other's events.
 */
export class RelayEventStream {
  #history: RelayEvent[] = []
  #subscribers = new Set<AsyncQueue<RelayEvent>>()
  #seq = 0
  #closed = false
  #droppedAfterClose = 0

  get closed(): boolean {
    return this.#closed
  }

  /**
   * Emissions that arrived after the terminal event and were refused. A child can still
   * be emitting while the relay tears down, so this is expected rather than alarming --
   * but it is counted rather than silently swallowed, because a stream that quietly eats
   * events is indistinguishable from one that lost them.
   */
  get droppedAfterClose(): number {
    return this.#droppedAfterClose
  }

  emit(input: RelayEventInput): void {
    // `run_end` is terminal, and it has to be terminal for EVERY subscriber -- including
    // one that attaches later and reads the history. Dropping post-close emissions from
    // the history is what makes that true; without it a late subscriber would replay
    // activity sitting after the run it belongs to.
    //
    // Nothing is lost by this. The participant's own event array still holds the event,
    // and `snapshot()` remains authoritative; only the observation stream declines it.
    if (this.#closed) {
      this.#droppedAfterClose++
      return
    }
    // The cast is the price of building the envelope once for a union of several shapes.
    const event = { ...input, seq: ++this.#seq, at: Date.now() } as RelayEvent
    // Retained even with no subscribers, so one attaching later still gets the history.
    // These hold references to the same RelayMessage, AgentEvent and RunPause objects the
    // log, the participants and the handle already keep, so it is an envelope per event and
    // not a second copy of the prose.
    this.#history.push(event)
    for (const q of this.#subscribers) q.push(event)
  }

  /** Ends every subscription. Emit the terminal `run_end` before calling this. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const q of this.#subscribers) q.close()
    this.#subscribers.clear()
  }

  /**
   * Iterate the session as it happens.
   *
   * One iterable is one subscription: iterate it once. Breaking out of a `for await`
   * detaches it, because an abandoned subscriber that stayed attached would accumulate
   * every event for the rest of the run with nobody reading them.
   */
  observe(opts: ObserveOptions = {}): AsyncIterable<RelayEvent> {
    const queue = new AsyncQueue<RelayEvent>()
    if (opts.replay !== false) for (const e of this.#history) queue.push(e)
    // Already-queued replay still drains before the iterator reports done.
    if (this.#closed) queue.close()
    else this.#subscribers.add(queue)

    const detach = () => {
      this.#subscribers.delete(queue)
      queue.close()
    }

    return {
      [Symbol.asyncIterator]: () => {
        const inner = queue[Symbol.asyncIterator]()
        return {
          next: () => inner.next(),
          return: async () => {
            detach()
            return { value: undefined as never, done: true }
          },
        }
      },
    }
  }
}
