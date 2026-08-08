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
 *
 * A delivery is what produces `completed (proven) [hook:Stop]`, so what the receiver
 * accepts is what the evidence model is worth. A POST that looks authentic can
 * manufacture a completion that never happened, which is a cheap forgery of exactly the
 * claim conclave exists to be trusted about -- so it is worth writing down what is
 * trusted (issue #46).
 *
 * Binding loopback excludes remote callers, and nothing more: any other local process can
 * discover an ephemeral port with `lsof -i`. The port is therefore not the credential.
 * The credential is a random token in the URL path, which reaches the child through
 * ORCH_HOOK_URL and never touches disk, so what is trusted is the child and the secrecy
 * of its environment. Anyone who can read that environment holds the credential and can
 * forge a delivery; that is outside this defence's boundary.
 *
 * The token is per receiver instance and lives only in memory, which is why this cannot
 * fail open: there is no secret file whose absence could be read as "auth disabled".
 *
 * `x-orch-hook-pid` remains self-reported. The token proves the sender held the URL, not
 * that it is the process it names.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { EventEmitter } from 'node:events'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { HookJournal, mintDeliveryId, type HookDelivery } from './journal.ts'

/**
 * Digests rather than the strings themselves, so unequal lengths can still be compared in
 * constant time. Timing is not the attack the token defends against; this is the cheap
 * version of not having to argue about it.
 */
function secretEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  )
}

export interface ReceiverEvents {
  delivery: [HookDelivery]
  /** A delivery already journalled. Emitted so replays are visible, not silent. */
  duplicate: [HookDelivery]
}

export class HookReceiver extends EventEmitter<ReceiverEvents> {
  readonly journal: HookJournal
  #server: Server | undefined
  #url: string | undefined
  /** Per instance, so one session's URL is not authority over another's evidence. */
  readonly #token = randomBytes(32).toString('base64url')
  #path: string | undefined

  constructor(journalPath: string) {
    super()
    this.journal = new HookJournal(journalPath)
  }

  get url(): string {
    if (!this.#url) throw new Error('receiver not started')
    return this.#url
  }

  async start(host = '127.0.0.1'): Promise<string> {
    this.#path = `/hook/${this.#token}`

    this.#server = createServer((req, res) => {
      if (req.method !== 'POST') {
        req.resume()
        res.writeHead(405).end()
        return
      }
      // Ahead of the body, the parse and the journal: a rejected delivery must leave no
      // trace, or a forger still gets to write to the evidence by being refused.
      if (!secretEqual(req.url ?? '', this.#path!)) {
        req.resume() // drain, so the sender reads the status instead of a reset socket
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'unauthenticated' }))
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
    this.#url = `http://${host}:${addr.port}${this.#path}`
    return this.#url
  }

  async stop(): Promise<void> {
    if (!this.#server) return
    await new Promise<void>((resolve) => this.#server!.close(() => resolve()))
    this.#server = undefined
  }
}
