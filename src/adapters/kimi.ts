/**
 * Kimi CLI, driven through `kimi --print --output-format stream-json`.
 *
 * The fourth participant. Like OpenCode it needs no pty, but for a different reason: Kimi's
 * headless mode emits a structured MESSAGE stream rather than a lifecycle stream, so what
 * arrives is the conversation itself in OpenAI-chat shape.
 *
 *   {role: "assistant", content: [{type: "think"|"text", ...}], tool_calls: [...]}
 *   {role: "tool", content: ..., tool_call_id: "..."}
 *   {role: "assistant", content: [...]}            <- no tool_calls: the turn is over
 *
 * ## Where the evidence is weaker than OpenCode's, and why that is recorded rather than hidden
 *
 * OpenCode announces its own turn end (`step_finish reason=stop`). Kimi, in this output mode,
 * does not. Completion is inferred from the shape of the last message plus the process
 * exiting, which is a genuinely weaker claim, and the capabilities grade says so.
 *
 * Kimi DOES have an announced terminal signal -- a `Stop` hook, one of thirteen it supports,
 * all carrying `{hook_event_name, session_id, cwd, ...}` exactly as Claude Code's do. It is
 * not used here yet. Wiring it would upgrade `completed` from inferred to announced and would
 * additionally give `PostToolUseFailure` (a failed tool distinguished at the source, which
 * this adapter currently cannot do) and `PreCompact`/`PostCompact`. That is issue #24's
 * follow-up, and it is cheap because hooks are declared in the same generated config file
 * this adapter already writes -- no mutation of the user's own configuration.
 *
 * ## Two things this mode gives up
 *
 * `--print` auto-approves tool calls and auto-dismisses AskUserQuestion for the invocation.
 * There is no permission dialog to mediate, so `decidePermission` throws rather than
 * pretending, and `permission_refused` is `unsupported` -- the same honest gap as OpenCode.
 *
 * The default (text) UI carries a `StatusUpdate` with `context_usage` as a fraction of the
 * limit, per turn. `stream-json` omits it. That measurement is the one the rotation
 * experiments have been unable to take (see spikes/experiments/04-complaint-as-signal.md),
 * so losing it here is a real cost and the reason the hook path is worth taking next.
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

/** One line of `--output-format stream-json`. Partial and defensive, as OpenCode's is. */
export interface KimiRecord {
  role?: string
  /** A string on some tool results, a list of parts on assistant messages. */
  content?: string | { type?: string; text?: string; think?: string }[]
  tool_calls?: {
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }[]
  tool_call_id?: string
}

export function parseRecord(line: string): KimiRecord | undefined {
  const trimmed = line.trim()
  if (!trimmed || trimmed[0] !== '{') return undefined
  try {
    const value = JSON.parse(trimmed) as KimiRecord
    return typeof value?.role === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

/** Text parts only. `think` is reasoning and is deliberately not part of the report. */
export function textOf(content: KimiRecord['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text!)
    .join('\n\n')
}

/**
 * The session id, which Kimi prints to STDERR as a resume instruction rather than to the
 * structured stream:
 *
 *     To resume this session: kimi -r e5c1ee8d-5bc8-41c4-9acb-de94ccd28c9e
 *
 * Parsing human-facing text for a machine-readable fact is unpleasant and is done here
 * because it is the only channel that carries it. If a future version puts the id in the
 * stream, or a hook supplies `session_id`, that is strictly better and this should go.
 */
export function sessionIdFrom(stderr: string): string | undefined {
  return /kimi\s+-r\s+([0-9a-f-]{36})/i.exec(stderr)?.[1]
}

interface TurnState {
  key: TurnKey
  prompt: string
  state: TurnLiveness
  confidence?: Confidence | undefined
  provenance: Provenance[]
  textBlocks: string[]
  toolCalls: { tool: string; failed: boolean; args?: string | undefined }[]
  /** True once an assistant message arrives carrying no tool calls. */
  sawFinalAssistant: boolean
  startedAt: number
  endedAt?: number | undefined
}

export interface KimiAdapterOptions {
  cwd: string
  role: Role
  inputOwnership?: InputOwnership | undefined
  /** Extra args. Model selection and `--config-file` live here. */
  args?: string[] | undefined
  command?: string | undefined
  watchdogMs?: number | undefined
}

export class KimiPrintAdapter implements AgentSession {
  readonly agent = 'kimi'
  readonly guarantees: Guarantees

  #opts: KimiAdapterOptions
  #events = new AsyncQueue<AgentEvent>()
  #turns: TurnState[] = []
  #seq = 0
  #turnCounter = 0
  #sessionId = ''
  #state: SessionState = 'running'
  #child: ChildProcessByStdio<null, Readable, Readable> | undefined
  #closed = false
  #closeMode: CloseMode | undefined
  #cancelling = false

  private constructor(opts: KimiAdapterOptions) {
    this.#opts = opts
    this.guarantees = guaranteesFor(opts.inputOwnership ?? 'mediated')
  }

  /** No boot: there is no resident process until there is something to say. */
  static async start(opts: KimiAdapterOptions): Promise<KimiPrintAdapter> {
    return new KimiPrintAdapter(opts)
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

  async send(message: string, _provenance: SendProvenance): Promise<TurnKey> {
    if (this.#closed) throw new Error('kimi: session is closed')
    if (this.#state !== 'running') {
      throw new Error(`kimi: session is ${this.#state} and cannot accept work`)
    }
    if (this.#child) throw new Error('kimi: a turn is already in flight')

    const key = turnKey(`kimi-${++this.#turnCounter}`)
    const turn: TurnState = {
      key,
      prompt: message,
      state: 'in_progress',
      provenance: [],
      textBlocks: [],
      toolCalls: [],
      sawFinalAssistant: false,
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
    void this.#runTurn(turn, message)
    return key
  }

  #args(prompt: string): string[] {
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      // No user is present: AskUserQuestion is auto-dismissed and tool calls auto-approved.
      // Without it an unattended turn can stop on a question nobody will answer.
      '--afk',
      '-w',
      this.#opts.cwd,
    ]
    // Resume, so the participant remembers the conversation it is having. Kimi prints the
    // id to stderr at the end of the previous turn; see sessionIdFrom.
    if (this.#sessionId) args.push('-r', this.#sessionId)
    args.push(...(this.#opts.args ?? []))
    // `--prompt` takes a value, so a prompt starting with `-` is safe here in a way a bare
    // positional would not be.
    args.push('--prompt', prompt)
    return args
  }

  async #runTurn(turn: TurnState, prompt: string): Promise<void> {
    const child = spawn(this.#opts.command ?? 'kimi', this.#args(prompt), {
      cwd: this.#opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.#child = child

    let watchdog: NodeJS.Timeout | undefined
    if (this.#opts.watchdogMs !== undefined) {
      watchdog = setTimeout(() => {
        turn.provenance.push({
          source: 'watchdog',
          detail: `no terminal message within ${this.#opts.watchdogMs}ms`,
        })
        child.kill('SIGTERM')
      }, this.#opts.watchdogMs)
    }

    let stderr = ''
    child.stderr.on('data', (c: Buffer) => {
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

    const learned = sessionIdFrom(stderr)
    if (learned && !this.#sessionId) this.#sessionId = learned

    this.#settle(turn, code, signal, stderr)
  }

  #onRecord(turn: TurnState, record: KimiRecord): void {
    const at = Date.now()
    if (record.role === 'assistant') {
      const text = textOf(record.content)
      if (text) {
        turn.textBlocks.push(text)
        this.#emit({
          type: 'message',
          turnKey: turn.key,
          seq: this.#next(),
          at,
          provisional: false,
          role: 'assistant',
          text,
        })
      }
      const calls = record.tool_calls ?? []
      for (const call of calls) {
        const tool = call.function?.name ?? 'unknown'
        // `arguments` is a JSON STRING, per the OpenAI convention. Kept as text rather than
        // parsed: `TurnRecord.toolCalls.args` is deliberately a raw string, because the
        // agents share no structured path field to normalise into.
        turn.toolCalls.push({
          tool,
          // Failure is not distinguishable in this output mode; see PostToolUseFailure in
          // the module comment. Claiming otherwise would be worse than not knowing.
          failed: false,
          ...(call.function?.arguments ? { args: call.function.arguments } : {}),
        })
        this.#emit({
          type: 'tool_use',
          turnKey: turn.key,
          seq: this.#next(),
          at,
          provisional: false,
          tool,
          input: call.function?.arguments,
        })
      }
      // An assistant message with no tool calls is the model finishing rather than
      // continuing. It is the only completion signal this output mode offers.
      turn.sawFinalAssistant = calls.length === 0
    }
    // `role: 'tool'` records carry results. They are not emitted separately: the tool call
    // has already been recorded, and re-emitting would double-count it.
  }

  #settle(
    turn: TurnState,
    code: number | null,
    signal: NodeJS.Signals | null,
    stderr: string,
  ): void {
    if (turn.state !== 'in_progress') return
    turn.endedAt = Date.now()
    const killed = signal !== null
    let verdict: Verdict

    if (turn.sawFinalAssistant && code === 0) {
      verdict = {
        outcome: 'completed',
        // NOT `proven`. Nothing announced this: it is the shape of the last message plus a
        // zero exit. OpenCode's `completed` is proven because the child said so; Kimi's is
        // not, and the difference is exactly what a Stop hook would close.
        confidence: 'inferred',
        provenance: [
          { source: 'transcript', detail: 'final assistant message carried no tool calls' },
          { source: 'process', detail: `exit code ${code}` },
          {
            source: 'transport',
            detail: 'no announced terminal event in stream-json; a Stop hook would upgrade this',
            caveat: true,
          },
        ],
      }
    } else if (this.#cancelling && killed) {
      verdict = {
        outcome: 'cancelled',
        confidence: 'proven',
        provenance: [
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
      verdict = {
        outcome: 'unknown_abnormal_end',
        confidence: 'assumed',
        provenance: [
          {
            source: 'process',
            detail: `exit code ${code}, ${turn.sawFinalAssistant ? 'final message seen' : 'no final assistant message'}`,
          },
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
      // True even on the happy path: we concluded it, nothing announced it.
      synthesized: true,
    })
    this.#cancelling = false
  }

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
    this.#child.kill('SIGTERM')
    return live.key
  }

  async decidePermission(_decision: 'allow' | 'deny'): Promise<void> {
    throw new Error(
      'kimi: --print auto-approves tool calls for the invocation, so there is no pending ' +
        'request to decide.',
    )
  }

  /**
   * Rebuilt from the stream, like OpenCode's. Kimi DOES keep transcripts, and a
   * `PreCompact`/`PostCompact` pair implies they can be rewritten -- so `compactionGeneration`
   * staying 0 here is a statement about this adapter's evidence, not about the agent.
   */
  async snapshot(): Promise<SessionSnapshot> {
    const turns: TurnRecord[] = this.#turns.map((t) => ({
      key: t.key,
      prompt: t.prompt,
      state: t.state,
      confidence: t.confidence,
      provenance: t.provenance.length ? t.provenance : undefined,
      assistantText: t.textBlocks.length ? t.textBlocks.join('\n\n') : undefined,
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

  async fork(): Promise<AgentSession> {
    throw new Error('kimi: fork is not implemented')
  }

  async close(mode: CloseMode = 'graceful'): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#closeMode = mode
    if (this.#child && mode === 'graceful') this.#child.kill('SIGTERM')
    this.#state = 'terminated'
    this.#events.close()
  }
}
