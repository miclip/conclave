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
// The same function the run record reads, so the diagnosis names the model the report does.
import { modelFromArgs } from '../registry/launch.ts'

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
  /**
   * How many times this turn has heard ANYTHING from the child: a parsed record of any role, a
   * hook delivery, or a non-empty write to stderr.
   *
   * Counted separately from `textBlocks` and `toolCalls` because those two are CONTENT, and
   * plenty of real signals leave both empty: a `role: 'tool'` result is deliberately not
   * re-emitted, an assistant message with neither text nor tool calls is the completion signal
   * itself, and a provider or startup failure arrives on stderr and nowhere else. The
   * first-turn diagnosis (#82) asks whether the child said ANYTHING, so it reads a counter that
   * no signal can pass through unnoticed -- "no output whatsoever" is a claim about bytes.
   */
  heard: number
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
      heard: 0,
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
    // GUARDED (#146). `void` on its own leaves a rejection unhandled, and worse: a throw
    // before `#child` is assigned strands this turn `in_progress` with no child, which also
    // skips the `this.#child &&` half of `close()`'s wait -- so nothing would ever emit a
    // terminal verdict for it and the stream would close over a turn that never started.
    //
    // DEFENSIVE, and untested, stated so rather than implied by a test that proves nothing. No
    // input reaches it today: `spawn` does not throw synchronously for a bad command or a bad
    // cwd -- it emits an asynchronous `error`, which the handler below already covers -- so the
    // synchronous throw this guards is not constructible from the public API. A first attempt to
    // test it passed with the guard removed, which is worse than no test.
    void this.#runTurn(turn, message).catch((err: unknown) => {
      // `unknown_abnormal_end` rather than a guess at a cause: the turn ended and nothing
      // observed how. Marking it terminal is what stops it being stranded `in_progress` for
      // `snapshot()`; deliberately NOT a synthesised `turn_end`, because a verdict nobody
      // observed is the thing #146 says must not be invented -- that belongs to the larger
      // fix, where an adapter emits a terminal verdict it can actually stand behind.
      turn.state = 'unknown_abnormal_end'
      this.#emit({
        type: 'error',
        message: `turn ${turn.key} failed before it began: ${err instanceof Error ? err.message : String(err)}`,
        fatal: false,
        seq: this.#next(),
        at: Date.now(),
        provisional: false,
      })
    })
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
    // Created before the error handler, which closes it: a failed spawn must be able to
    // end the read, and the handler cannot reference something declared below it.
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })

    // A spawn that never starts emits an asynchronous 'error' event rather than throwing.
    // Unhandled, it takes the whole process down with a stack trace: `spawn opencode ENOENT`
    // killed a run outright, with no verdict, no summary and no routing log -- the exact
    // failure #32 was filed about, reached by a path #32's fix does not cover because
    // nothing was thrown for it to catch.
    let spawnFailed: string | undefined
    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnFailed =
        err.code === 'ENOENT'
          ? `${this.#opts.command ?? 'kimi'} is not on PATH (spawn ENOENT). Install it, or name a different agent.`
          : err.message
      // Close the READLINE INTERFACE, not the stream. Destroying `child.stdout` leaves the
      // interface's async iterator waiting forever -- verified, and it hung every turn.
      lines.close()
    })

    let watchdog: NodeJS.Timeout | undefined
    if (this.#opts.watchdogMs !== undefined) {
      watchdog = setTimeout(() => {
        turn.provenance.push({
          source: 'watchdog',
          detail: `no terminal message within ${this.#opts.watchdogMs}ms`,
        })
        // A FIRST run that produced not one signal before the deadline is a different finding
        // from one that produced some and then stalled, and #82 is that they read the same.
        // `received` rather than the content fields, and the difference is not academic: a
        // `role: 'tool'` result is deliberately never re-emitted and an assistant message with
        // no text and no calls is the completion signal itself, so both leave `textBlocks` and
        // `toolCalls` empty on a child that is plainly talking.
        //
        // Kimi's model normally comes from the generated config file rather than the argv, so
        // this usually says the argv named none -- which is still the sentence that points at
        // the launch instead of leaving `timed_out` to stand on its own.
        if (this.#turns.length === 1 && turn.heard === 0) {
          const model = modelFromArgs(this.#opts.args ?? [])
          turn.provenance.push({
            source: 'orchestrator',
            detail:
              `the first run produced nothing at all -- no records, no hooks, not a byte of ` +
              `stderr -- rather than producing some output and stalling` +
              (model === null
                ? ': its argv named no model, so the provider config file chose one'
                : `: it was launched with model '${model}', which is a candidate cause`),
            caveat: true,
          })
        }
        child.kill('SIGTERM')
      }, this.#opts.watchdogMs)
    }

    let stderr = ''
    child.stderr.on('data', (c: Buffer) => {
      // Counted BEFORE the bound, and outside it: whether the child spoke at all must not
      // depend on how much it had already said.
      if (c.toString('utf8').trim()) turn.heard += 1
      if (stderr.length < 8192) stderr += c.toString('utf8')
    })

    // A killed child does not guarantee the stream ends. Its own children inherit stdout, so
    // an orphaned grandchild -- a bash tool, a sleep, anything the CLI spawned -- holds the
    // pipe open after the parent is gone. Measured: SIGTERM produced `exit` immediately and
    // `close` never, so the read loop never ended and `#settle` was never reached. A cancelled
    // turn then produced no `turn_end` at all, and `#exchange` waits without a timeout by
    // design, trusting the adapter to settle.
    //
    // So `exit` is the signal, and the stream gets a short grace to flush before it is closed
    // out from under whatever is still holding it.
    let exited: [number | null, NodeJS.Signals | null] | undefined
    child.once('exit', (c, s) => {
      exited = [c, s]
      setTimeout(() => lines.close(), 250).unref()
    })

    for await (const line of lines) {
      const record = parseRecord(line)
      if (record) this.#onRecord(turn, record)
    }

    const [code, signal] = exited ?? await new Promise<[number | null, NodeJS.Signals | null]>((r) => {
      child.once('close', (c, s) => r([c, s]))
      child.once('exit', (c, s) => r([c, s]))
      // A process that never spawned may never emit `close` at all -- its stdio pipes were
      // never opened, so there is nothing to close. Waiting on `close` alone hung the turn
      // forever, which is a worse failure than the crash it replaced.
      child.once('error', () => r([null, null]))
    })
    if (watchdog) clearTimeout(watchdog)
    this.#child = undefined
    if (spawnFailed) turn.provenance.push({ source: 'transport', detail: spawnFailed })

    const learned = sessionIdFrom(stderr)
    if (learned && !this.#sessionId) this.#sessionId = learned

    this.#settle(turn, code, signal, stderr)
  }

  #onRecord(turn: TurnState, record: KimiRecord): void {
    // Counted before anything is inspected, so a record that produces no event -- a tool result,
    // an empty assistant message, a role this adapter ignores -- still proves the child spoke.
    turn.heard += 1
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
    // A hook is the child too, and on this adapter it is a channel the record stream does not
    // carry: a turn whose only signal was `Stop` has spoken, whatever its stdout did.
    if (live) live.heard += 1
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
          // The watchdog's own lines, and the diagnosis it wrote beside them.
          ...turn.provenance.filter((p) => p.source === 'watchdog' || p.caveat === true),
          // What the child said before it went quiet -- on this adapter, the only place a
          // provider or config failure appears at all. Discarding it on the killed path meant
          // reporting a clock over the top of the child's own answer.
          ...(stderr.trim()
            ? [{ source: 'process' as const, detail: stderr.trim().slice(0, 400), caveat: true }]
            : []),
          { source: 'process', detail: `signal ${signal}` },
        ],
      }
    } else {
      // A transport that never started is not an ambiguous ending: we know exactly what
      // happened and can say so, so it does not get graded `assumed` alongside the genuinely
      // unknown cases.
      const transport = turn.provenance.find((p) => p.source === 'transport')
      verdict = transport
        ? {
            outcome: 'transport_lost',
            confidence: 'proven',
            provenance: [transport],
          }
        : {
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
    // The queue is closed in a `finally`, so a close that THROWS still ends the iteration (#143).
    // Everything between here and there can reject -- draining stdin, reconciling the transcript,
    // terminating the pty, stopping the receiver -- and `#closed` is already true above, so a
    // caller that retries returns immediately without ever reaching this line. The relay waits for
    // its forwarder to drain before it abandons a turn, and a queue that never ends turns that
    // wait into the hang it was added to remove: the one path least able to afford it, again.
    try {
      // `graceful` means "we are finished with it; reconcile, THEN SIGTERM and wait". The
      // waiting half was missing: the child was killed and the event queue closed in the same
      // breath, so a turn still in flight settled into a CLOSED stream and its `turn_end` was
      // dropped. `snapshot()` still had it -- the seam permits exactly that divergence and
      // tells consumers to reconcile -- but a consumer following events() never learned how the
      // last turn ended, which is the one it most needs to know about.
      if (this.#child && mode === 'graceful') {
        const settled = new Promise<void>((resolve) => {
          const live = this.#turns.find((t) => t.state === 'in_progress')
          if (!live) return resolve()
          let cap: ReturnType<typeof setTimeout>
          const poll = setInterval(() => {
            if (live.state !== 'in_progress') {
              clearInterval(poll)
              // `cap` too (#146). Only the interval was cleared, and both timers are
              // deliberately ref'd -- so every FAST graceful close held the event loop open for
              // the balance of the three seconds it had just finished not needing.
              clearTimeout(cap)
              resolve()
            }
          }, 50)
          // NOT unref'd, unlike the watchdog timers. An unref'd pair here let the event loop
          // drain with this promise still pending, so `close()` never resolved -- Node reports
          // it as an unsettled top-level await. Both are bounded at 3s, so keeping them ref'd
          // cannot hold a process open for long.
          // Bounded. A child that will not die must not hold the console open, and this
          // divergence is a nicety next to a session that cannot be shut down.
          cap = setTimeout(() => {
            clearInterval(poll)
            // ESCALATE (#146). `contract/session.ts`'s `close()` says "always SIGTERM and wait
            // before escalating", and this never did: a child that ignores SIGTERM was left
            // running after `close()` returned with `#state = 'terminated'` -- a process leak
            // the caller is told nothing about -- and it guaranteed this cap was reached rather
            // than merely risked.
            try {
              this.#child?.kill('SIGKILL')
            } catch {
              // Already gone between the check and the signal. Nothing to escalate to.
            }
            // SAID, not dropped (#146). The turn is still `in_progress` and the stream is about
            // to close over it, so a consumer following `events()` would otherwise never learn
            // that the last turn's verdict is missing rather than pending. `snapshot()` keeps
            // the divergence; this is what tells anyone to go and look.
            this.#emit({
              type: 'error',
              message:
                `close('graceful') gave up waiting for turn ${live.key} after 3s; ` +
                `the child was killed and no terminal verdict was observed`,
              fatal: false,
              seq: this.#next(),
              at: Date.now(),
              provisional: false,
            })
            resolve()
          }, 3_000)
        })
        this.#child.kill('SIGTERM')
        await settled
      }
      await this.#receiver?.stop()
      // The generated config holds a copy of whatever credential the operator's own config
      // holds, so it does not outlive the session.
      if (this.#runDir) rmSync(this.#runDir, { recursive: true, force: true })
      this.#state = 'terminated'
    } finally {
      this.#events.close()
    }
  }
}
