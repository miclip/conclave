/**
 * A transport that goes nowhere, for tests and for proving an adapter is thin.
 *
 * Exported from `src/` rather than kept in a test file on purpose: the point of the interface
 * is that a real adapter -- glasses, Slack, Signal -- is a small thing written against it, and
 * the cheapest way to keep that true is for the reference implementation to be readable and to
 * live beside the interface it implements.
 */

import type { Inbound, Outbound, Transport, TransportLimits } from './types.ts'

export class FakeTransport implements Transport {
  readonly name: string
  readonly limits: TransportLimits
  /** Everything handed to `send`, exactly as the broker built it. */
  readonly sent: Outbound[] = []
  /** What `receive` will answer with, in order. */
  reply: Inbound | undefined
  /** Set to make `send` fail, which is the case a run must survive. */
  failSend: string | undefined
  /** Set to make `receive` fail after a successful send. */
  failReceive: string | undefined
  /** Answers that arrived with nothing waiting -- late vetoes. Drained by `poll`. */
  unsolicited: Inbound[] = []

  constructor(over: Partial<TransportLimits> & { name?: string } = {}) {
    this.name = over.name ?? 'fake'
    this.limits = { maxChars: over.maxChars ?? 200, canReceive: over.canReceive ?? true }
  }

  send(m: Outbound): Promise<{ id: string }> {
    if (this.failSend !== undefined) return Promise.reject(new Error(this.failSend))
    this.sent.push(m)
    return Promise.resolve({ id: `fake-${this.sent.length}` })
  }

  poll(): Promise<Inbound[]> {
    const taken = this.unsolicited
    this.unsolicited = []
    return Promise.resolve(taken)
  }

  receive(): Promise<Inbound> {
    if (this.failReceive !== undefined) return Promise.reject(new Error(this.failReceive))
    if (!this.reply) return Promise.reject(new Error('no reply configured'))
    return Promise.resolve(this.reply)
  }
}
