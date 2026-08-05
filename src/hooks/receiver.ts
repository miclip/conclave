/**
 * Hook receiver, owned by the adapter.
 *
 * Binds an ephemeral port on loopback and hands the URL to the child through its
 * environment, so sessions do not contend for a fixed port and a delivery can always be
 * attributed to the session that produced it.
 *
 * Acknowledgement order is the contract: journal durably, THEN respond. A 200 that
 * outruns the fsync converts a crash into silent loss, because the hook client treats a
 * 200 as "delivered" and will never replay it.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { EventEmitter } from 'node:events'
import { HookJournal, mintDeliveryId, type HookDelivery } from './journal.ts'

export interface ReceiverEvents {
  delivery: [HookDelivery]
  /** A delivery already journalled. Emitted so replays are visible, not silent. */
  duplicate: [HookDelivery]
}

export class HookReceiver extends EventEmitter<ReceiverEvents> {
  readonly journal: HookJournal
  #server?: Server
  #url?: string

  constructor(journalPath: string) {
    super()
    this.journal = new HookJournal(journalPath)
  }

  get url(): string {
    if (!this.#url) throw new Error('receiver not started')
    return this.#url
  }

  async start(host = '127.0.0.1'): Promise<string> {
    this.#server = createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let payload: Record<string, any> = {}
        try {
          payload = JSON.parse(raw || '{}')
        } catch {
          /* keep the raw body; a malformed payload is still evidence a hook fired */
        }

        const hookPid = Number(req.headers['x-orch-hook-pid'] ?? 0)
        const firedAt = Number(req.headers['x-orch-fired-at'] ?? Date.now() / 1000)
        // Prefer the identity minted at fire time so a replay keeps the original's.
        const deliveryId =
          (req.headers['x-orch-delivery-id'] as string | undefined) ||
          mintDeliveryId(raw, hookPid, firedAt)

        const delivery: HookDelivery = {
          deliveryId,
          agent: String(req.headers['x-orch-agent'] ?? 'unknown'),
          event: String(payload.hook_event_name ?? req.headers['x-orch-event'] ?? 'unknown'),
          sessionId: payload.session_id,
          turnKey: payload.prompt_id ?? payload.turn_id,
          payload,
          firedAt,
          hookPid,
          receivedAt: Date.now(),
        }

        // Durable first. Only then may the client believe us.
        let fresh: boolean
        try {
          fresh = this.journal.appendDurable(delivery)
        } catch (err) {
          // Refusing the delivery is correct: the client's non-zero exit makes the
          // failure visible in the UI, which a silent 200 would not.
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: String(err) }))
          return
        }

        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, deliveryId, duplicate: !fresh }))

        if (fresh) this.emit('delivery', delivery)
        else this.emit('duplicate', { ...delivery, replay: true })
      })
    })

    await new Promise<void>((resolve) => this.#server!.listen(0, host, resolve))
    const addr = this.#server!.address() as AddressInfo
    this.#url = `http://${host}:${addr.port}/hook`
    return this.#url
  }

  async stop(): Promise<void> {
    if (!this.#server) return
    await new Promise<void>((resolve) => this.#server!.close(() => resolve()))
    this.#server = undefined
  }
}
