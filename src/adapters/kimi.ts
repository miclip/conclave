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
 ## Content from the stream, lifecycle from hooks
 *
 * The stream carries what was said and done. It carries no terminal signal at all, so on its
 * own a completion is only ever the shape of the last message plus a zero exit.
 *
 * Kimi does announce one -- a `Stop` hook, one of thirteen, all carrying
 * `{hook_event_name, session_id, cwd, ...}` exactly as Claude Code's do. The adapter
 * registers them in a config it generates, so `completed` is `proven` with
 * `provenance: hook:Stop` and `synthesized: false`. Two other events earn their place:
 * `PostToolUseFailure`, without which every tool is reported `failed: false` whether it
 * failed or not, and `StopFailure`, which announces a badly-ended turn that both pty adapters
 * have to infer from absence.
 *
 * `session_id` rides on every hook payload, which replaces scraping it out of the stderr
 * resume line -- that only appeared after the process had exited, so the first turn could
 * never use it.
 *
 * Hook mode is BEST-EFFORT. If the operator's config cannot be read, the adapter falls back
 * to inferring from the stream and says so through a non-fatal error event. A participant
 * that refuses to start is worse than one whose completions are graded `inferred`, and the
 * grade then describes that session rather than the agent.
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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HookReceiver } from '../hooks/receiver.ts'
import type { HookDelivery } from '../hooks/journal.ts'
import { sanitizedCopy } from '../process/childenv.ts'
import {
  defaultKimiConfigPath,
  readKimiConfig,
  withConclaveHooks,
  writeKimiConfig,
} from './kimiConfig.ts'

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

/** The hook handler each event runs. Shared with the Claude adapter; it posts to loopback. */
const CLIENT = join(import.meta.dirname, '..', 'hooks', 'client.ts')

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
  /**
   * A `Stop` hook fired for this turn.
   *
   * The difference between an inferred completion and an announced one, and the entire
   * reason hook mode exists. Without it, `completed` rests on the shape of the last message
   * plus a zero exit; with it, the child said so.
   */
  announcedStop: boolean
  /** Tools the child reported as having FAILED. `stream-json` cannot distinguish these. */
  failedTools: Set<string>
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
  #runDir: string | undefined
  #receiver: HookReceiver | undefined
  #configPath: string | undefined
  #hookUrl = ''

  private constructor(opts: KimiAdapterOptions) {
    this.#opts = opts
    this.guarantees = guaranteesFor(opts.inputOwnership ?? 'mediated')
  }

  /**
   * No child is started here -- there is none until there is something to say -- but the
   * hook receiver and the generated config are, because both must exist before the first
   * turn and neither depends on a process.
   */
  static async start(opts: KimiAdapterOptions): Promise<KimiPrintAdapter> {
    const self = new KimiPrintAdapter(opts)
    await self.#prepare()
    return self
  }

  /**
   * Stand up the hook receiver and write the config that points at it.
   *
   * The base config is whatever the operator already uses: a `--config-file` in the
   * participant's args if they gave one, otherwise `~/.kimi/config.toml`. It is READ and
   * copied, never modified -- the same guarantee `--settings` buys on Claude Code.
   *
   * Hook mode is best-effort. If the config cannot be read -- no python3, malformed TOML --
   * the adapter falls back to the message-stream inference it had before, because a
   * participant that refuses to start is worse than one whose completions are graded
   * `inferred`. The reason is emitted as a non-fatal error so the degradation is visible
   * rather than silent.
   */
  async #prepare(): Promise<void> {
    this.#runDir = mkdtempSync(join(tmpdir(), 'orch-kimi-'))
    try {
      this.#receiver = new HookReceiver(join(this.#runDir, 'hooks.ndjson'))
      this.#hookUrl = await this.#receiver.start()
      this.#receiver.on('delivery', (d) => this.#onHook(d))

      const base = readKimiConfig(this.#baseConfigPath())
      this.#configPath = writeKimiConfig(
        this.#runDir,
        withConclaveHooks(base, `node ${CLIENT} kimi`),
      )
    } catch (err) {
      this.#configPath = undefined
      this.#emit({
        type: 'error',
        message:
          `kimi: hook mode unavailable (${err instanceof Error ? err.message : String(err)}); ` +
          'turn completion will be inferred from the message stream rather than announced',
        fatal: false,
        seq: this.#next(),
        at: Date.now(),
        provisional: false,
      })
    }
  }

  /** The operator's own config, which the generated one is a copy of. */
  #baseConfigPath(): string {
    const args = this.#opts.args ?? []
    const i = args.indexOf('--config-file')
    return i >= 0 && args[i + 1] ? args[i + 1]! : defaultKimiConfigPath()
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
      announcedStop: false,
      failedTools: new Set(),
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
    // The operator's `--config-file` is the SOURCE for the generated one, not an argument to
    // pass through: `kimi` loads exactly one config and refuses `--config` alongside it, so
    // forwarding both would either drop our hooks or fail outright.
    const passthrough = [...(this.#opts.args ?? [])]
    const i = passthrough.indexOf('--config-file')
    if (i >= 0) passthrough.splice(i, 2)
    args.push(...passthrough)
    if (this.#configPath) args.push('--config-file', this.#configPath)
    // `--prompt` takes a value, so a prompt starting with `-` is safe here in a way a bare
    // positional would not be.
    args.push('--prompt', prompt)
    return args
  }

  async #runTurn(turn: TurnState, prompt: string): Promise<void> {
    const child = spawn(this.#opts.command ?? 'kimi', this.#args(prompt), {
      cwd: this.#opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // The hook handler reads these. Absent when hook mode could not be set up, in which
      // case no hooks are registered either and nothing looks for them.
      env: this.#hookUrl
        ? sanitizedCopy(process.env as Record<string, string>, {
            extra: {
              ORCH_HOOK_URL: this.#hookUrl,
              ORCH_HOOK_ATTEMPT_JOURNAL: join(this.#runDir!, 'attempts.ndjson'),
              ORCH_HOOK_TIMEOUT_MS: '5000',
            },
          })
        : process.env,
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
          // From `PostToolUseFailure` when hook mode is live. Without it the stream cannot
          // distinguish a failed tool from a successful one and everything reads as fine,
          // which is a falsehood rather than an absence.
          failed: turn.failedTools.has(tool),
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

  /**
   * A hook delivery from the child.
   *
   * `session_id` rides on every payload, which is strictly better than the stderr scrape it
   * replaces -- that only appeared after the process had already exited, so the first turn
   * could never use it.
   */
  #onHook(d: HookDelivery): void {
    const payload = (d.payload ?? {}) as Record<string, unknown>
    const sid = typeof payload.session_id === 'string' ? payload.session_id : ''
    if (sid && !this.#sessionId) this.#sessionId = sid

    const live = this.#turns.find((t) => t.state === 'in_progress')
    switch (d.event) {
      case 'Stop':
        // The announced terminal signal. Recorded on the turn rather than settled here: the
        // process is still running, and the stream may still carry the closing message.
        if (live) live.announcedStop = true
        break
      case 'StopFailure':
        if (live) {
          live.provenance.push({
            source: 'hook',
            detail: `StopFailure: ${String(payload.error_type ?? 'unknown')} ${String(payload.error_message ?? '')}`.trim(),
          })
        }
        break
      case 'PostToolUseFailure': {
        // The one thing `stream-json` genuinely cannot express. Without this every tool is
        // reported `failed: false`, which is a falsehood the adapter was forced into.
        const tool = typeof payload.tool_name === 'string' ? payload.tool_name : ''
        if (live && tool) live.failedTools.add(tool)
        break
      }
      default:
        // SessionStart, UserPromptSubmit, SessionEnd, Pre/PostCompact: journalled by the
        // receiver, not acted on here. Registering them costs one subprocess each and buys
        // a durable record of the lifecycle, which is what the fixtures are made of.
        break
    }
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

    if (turn.announcedStop) {
      // The child said the turn ended. Same standing as OpenCode's `step_finish reason=stop`
      // and Claude Code's `Stop`, and the reason hook mode exists at all.
      verdict = {
        outcome: 'completed',
        confidence: 'proven',
        provenance: [
          { source: 'hook', detail: 'Stop' },
          { source: 'process', detail: `exit code ${code}` },
        ],
      }
    } else if (turn.sawFinalAssistant && code === 0) {
      verdict = {
        outcome: 'completed',
        // NOT `proven`. Nothing announced this: it is the shape of the last message plus a
        // zero exit. Reached when hook mode could not be set up -- see #prepare -- so the
        // weaker grade is a live statement about THIS session, not a property of the agent.
        confidence: 'inferred',
        provenance: [
          { source: 'transcript', detail: 'final assistant message carried no tool calls' },
          { source: 'process', detail: `exit code ${code}` },
          {
            source: 'transport',
            detail: 'no Stop hook fired; completion inferred from the message stream',
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
      // False when a Stop hook fired: the child announced it and we merely recorded it.
      synthesized: !turn.announcedStop,
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
    await this.#receiver?.stop()
    // The generated config holds a copy of whatever credential the operator's own config
    // holds, so it does not outlive the session.
    if (this.#runDir) rmSync(this.#runDir, { recursive: true, force: true })
    this.#state = 'terminated'
    this.#events.close()
  }
}
