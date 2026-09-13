/**
 * A run's `Transport` over the broker's socket. #286.
 *
 * Lazy: resolving the transport touches nothing. The first `send`, `receive` or `poll` finds
 * or starts the broker, connects, and opens the run as a session -- so `--transport
 * even-realities` on a command that turns out to have nothing to send starts no daemon.
 *
 * Connection is registration. What the broker knows about the run is what `open` carried,
 * read from the run's own record by `describe`; the session exists for as long as this
 * socket does and not a moment longer. `close()` is that moment, and the CLI calls it when
 * the operation is done, because a `conclave notify ask` lives exactly as long as its question.
 *
 * The formatting -- titles, the `[name]` label, option/label mapping, the veto path -- is
 * `EvenRealitiesTransport`'s, unchanged: this is that class over a channel that happens to be
 * a socket.
 */

import type { SessionMetadata } from './client.ts'
import { EvenRealitiesBrokerClient } from './broker.ts'
import { EvenRealitiesTransport, type SessionChannel } from './transport.ts'

/** Finds or starts the broker; resolves with where its socket is. */
export type Ensure = () => Promise<{ socketPath: string }>

/**
 * How long an ANSWERED run holds its socket open before letting go, so the device can render
 * the confirmation before the stream it arrived on is torn down (#285).
 *
 * The bug this exists for: the bridge writes a `Received` frame and settles `deliver` when the
 * kernel has the bytes. That is TRANSMISSION, not rendering -- nothing about a settled write
 * says the app has drawn anything -- and the answer is then given to the run, the run's
 * `close()` ends its socket, the broker closes the session, and the session's event stream is
 * ended. On the device the teardown beat the render every time, and the operator never saw
 * the confirmation. The surface was suspected; it was innocent: three notifications pushed to
 * an open session with no question outstanding were all seen. What was missing was time.
 *
 * 300ms: several render frames and a network's worth of scheduling on top, and below what
 * reads as a slow command -- the answer is on the run's stdout BEFORE this starts, so what it
 * delays is the process's exit, not the answer. `CONCLAVE_EVEN_CONFIRM_GRACE_MS` moves it;
 * anything that is not a non-negative number is the default.
 *
 * CONDITIONAL, and deliberately so. It applies to one thing: the close of a run socket on
 * which a question was answered. A `tell`-only run closes at once (nothing was confirmed).
 * The broker's answer routing has no delay (it closes nothing: the stream stays up as long as
 * the socket does, and a stream that is not closing has no render to race). The bridge's own
 * `#confirm` has no delay (it must not hold an answer the run is owed). A run that stays
 * attached after its answer -- more to say on the same connection -- pays it once, at the end.
 * Do not tidy it into every path, and do not delete it as dead code because a linger or a
 * long-lived session made it look unneeded: it is for the teardown that follows an answer.
 */
export const DEFAULT_CONFIRM_GRACE_MS = 300

export const CONFIRM_GRACE_ENV = 'CONCLAVE_EVEN_CONFIRM_GRACE_MS'

export function confirmGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CONFIRM_GRACE_ENV]
  if (raw === undefined || raw.trim() === '') return DEFAULT_CONFIRM_GRACE_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CONFIRM_GRACE_MS
}

/**
 * The channel: one client, connected on first use. Every method attaches first, so the
 * transport above it never sees a difference between "connected already" and "not yet".
 */
class LazyChannel implements SessionChannel {
  #client: Promise<EvenRealitiesBrokerClient> | undefined
  /** Whether a question was answered on this connection: the one case `close` waits for. */
  #answered = false
  readonly #runId: string
  readonly #describe: () => SessionMetadata | undefined
  readonly #ensure: Ensure

  constructor(runId: string, describe: () => SessionMetadata | undefined, ensure: Ensure) {
    this.#runId = runId
    this.#describe = describe
    this.#ensure = ensure
  }

  #attach(): Promise<EvenRealitiesBrokerClient> {
    this.#client ??= (async () => {
      const meta = this.#describe()
      // Checked at resolution too, but the record may have gone between then and now, and a
      // session with nothing to list is the invented entry the bridge refuses.
      if (!meta) throw new Error(`no readable record for run ${this.#runId}`)
      // TWICE, at most. A broker that is lingering out turns away a connection that arrives
      // while it closes (`EvenRealitiesBroker.#attach`), and what that looks like from here is
      // a connection that ended before `opened`. The second attempt finds no broker and
      // starts one; a second refusal is something else, and is reported as what it said.
      for (let attempt = 1; ; attempt++) {
        const { socketPath } = await this.#ensure()
        const client = await EvenRealitiesBrokerClient.connect(socketPath)
        try {
          await client.open(this.#runId, meta)
          return client
        } catch (err) {
          client.close()
          if (attempt < 2 && (err as Error).message === 'the broker connection closed') continue
          throw err
        }
      }
    })()
    return this.#client
  }

  async send(runId: string, msg: Parameters<EvenRealitiesBrokerClient['tell']>[0]): Promise<number> {
    this.#same(runId)
    return (await this.#attach()).tell(msg)
  }

  async ask(runId: string, q: Parameters<EvenRealitiesBrokerClient['ask']>[0]): ReturnType<EvenRealitiesBrokerClient['ask']> {
    this.#same(runId)
    const answer = await (await this.#attach()).ask(q)
    // Landed. The answer is returned NOW, unconditionally; what the flag changes is how the
    // eventual `close` behaves, and nothing here can hold or fail an answer already given.
    this.#answered = true
    return answer
  }

  async takeUnsolicited(runId: string): ReturnType<EvenRealitiesBrokerClient['poll']> {
    this.#same(runId)
    return (await this.#attach()).poll()
  }

  /** One connection is one session; a channel asked to speak for another run is a wiring bug. */
  #same(runId: string): void {
    if (runId !== this.#runId) throw new Error(`this channel is run ${this.#runId}, not ${runId}`)
  }

  /**
   * Hang up if ever connected. Never connects in order to disconnect, and never throws: by the
   * time this runs the caller has its answer, and a failure to let go is not a failure to ask.
   *
   * After an answered question, waits `graceMs` first -- see `DEFAULT_CONFIRM_GRACE_MS` for
   * why, and for why ONLY then. The socket is what keeps the session, and the session is what
   * keeps the device's stream: holding the socket is how the confirmation gets its render.
   */
  async close(graceMs: number): Promise<void> {
    const pending = this.#client
    this.#client = undefined
    if (!pending) return
    let client: EvenRealitiesBrokerClient
    try {
      client = await pending
    } catch {
      // Attaching failed, so there is nothing connected to hang up.
      return
    }
    if (this.#answered && graceMs > 0 && !client.closed) await new Promise((r) => setTimeout(r, graceMs))
    client.close()
  }
}

export class BrokerBackedTransport extends EvenRealitiesTransport<LazyChannel> {
  readonly #graceMs: number

  constructor(
    runId: string,
    label: string,
    describe: () => SessionMetadata | undefined,
    ensure: Ensure,
    opts: { confirmGraceMs?: number } = {},
  ) {
    super(new LazyChannel(runId, describe, ensure), runId, label)
    this.#graceMs = opts.confirmGraceMs ?? confirmGraceMs()
  }

  /**
   * The session ends with the socket. Called by the CLI once its one operation is done and
   * its answer, if any, is already on stdout -- after an answer this waits the confirmation
   * grace before letting go, so call it after the answer has been handed on, not before.
   */
  close(): Promise<void> {
    return this.bridge.close(this.#graceMs)
  }
}
