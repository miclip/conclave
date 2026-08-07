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
import { InputQueue } from '../process/input.ts'
import { HookReceiver } from '../hooks/receiver.ts'
import type { HookDelivery } from '../hooks/journal.ts'
import { TranscriptSessionView } from '../transcript/reconcile.ts'
import { AsyncQueue } from './asyncQueue.ts'

const CLIENT = join(import.meta.dirname, '..', 'hooks', 'client.ts')
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'SessionEnd']

interface TurnState {
  key: TurnKey
  prompt: string
  startedAt: number
  /**
   * Owns this turn's evidence and verdict. Replaces the previous one-shot finalisation,
   * which could
   * not represent Codex-style classification at all: the outcome depends on evidence
   * arriving through four different channels -- transcript records, the hook stream, the
   * mediated input log, and the input-ownership policy -- and some of it arrives after a
   * verdict has already been reported.
   */
  tracker: TurnVerdictTracker
  /** Seq of the last `turn_end` emitted, so a revision can withdraw it by number. */
  endSeq: number | undefined
  assistantText: string | undefined
}

export interface ClaudeAdapterOptions {
  cwd: string
  role: Role
  inputOwnership?: InputOwnership | undefined
  /** Extra CLI args, e.g. ['--permission-mode', 'default']. */
  args?: string[] | undefined
  readyTimeoutMs?: number | undefined
  /** How long an unmatched turn may run before the watchdog calls it uncertain. */
  watchdogMs?: number | undefined
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

export class ClaudePtyHookAdapter implements AgentSession {
  readonly agent = 'claude'
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
  #ready = false
  #closed = false
  #closeMode: 'graceful' | 'abandoned' | undefined
  #pendingPrompt: { resolve: (k: TurnKey) => void; reject: (e: Error) => void; prompt: string } | undefined
  #opts: ClaudeAdapterOptions
  #settingsDir: string | undefined
  #watchdog: TurnWatchdog<TurnState>

  private constructor(opts: ClaudeAdapterOptions) {
    this.#opts = opts
    this.guarantees = guaranteesFor(opts.inputOwnership ?? 'mediated')
    // A hung turn produces no hooks, no transcript records and no exit, so the deadline
    // rule has to be driven by a clock rather than by an arrival like everything else.
    // `synthesized: true` -- nothing from the child said this.
    this.#watchdog = new TurnWatchdog<TurnState>(opts.watchdogMs ?? DEFAULT_WATCHDOG_MS, (turn, update) =>
      this.#apply(turn, update, true),
    )
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
    if (!this.#ready) throw new Error(this.#whyNotReady())
    // Readiness is not the same as being able to type; wait for both.
    await this.#pty.waitForOutput(() => this.#pty.isInteractive, 30_000)
    await this.#pty.waitQuiet(700, 20_000)
  }

  /**
   * Why the session never became ready, in terms the operator can act on.
   *
   * `claude session did not report SessionStart` named an internal fact and offered nothing.
   * The commonest cause by far is the FOLDER TRUST dialog, which 2.1.224 shows on any
   * directory it has not seen -- including under `--dangerously-skip-permissions`, which does
   * not cover it. Nothing proceeds until it is answered, so no hook ever fires and the
   * failure looks identical to a broken hook registration.
   *
   * That is a direct hit on what Conclave claims: run it in the project you want worked on,
   * the project needs nothing installed. It needs one thing, once, and it is not obvious.
   *
   * Deliberately NOT answered automatically. The dialog asks whether the FOLDER's contents
   * are safe to execute, and running Conclave in a directory is not the same as having vetted
   * what is in it. Both remedies are named instead -- the interactive one, and the key Claude
   * Code's own message points at.
   */
  #whyNotReady(): string {
    // Escapes are stripped and whitespace collapsed before matching. The raw buffer carries
    // cursor-positioning sequences BETWEEN words -- `trust\x1b[20Gthis\x1b[25Gfolder` -- so
    // no phrase appears contiguously and a naive regex silently never matches.
    const screen = (this.#pty?.output ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;?]*[a-zA-Z]|\u001b[()][A-Z0-9]|\u001b[]][^\u0007]*\u0007/g, ' ')
      .replace(/\s+/g, ' ')
    if (/trust this folder|Is this a project you created/i.test(screen)) {
      return (
        `claude is waiting on its folder-trust dialog for ${this.#opts.cwd}, so no hook can ` +
        'fire and the session never becomes ready. Run `claude` in that directory once and ' +
        'accept, or set projects["' +
        this.#opts.cwd +
        '"].hasTrustDialogAccepted to true in ~/.claude.json. Note that ' +
        '--dangerously-skip-permissions does NOT cover this dialog.'
      )
    }
    if (!this.#pty?.alive) {
      return 'claude exited before reporting SessionStart; run `conclave config check` to verify the hook registration'
    }
    return (
      'claude did not report SessionStart within the readiness window. The hooks may not be ' +
      'registered: run `conclave config check`. If it is merely slow, raise readyTimeoutMs.'
    )
  }

  #hookSettings(): unknown {
    const command = `node ${CLIENT} claude`
    const entry = { hooks: [{ type: 'command', command, timeout: 10 }] }
    return { hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, [entry]])) }
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
    if (e.turnKey !== undefined && e.type !== 'turn_end') this.#watchdog.touch(String(e.turnKey))
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
        const tracker = new TurnVerdictTracker({
          agent: this.agent,
          orchestrator: {
            sentCancel: false,
            inputIsMediated: this.guarantees.inputOwnership === 'mediated',
          },
          watchdogSeconds: (this.#opts.watchdogMs ?? DEFAULT_WATCHDOG_MS) / 1000,
        })
        tracker.observeHook('UserPromptSubmit', d.payload)
        const turn: TurnState = {
          key,
          prompt: String(d.payload.prompt ?? ''),
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
        const turn = this.#latestLiveTurn()
        if (turn) this.#apply(turn, turn.tracker.observeHook('PermissionRequest', d.payload), true)
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
        // A Stop may arrive for a turn already settled by other evidence; the tracker
        // decides whether it changes anything, rather than a guard here deciding it is
        // too late to matter.
        const turn = this.#turnFor(key) ?? this.#latestSettleableTurn()
        if (!turn) return
        // Fallback only. The peer is entitled to the full narration, which lives in the
        // transcript; this is the closing paragraph and is used until reconciliation
        // replaces it, or permanently if the transcript is unreadable.
        if (d.payload.last_assistant_message && !turn.assistantText) {
          turn.assistantText = String(d.payload.last_assistant_message)
        }
        this.#apply(turn, turn.tracker.observeHook('Stop', d.payload), false)
        return
      }
      case 'SessionEnd': {
        // Session-level, not turn-level. Recorded as evidence on turns still open.
        for (const t of this.#liveTurns()) {
          this.#apply(t, t.tracker.observeHook('SessionEnd', d.payload), true)
        }
        return
      }
    }
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

  /** Most recent turn, settled or not -- late evidence may still revise a settled one. */
  #latestSettleableTurn(): TurnState | undefined {
    return this.#liveTurns().at(-1) ?? this.#allTurns().at(-1)
  }

  /**
   * Emit whatever a tracker update implies: a `revision` withdrawing the previous
   * `turn_end` when one is superseded, then the new terminal event.
   *
   * This is the whole point of the migration. A verdict already reported to consumers is
   * withdrawn by number rather than left standing beside its own contradiction.
   */
  #apply(turn: TurnState, update: VerdictUpdate | undefined, synthesized: boolean): void {
    if (!update) return

    if (update.supersedes && turn.endSeq !== undefined) {
      this.#emit({
        type: 'revision',
        reason: 'late_signal',
        replaces: [turn.endSeq],
        provenance: [
          {
            source: 'hook',
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

    if (!update.verdict) return // withdrawn without replacement; the turn is open again

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

  #lastPermissionDecision(since: number): 'allow' | 'deny' | undefined {
    const a = this.#input.last('permission_decision')
    if (!a || a.at < since) return undefined
    return a.detail?.startsWith('deny') ? 'deny' : 'allow'
  }

  /**
   * Rebuild transcript evidence for every turn from the transcript as it CURRENTLY
   * stands, and let each tracker re-decide.
   *
   * `resetTranscript` rather than `observeTranscript` on purpose. Everywhere else
   * evidence accumulates, which is what stops weaker repeated signals resurrecting a
   * verdict. Compaction breaks that: a rewritten transcript may no longer contain a
   * record a tracker already saw, and holding it would assert something the source of
   * truth now denies. Hook and orchestrator evidence survive untouched -- those channels
   * were not rewritten.
   *
   * This is also what stops a lost `Stop` from becoming `process_exited` at shutdown: an
   * assistant entry with stop_reason=end_turn is correlation evidence that the turn
   * completed even though its hook never arrived.
   */
  async #reconcileFromTranscript(): Promise<void> {
    if (!this.#view) return

    let snap: SessionSnapshot
    try {
      snap = await this.#view.snapshot()
    } catch {
      return // transcript unreadable; leave existing evidence alone rather than guess
    }
    const completedInTranscript = snap.turns.filter((t) => t.state === 'completed').length

    // Only as many turns as the transcript actually evidences may claim completion.
    let credits = Math.max(0, completedInTranscript - this.#provenCompletedCount())

    this.#allTurns().forEach((turn, i) => {
      // The peer receives ALL prose, not just the closing message, so the transcript is
      // the source of truth here: parseClaude concatenates every text block in the turn,
      // which is the running narration a reader following along actually sees. The Stop
      // hook's last_assistant_message is only the final paragraph, and is kept as a
      // fallback for when the transcript cannot be read. Claude Code writes no per-turn
      // id, so correspondence is positional.
      const narration = snap.turns[i]?.assistantText
      if (narration) turn.assistantText = narration

      const recovered = !turn.tracker.evidence.hooks.includes('Stop') && credits > 0
      if (recovered) credits--
      const update = turn.tracker.resetTranscript({
        ...emptyTranscriptState(),
        exists: true,
        hasAssistantAfterPrompt: recovered,
        finalStopReason: recovered ? 'end_turn' : undefined,
      })
      this.#apply(turn, update, true)
    })
  }

  /** Turns whose completion is proven by a Stop, so they need no transcript credit. */
  #provenCompletedCount(): number {
    return this.#allTurns().filter((t) => t.tracker.evidence.hooks.includes('Stop')).length
  }

  async #onExit(reason: string): Promise<void> {
    // Every outstanding command promise must resolve; a caller awaiting send() when the
    // child dies would otherwise hang forever.
    this.#pendingPrompt?.reject(new Error(`claude exited (${reason}) before accepting the prompt`))
    this.#pendingPrompt = undefined

    // The child is gone: whatever the turns are, they are not still running. The deadline
    // has nothing left to say and must not fire against a dead session.
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
    // Serialized against cancel() and decidePermission() by the shared queue.
    await this.#input.submit(message)
    // Cleared on the way out: the loser of the race is a live 30s timer, and leaving it
    // pending keeps the event loop alive long after the send resolved.
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(SEND_HOOK_TIMEOUT)), 30_000)
    })
    try {
      return await Promise.race([keyed, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  async cancel(): Promise<TurnKey | undefined> {
    const turn = this.#latestLiveTurn()
    await this.#input.cancel(turn ? String(turn.key) : 'no live turn')
    if (!turn) return undefined
    // Cancellation produces no signal from the child at all. Give the UI a moment to
    // settle, then conclude from our own record of having sent ESC -- which is why the
    // input queue's semantic action log is classification evidence, not a debug aid.
    await new Promise((r) => setTimeout(r, 1500))
    this.#apply(turn, turn.tracker.observeOrchestrator({ sentCancel: true }), true)
    return turn.key
  }

  async decidePermission(decision: 'allow' | 'deny'): Promise<void> {
    if (this.guarantees.inputOwnership !== 'mediated') {
      throw new Error('permission decisions require mediated input ownership')
    }
    const action = await this.#input.decidePermission(decision)
    // The decision is evidence: on both agents a refused permission is otherwise
    // indistinguishable from a user cancellation.
    const turn = this.#latestSettleableTurn()
    if (turn) {
      this.#apply(
        turn,
        turn.tracker.observeOrchestrator({ sentPermissionDecision: decision }),
        true,
      )
    }
    void action
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

    // Claude Code writes no per-turn id into its transcript, so correspondence is
    // positional. Hook-derived verdicts outrank transcript inference -- Stop proves
    // completion, the transcript only suggests it -- and any turn the adapter knows about
    // beyond what the transcript has yet recorded is appended rather than dropped.
    // Omitting it would make a consumer folding events() disagree with snapshot().
    const turns = [...snap.turns]
    this.#order.forEach((key, i) => {
      const known = this.#turns.get(key)
      if (!known) return
      const verdict = known.tracker.verdict
      const base = turns[i] ?? { key: known.key, prompt: known.prompt, state: 'in_progress' as const, toolCalls: [] }
      const merged: TurnRecord = { ...base, key: known.key }
      if (verdict) {
        merged.state = verdict.outcome
        merged.confidence = verdict.confidence
        merged.provenance = verdict.provenance
      }
      turns[i] = merged
    })
    return { ...snap, turns, role: this.#opts.role }
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
    // Before either branch: we are done observing, so the deadline stops applying. Left
    // armed it could fire during the awaits below and race the verdict each branch is
    // deliberately choosing.
    this.#watchdog.disarmAll()

    if (mode === 'graceful' && this.#pty.alive) {
      await this.#input.drain()
      // Reconcile BEFORE terminating. A verdict already established by stronger evidence
      // must not be replaced by a weaker causal guess just because cleanup killed the
      // process; the classifier's rule order enforces the same thing from the other side.
      await this.#reconcileFromTranscript()
      await this.#pty.terminate()
    } else if (mode === 'abandoned') {
      // We are walking away from the transport, not asserting anything about the turns.
      // Only turns with no verdict yet: abandonment asserts nothing about a turn whose
      // outcome is already established -- walking away does not un-complete it. Routed
      // through the tracker so the verdict it holds matches what the stream reported.
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
