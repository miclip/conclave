/**
 * ClaudePtyHookAdapter — the first live adapter.
 *
 * Deliberately mechanical. It owns process lifecycle, sanitized environment, input
 * serialization, hook ingestion, transcript reconciliation and evidence classification.
 * It owns no relay policy, no round budgets, no role prompting and no summarisation --
 * those belong above the seam and would make the adapter's guarantees harder to check.
 *
 * The three claims that were hardest to establish, and how they are honoured here:
 *
 *   completion   `Stop` proves it. Nothing else does.
 *   cancellation nothing in the child records it, so it rests entirely on the input
 *                queue's record of having sent ESC -- hence confidence `assumed`, and
 *                hence input mediation being a product-level guarantee rather than a
 *                convenience.
 *   loss         a lost `Stop` must not become `process_exited` on shutdown. Before
 *                finalising anything, the transcript is reconciled: an assistant entry
 *                with stop_reason=end_turn is correlation evidence that the turn
 *                completed even though its hook never arrived.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentEvent,
  AgentSession,
  Guarantees,
  InputOwnership,
  Role,
  SendProvenance,
  SessionSnapshot,
  TurnKey,
} from '../contract/session.ts'
import { guaranteesFor, turnKey } from '../contract/session.ts'
import type { Provenance, Verdict } from '../contract/outcome.ts'
import { classify, evidence, emptyTranscriptState } from '../outcomes/classify.ts'
import { sanitizedCopy } from '../process/childenv.ts'
import { PtyProcess } from '../process/pty.ts'
import { InputQueue } from '../process/input.ts'
import { HookReceiver } from '../hooks/receiver.ts'
import type { HookDelivery } from '../hooks/journal.ts'
import { TranscriptSessionView } from '../transcript/reconcile.ts'

const CLIENT = join(import.meta.dirname, '..', 'hooks', 'client.ts')
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'SessionEnd']

interface TurnState {
  key: TurnKey
  prompt: string
  startedAt: number
  hooks: string[]
  payloads: Record<string, Record<string, any>>
  verdict?: Verdict
  assistantText?: string
}

class AsyncQueue<T> {
  #items: T[] = []
  #waiters: ((v: IteratorResult<T>) => void)[] = []
  #closed = false

  push(item: T): void {
    const w = this.#waiters.shift()
    if (w) w({ value: item, done: false })
    else this.#items.push(item)
  }

  close(): void {
    this.#closed = true
    for (const w of this.#waiters.splice(0)) w({ value: undefined as any, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () =>
        new Promise<IteratorResult<T>>((resolve) => {
          const item = this.#items.shift()
          if (item !== undefined) resolve({ value: item, done: false })
          else if (this.#closed) resolve({ value: undefined as any, done: true })
          else this.#waiters.push(resolve)
        }),
    }
  }
}

export interface ClaudeAdapterOptions {
  cwd: string
  role: Role
  inputOwnership?: InputOwnership
  /** Extra CLI args, e.g. ['--permission-mode', 'default']. */
  args?: string[]
  readyTimeoutMs?: number
  /** How long an unmatched turn may run before the watchdog calls it uncertain. */
  watchdogMs?: number
}

export class ClaudePtyHookAdapter implements AgentSession {
  readonly agent = 'claude'
  readonly guarantees: Guarantees

  #pty!: PtyProcess
  #input!: InputQueue
  #receiver!: HookReceiver
  #events = new AsyncQueue<AgentEvent>()
  #turns = new Map<string, TurnState>()
  #order: string[] = []
  #view?: TranscriptSessionView
  #sessionId = ''
  #transcriptPath?: string
  #seq = 0
  #ready = false
  #closed = false
  #closeMode?: 'graceful' | 'abandoned'
  #pendingPrompt?: { resolve: (k: TurnKey) => void; reject: (e: Error) => void; prompt: string }
  #opts: ClaudeAdapterOptions
  #settingsDir?: string

  private constructor(opts: ClaudeAdapterOptions) {
    this.#opts = opts
    this.guarantees = guaranteesFor(opts.inputOwnership ?? 'mediated')
  }

  get sessionId(): string {
    return this.#sessionId
  }

  /** SessionStart has arrived: the session exists and its transcript path is known. */
  get isReady(): boolean {
    return this.#ready
  }

  /**
   * Separate capability from readiness on purpose. SessionStart can arrive before the
   * composer is drawn, and it blocks the first turn until it returns (measured in spike
   * 2: 2.1s baseline vs 10.0s with the hook stalled to its timeout). Readiness says the
   * session exists; this says keystrokes will land.
   */
  get acceptsInput(): boolean {
    return this.#pty?.alive === true && this.#pty.isInteractive
  }

  static async start(opts: ClaudeAdapterOptions): Promise<ClaudePtyHookAdapter> {
    const self = new ClaudePtyHookAdapter(opts)
    await self.#boot()
    return self
  }

  async #boot(): Promise<void> {
    const runDir = mkdtempSync(join(tmpdir(), 'orch-claude-'))
    this.#settingsDir = runDir

    this.#receiver = new HookReceiver(join(runDir, 'hooks.ndjson'))
    const url = await this.#receiver.start()
    this.#receiver.on('delivery', (d) => this.#onHook(d))
    // Replays are visible rather than silent: a duplicate means recovery ran.
    this.#receiver.on('duplicate', (d) =>
      this.#emit({
        type: 'error',
        message: `replayed hook delivery ${d.deliveryId} (${d.event}); ignored`,
        fatal: false,
        seq: this.#next(),
        at: Date.now(),
        provisional: false,
      }),
    )

    // A dedicated settings file rather than editing the project's: the adapter must not
    // mutate a user's configuration to do its job.
    const settingsPath = join(runDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify(this.#hookSettings(), null, 2))

    const env = sanitizedCopy(process.env as Record<string, string>, {
      extra: {
        ORCH_HOOK_URL: url,
        ORCH_HOOK_ATTEMPT_JOURNAL: join(runDir, 'attempts.ndjson'),
        ORCH_HOOK_TIMEOUT_MS: '5000',
      },
    })

    this.#pty = await PtyProcess.spawn({
      file: 'claude',
      args: ['--settings', settingsPath, ...(this.#opts.args ?? [])],
      cwd: this.#opts.cwd,
      env,
    })
    this.#input = new InputQueue(this.#pty)
    this.#pty.on('exit', (info) => void this.#onExit(info.reason))

    const deadline = Date.now() + (this.#opts.readyTimeoutMs ?? 60_000)
    while (!this.#ready && Date.now() < deadline && this.#pty.alive) {
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!this.#ready) throw new Error('claude session did not report SessionStart')
    // Readiness is not the same as being able to type; wait for both.
    await this.#pty.waitForOutput(() => this.#pty.isInteractive, 30_000)
    await this.#pty.waitQuiet(700, 20_000)
  }

  #hookSettings(): unknown {
    const command = `node ${CLIENT} claude`
    const entry = { hooks: [{ type: 'command', command, timeout: 10 }] }
    return { hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, [entry]])) }
  }

  #next(): number {
    return ++this.#seq
  }

  #emit(e: AgentEvent): void {
    this.#events.push(e)
  }

  #turnFor(key: string): TurnState | undefined {
    return this.#turns.get(key)
  }

  #onHook(d: HookDelivery): void {
    switch (d.event) {
      case 'SessionStart': {
        this.#sessionId = d.sessionId ?? ''
        this.#transcriptPath = d.payload.transcript_path
        if (this.#transcriptPath) {
          this.#view = new TranscriptSessionView({
            path: this.#transcriptPath,
            agent: 'claude',
            sessionId: this.#sessionId,
            cwd: this.#opts.cwd,
            guarantees: this.guarantees,
          })
        }
        this.#ready = true
        return
      }
      case 'UserPromptSubmit': {
        const key = turnKey(String(d.turnKey ?? `unkeyed-${this.#order.length}`))
        const turn: TurnState = {
          key,
          prompt: String(d.payload.prompt ?? ''),
          startedAt: Date.now(),
          hooks: ['UserPromptSubmit'],
          payloads: { UserPromptSubmit: d.payload },
        }
        this.#turns.set(String(key), turn)
        this.#order.push(String(key))
        this.#emit({
          type: 'turn_start',
          prompt: turn.prompt,
          turnKey: key,
          seq: this.#next(),
          at: turn.startedAt,
          provisional: false,
        })
        this.#pendingPrompt?.resolve(key)
        this.#pendingPrompt = undefined
        return
      }
      case 'PermissionRequest': {
        const turn = this.#latestLiveTurn()
        if (turn) {
          turn.hooks.push('PermissionRequest')
          turn.payloads['PermissionRequest'] = d.payload
        }
        this.#emit({
          type: 'permission_requested',
          tool: String(d.payload.tool_name ?? 'unknown'),
          input: d.payload.tool_input,
          turnKey: turn?.key,
          seq: this.#next(),
          at: Date.now(),
          provisional: false,
        })
        return
      }
      case 'Stop': {
        const key = String(d.turnKey ?? '')
        const turn = this.#turnFor(key) ?? this.#latestLiveTurn()
        if (!turn) return
        turn.hooks.push('Stop')
        turn.payloads['Stop'] = d.payload
        // The cheap common case: the answer without reading the transcript. The
        // transcript is still required for recovery, audit and richer reconstruction.
        if (d.payload.last_assistant_message) {
          turn.assistantText = String(d.payload.last_assistant_message)
        }
        this.#finalise(turn, false)
        return
      }
      case 'SessionEnd': {
        // Session-level, not turn-level. Recorded on live turns as evidence only.
        for (const t of this.#liveTurns()) t.payloads['SessionEnd'] = d.payload
        return
      }
    }
  }

  #liveTurns(): TurnState[] {
    return this.#order.map((k) => this.#turns.get(k)!).filter((t) => t && !t.verdict)
  }

  #latestLiveTurn(): TurnState | undefined {
    return this.#liveTurns().at(-1)
  }

  #evidenceFor(turn: TurnState, processAlive: boolean, transcriptSaysCompleted: boolean) {
    return evidence({
      agent: 'claude',
      hooks: turn.hooks,
      hookPayloads: turn.payloads,
      transcript: transcriptSaysCompleted
        ? { ...emptyTranscriptState(), exists: true, hasAssistantAfterPrompt: true, finalStopReason: 'end_turn' }
        : emptyTranscriptState(),
      process: { alive: processAlive, howEnded: this.#pty?.exitInfo?.reason },
      orchestrator: {
        sentCancel: this.#input.hasSent('cancel', turn.startedAt),
        sentPermissionDecision: this.#lastPermissionDecision(turn.startedAt),
        inputIsMediated: this.guarantees.inputOwnership === 'mediated',
      },
      elapsedSeconds: (Date.now() - turn.startedAt) / 1000,
      watchdogSeconds: (this.#opts.watchdogMs ?? 600_000) / 1000,
    })
  }

  #lastPermissionDecision(since: number): 'allow' | 'deny' | undefined {
    const a = this.#input.last('permission_decision')
    if (!a || a.at < since) return undefined
    return a.detail?.startsWith('deny') ? 'deny' : 'allow'
  }

  #finalise(turn: TurnState, synthesized: boolean, extra: Provenance[] = []): void {
    if (turn.verdict) return
    const got = classify(this.#evidenceFor(turn, this.#pty.alive, false))
    if (got.state === 'in_progress') return
    turn.verdict = {
      outcome: got.outcome!,
      confidence: got.confidence!,
      provenance: [...got.provenance!, ...extra],
    }
    this.#emit({
      type: 'turn_end',
      verdict: turn.verdict,
      synthesized,
      turnKey: turn.key,
      seq: this.#next(),
      at: Date.now(),
      provisional: false,
    })
  }

  /**
   * Reconcile unfinished turns against the transcript before declaring anything.
   *
   * This is what stops a lost `Stop` from becoming `process_exited` on shutdown. An
   * assistant entry with stop_reason=end_turn is correlation evidence that the turn
   * completed; without it, a live turn in a dead process really did die.
   */
  async #reconcileLiveTurns(): Promise<void> {
    const live = this.#liveTurns()
    if (live.length === 0) return

    let completedInTranscript = 0
    if (this.#view) {
      try {
        const snap = await this.#view.snapshot()
        completedInTranscript = snap.turns.filter((t) => t.state === 'completed').length
      } catch {
        /* transcript unreadable; fall through with zero evidence */
      }
    }

    // Turns are finalised in order, and only as many as the transcript actually
    // evidences may claim completion.
    let credits = Math.max(0, completedInTranscript - this.#completedCount())
    for (const turn of live) {
      const recovered = credits > 0
      if (recovered) credits--
      const got = classify(this.#evidenceFor(turn, this.#pty.alive, recovered))
      if (got.state === 'in_progress') continue
      turn.verdict = {
        outcome: got.outcome!,
        confidence: got.confidence!,
        provenance: [
          ...got.provenance!,
          recovered
            ? {
                source: 'transcript' as const,
                detail: 'completion recovered from transcript; the Stop hook never arrived',
                caveat: true,
              }
            : {
                source: 'transcript' as const,
                detail: 'no transcript evidence of completion for this turn',
                caveat: true,
              },
        ],
      }
      this.#emit({
        type: 'turn_end',
        verdict: turn.verdict,
        synthesized: true,
        turnKey: turn.key,
        seq: this.#next(),
        at: Date.now(),
        provisional: false,
      })
    }
  }

  #completedCount(): number {
    return [...this.#turns.values()].filter((t) => t.verdict?.outcome === 'completed').length
  }

  async #onExit(reason: string): Promise<void> {
    // Every outstanding command promise must resolve; a caller awaiting send() when the
    // child dies would otherwise hang forever.
    this.#pendingPrompt?.reject(new Error(`claude exited (${reason}) before accepting the prompt`))
    this.#pendingPrompt = undefined

    await this.#reconcileLiveTurns()

    if (!this.#closed) {
      this.#emit({
        type: 'error',
        message: `child exited unexpectedly (${reason})`,
        fatal: true,
        seq: this.#next(),
        at: Date.now(),
        provisional: false,
      })
    }
    this.#events.close()
  }

  // --- AgentSession ---------------------------------------------------------------

  async send(message: string, _provenance: SendProvenance): Promise<TurnKey> {
    if (!this.acceptsInput) throw new Error('session is not accepting input')
    const keyed = new Promise<TurnKey>((resolve, reject) => {
      this.#pendingPrompt = { resolve, reject, prompt: message }
    })
    // Serialized against cancel() and decidePermission() by the shared queue.
    await this.#input.submit(message)
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('no UserPromptSubmit hook after send')), 30_000),
    )
    return Promise.race([keyed, timeout])
  }

  async cancel(): Promise<TurnKey | undefined> {
    const turn = this.#latestLiveTurn()
    await this.#input.cancel(turn ? String(turn.key) : 'no live turn')
    if (!turn) return undefined
    // Cancellation produces no signal from the child at all. Give the UI a moment to
    // settle, then conclude from our own record of having sent ESC.
    await new Promise((r) => setTimeout(r, 1500))
    this.#finalise(turn, true)
    return turn.key
  }

  async decidePermission(decision: 'allow' | 'deny'): Promise<void> {
    if (this.guarantees.inputOwnership !== 'mediated') {
      throw new Error('permission decisions require mediated input ownership')
    }
    await this.#input.decidePermission(decision)
  }

  events(): AsyncIterable<AgentEvent> {
    return this.#events
  }

  async snapshot(): Promise<SessionSnapshot> {
    if (!this.#view) {
      return {
        sessionId: this.#sessionId,
        agent: this.agent,
        cwd: this.#opts.cwd,
        role: this.#opts.role,
        turns: [],
        guarantees: this.guarantees,
        compactionGeneration: 0,
        builtAt: Date.now(),
      }
    }
    const snap = await this.#view.snapshot()
    // Hook-derived verdicts outrank transcript inference: Stop proves completion, the
    // transcript only suggests it.
    for (let i = 0; i < snap.turns.length; i++) {
      const known = this.#turns.get(this.#order[i] ?? '')
      if (known?.verdict) {
        snap.turns[i] = {
          ...snap.turns[i]!,
          key: known.key,
          state: known.verdict.outcome,
          confidence: known.verdict.confidence,
          provenance: known.verdict.provenance,
        }
      }
    }
    return { ...snap, role: this.#opts.role }
  }

  async fork(): Promise<AgentSession> {
    throw new Error('fork() not implemented for the PTY adapter yet')
  }

  /**
   * Graceful shutdown, distinguished from transport abandonment. Cleanup must not
   * manufacture an outcome: turns are reconciled against the transcript first, so a
   * completed turn whose Stop was lost is recovered rather than reported as a death.
   */
  async close(mode: 'graceful' | 'abandoned' = 'graceful'): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#closeMode = mode

    if (mode === 'graceful' && this.#pty.alive) {
      await this.#input.drain()
      await this.#reconcileLiveTurns()
      await this.#pty.terminate()
    } else if (mode === 'abandoned') {
      // We are walking away from the transport, not asserting anything about the turns.
      for (const turn of this.#liveTurns()) {
        turn.verdict = {
          outcome: 'transport_lost',
          confidence: 'uncertain',
          provenance: [
            { source: 'transport', detail: 'adapter abandoned the session' },
            { source: 'transport', detail: 'the child may still be running', caveat: true },
          ],
        }
        this.#emit({
          type: 'turn_end',
          verdict: turn.verdict,
          synthesized: true,
          turnKey: turn.key,
          seq: this.#next(),
          at: Date.now(),
          provisional: false,
        })
      }
    }

    await this.#receiver.stop()
    this.#events.close()
  }

  /** Test/diagnostic access. */
  get closeMode(): string | undefined {
    return this.#closeMode
  }
  get inputLog() {
    return this.#input.actions
  }
  get receiver(): HookReceiver {
    return this.#receiver
  }
  get pty(): PtyProcess {
    return this.#pty
  }
}
