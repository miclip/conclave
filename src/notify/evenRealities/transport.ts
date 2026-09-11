/**
 * `Transport` over the Even Realities bridge, for ONE run.
 *
 * Thin on purpose. Everything that knows the wire format is in `client.ts`, which imports
 * nothing from conclave; this file is the part that would be thrown away if the notify layer
 * were ever pointed at something else.
 *
 * It does not own the bridge. A session on the wire is a run (#278), and the server the glasses
 * dial is the machine's; so this takes a bridge somebody else listens on and the id of the run
 * it speaks for, and every call goes out under that id. `hub.ts` is where the bridge is owned.
 */

import type { Inbound, Outbound, Transport, TransportLimits } from '../types.ts'
import type { EvenRealitiesBridge } from './client.ts'

/**
 * What a HUD line can carry.
 *
 * A guess, and labelled as one: it is the number most likely to be wrong on first contact with
 * the hardware, and it is the only thing here that cannot be checked without glasses. The
 * renderer truncates to it, so being wrong makes a line short rather than broken.
 */
const HUD_CHARS = 120

export class EvenRealitiesTransport implements Transport {
  readonly name = 'even-realities'
  readonly limits: TransportLimits = { maxChars: HUD_CHARS, canReceive: true }
  readonly bridge: EvenRealitiesBridge
  /** The session on the wire. The run's id: it routes and is never shown. */
  readonly runId: string

  constructor(bridge: EvenRealitiesBridge, runId: string) {
    this.bridge = bridge
    this.runId = runId
  }

  async send(m: Outbound): Promise<{ id: string }> {
    // A message with options is a QUESTION on this surface, and questions are asked rather than
    // announced -- so `send` only announces, and `receive` does the asking. Splitting it that
    // way keeps `tell` from opening a dialog nobody is waiting on.
    if (!m.options || m.options.length === 0) {
      const id = this.bridge.send(this.runId, { type: 'notification', title: titleFor(m), message: m.headline })
      return { id: String(id) }
    }
    // A `tell` that carries options is a decision with a veto: announced, not asked, so the
    // options travel with the notification and the tap comes back through `poll`.
    if (m.kind === 'decided' || m.kind === 'progress') {
      this.#lastOffered = m.options.map((o) => ({ id: o.id, label: o.label }))
      const id = this.bridge.send(this.runId, {
        type: 'notification',
        title: titleFor(m),
        message: `${m.headline} — ${m.options.map((o) => o.label).join(' / ')}`,
      })
      return { id: String(id) }
    }
    // Deferred to `receive`, which is where the answer is awaited. The id is the correlation the
    // broker holds; the bridge allows one outstanding question per run, which is the same
    // constraint.
    this.#pending = m
    return { id: `q-${Date.now()}` }
  }

  #pending: Outbound | undefined

  /**
   * Late answers, which on this surface is how a veto arrives.
   *
   * A tap on a `decided` notification reaches `/api/question-response` with nothing awaiting it.
   * The bridge buffers those per run; this hands over this run's as inbound with no option
   * resolution, because the broker matches them against the decision that offered them and
   * knows the ids.
   */
  async poll(): Promise<Inbound[]> {
    const from = { id: 'even-realities', kind: 'human' as const }
    return this.bridge.takeUnsolicited(this.runId).map((a) => {
      const chosen = this.#lastOffered.find((o) => o.label === a.answer)
      return chosen ? { option: chosen.id, from } : { text: a.answer, from }
    })
  }

  /** The options most recently announced, so a late tap on a label resolves to its id. */
  #lastOffered: { id: string; label: string }[] = []

  async receive(): Promise<Inbound> {
    const m = this.#pending
    this.#pending = undefined
    if (!m?.options) throw new Error('nothing was asked')
    const { answer } = await this.bridge.ask(this.runId, {
      header: titleFor(m),
      question: m.headline,
      // `description` carries the href, which is where the evidence is. The label is what a
      // glance has to be enough to choose from.
      options: m.options.map((o) => ({ label: o.label, description: m.href ?? '' })),
    })
    // An answer that matches an offered LABEL is that option; anything else is speech, and the
    // caller interprets it. The broker refuses an id that was never offered, so mapping label to
    // id here is what keeps a tap an action rather than prose.
    const chosen = m.options.find((o) => o.label === answer)
    const from = { id: 'even-realities', kind: 'human' as const }
    return chosen ? { option: chosen.id, from } : { text: answer, from }
  }
}

/** The `title` a notification shows, from the kind rather than invented per call site. */
function titleFor(m: Outbound): string {
  switch (m.kind) {
    case 'approval':
      return 'Approval'
    case 'direction':
      return 'Which next'
    case 'question':
      return 'Question'
    case 'decided':
      return 'Decided'
    default:
      return 'conclave'
  }
}
