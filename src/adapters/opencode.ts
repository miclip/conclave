/**
 * OpenCode, driven through `opencode run --format json`.
 *
 * The third participant, and the first whose lifecycle did not have to be reverse
 * engineered. Claude Code and Codex both required a pty, a generated hook registration and
 * a transcript tail, because neither will simply tell you what it did. OpenCode will:
 * `--format json` writes one JSON record per line to stdout, and those records carry an
 * ANNOUNCED terminal signal rather than one we have to infer.
 *
 * So this adapter has no pty, no hook receiver, no transcript parser and nothing to
 * install. That is not a shortcut -- it is the whole reason OpenCode was worth adding
 * first. If the seam in `contract/session.ts` only fits agents shaped like the two it was
 * derived from, it is not a seam.
 *
 * ## One turn is one process
 *
 * `opencode run` is one-shot: it takes a prompt, works, and exits. Continuity comes from
 * `--session <id>`, which resumes the server-side session with its context intact. So a
 * long-lived Conclave session is a sequence of short-lived children sharing one session id,
 * rather than one child held open at a terminal.
 *
 * Three consequences worth stating, because they are guarantees the other two adapters
 * cannot offer:
 *
 *   - `quiesce()` is exact. Between turns there is no child at all, so a quiesced session
 *     genuinely cannot act. On a pty adapter quiescence is a promise not to type.
 *   - Turn end is announced AND corroborated: `step_finish reason=stop` from the child,
 *     then process exit. Two independent signals for the same fact.
 *   - Cancellation is attributable without qualification. We own the process; killing it
 *     is the cancellation, not a guess about one.
 *
 * ## What it costs
 *
 * Permission mediation. In `run` mode there is no dialog to answer, so `decidePermission`
 * has nothing to decide and `permission_requested` never fires. Permissions are settled
 * before the process starts, by configuration. `permission_refused` is therefore
 * `unsupported` for this adapter rather than merely unverified -- see
 * `conformance/capabilities.ts`. Recording that as a real capability gap is the point; an
 * adapter that quietly no-ops `decidePermission` would look complete and behave worse.
 *
 * ## The wedge, and why `--auto` is not optional
 *
 * A plugin registered without an explicit `permission` config hangs indefinitely on the
 * first tool call that needs approval: the process stays alive, emits nothing, and never
 * exits. One run in the spike sat for 67 minutes. Registering a plugin appears to move
 * permission handling off the headless auto-allow path onto one that waits for a decision
 * `run` cannot supply.
 *
 * This adapter does not register a plugin, so it is not exposed to that path -- but the
 * same class of stall is reachable whenever a tool needs approval and nothing can give it.
 * `--auto` is passed under `bypass` and the reason is recorded in `config/project.ts`
 * beside the other two CLIs' flags.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { createInterface } from 'node:readline'
import type {
  AgentEvent,
  AgentSession,
  CloseMode,
  Guarantees,
  InputOwnership,
  Role,
  SendProvenance,
  SessionSnapshot,
  SessionState,
  TurnKey,
  TurnRecord,
} from '../contract/session.ts'
import { guaranteesFor, turnKey } from '../contract/session.ts'
import type { Confidence, Provenance, TurnLiveness, Verdict } from '../contract/outcome.ts'
import { AsyncQueue } from './asyncQueue.ts'

/**
 * A record from `--format json`, as it actually arrives.
 *
 * Deliberately partial and defensive. This is an undocumented stdout format on a tool that
 * ships often, and the failure mode to avoid is an adapter that throws on an unfamiliar
 * `type` -- an unknown record is not an error, it is a record we do not use yet.
 */
export interface OpenCodeRecord {
  type: string
  timestamp?: number
  sessionID?: string
  part?: {
    type?: string
    text?: string
    tool?: string
    callID?: string
    /** `tool-calls` on an intermediate step, `stop` on the terminal one. */
    reason?: string
    snapshot?: string
    messageID?: string
    tokens?: {
      total?: number
      input?: number
      output?: number
      reasoning?: number
      cache?: { read?: number; write?: number }
    }
    cost?: number
    state?: {
      status?: string
      input?: unknown
      output?: string
      error?: string
      metadata?: unknown
    }
  }
}

export function parseRecord(line: string): OpenCodeRecord | undefined {
  const trimmed = line.trim()
  if (!trimmed || trimmed[0] !== '{') return undefined
  try {
    const value = JSON.parse(trimmed) as OpenCodeRecord
    return typeof value?.type === 'string' ? value : undefined
  } catch {
    // Not every stdout line is a record. Log noise interleaves when the child is run with
    // `--print-logs`, and a partial line is possible if the child dies mid-write.
    return undefined
  }
}

/** Tokens carried by the last `step_finish` of a turn: what the turn actually cost. */
export interface TurnTokens {
  total: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

interface TurnState {
  key: TurnKey
  prompt: string
  state: TurnLiveness
  confidence?: Confidence | undefined
  provenance: Provenance[]
  /** Every text block the model produced, in order. */
  textBlocks: string[]
  toolCalls: { tool: string; failed: boolean; args?: string | undefined }[]
  steps: number
  tokens?: TurnTokens | undefined
  /** Content hash from the last step that reported one. Artifact attribution, free. */
  snapshot?: string | undefined
  startedAt: number
  endedAt?: number | undefined
}

export interface OpenCodeAdapterOptions {
  cwd: string
  role: Role
  inputOwnership?: InputOwnership | undefined
  /** Extra args, e.g. `-m provider/model` and `--auto`. Model selection lives here. */
  args?: string[] | undefined
  /** Overridable so a test can point at a stub without a real OpenCode on PATH. */
  command?: string | undefined
  /** Kills a turn that produces nothing terminal. Absent means wait indefinitely. */
  watchdogMs?: number | undefined
}

export class OpenCodeRunAdapter implements AgentSession {
  readonly agent = 'opencode'
  readonly guarantees: Guarantees

  #opts: OpenCodeAdapterOptions
  #events = new AsyncQueue<AgentEvent>()
  #turns: TurnState[] = []
  #seq = 0
  #turnCounter = 0
  /** Learned from the first record. Absent until the first turn has spoken. */
  #sessionId = ''
  #state: SessionState = 'running'
  #child: ChildProcessByStdio<null, Readable, Readable> | undefined
  #closed = false
  #closeMode: CloseMode | undefined
  #cancelling = false

  private constructor(opts: OpenCodeAdapterOptions) {
    this.#opts = opts
    this.guarantees = guaranteesFor(opts.inputOwnership ?? 'mediated')
  }

  /**
   * No boot. Every other adapter starts a child here and waits for a readiness signal;
   * there is nothing to start until there is something to say, and no readiness signal
   * exists because there is no resident process to become ready.
   *
   * `readinessSignal: 'first_turn'` in the capabilities is therefore literal rather than a
   * concession: the first turn IS the first evidence the agent works.
   */
  static async start(opts: OpenCodeAdapterOptions): Promise<OpenCodeRunAdapter> {
    return new OpenCodeRunAdapter(opts)
  }

  get sessionId(): string {
    return this.#sessionId
  }

  get state(): SessionState {
    return this.#state
  }

  get closeMode(): CloseMode | undefined {
    return this.#closeMode
  }

  /** True once a turn has run and OpenCode has told us the id to resume. */
  get sessionIdentified(): boolean {
    return this.#sessionId !== ''
  }

  #next(): number {
    return this.#seq++
  }

  #emit(e: AgentEvent): void {
    this.#events.push(e)
  }

  events(): AsyncIterable<AgentEvent> {
    return this.#events
  }

  // --- sending -----------------------------------------------------------------------

  async send(message: string, _provenance: SendProvenance): Promise<TurnKey> {
    if (this.#closed) throw new Error('opencode: session is closed')
    if (this.#state !== 'running') {
      throw new Error(`opencode: session is ${this.#state} and cannot accept work`)
    }
    if (this.#child) throw new Error('opencode: a turn is already in flight')

    const key = turnKey(`oc-${++this.#turnCounter}`)
    const turn: TurnState = {
      key,
      prompt: message,
      state: 'in_progress',
      provenance: [],
      textBlocks: [],
      toolCalls: [],
      steps: 0,
      startedAt: Date.now(),
    }
    this.#turns.push(turn)

    this.#emit({
      type: 'turn_start',
      turnKey: key,
      seq: this.#next(),
      at: turn.startedAt,
      provisional: false,
      prompt: message,
    })

    // Not awaited: send() returns once the turn is under way, matching the other adapters.
    void this.#runTurn(turn, message)
    return key
  }

  #args(prompt: string): string[] {
    const args = ['run', '--format', 'json']
    // Resume rather than start over. Without this every turn is a fresh context and the
    // participant has no memory of the conversation it is supposedly having.
    if (this.#sessionId) args.push('--session', this.#sessionId)
    args.push(...(this.#opts.args ?? []))
    // Last, and after everything flag-shaped: `message..` is variadic and positional, so a
    // prompt beginning with `-` would otherwise be parsed as an option.
    args.push('--', prompt)
    return args
  }

  async #runTurn(turn: TurnState, prompt: string): Promise<void> {
    const child = spawn(this.#opts.command ?? 'opencode', this.#args(prompt), {
      cwd: this.#opts.cwd,
      // No tty. `run` is non-interactive by design, and giving it one would reintroduce
      // exactly the interactive prompt path that wedges.
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.#child = child

    let watchdog: NodeJS.Timeout | undefined
    if (this.#opts.watchdogMs !== undefined) {
      watchdog = setTimeout(() => {
        turn.provenance.push({
          source: 'watchdog',
          detail: `no terminal record within ${this.#opts.watchdogMs}ms`,
        })
        child.kill('SIGTERM')
      }, this.#opts.watchdogMs)
    }

    let stderr = ''
    child.stderr.on('data', (c: Buffer) => {
      // Bounded: a failing child can be noisy, and this is only ever used as a message.
      if (stderr.length < 8192) stderr += c.toString('utf8')
    })

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    for await (const line of lines) {
      const record = parseRecord(line)
      if (record) this.#onRecord(turn, record)
    }

    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((r) =>
      child.once('close', (c, s) => r([c, s])),
    )
    if (watchdog) clearTimeout(watchdog)
    this.#child = undefined
    this.#settle(turn, code, signal, stderr)
  }

  #onRecord(turn: TurnState, record: OpenCodeRecord): void {
    // Every record carries it; the first one to arrive is what makes the session resumable.
    if (!this.#sessionId && record.sessionID) this.#sessionId = record.sessionID

    const part = record.part ?? {}
    switch (record.type) {
      case 'step_start':
        turn.steps += 1
        if (part.snapshot) turn.snapshot = part.snapshot
        break

      case 'text': {
        const text = part.text ?? ''
        if (!text) break
        turn.textBlocks.push(text)
        this.#emit({
          type: 'message',
          turnKey: turn.key,
          seq: this.#next(),
          at: record.timestamp ?? Date.now(),
          provisional: false,
          role: 'assistant',
          text,
        })
        break
      }

      case 'tool_use': {
        const status = part.state?.status
        // A tool is reported at each transition (pending, running, completed). Record it
        // once, when it settles, so `toolCalls` counts calls rather than transitions.
        if (status !== 'completed' && status !== 'error') break
        const failed = status === 'error'
        const input = part.state?.input
        turn.toolCalls.push({
          tool: part.tool ?? 'unknown',
          failed,
          args: input === undefined ? undefined : JSON.stringify(input),
        })
        this.#emit({
          type: 'tool_use',
          turnKey: turn.key,
          seq: this.#next(),
          at: record.timestamp ?? Date.now(),
          provisional: false,
          tool: part.tool ?? 'unknown',
          input,
          failed,
        })
        break
      }

      case 'step_finish': {
        if (part.snapshot) turn.snapshot = part.snapshot
        const t = part.tokens
        if (t) {
          turn.tokens = {
            total: t.total ?? 0,
            input: t.input ?? 0,
            output: t.output ?? 0,
            reasoning: t.reasoning ?? 0,
            cacheRead: t.cache?.read ?? 0,
            cacheWrite: t.cache?.write ?? 0,
          }
        }
        // The announced terminal signal. `tool-calls` means another step follows; `stop`
        // means the model is done. This is what makes `completed` observed rather than
        // inferred from the process having exited.
        if (part.reason === 'stop') {
          turn.provenance.unshift({ source: 'hook', detail: 'step_finish reason=stop' })
        }
        break
      }

      default:
        // Unknown record types are ignored on purpose -- see OpenCodeRecord.
        break
    }
  }

  /**
   * Turn the child's exit into a verdict.
   *
   * Announced completion outranks exit status, and deliberately so: a run can exit 0 with a
   * silently failed auxiliary model call, so exit 0 alone is NOT evidence that the turn
   * finished. `step_finish reason=stop` is.
   */
  #settle(
    turn: TurnState,
    code: number | null,
    signal: NodeJS.Signals | null,
    stderr: string,
  ): void {
    if (turn.state !== 'in_progress') return
    turn.endedAt = Date.now()

    const announced = turn.provenance.some((p) => p.detail === 'step_finish reason=stop')
    const killed = signal !== null
    let verdict: Verdict

    if (announced) {
      verdict = {
        outcome: 'completed',
        confidence: 'proven',
        provenance: [
          { source: 'hook', detail: 'step_finish reason=stop' },
          { source: 'process', detail: `exit code ${code}` },
        ],
      }
    } else if (this.#cancelling && killed) {
      verdict = {
        outcome: 'cancelled',
        confidence: 'proven',
        provenance: [
          // We own the process, so this is bookkeeping rather than inference -- the
          // qualification the pty adapters have to carry does not apply.
          { source: 'orchestrator', detail: 'cancel() killed the run' },
          { source: 'process', detail: `signal ${signal}` },
        ],
      }
    } else if (killed) {
      const watchdogged = turn.provenance.some((p) => p.source === 'watchdog')
      verdict = {
        outcome: watchdogged ? 'timed_out' : 'process_exited',
        confidence: 'proven',
        provenance: [
          ...turn.provenance.filter((p) => p.source === 'watchdog'),
          { source: 'process', detail: `signal ${signal}` },
        ],
      }
    } else {
      // Exited without saying it was done. The turn produced no terminal record, so what
      // happened is genuinely unknown -- naming it `completed` because the code was 0
      // would be the exact error this adapter's stop signal exists to prevent.
      verdict = {
        outcome: 'unknown_abnormal_end',
        confidence: 'assumed',
        provenance: [
          { source: 'process', detail: `exit code ${code}, no step_finish reason=stop` },
          ...(stderr.trim()
            ? [{ source: 'process' as const, detail: stderr.trim().slice(0, 400), caveat: true }]
            : []),
        ],
      }
    }

    turn.state = verdict.outcome
    turn.confidence = verdict.confidence
    turn.provenance = verdict.provenance

    this.#emit({
      type: 'turn_end',
      turnKey: turn.key,
      seq: this.#next(),
      at: turn.endedAt,
      provisional: false,
      verdict,
      // Never synthesized when announced: the child said so.
      synthesized: !announced,
    })
    this.#cancelling = false
  }

  // --- lifecycle ---------------------------------------------------------------------

  /**
   * Exact rather than promissory. Between turns there is no child process, so a quiesced
   * OpenCode session is incapable of acting rather than merely undisturbed.
   */
  async quiesce(): Promise<void> {
    if (this.#state === 'quiesced') return
    if (this.#state !== 'running') throw new Error(`cannot quiesce from ${this.#state}`)
    this.#state = 'quiesced'
  }

  async unquiesce(): Promise<void> {
    if (this.#state === 'running') return
    if (this.#state !== 'quiesced' && this.#state !== 'rotating') {
      throw new Error(`cannot unquiesce from ${this.#state}`)
    }
    this.#state = 'running'
  }

  async beginRotation(): Promise<void> {
    if (this.#state !== 'quiesced') {
      throw new Error(`rotation requires a quiesced session, not ${this.#state}`)
    }
    this.#state = 'rotating'
  }

  async cancel(): Promise<TurnKey | undefined> {
    const live = this.#turns.find((t) => t.state === 'in_progress')
    if (!live || !this.#child) return undefined
    this.#cancelling = true
    // SIGTERM and let it close: the child owns the server-side session, and killing it
    // outright risks leaving that session mid-write.
    this.#child.kill('SIGTERM')
    return live.key
  }

  /**
   * Unsupported, loudly.
   *
   * `run` has no permission dialog -- approval is settled by configuration before the
   * process starts. Silently resolving would let a caller believe it had made a decision
   * that was never offered, and the relay would go on waiting for a turn that already
   * decided for itself.
   */
  async decidePermission(_decision: 'allow' | 'deny'): Promise<void> {
    throw new Error(
      'opencode: permissions are settled by configuration before the run starts, so there ' +
        'is no pending request to decide. Set permissions in .conclave/config.json.',
    )
  }

  /**
   * Rebuilt from records this adapter received, not re-read from a store.
   *
   * The distinction that motivates `snapshot()` -- that a transcript is not append-only and
   * compaction rewrites it -- does not apply here: the stdout of a finished process cannot
   * be revised. So no `revision` event is ever emitted, and `compactionGeneration` stays 0.
   *
   * Whether OpenCode compacts server-side across resumed sessions is UNTESTED. If it does,
   * this is where that would have to be reconciled, and the honest position until someone
   * runs a long enough session is that we do not know.
   */
  async snapshot(): Promise<SessionSnapshot> {
    const turns: TurnRecord[] = this.#turns.map((t) => ({
      key: t.key,
      prompt: t.prompt,
      state: t.state,
      confidence: t.confidence,
      provenance: t.provenance.length ? t.provenance : undefined,
      // Narration for the human: every block, in order, blank-line separated.
      assistantText: t.textBlocks.length ? t.textBlocks.join('\n\n') : undefined,
      // The report for the other participant: the closing block alone. The two adapters
      // silently disagreed about this once; here they are separated at the source.
      report: t.textBlocks.length ? t.textBlocks[t.textBlocks.length - 1] : undefined,
      toolCalls: t.toolCalls,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
    }))

    return {
      sessionId: this.#sessionId,
      agent: this.agent,
      cwd: this.#opts.cwd,
      role: this.#opts.role,
      turns,
      guarantees: this.guarantees,
      compactionGeneration: 0,
      builtAt: Date.now(),
    }
  }

  /**
   * A fork is a new adapter over the same session id with `--fork`, which OpenCode
   * supports natively. Not wired yet: `--fork` needs a live check that a forked session
   * really is independent, and claiming it on the strength of a help string is how the
   * `session.next.step.ended` mistake happened.
   */
  async fork(): Promise<AgentSession> {
    throw new Error('opencode: fork is not implemented (see --fork, unverified)')
  }

  async close(mode: CloseMode = 'graceful'): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#closeMode = mode
    if (this.#child) {
      if (mode === 'graceful') this.#child.kill('SIGTERM')
      // `abandoned` asserts nothing about the child, so it is left alone deliberately.
    }
    this.#state = 'terminated'
    this.#events.close()
  }

  /** Per-step token accounting from the last `step_finish`. Neither pty adapter has this. */
  tokensFor(key: TurnKey): TurnTokens | undefined {
    return this.#turns.find((t) => t.key === key)?.tokens
  }

  /** Content hash of the workspace as OpenCode last saw it. Attribution without guessing. */
  snapshotHashFor(key: TurnKey): string | undefined {
    return this.#turns.find((t) => t.key === key)?.snapshot
  }
}
