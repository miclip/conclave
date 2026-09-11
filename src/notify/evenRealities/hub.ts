/**
 * One bridge, many runs. #184, #278.
 *
 * The glasses are a device, not a per-run resource: one pair, one address the operator typed,
 * one connection. `registry.ts` built a fresh transport per broker on a fixed port, so a second
 * concurrent run's `listen()` met a bound port — and even if it had not, two runs attached to
 * one device would each be taking whichever answer arrived next.
 *
 * So the bridge is owned here and handed out as views. Each view is an ordinary `Transport`
 * to its broker and knows nothing about the others.
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
 * The id routes and never appears. The name appears and never routes. On the wire the id is
 * the `sessionId`; the session's own `title` is the run's GOAL, read from its record, which is
 * what an operator choosing a run on the glasses needs. Two runs from the same directory have
 * the same name and different ids, and that is fine, because nothing looks a name up.
 *
 * ## One outstanding question per run, because that is what the protocol routes by
 *
 * `POST /api/question-response` carries `{ sessionId, answer }` — the session, not the
 * question. An earlier version of this file put every run on one hardcoded session, and then
 * an incoming answer said nothing about which run it belonged to; so it serialised questions
 * across every view, and a second run genuinely waited while the first was unanswered.
 *
 * That premise was ours, not the protocol's. A session IS a run now (#278): each view opens its
 * own on the bridge, an answer names the run by construction, and the bridge refuses a second
 * outstanding question on the same run — which is the granularity the protocol gives and the
 * one that is right anyway. Two runs asking at once both get asked, and each gets its own
 * answer. There is nothing left here to queue.
 */

import type { Inbound, Outbound, Transport, TransportLimits } from '../types.ts'
import { EvenRealitiesBridge, type BridgeOptions, type SessionMetadata } from './client.ts'
import { EvenRealitiesTransport } from './transport.ts'

export class EvenRealitiesHub {
  readonly bridge: EvenRealitiesBridge
  #listening: Promise<void> | undefined
  /** Views open per run. A run's session closes with its last view; the bridge with its last run. */
  readonly #holders = new Map<string, number>()

  constructor(opts: BridgeOptions = {}) {
    this.bridge = new EvenRealitiesBridge(opts)
  }

  /** Listened at most once, however many views ask. */
  async listen(): Promise<void> {
    this.#listening ??= this.bridge.listen()
    await this.#listening
  }

  /**
   * A `Transport` for one run, labelled with the name the operator will read.
   *
   * Opens the run's session on the bridge, so it is in `/api/sessions` from here on, described
   * by `describe` -- the run's own record, asked again on every listing. A second view of the
   * same run joins the session it already has rather than resetting it. The name goes on every
   * message this view sends; the session's title is the run's goal.
   *
   * Refuses, by way of the bridge, a run `describe` cannot answer for now: a session with no
   * readable run behind it would be an invented entry.
   */
  view(runId: string, name: string, describe: () => SessionMetadata | undefined): Transport {
    this.bridge.openSession(runId, describe)
    this.#holders.set(runId, (this.#holders.get(runId) ?? 0) + 1)
    const hub = this
    const run = new EvenRealitiesTransport(this.bridge, runId)
    return {
      // The TRANSPORT's name, not the run's. This is the identity `--transport` resolves and
      // the record reports; the friendly name is a property of the messages, which is where
      // the operator reads it. A view that renamed itself would make `even-realities`
      // unresolvable and every run's transport look like a different one.
      name: run.name,
      get limits(): TransportLimits {
        return run.limits
      },
      async send(m: Outbound): Promise<{ id: string }> {
        // LISTEN FIRST (#276). `listen()` existed on both the transport and this hub and had no
        // caller anywhere, so the server was never started: nothing was ever bound to the port,
        // no device could attach, and every send went into the client's buffer instead.
        //
        // It also made `ask` exit ZERO AND SILENT. `receive` awaits a promise only a connected
        // device can settle, and with no server there is no handle keeping the event loop alive
        // -- so node ran out of work and exited cleanly, past the branch that would have printed
        // "carried no answer" and returned 1. A hang would have been the honest failure; this
        // looked like success.
        //
        // Idempotent through `#listening`, so the first caller starts it and the rest await it.
        await hub.listen()
        return run.send(label(m, name))
      },
      async receive(): Promise<Inbound> {
        return run.receive()
      },
      async poll(): Promise<Inbound[]> {
        return run.poll()
      },
    }
  }

  /**
   * Release one view of one run. The run's session closes when its last view does, and the
   * bridge closes when the last run does: the device belongs to the machine, not to whichever
   * run happens to finish first.
   */
  async release(runId: string): Promise<void> {
    const left = (this.#holders.get(runId) ?? 0) - 1
    if (left > 0) {
      this.#holders.set(runId, left)
      return
    }
    this.#holders.delete(runId)
    this.bridge.closeSession(runId)
    if (this.#holders.size === 0) {
      await this.bridge.close()
      // Forgotten, not just closed: the next view's `send` must start a server again rather
      // than await a listen that already finished on a socket that is gone.
      this.#listening = undefined
    }
  }
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
