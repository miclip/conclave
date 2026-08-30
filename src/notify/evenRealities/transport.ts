/**
 * `Transport` over the Even Realities bridge.
 *
 * Thin on purpose. Everything that knows the wire format is in `client.ts`, which imports
 * nothing from conclave; this file is the part that would be thrown away if the notify layer
 * were ever pointed at something else.
 */

import type { Inbound, Outbound, Transport, TransportLimits } from '../types.ts'
import { EvenRealitiesBridge, type BridgeOptions } from './client.ts'

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

  constructor(opts: BridgeOptions = {}) {
    this.bridge = new EvenRealitiesBridge(opts)
  }

  async listen(): Promise<void> {
    await this.bridge.listen()
  }

  async close(): Promise<void> {
    await this.bridge.close()
  }

  async send(m: Outbound): Promise<{ id: string }> {
    // A message with options is a QUESTION on this surface, and questions are asked rather than
    // announced -- so `send` only announces, and `receive` does the asking. Splitting it that
    // way keeps `tell` from opening a dialog nobody is waiting on.
    if (!m.options || m.options.length === 0) {
      const id = this.bridge.send({ type: 'notification', title: titleFor(m), message: m.headline })
      return { id: String(id) }
    }
    // Deferred to `receive`, which is where the answer is awaited. The id is the correlation the
    // broker holds; the bridge allows one outstanding question, which is the same constraint.
    this.#pending = m
    return { id: `q-${Date.now()}` }
  }

  #pending: Outbound | undefined

  async receive(): Promise<Inbound> {
    const m = this.#pending
    this.#pending = undefined
    if (!m?.options) throw new Error('nothing was asked')
    const { answer } = await this.bridge.ask({
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
