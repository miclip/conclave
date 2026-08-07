/**
 * CodexPtyHookAdapter — the second live adapter.
 *
 * Written against the fixtures in spikes/codex/FINDINGS.md rather than by analogy with
 * the Claude adapter, because the two genuinely differ in what they can know:
 *
 *   readiness      Codex fires NO hook before the first turn -- not even SessionStart.
 *                  Readiness is the TUI negotiating raw mode, and session identity
 *                  (session_id, transcript_path) is unknown until a turn exists.
 *   completion     Stop fires AND the transcript records task_complete.
 *   cancellation   turn_aborted reason=interrupted in the transcript. Stop does NOT
 *                  fire; on 0.146.0 the two are mutually exclusive.
 *   refusal        PermissionRequest fires and the transcript records turn_aborted --
 *                  byte-identical to a user cancellation. Only the permission event plus
 *                  our own record of the mediated deny separates them.
 *   correlation    turn_id, present on every hook except SessionStart.
 *
 * The adapter owns process lifecycle, sanitized environment, input serialization, hook
 * ingestion, transcript reconciliation and evidence classification. No relay policy, no
 * round budgets, no role prompting, no summarisation.
 *
 * Hook registration is NOT generated per session the way Claude's is: Codex reads a
 * project-local `.codex/hooks.json`, and its trust hash covers the command string. The
 * registry preflight therefore refuses to construct this adapter until those hooks are
 * loaded, enabled AND trusted -- a session whose hooks cannot execute has no
 * turn-completion signal at all.
 */

import { mkdtempSync } from 'node:fs'
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
  SessionState,
  TurnKey,
  TurnRecord,
} from '../contract/session.ts'
import { guaranteesFor, turnKey } from '../contract/session.ts'
import { emptyTranscriptState } from '../outcomes/classify.ts'
import { TurnVerdictTracker, type VerdictUpdate } from '../outcomes/tracker.ts'
import { DEFAULT_WATCHDOG_MS, TAIL_INTERVAL_MS, TurnWatchdog } from '../outcomes/watchdog.ts'
import { sanitizedCopy } from '../process/childenv.ts'
import { PtyProcess } from '../process/pty.ts'
import { CODEX_PERMISSION_ENCODING, InputQueue } from '../process/input.ts'
import { HookReceiver } from '../hooks/receiver.ts'
import type { HookDelivery } from '../hooks/journal.ts'
import { TranscriptSessionView } from '../transcript/reconcile.ts'
import { AsyncQueue } from './asyncQueue.ts'

interface TurnState {
  key: TurnKey
  prompt: string
  startedAt: number
  tracker: TurnVerdictTracker
  /** Seq of the last `turn_end` emitted, so a revision can withdraw it by number. */
  endSeq: number | undefined
  assistantText: string | undefined
}

export interface CodexAdapterOptions {
  cwd: string
  role: Role
  inputOwnership?: InputOwnership | undefined
  /** Extra CLI args from the participant spec. */
  args?: string[] | undefined
  readyTimeoutMs?: number | undefined
  watchdogMs?: number | undefined
  /**
   * How long a turn may produce nothing before it is called hung. Defaults to
   * `DEFAULT_IDLE_MS`.
   *
   * Configurable for the same reason `watchdogMs` is: the right value depends on the work.
   * It was also the only way to TEST the idle deadline against a real session -- a live proof
   * otherwise needs a turn that genuinely stalls for twelve minutes.
   */
  idleMs?: number | undefined
}

/**
 * What to tell an operator when a send is never acknowledged by a hook.
 *
 * The bare condition named an internal fact with no action attached, and it was the
 * last line a 12-turn run ever printed (issue #32). A diagnostic that ends a run
 * should say what to do about it.
 */
const SEND_HOOK_TIMEOUT =
  "no UserPromptSubmit hook after send. The child accepted the text but no hook fired, so this turn could not be observed. Most often the previous turn had not finished -- neither CLI accepts input mid-turn -- so try a longer --settle. If it recurs at the first turn, the hooks are probably not firing at all: run `conclave config check`."

export class CodexPtyHookAdapter implements AgentSession {
  readonly agent = 'codex'
  readonly guarantees: Guarantees

  #pty!: PtyProcess
  #input!: InputQueue
  #receiver!: HookReceiver
  #events = new AsyncQueue<AgentEvent>()
  #turns = new Map<string, TurnState>()
  #order: string[] = []
  #view: TranscriptSessionView | undefined
  #sessionId = ''
  #transcriptPath: string | undefined
  #seq = 0
  #interactive = false
  #closed = false
  #closeMode: 'graceful' | 'abandoned' | undefined
  #pendingPrompt:
    | { resolve: (k: TurnKey) => void; reject: (e: Error) => void; prompt: string }
    | undefined
  #opts: CodexAdapterOptions
  #watchdog: TurnWatchdog<TurnState>

  private constructor(opts: CodexAdapterOptions) {
    this.#opts = opts
    this.guarantees = guaranteesFor(opts.inputOwnership ?? 'mediated')
    // See the Claude adapter: a hang is defined by nothing arriving, so the deadline rule
    // needs its own clock rather than a hook to react to. `synthesized: true` -- the child
    // said nothing.
    this.#watchdog = new TurnWatchdog<TurnState>(
      opts.watchdogMs ?? DEFAULT_WATCHDOG_MS,
      (turn, update) => this.#apply(turn, update, true),
      opts.idleMs,
    )
  }

  get sessionId(): string {
    return this.#sessionId
  }

  /**
   * Codex fires no hook before the first turn, so there is no lifecycle event that means
   * "the session exists". Readiness here is honestly weaker than Claude's: the terminal
   * is live and will accept a prompt. It deliberately does NOT pretend to be SessionStart
   * -- session identity stays unknown until the first turn produces it.
   */
  get isReady(): boolean {
    return this.#interactive && this.#pty?.alive === true
  }

  get acceptsInput(): boolean {
    return this.#pty?.alive === true && this.#pty.isInteractive
  }

  /** True once a hook has told us which session and transcript this is. */
  get sessionIdentified(): boolean {
    return this.#transcriptPath !== undefined
  }

  static async start(opts: CodexAdapterOptions): Promise<CodexPtyHookAdapter> {
    const self = new CodexPtyHookAdapter(opts)
    await self.#boot()
    return self
  }

  async #boot(): Promise<void> {
    const runDir = mkdtempSync(join(tmpdir(), 'orch-codex-'))

    this.#receiver = new HookReceiver(join(runDir, 'hooks.ndjson'))
    const url = await this.#receiver.start()
    this.#receiver.on('delivery', (d) => this.#onHook(d))
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

    const env = sanitizedCopy(process.env as Record<string, string>, {
      extra: {
        ORCH_HOOK_URL: url,
        ORCH_HOOK_ATTEMPT_JOURNAL: join(runDir, 'attempts.ndjson'),
        ORCH_HOOK_TIMEOUT_MS: '5000',
      },
    })

    this.#pty = await PtyProcess.spawn({
      file: 'codex',
      args: this.#opts.args ?? [],
      cwd: this.#opts.cwd,
      env,
    })
    this.#input = new InputQueue(this.#pty, CODEX_PERMISSION_ENCODING)
    this.#pty.on('exit', (info) => void this.#onExit(info.reason))

    // Raw-mode negotiation is the only readiness evidence Codex offers before a turn.
    const interactive = await this.#pty.waitForOutput(
      () => this.#pty.isInteractive,
      this.#opts.readyTimeoutMs ?? 60_000,
    )
    if (!interactive) throw new Error('codex did not negotiate an interactive terminal')
    this.#interactive = true
    await this.#pty.waitQuiet(1200, 25_000)
  }

  #next(): number {
    return ++this.#seq
  }

/**
   * Tail the transcript while a turn is in flight, so its events exist while they matter.
   *
   * The transcript view emits `message` deltas and `tool_use` as they appear — the running
   * commentary a watching human wants, and the per-participant evidence attribution needs.
   * Nothing was calling it during a turn: `#view.poll()` ran only inside `snapshot()`, which
   * the relay calls at turn boundaries. So every transcript-derived event materialised in a
   * burst AFTER the turn ended, and "live activity" was live in name only.
   *
   * The fan-out in `relay/observe.ts` was built for exactly this stream and had nothing
   * feeding it. Found by a human saying they could not see the implementer working.
   *
   * Unref'd, and serialized against itself: two concurrent polls would read the same tail
   * offset twice. `snapshot()` shares the view, so a poll in flight is awaited rather than
   * duplicated.
   */
  #tailTimer: NodeJS.Timeout | undefined
  #polling: Promise<void> | undefined

  async #pollTranscript(): Promise<void> {
    if (!this.#view) return
    if (this.#polling) return this.#polling
    this.#polling = (async () => {
      try {
        for (const e of await this.#view!.poll()) {
          // CONTENT ONLY. The view also derives `turn_start` and `turn_end` from the
          // transcript, and those are the hooks' job: `Stop` proves completion, a parsed
          // `stop_reason` merely suggests it. Emitting both put two lifecycle events in one
          // stream — the console started the status twice per turn, and worse, `#exchange`
          // waits for the FIRST turn_end after a send, so a transcript-derived one could
          // end an exchange before the authoritative verdict existed.
          //
          // Until this poller existed the view's events were never emitted at all, so the
          // duplication had nowhere to show up.
          if (e.type === 'turn_start' || e.type === 'turn_end') continue
          this.#emit(e)
        }
      } catch {
        // Unreadable mid-write is ordinary; the next tick picks it up.
      } finally {
        this.#polling = undefined
      }
    })()
    return this.#polling
  }

  #startTailing(): void {
    if (this.#tailTimer) return
    this.#tailTimer = setInterval(() => void this.#pollTranscript(), TAIL_INTERVAL_MS)
    this.#tailTimer.unref()
  }

  #stopTailing(): void {
    if (this.#tailTimer) clearInterval(this.#tailTimer)
    this.#tailTimer = undefined
  }

  #emit(e: AgentEvent): void {
    // Any event is a sign of life for its turn, so the idle deadline moves with it. Without
    // this the only clock is the absolute one, and a turn that goes silent mid-work waits it
    // out in full -- issue #36, where a session sat idle ~44 minutes producing nothing.
    // `touchAll`, not `touch(e.turnKey)`: the key on an event depends on what produced it,
    // and a transcript-sourced event does not carry the hook key the watchdog is armed under.
    if (e.type !== 'turn_end') this.#watchdog.touchAll()
    this.#events.push(e)
  }

  #newTracker(): TurnVerdictTracker {
    return new TurnVerdictTracker({
      agent: this.agent,
      orchestrator: {
        sentCancel: false,
        inputIsMediated: this.guarantees.inputOwnership === 'mediated',
      },
      watchdogSeconds: (this.#opts.watchdogMs ?? DEFAULT_WATCHDOG_MS) / 1000,
    })
  }

  /**
   * Hook payloads are consumed as delivered and normalised only here, at the adapter
   * boundary. The receiver journals them byte-for-byte; nothing upstream reshapes them.
   */
  #onHook(d: HookDelivery): void {
    // SessionStart carries the transcript path but no turn_id: it is the first chance to
    // learn session identity, and on Codex it arrives with the first turn rather than at
    // boot.
    if (d.payload['transcript_path'] && !this.#transcriptPath) {
      this.#sessionId = String(d.payload['session_id'] ?? '')
      this.#transcriptPath = String(d.payload['transcript_path'])
      this.#view = new TranscriptSessionView({
        path: this.#transcriptPath,
        agent: 'codex',
        sessionId: this.#sessionId,
        cwd: this.#opts.cwd,
        guarantees: this.guarantees,
      })
    }

    switch (d.event) {
      case 'SessionStart':
        return

      case 'UserPromptSubmit': {
        const key = turnKey(String(d.turnKey ?? `unkeyed-${this.#order.length}`))
        const tracker = this.#newTracker()
        tracker.observeHook('UserPromptSubmit', d.payload)
        const turn: TurnState = {
          key,
          prompt: String(d.payload['prompt'] ?? ''),
          startedAt: Date.now(),
          tracker,
          endSeq: undefined,
          assistantText: undefined,
        }
        this.#turns.set(String(key), turn)
        this.#order.push(String(key))
        this.#watchdog.arm(String(key), turn)
        // A turn is running: tail the transcript so its narration and tool use exist while
        // they are useful, not in a burst after it ends.
        this.#startTailing()
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
        const turn = this.#turnFor(d) ?? this.#latestLiveTurn()
        if (turn) this.#apply(turn, turn.tracker.observeHook('PermissionRequest', d.payload), true)
        this.#emit({
          type: 'permission_requested',
          tool: String(d.payload['tool_name'] ?? 'unknown'),
          input: d.payload['tool_input'],
          turnKey: turn?.key,
          seq: this.#next(),
          at: Date.now(),
          provisional: false,
        })
        return
      }

      case 'Stop': {
        const turn = this.#turnFor(d) ?? this.#latestSettleableTurn()
        if (!turn) return
        // Fallback only; the transcript carries the full narration and reconciliation
        // replaces this. See the visibility model: the peer receives all prose.
        if (d.payload['last_assistant_message'] && !turn.assistantText) {
          turn.assistantText = String(d.payload['last_assistant_message'])
        }
        this.#apply(turn, turn.tracker.observeHook('Stop', d.payload), false)
        return
      }

      case 'SessionEnd': {
        // Never observed on Codex in any fixture, and deliberately not depended on for
        // readiness or terminal resolution. Recorded as audit evidence if it appears --
        // it can only strengthen a process_exited verdict, never create one.
        for (const t of this.#liveTurns()) {
          this.#apply(t, t.tracker.observeHook('SessionEnd', d.payload), true)
        }
        return
      }
    }
  }

  #turnFor(d: HookDelivery): TurnState | undefined {
    return d.turnKey ? this.#turns.get(String(d.turnKey)) : undefined
  }

  #allTurns(): TurnState[] {
    return this.#order.map((k) => this.#turns.get(k)!).filter(Boolean)
  }

  #liveTurns(): TurnState[] {
    return this.#allTurns().filter((t) => !t.tracker.settled)
  }

  #latestLiveTurn(): TurnState | undefined {
    return this.#liveTurns().at(-1)
  }

  #latestSettleableTurn(): TurnState | undefined {
    return this.#liveTurns().at(-1) ?? this.#allTurns().at(-1)
  }

  #apply(turn: TurnState, update: VerdictUpdate | undefined, synthesized: boolean): void {
    if (!update) return

    // A settled turn releases its watchdog target. `disarm` keeps the target on purpose so
    // `touch` can re-arm a live turn, so something has to let go or every TurnState ever
    // armed -- with its tracker, provenance and assistant text -- is retained until the
    // session ends. A long interactive session accumulates one per turn.
    this.#watchdog.forget(String(turn.key))

    if (update.supersedes && turn.endSeq !== undefined) {
      this.#emit({
        type: 'revision',
        reason: 'late_signal',
        replaces: [turn.endSeq],
        provenance: [
          {
            source: 'transcript',
            detail:
              `stronger evidence superseded ${update.supersedes.outcome}` +
              (update.verdict ? ` with ${update.verdict.outcome}` : ' with no verdict'),
          },
          ...(update.verdict?.provenance ?? []),
        ],
        seq: this.#next(),
        at: Date.now(),
        provisional: false,
      })
      turn.endSeq = undefined
    }

    if (!update.verdict) return

    const seq = this.#next()
    turn.endSeq = seq
    // One last read before standing down, so the closing message is not left for the next
    // turn's tail to discover.
    this.#stopTailing()
    void this.#pollTranscript()
    this.#emit({
      type: 'turn_end',
      verdict: update.verdict,
      synthesized,
      turnKey: turn.key,
      seq,
      at: Date.now(),
      provisional: false,
    })
  }

  /**
   * Rebuild transcript evidence per turn from the transcript as it currently stands.
   *
   * Codex correlates far better than Claude here: turns are keyed by `turn_id` in both
   * the hooks and the transcript, so this matches by key instead of Claude's positional
   * credit accounting. `turn_aborted` is the only proof of cancellation Codex offers, and
   * it lives only in the transcript -- so this is not an optional enrichment step, it is
   * where cancelled turns get their verdict.
   *
   * `resetTranscript` rather than merge: compaction may remove a record already observed,
   * and continuing to assert it would contradict the source of truth.
   */
  async #reconcileFromTranscript(): Promise<void> {
    if (!this.#view) return
    let snap: SessionSnapshot
    try {
      snap = await this.#view.snapshot()
    } catch {
      return
    }

    const byKey = new Map(snap.turns.map((t) => [String(t.key), t]))
    for (const turn of this.#allTurns()) {
      const record = byKey.get(String(turn.key))
      if (!record) continue
      const state = { ...emptyTranscriptState(), exists: true }
      if (record.state === 'cancelled') {
        // parseCodex only sets this from an explicit turn_aborted record.
        state.turnAbortedReason =
          record.provenance?.find((p) => p.detail.startsWith('turn_aborted'))?.detail.split('=')[1] ??
          'interrupted'
      } else if (record.state === 'completed') {
        state.taskComplete = true
        state.hasAssistantAfterPrompt = true
        state.finalStopReason = 'end_turn'
      }
      if (record.assistantText) turn.assistantText = record.assistantText
      this.#apply(turn, turn.tracker.resetTranscript(state), true)
    }
  }

  async #onExit(reason: string): Promise<void> {
    this.#pendingPrompt?.reject(new Error(`codex exited (${reason}) before accepting the prompt`))
    this.#pendingPrompt = undefined

    // The child is gone, so the deadline has nothing left to say about these turns.
    this.#watchdog.disarmAll()

    await this.#reconcileFromTranscript()
    for (const turn of this.#liveTurns()) {
      this.#apply(
        turn,
        turn.tracker.observeProcess({ alive: false, howEnded: this.#pty.exitInfo?.reason }),
        true,
      )
    }

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


  #state: SessionState = 'running'

  get state(): SessionState {
    return this.#state
  }

  /**
   * Stop accepting work; stay alive and keep the context.
   *
   * Deliberately does not touch the PTY. A quiesced session is one a replacement may have
   * to be rolled back to, so nothing about it may be discarded -- not the process, not the
   * transcript, not the trackers. The only change is that `send()` refuses.
   */
  async quiesce(): Promise<void> {
    if (this.#state === 'terminated') throw new Error('cannot quiesce a terminated session')
    await this.#input.drain()
    this.#state = 'quiesced'
  }

  /** The rollback path: return a quiesced session to service. */
  async unquiesce(): Promise<void> {
    if (this.#state === 'terminated') throw new Error('cannot unquiesce a terminated session')
    this.#state = 'running'
  }

  async beginRotation(): Promise<void> {
    if (this.#state !== 'quiesced') {
      throw new Error(`cannot begin rotation from '${this.#state}': quiesce the session first`)
    }
    this.#state = 'rotating'
  }

  async send(message: string, _provenance: SendProvenance): Promise<TurnKey> {
    if (this.#state !== 'running') {
      throw new Error(`session is ${this.#state}; it is not accepting work`)
    }
    if (!this.acceptsInput) throw new Error('session is not accepting input')
    const keyed = new Promise<TurnKey>((resolve, reject) => {
      this.#pendingPrompt = { resolve, reject, prompt: message }
    })
    await this.#input.submit(message)
    // Cleared on the way out: the loser of the race is a live 60s timer, and leaving it
    // pending keeps the event loop alive long after the send resolved.
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(SEND_HOOK_TIMEOUT)), 60_000)
    })
    try {
      return await Promise.race([keyed, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * ESC interrupts. Unlike Claude, the child records this: `turn_aborted` appears in the
   * transcript, so the verdict becomes `proven` once reconciled rather than resting on
   * our own bookkeeping.
   */
  async cancel(): Promise<TurnKey | undefined> {
    const turn = this.#latestLiveTurn()
    await this.#input.cancel(turn ? String(turn.key) : 'no live turn')
    if (!turn) return undefined
    this.#apply(turn, turn.tracker.observeOrchestrator({ sentCancel: true }), true)
    // The child writes turn_aborted asynchronously, so poll rather than reconcile once.
    // Until it lands the verdict rests on our own ESC record (`assumed`); once it does,
    // the transcript upgrades it to `proven`. A single fixed sleep raced the write.
    await this.#awaitTranscriptEvidence(turn, 15_000)
    return turn.key
  }

  async decidePermission(decision: 'allow' | 'deny'): Promise<void> {
    if (this.guarantees.inputOwnership !== 'mediated') {
      throw new Error('permission decisions require mediated input ownership')
    }
    await this.#input.decidePermission(decision)
    const turn = this.#latestSettleableTurn()
    if (turn) {
      this.#apply(turn, turn.tracker.observeOrchestrator({ sentPermissionDecision: decision }), true)
    }
    // A denial ends the turn via turn_aborted; an allow lets it continue to Stop, which
    // arrives through the hook channel and needs no transcript polling.
    if (decision === 'deny') {
      const turnToWatch = turn
      if (turnToWatch) await this.#awaitTranscriptEvidence(turnToWatch, 15_000)
    }
  }

  /**
   * Reconcile repeatedly until this turn's verdict stops resting on our own bookkeeping,
   * or the budget runs out. Codex records `turn_aborted` after the fact, so the evidence
   * that upgrades a verdict from `assumed` to `proven` simply is not there yet when the
   * keystroke returns.
   */
  async #awaitTranscriptEvidence(turn: TurnState, budgetMs: number): Promise<void> {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 750))
      await this.#reconcileFromTranscript()
      const v = turn.tracker.verdict
      if (v && v.confidence !== 'assumed') return
    }
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

    // Union, not overlay. The adapter learns a turn exists from UserPromptSubmit, which
    // arrives before Codex has written anything about it to the transcript -- so a
    // transcript-only view silently omits in-flight turns, and a consumer folding
    // events() would then disagree with snapshot(). Adapter-known turns lead; tracker
    // verdicts outrank transcript inference; transcript turns we never saw a hook for
    // are still reported.
    const byKey = new Map(snap.turns.map((t) => [String(t.key), t]))
    const turns: TurnRecord[] = []

    for (const turn of this.#allTurns()) {
      const record = byKey.get(String(turn.key))
      byKey.delete(String(turn.key))
      const verdict = turn.tracker.verdict
      const merged: TurnRecord = {
        key: turn.key,
        prompt: turn.prompt || record?.prompt || '',
        state: verdict?.outcome ?? record?.state ?? 'in_progress',
        toolCalls: record?.toolCalls ?? [],
      }
      const confidence = verdict?.confidence ?? record?.confidence
      if (confidence) merged.confidence = confidence
      const provenance = verdict?.provenance ?? record?.provenance
      if (provenance) merged.provenance = provenance
      const text = turn.assistantText ?? record?.assistantText
      if (text) merged.assistantText = text
      merged.startedAt = record?.startedAt ?? turn.startedAt
      turns.push(merged)
    }

    for (const orphan of byKey.values()) turns.push(orphan)

    return { ...snap, turns, role: this.#opts.role }
  }

  async fork(): Promise<AgentSession> {
    throw new Error('fork() not implemented for the PTY adapter yet')
  }

  async close(mode: 'graceful' | 'abandoned' = 'graceful'): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#closeMode = mode
    // We are done observing, so the deadline stops applying. Left armed it could fire
    // during the awaits below and race the verdict each branch is deliberately choosing.
    this.#watchdog.disarmAll()

    if (mode === 'graceful' && this.#pty.alive) {
      await this.#input.drain()
      // Reconcile before terminating: an established verdict must not be replaced by a
      // weaker causal guess because cleanup killed the process.
      await this.#reconcileFromTranscript()
      await this.#pty.terminate()
    } else if (mode === 'abandoned') {
      // Through the tracker, never around it. Emitting a verdict the tracker does not
      // hold is precisely what made events() and snapshot() disagree here.
      for (const turn of this.#liveTurns()) {
        this.#apply(turn, turn.tracker.observeObservationGap(), true)
      }
      // Record the gap first, THEN terminate. The distinction between the two modes is
      // epistemic, not custodial: abandonment refuses to claim anything about the turns,
      // and it was never meant to leak the process. It did -- the first live rotation
      // rolled back, closed its replacement as abandoned, and left a Claude CLI running.
      // The node process then could not exit for 26 minutes, which is how this was found.
      //
      // Terminating after the gap is recorded means cleanup cannot manufacture a verdict:
      // the tracker already holds `unknown_abnormal_end`, and process death is weaker
      // evidence than what it holds, so the classifier's rule order discards it.
      if (this.#pty.alive) await this.#pty.terminate()
    }

    this.#stopTailing()
    await this.#receiver.stop()
    this.#state = 'terminated'
    this.#events.close()
  }

  /** Test and diagnostic access. */
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
