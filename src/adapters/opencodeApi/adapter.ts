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
import { isSeatLiveness, isTurnBoundary, sessionError, sessionOf, translate } from './translate.ts'

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
  /**
   * What the server said went wrong, if it said anything (#224).
   *
   * Held on the turn rather than ending it on the spot. `session.error` is followed by
   * `session.idle`, so the ordinary boundary still closes the turn; what this changes is the
   * verdict that boundary produces. Ending on the error itself was the alternative and is
   * rejected on evidence: only one error has ever been captured, and if a server can report a
   * failure it then recovers from, ending here would truncate a working turn on the strength of
   * a guess. If no idle follows, the silence clock reaches it, which is what that clock is for.
   */
  failure?: string | undefined
  /** Streamed text not yet emitted as a message (#219). */
  pending?: string | undefined
  flushTimer?: ReturnType<typeof setTimeout> | undefined
  ended: boolean
}

/**
 * How long streamed text is held before it is emitted as one message (#219).
 *
 * Short enough that a watching human sees progress rather than a stall, and long enough that a
 * token-at-a-time stream becomes sentences. At 250ms the run that found this would have produced
 * a few hundred messages instead of 46,289.
 */
const FLUSH_MS = 250

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
   * The model every prompt asks for, as `provider/model` (#221).
   *
   * A SESSION-LEVEL SETTING DELIVERED PER PROMPT, because that is where this transport puts it:
   * `prompt_async` takes a `model` in its body. The old adapter took it in argv, which is why
   * `--model` reached a seat at all; when the transport changed, launch args stopped reaching
   * anything and were dropped in silence while the run report went on stating them.
   */
  model?: string | undefined
  /**
   * Launch args this transport cannot use, carried so it can SAY so.
   *
   * A server takes no per-turn argv. Anything that is not the model has nowhere to go, and the
   * failure worth avoiding is not that it is unusable -- it is that it was unusable and nobody
   * was told, while the run report recorded it as the launch configuration.
   */
  ignoredArgs?: readonly string[] | undefined
  /**
   * Notices the registry composed, which this adapter could not have written itself (#223).
   *
   * The permission posture is the case it exists for: what a seat's configured mode WAS is
   * known where the launch args are resolved, and whether this transport can honour it is known
   * here. Neither half is a notice on its own.
   */
  extraNotices?: readonly string[] | undefined
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
  readonly #model: string | undefined
  readonly startupNotices: readonly string[] | undefined

  private constructor(
    server: StartedServer,
    client: OpenCodeClient,
    sessionId: string,
    watchdogMs?: number,
    idleMs?: number,
    model?: string,
    ignoredArgs?: readonly string[],
    extraNotices?: readonly string[],
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
    this.#model = model
    // SAID AT STARTUP, where a notice is read, rather than left for someone to discover from a
    // seat behaving as though it had been configured differently.
    const notices = [
      ...(ignoredArgs && ignoredArgs.length > 0
        ? [
            `opencode: ${JSON.stringify([...ignoredArgs])} cannot be delivered to this seat. ` +
              `Its child is a server rather than a turn, so it takes no per-turn argv; only the ` +
              `model is carried, and it goes with each prompt. See #221.`,
          ]
        : []),
      ...(extraNotices ?? []),
    ]
    this.startupNotices = notices.length > 0 ? notices : undefined
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
    return new OpenCodeApiAdapter(
      server,
      client,
      sessionId,
      opts.watchdogMs,
      opts.idleMs,
      opts.model,
      opts.ignoredArgs,
      opts.extraNotices,
    )
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
            // A SIGN OF LIFE ON EVERY DELTA, even though only some of them are emitted below.
            // Liveness and narration are different questions: the silence clock wants to know
            // that SOMETHING arrived, and a reader wants sentences. Coalescing the second must
            // not coarsen the first, or the seat would look quiet between flushes (#219, #220).
            open.lastActivityAt = Date.now()
            this.#watchdog.touch(String(open.key))
          }
          if (mapped.type === 'message' && open) this.#buffer(open, mapped.text)
          else this.#events.push(mapped)
        }
        // THE SESSION IS CHECKED HERE TOO, and it was not at first. `translate` filters by
        // session, so a stranger's output could never become our event -- but the boundary check
        // sat outside that filter, and one server sends every session's events down one stream.
        // Another seat going idle would have ended this seat's turn, silently: the turn would
        // simply finish early and the seat would look fast. A test written for exactly that
        // caught it.
        // A SEAT AT WORK IS ALIVE EVEN WHEN IT IS SAYING NOTHING (#226). Narration is what
        // `translate` returns; liveness is a wider set, and conflating them let a turn spent
        // inside one long tool call look silent to a clock whose whole job is telling those
        // apart. Touched without emitting: nothing here is worth putting in front of a reader.
        if (open && isSeatLiveness(e) && sessionOf(e) === this.sessionId) {
          open.lastActivityAt = Date.now()
          this.#watchdog.touch(String(open.key))
        }
        // RECORDED BEFORE THE BOUNDARY IS CHECKED, because the two arrive together and in this
        // order. A failure noticed after `#endTurn` had already graded the turn would be a note
        // attached to a verdict that has stopped being true.
        const failure = sessionError(e)
        if (failure !== undefined && sessionOf(e) === this.sessionId) {
          // The operator hears it as well as the verdict. A run whose seat is misconfigured --
          // a disabled model, an expired key -- is a run someone can fix while it is happening,
          // but only if the reason reaches them rather than only the run report.
          this.#emit({
            type: 'error',
            message: failure,
            // NOT FATAL. The stream is healthy and the seat can take another prompt; it is this
            // TURN that failed. Marking it fatal would retire a session over one bad model name.
            fatal: false,
            seq: ++this.#seq,
            at: Date.now(),
            provisional: false,
          })
          if (open) open.failure = failure
        }
        if (isTurnBoundary(e) && open && sessionOf(e) === this.sessionId) {
          // FLUSHED BEFORE THE ENDING, or a turn's last words arrive after its own `turn_end`
          // and a reader sees the verdict before the sentence it was reached on.
          this.#flush(open)
          this.#endTurn(open)
        }
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

  /**
   * Hold streamed text until it is worth reading, then emit it as one message (#219).
   *
   * The first run to use this adapter produced 90,107 characters of prose as 7,402 events -- a
   * median of TEN characters each -- because every `message.part.delta` became an `AgentEvent`.
   * A whole pty run is 81 events. The console rendered it a fragment at a time: "sue. L / et / me
   * re-run cleanly.The" -- narration exists to be read, and that cannot be.
   *
   * Three consumers eat these -- the relay's narration, the console's activity stream, and
   * `events.ndjson` -- so coalescing in any one of them would leave the other two broken. It
   * belongs at the source.
   *
   * FLUSHED ON A TIMER rather than on a part boundary, because a part can be a whole answer: a
   * seat that streams one long reply would otherwise produce nothing until it finished, and a
   * human watching would see silence where the pty adapters show progress. The interval is short
   * against how a person reads and enormous against how fast tokens arrive.
   */
  #buffer(turn: TurnState, text: string): void {
    turn.pending = (turn.pending ?? '') + text
    if (turn.flushTimer) return
    const timer = setTimeout(() => {
      turn.flushTimer = undefined
      this.#flush(turn)
    }, FLUSH_MS)
    timer.unref?.()
    turn.flushTimer = timer
  }

  #flush(turn: TurnState): void {
    if (turn.flushTimer) {
      clearTimeout(turn.flushTimer)
      turn.flushTimer = undefined
    }
    const text = turn.pending
    turn.pending = undefined
    if (!text) return
    this.#emit({
      type: 'message',
      role: 'assistant',
      text,
      turnKey: turn.key,
      seq: ++this.#seq,
      at: Date.now(),
      provisional: false,
    })
  }

  #endTurn(turn: TurnState, forced?: 'transport_lost'): void {
    if (turn.ended) return
    turn.ended = true
    // Every path out of a turn passes through here, which is why the disarm belongs here rather
    // than beside each caller: a clock left armed on a settled turn fires a second verdict for it.
    this.#watchdog.disarm(String(turn.key))
    // A REPORTED FAILURE OUTRANKS THE BOUNDARY (#224). `session.idle` says the session stopped
    // working, which is true of a turn that failed as much as of one that succeeded, and reading
    // it as `completed` put `proven` -- the strongest grade the ladder has -- on a 401.
    //
    // `unknown_abnormal_end` rather than a failure outcome of its own, because the union has
    // none and inventing one here would put a value in run reports that nothing else grades.
    // Its definition is "there is evidence the turn ended, but not why"; the why is not lost, it
    // is in the provenance, where the server's own words are quoted rather than summarised.
    const outcome = forced ?? (turn.cancelled ? 'cancelled' : turn.failure ? 'unknown_abnormal_end' : 'completed')
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
        // PROVEN for a reported failure too, and that is not a contradiction: confidence is how
        // sure we are of the OUTCOME, and a server that names its own error is the most direct
        // evidence available that the turn did not do the work.
        confidence: forced ? 'uncertain' : 'proven',
        provenance: [
          forced
            ? { source: 'transport', detail: 'the event stream ended while this turn was open' }
            : turn.failure
              ? { source: 'hook', detail: `session.error: ${turn.failure}` }
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
      await this.#client.promptAsync(this.sessionId, message, this.#model)
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
