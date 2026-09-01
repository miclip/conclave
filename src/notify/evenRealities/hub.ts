/**
 * One bridge, many runs. #184.
 *
 * The glasses are a device, not a per-run resource: one pair, one address the operator typed,
 * one connection. `registry.ts` built a fresh `EvenRealitiesTransport` per broker on a fixed
 * port, so a second concurrent run's `listen()` met a bound port — and even if it had not,
 * two sessions attached to one device would each be taking whichever answer arrived next.
 *
 * So the bridge is owned here and handed out as named views. Each view is an ordinary
 * `Transport` to its broker and knows nothing about the others.
 *
 * ## The name is not the id
 *
 * A run id is unreadable on a heads-up display and unreadable to a person anywhere. What the
 * operator sees is a short name they already use for the thing — the project, as tmux would
 * name a session — and for an unprompted notification that name is the entire context they
 * get, because they were not looking at a terminal and may have several projects running.
 *
 *     [conclave]  merge fix-189? checks green
 *     [patchnote] advisor wants a premise confirmed
 *
 * The id routes and never appears. The name appears and never routes.
 *
 * ## Questions are serialised, because the protocol cannot tell them apart
 *
 * `POST /api/question-response` carries `{ sessionId, answer }` — the session, not the
 * question. With several runs multiplexed onto one session an incoming answer says nothing
 * about which of them it belongs to, and "whichever asked most recently" is a guess that
 * would occasionally hand one run's decision to another.
 *
 * So one question is outstanding at a time across every view, and the rest queue. That is a
 * real cost — a second run waits — and it is the honest one: the alternative is a merge
 * approval landing on the wrong branch. If the protocol ever carries a question id, this is
 * the constraint that lifts.
 */

import type { Inbound, Outbound, Transport, TransportLimits } from '../types.ts'
import { EvenRealitiesTransport } from './transport.ts'
import type { BridgeOptions } from './client.ts'

/** A view's turn to hold the one outstanding question. */
interface Waiting {
  run: () => void
}

export class EvenRealitiesHub {
  readonly transport: EvenRealitiesTransport
  #listening: Promise<void> | undefined
  #views = 0
  /** Whoever is asking now, and who is waiting. See the serialisation note above. */
  #busy = false
  readonly #queue: Waiting[] = []

  constructor(opts: BridgeOptions = {}) {
    this.transport = new EvenRealitiesTransport(opts)
  }

  /** Listened at most once, however many views ask. */
  async listen(): Promise<void> {
    this.#listening ??= this.transport.listen()
    await this.#listening
  }

  /**
   * A `Transport` for one run, labelled with the name the operator will read.
   *
   * Closing a view releases it; the bridge closes when the last one does, because the device
   * belongs to the machine rather than to whichever run happens to finish first.
   */
  view(name: string): Transport {
    this.#views++
    const hub = this
    return {
      // The TRANSPORT's name, not the run's. This is the identity `--transport` resolves and
      // the record reports; the friendly name is a property of the messages, which is where
      // the operator reads it. A view that renamed itself would make `even-realities`
      // unresolvable and every run's transport look like a different one.
      name: hub.transport.name,
      get limits(): TransportLimits {
        return hub.transport.limits
      },
      async send(m: Outbound): Promise<{ id: string }> {
        // The wait is HERE, not around `receive`. A question becomes outstanding the moment it
        // is put to the glasses, and `EvenRealitiesTransport` holds exactly one -- so a second
        // view sending while the first is unanswered would overwrite the question the operator
        // is currently looking at. Waiting on `receive` instead deadlocked on precisely that.
        if (asks(m)) await hub.#acquire()
        return hub.transport.send(label(m, name))
      },
      async receive(): Promise<Inbound> {
        try {
          return await hub.transport.receive()
        } finally {
          // Paired with the acquire in `send`. `Broker.ask` always receives what it sent; a
          // caller that sends a question and walks away holds the device until it closes,
          // which is the same hazard as walking away from a dialog on any other surface.
          hub.#release()
        }
      },
      async poll(): Promise<Inbound[]> {
        return hub.transport.poll()
      },
    }
  }

  /**
   * Release one view. The bridge closes when the last one does: the device belongs to the
   * machine, not to whichever run happens to finish first.
   */
  async release(): Promise<void> {
    this.#views--
    if (this.#views <= 0) await this.transport.close()
  }

  async #acquire(): Promise<void> {
    if (!this.#busy) {
      this.#busy = true
      return
    }
    await new Promise<void>((resolve) => this.#queue.push({ run: resolve }))
  }

  #release(): void {
    const next = this.#queue.shift()
    if (next) next.run()
    else this.#busy = false
  }
}

/**
 * Does this message put a question to the operator, as opposed to announcing something?
 *
 * The same split `EvenRealitiesTransport.send` makes: options alone are not a question, because
 * a `decided` or `progress` message carries its options as a veto that nobody waits on.
 */
function asks(m: Outbound): boolean {
  return (m.options?.length ?? 0) > 0 && m.kind !== 'decided' && m.kind !== 'progress'
}

/**
 * The name, in front of the text, on every line the operator reads.
 *
 * On the headline rather than the title: the title is a kind ("Approval"), and two runs asking
 * for approval have identical titles. The headline is the only line guaranteed to be shown.
 */
function label(m: Outbound, name: string): Outbound {
  return { ...m, headline: `[${name}] ${m.headline}` }
}

/**
 * The process's bridge, created once.
 *
 * Within one process this is the whole of the problem: several brokers, one device. ACROSS
 * processes — two `conclave session` commands in two terminals — the second still meets a
 * bound port, and gets `EADDRINUSE` rather than a sentence. That is a real remaining gap and
 * is left as one deliberately: sharing between processes means a broker that outlives every
 * run, and whether conclave should hold a daemon is a decision, not an implementation detail.
 */
let shared: EvenRealitiesHub | undefined

export function sharedHub(opts: BridgeOptions = {}): EvenRealitiesHub {
  shared ??= new EvenRealitiesHub(opts)
  return shared
}

/** Test seam: forget the process hub, so a suite can build another on another port. */
export function resetSharedHub(): void {
  shared = undefined
}
