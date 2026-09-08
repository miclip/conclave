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
  /**
   * A listener threw and was contained. Reported as an event rather than raised, because
   * raising is what #263 is about.
   */
  listener_error: [ListenerFailure]
}

/** What a contained listener throw amounts to, for whoever has to explain it afterwards. */
export interface ListenerFailure {
  /** Which emit the throw escaped from. */
  event: 'delivery' | 'duplicate'
  /** The delivery being announced when it happened. It IS journalled; only the listener failed. */
  delivery: HookDelivery
  /** Whatever was thrown, unchanged, for a consumer that wants more than the text. */
  error: unknown
  /**
   * The thrown message, verbatim.
   *
   * Verbatim is the requirement, not a nicety. The throw this exists for carries the
   * prompt-fidelity diagnosis, which is several sentences of reasoning an operator is meant to
   * read -- summarising it would leave them with the fact that something failed and none of
   * why.
   */
  message: string
}

/**
 * One sentence for a contained listener failure, wherever it comes out.
 *
 * Shared by the stderr fallback below and by the adapters that turn the event into an
 * `AgentEvent`, so the operator reads the same words whether the fault reached them through
 * the session's event stream or off the back of the process. Two phrasings of one fault is how
 * a reader ends up believing they are two.
 */
export function describeListenerFailure(f: ListenerFailure): string {
  return (
    `a hook '${f.event}' listener threw on delivery ${f.delivery.deliveryId} ` +
    `(${f.delivery.event}); the delivery is journalled and the run continues: ${f.message}`
  )
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

        if (fresh) this.#dispatch('delivery', delivery)
        else this.#dispatch('duplicate', { ...delivery, replay: true })
      })
    })

    await new Promise<void>((resolve) => this.#server!.listen(0, host, resolve))
    const addr = this.#server!.address() as AddressInfo
    this.#url = `http://${host}:${addr.port}${this.#path}`
    return this.#url
  }

  /**
   * The only place this receiver emits a delivery, and the only place a listener may throw
   * without ending the run (#263).
   *
   * WHY THE BOUNDARY IS HERE, and not in the listeners. Both emits happen inside the request's
   * `'end'` handler, which is an I/O callback with no caller: a listener that throws throws out
   * of `emit`, out of `'end'`, and into Node's uncaught handler. That killed a multi-hour run
   * for a prompt-fidelity correlation fault whose own diagnosis says the send is refused and
   * nothing downstream should treat the other message as this one -- a condition the code had
   * already decided was recoverable, made fatal by where it was raised.
   *
   * Every route to a listener passes through here: three adapters, both events, and the replay
   * path that only runs after something has ALREADY gone wrong. Containment written in the
   * listeners instead would be four copies of one policy in the two places, and the copy that
   * was forgotten would be the one that ran. It is also the only version that covers a listener
   * this file has never heard of -- a test's, a future adapter's -- which is what "the receiver
   * does not let its listeners kill the process" has to mean to be worth stating.
   *
   * What is NOT decided here: what the failure means. The receiver knows a listener threw and
   * knows the delivery survived it; whether that is a refused send, a bad parse or a bug is the
   * listener's business, so the fault is handed on as an event and the receiver keeps receiving.
   */
  #dispatch(event: 'delivery' | 'duplicate', delivery: HookDelivery): void {
    try {
      this.emit(event, delivery)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#report({ event, delivery, error, message })
    }
  }

  /**
   * Hand the fault on, and never let handing it on be the new way to lose it.
   *
   * Two ways the structured route can fail, and both end at stderr rather than at silence: no
   * `listener_error` listener is registered, or the one that is registered throws as well.
   * Silence is the outcome worth spending code on -- the crash at least left a stack, and a
   * correlation fault that vanishes leaves an operator with a run that behaved strangely and
   * nothing at all to read. The fallback is unconditional and takes no dependency on a
   * logger, because it has to work in exactly the case where the wiring above it did not.
   */
  #report(failure: ListenerFailure): void {
    if (this.listenerCount('listener_error') === 0) {
      process.stderr.write(`[conclave] ${describeListenerFailure(failure)}\n`)
      return
    }
    try {
      this.emit('listener_error', failure)
    } catch (reporting) {
      const why = reporting instanceof Error ? reporting.message : String(reporting)
      process.stderr.write(
        `[conclave] ${describeListenerFailure(failure)}\n` +
          `[conclave] and reporting that threw too: ${why}\n`,
      )
    }
  }

  async stop(): Promise<void> {
    if (!this.#server) return
    await new Promise<void>((resolve) => this.#server!.close(() => resolve()))
    this.#server = undefined
  }
}
