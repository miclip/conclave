/**
 * An OpenCode seat driven through its HTTP API, rather than one process per turn.
 *
 * WHY A SECOND ADAPTER FOR ONE AGENT. `OpenCodeRunAdapter` spawns `opencode run` per turn and
 * learns what happened by parsing stdout after the process exits. That is the honest shape for a
 * CLI driven without a session, and it costs this seat almost everything conclave does with the
 * others: no turn boundary except process exit, no within-turn activity at all -- which is why
 * `RUN_PER_TURN_DEADLINES` declares `silence: unsupported` for it -- no way to send a command,
 * and cancellation that means killing a process.
 *
 * None of that is a limitation of OpenCode. It runs a server, and the server says everything: a
 * turn boundary (`session.idle`), streaming output (`message.part.delta`), and transport liveness
 * (`server.heartbeat`) that neither pty adapter has -- they infer it from a child still existing.
 *
 * WHAT IT DOES NOT HAVE, and this is the argument that matters most: nothing is typed. The pty
 * adapters put text into a terminal and correlate what echoes back, which is the whole of #174,
 * #185, #207 and #216 -- four defects, three of them shipped, two of them run-killing. Here a
 * prompt is a POST and the response is an event. There is no echo, so there is nothing to
 * correlate wrongly.
 */

import type {
  AgentEvent,
  AgentSession,
  CloseMode,
  Guarantees,
  SendProvenance,
  SessionSnapshot,
  SessionState,
  TurnKey,
} from '../../contract/session.ts'
import { guaranteesFor, turnKey } from '../../contract/session.ts'
import { DEFAULT_WATCHDOG_MS, TurnWatchdog } from '../../outcomes/watchdog.ts'
import { TurnVerdictTracker } from '../../outcomes/tracker.ts'
import { AsyncQueue } from '../asyncQueue.ts'
import { OpenCodeClient, OpenCodeApiError } from './client.ts'
import { startOpenCodeServer, type StartedServer } from './server.ts'
import { isTurnBoundary, sessionOf, translate } from './translate.ts'

interface TurnState {
  key: TurnKey
  prompt: string
  startedAt: number
  /**
   * Last time the child produced anything, which is what separates a quiet turn from a stopped
   * one. Maintained by `touch` on the same events `isChildOutput` counts (#220).
   */
  lastActivityAt?: number
  /** Owns this turn's verdict, so a deadline grades it the way every other adapter's does. */
  tracker: TurnVerdictTracker
  /** Set when this adapter asked for the turn to stop, so the verdict can say who ended it. */
  cancelled: boolean
  /** Whether the child produced anything at all, which is what separates quiet from silent. */
  spoke: boolean
  ended: boolean
}

export interface OpenCodeApiAdapterOptions {
  cwd: string
  role: string
  command?: string | undefined
  /** The absolute per-turn deadline. Refreshed by nothing, as everywhere else. */
  watchdogMs?: number | undefined
  /**
   * The silence deadline: how long a turn may produce NOTHING before it is called stopped.
   *
   * Accepted here because the seat declares `silence: supported`, and a clock the run cannot
   * configure is one the operator's `--silence-timeout` never reaches. Omitted at first along
   * with the watchdog itself (#220), which is how a declared clock came to be no clock at all.
   */
  idleMs?: number | undefined
  /**
   * Injected so the adapter can be driven against a stand-in server.
   *
   * Not a testing back door bolted on: the alternative is tests that spawn a real OpenCode, which
   * makes the suite depend on a vendor binary, a model provider and a network -- and makes the
   * timing cases this adapter is mostly ABOUT (a stream dying mid-turn, a cancel racing a
   * boundary) impossible to produce on demand.
   */
  spawnFn?: Parameters<typeof startOpenCodeServer>[0]['spawnFn']
}

export class OpenCodeApiAdapter implements AgentSession {
  readonly agent = 'opencode'
  readonly guarantees: Guarantees
  readonly sessionId: string

  #state: SessionState = 'running'
  #server: StartedServer
  #client: OpenCodeClient
  #events = new AsyncQueue<AgentEvent>()
  #turns: TurnState[] = []
  #seq = 0
  #closed = false
  #abort = new AbortController()
  #following: Promise<void>
  /**
   * The clock this adapter DECLARED and did not arm (#220).
   *
   * `OPENCODE_API_DEADLINES` promises this seat both a silence clock and an absolute one, and
   * for one commit it had neither: `watchdogMs` was accepted and ignored, with a comment saying
   * a deadline would be wired later. A real run then hung for 72 minutes with the turn open and
   * nothing to notice, because the relay awaits an exchange that a clock is the only thing that
   * releases (`DEFAULT_WATCHDOG_MS`: "a turn that output can extend without limit is a run whose
   * ceilings can never fire").
   *
   * A declaration written from what a transport COULD support rather than what the adapter does
   * is the failure this repository spent #196, #201, #202 and #205 removing. This is the same
   * shape, committed hours after closing the last of them.
   */
  #watchdog: TurnWatchdog<TurnState>
  readonly #watchdogMs: number | undefined

  private constructor(
    server: StartedServer,
    client: OpenCodeClient,
    sessionId: string,
    watchdogMs?: number,
    idleMs?: number,
  ) {
    this.#server = server
    this.#client = client
    this.sessionId = sessionId
    // MEDIATED: this adapter is the only thing that can put a prompt into this session, because
    // it created the session and holds the only credential for the server it lives on. Nothing
    // else is typing, so a turn nobody here started cannot appear.
    this.guarantees = guaranteesFor('mediated')
    // Armed on `send`, touched by child output, disarmed when the turn ends -- the same three
    // points the pty adapters use. A hung turn produces no events at all, so a clock is the only
    // thing that can notice it.
    this.#watchdogMs = watchdogMs
    this.#watchdog = new TurnWatchdog<TurnState>(
      watchdogMs ?? DEFAULT_WATCHDOG_MS,
      (turn, update) => {
        if (!update?.verdict || turn.ended) return
        turn.ended = true
        this.#emit({
          type: 'turn_end',
          turnKey: turn.key,
          seq: ++this.#seq,
          at: Date.now(),
          provisional: false,
          verdict: update.verdict,
          // Nothing from the child said this. The clock did.
          synthesized: true,
        })
      },
      idleMs,
    )
    this.#following = this.#follow()
  }

  static async start(opts: OpenCodeApiAdapterOptions): Promise<OpenCodeApiAdapter> {
    const server = await startOpenCodeServer({
      cwd: opts.cwd,
      ...(opts.command ? { command: opts.command } : {}),
      ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
    })
    const client = new OpenCodeClient({ baseUrl: server.baseUrl, password: server.password })
    let sessionId: string
    try {
      sessionId = await client.createSession()
    } catch (e) {
      // The server started and would not give us a session. Stopping it here rather than leaving
      // an orphan listening on a port nobody will ever connect to again.
      await server.stop()
      throw e
    }
    return new OpenCodeApiAdapter(server, client, sessionId, opts.watchdogMs, opts.idleMs)
  }

  get state(): SessionState {
    return this.#state
  }

  get acceptsInput(): boolean {
    return this.#state === 'running'
  }

  /**
   * Read the event stream for as long as the session lives.
   *
   * The stream ENDING is a fact about the transport rather than about a turn, so it is reported
   * as one: a turn in flight when the server stops talking is not `completed`, and inventing a
   * verdict for it is what `#146` says must not happen.
   */
  async #follow(): Promise<void> {
    try {
      for await (const e of this.#client.events(this.#abort.signal)) {
        const open = this.#openTurn()
        const mapped = translate(e, {
          sessionId: this.sessionId,
          ...(open ? { openTurnKey: String(open.key) } : {}),
          next: () => ++this.#seq,
          now: () => Date.now(),
        })
        if (mapped) {
          if (open) {
            open.spoke = true
            // A SIGN OF LIFE, so the silence deadline moves out. The deltas that make this seat
            // noisy (#219) are the same thing that lets it have a silence clock at all -- which
            // is why coalescing them must keep touching, not just emit less.
            open.lastActivityAt = Date.now()
            this.#watchdog.touch(String(open.key))
          }
          this.#events.push(mapped)
        }
        // THE SESSION IS CHECKED HERE TOO, and it was not at first. `translate` filters by
        // session, so a stranger's output could never become our event -- but the boundary check
        // sat outside that filter, and one server sends every session's events down one stream.
        // Another seat going idle would have ended this seat's turn, silently: the turn would
        // simply finish early and the seat would look fast. A test written for exactly that
        // caught it.
        if (isTurnBoundary(e) && open && sessionOf(e) === this.sessionId) this.#endTurn(open)
      }
    } catch (e) {
      if (this.#closed) return
      this.#emit({
        type: 'error',
        message: e instanceof OpenCodeApiError ? `${e.kind}: ${e.message}` : String(e),
        // FATAL: the event stream is the only thing this adapter hears. Losing it is not a
        // degraded seat, it is a blind one -- every turn after this would end `transport_lost`
        // for want of a `session.idle` nobody is listening for.
        fatal: true,
        seq: ++this.#seq,
        at: Date.now(),
        provisional: false,
      })
    }
    // The stream is gone. Any turn still open is unresolved, and says so.
    const open = this.#openTurn()
    if (open && !this.#closed) this.#endTurn(open, 'transport_lost')
  }

  #openTurn(): TurnState | undefined {
    return this.#turns.find((t) => !t.ended)
  }

  #emit(e: AgentEvent): void {
    this.#events.push(e)
  }

  #endTurn(turn: TurnState, forced?: 'transport_lost'): void {
    if (turn.ended) return
    turn.ended = true
    // Every path out of a turn passes through here, which is why the disarm belongs here rather
    // than beside each caller: a clock left armed on a settled turn fires a second verdict for it.
    this.#watchdog.disarm(String(turn.key))
    const outcome = forced ?? (turn.cancelled ? 'cancelled' : 'completed')
    this.#emit({
      type: 'turn_end',
      turnKey: turn.key,
      seq: ++this.#seq,
      at: Date.now(),
      provisional: false,
      // PROVEN for the ordinary case: `session.idle` is the server saying the session stopped
      // working, which is a statement about this turn rather than an inference from a process
      // going away. `transport_lost` is uncertain by construction -- the turn may well have
      // finished after we stopped listening.
      verdict: {
        outcome,
        confidence: forced ? 'uncertain' : 'proven',
        provenance: [
          forced
            ? { source: 'transport', detail: 'the event stream ended while this turn was open' }
            : { source: 'hook', detail: 'session.idle' },
        ],
      },
      synthesized: forced !== undefined,
    })
  }

  async send(message: string, _provenance: SendProvenance): Promise<TurnKey> {
    if (this.#state !== 'running') throw new Error(`session is ${this.#state}; it is not accepting work`)
    const open = this.#openTurn()
    // The same refusal the pty adapters make. A second prompt into a session already working is
    // not queued by the server, and pretending it opened a turn would attribute the first turn's
    // events to the second.
    if (open) throw new Error('a turn is already in flight on this session')

    const key = turnKey(`${this.sessionId}-turn-${this.#turns.length}`)
    const turn: TurnState = {
      key,
      prompt: message,
      startedAt: Date.now(),
      tracker: new TurnVerdictTracker({
        agent: this.agent,
        orchestrator: { sentCancel: false, inputIsMediated: this.guarantees.inputOwnership === 'mediated' },
        watchdogSeconds: (this.#watchdogMs ?? DEFAULT_WATCHDOG_MS) / 1000,
      }),
      cancelled: false,
      spoke: false,
      ended: false,
    }
    this.#turns.push(turn)
    // Announced BEFORE the POST, so a prompt the server refuses still has a turn to attach the
    // failure to rather than an error belonging to nothing.
    this.#emit({ type: 'turn_start', prompt: message, turnKey: key, seq: ++this.#seq, at: turn.startedAt, provisional: false })
    // ARMED HERE, not after the POST succeeds. A prompt the server accepts and then never
    // answers is exactly the case that hung for 72 minutes, and the window between sending and
    // hearing back is the one the clock exists to cover.
    this.#watchdog.arm(String(key), turn)
    try {
      await this.#client.promptAsync(this.sessionId, message)
    } catch (e) {
      this.#endTurn(turn, 'transport_lost')
      throw e
    }
    return key
  }

  /** A slash command is a POST here, not a keystroke: `/session/{id}/command` (#215). */
  async submitRaw(text: string, _detail?: string): Promise<void> {
    if (this.#state !== 'running') throw new Error(`session is ${this.#state}; it is not accepting input`)
    await this.#client.command(this.sessionId, text)
  }

  async cancel(): Promise<TurnKey | undefined> {
    const turn = this.#openTurn()
    if (!turn) return undefined
    turn.cancelled = true
    // Nothing is killed. The server stops the turn and the session survives it, which is what
    // makes cancellation attributable here rather than inferred from a signal.
    await this.#client.abort(this.sessionId)
    return turn.key
  }

  async quiesce(): Promise<void> {
    if (this.#state === 'quiesced') return
    if (this.#state !== 'running') throw new Error(`cannot quiesce from ${this.#state}`)
    this.#state = 'quiesced'
  }

  async unquiesce(): Promise<void> {
    if (this.#state === 'running') return
    if (this.#state !== 'quiesced') throw new Error(`cannot unquiesce from ${this.#state}`)
    this.#state = 'running'
  }

  async beginRotation(): Promise<void> {
    if (this.#state !== 'quiesced') throw new Error(`rotation requires a quiesced session, not ${this.#state}`)
    this.#state = 'rotating'
  }

  async decidePermission(_decision: 'allow' | 'deny'): Promise<void> {
    // `/session/{id}/permissions/{permissionID}` exists and `permission.asked` is in the event
    // vocabulary, so this IS reachable -- but neither fired in the probed turn, so the payload
    // shape is unknown. Refusing is honest; implementing it from the route name would be reading
    // a name as a behaviour, which is the mistake this adapter exists partly to stop repeating.
    throw new Error(
      'opencode-api: permission replies are not wired yet. The route and the event exist ' +
        '(/session/{id}/permissions/{id}, permission.asked) but neither has been observed firing.',
    )
  }

  events(): AsyncIterable<AgentEvent> {
    return this.#events
  }

  async snapshot(): Promise<SessionSnapshot> {
    return {
      sessionId: this.sessionId,
      agent: this.agent,
      cwd: '',
      role: '',
      guarantees: this.guarantees,
      compactionGeneration: 0,
      builtAt: Date.now(),
      turns: this.#turns.map((t) => ({
        key: t.key,
        prompt: t.prompt,
        state: t.ended ? ('completed' as const) : ('in_progress' as const),
        toolCalls: [],
      })),
    }
  }

  async fork(): Promise<AgentSession> {
    // `/session/{id}/fork` exists and is one of the few things this transport could do that no
    // other can. Unimplemented rather than guessed: what a forked session inherits, and whether
    // its events arrive on the same stream, are both unobserved.
    throw new Error('opencode-api: fork is not implemented (the /session/{id}/fork route exists but is unverified)')
  }

  async close(mode: CloseMode = 'graceful'): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#state = 'terminated'
    this.#watchdog.disarmAll()
    this.#abort.abort()
    // The follow loop is awaited before the server goes, so a `session.idle` already on the wire
    // is read rather than lost to the teardown that was about to happen anyway.
    await Promise.race([this.#following, new Promise((r) => setTimeout(r, 2_000).unref?.())])
    if (mode !== 'abandoned') await this.#server.stop()
    this.#events.close()
  }
}
