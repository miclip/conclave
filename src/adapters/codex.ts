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
 * advisor-turn budgets, no role prompting, no summarisation.
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
import { guaranteesFor, isChildOutput, turnKey } from '../contract/session.ts'
import { emptyTranscriptState } from '../outcomes/classify.ts'
import { TurnVerdictTracker, type VerdictUpdate } from '../outcomes/tracker.ts'
import { DEFAULT_WATCHDOG_MS, TAIL_INTERVAL_MS, TurnWatchdog } from '../outcomes/watchdog.ts'
// The same function the run record reads, rather than a second parse of the same argv: what the
// diagnosis names must be what the report says this seat was launched with.
import { modelFromArgs } from '../registry/launch.ts'
import { sanitizedCopy } from '../process/childenv.ts'
import { PtyProcess } from '../process/pty.ts'
import { CODEX_PERMISSION_ENCODING, InputQueue } from '../process/input.ts'
import { HookReceiver } from '../hooks/receiver.ts'
import type { HookDelivery } from '../hooks/journal.ts'
import { TranscriptSessionView } from '../transcript/reconcile.ts'
import { TASK_COMPLETE_ERROR } from '../transcript/parse.ts'
import { AsyncQueue } from './asyncQueue.ts'
import { BoundedSingleFlight, type Abandonment } from './boundedReconcile.ts'
import {
  CorruptedPromptError,
  describePromptMismatch,
  isCorruptedPrompt,
  PROMPT_RECOVERY_MS,
  PROMPT_SEND_ATTEMPTS,
  promptRetryExhausted,
  promptRetryNotAttempted,
  type PromptMismatch,
} from './promptFidelity.ts'

/**
 * The one send this session is waiting on a hook for. See `#pendingPrompt`, and
 * `PROMPT_SEND_ATTEMPTS` for why a corrupted send keeps it rather than releasing it.
 */
interface PendingPrompt {
  resolve: (k: TurnKey) => void
  reject: (e: Error) => void
  prompt: string
}

interface TurnState {
  key: TurnKey
  prompt: string
  startedAt: number
  tracker: TurnVerdictTracker
  /** Seq of the last `turn_end` emitted, so a revision can withdraw it by number. */
  endSeq: number | undefined
  assistantText: string | undefined
  /**
   * Whether the CHILD has said anything during this turn (#82).
   *
   * Not `lastActivityAt`, which cannot answer this: the adapter emits `turn_start` the instant
   * it arms, so every turn looks active from its first millisecond. This is set only by output
   * that came from the child, which is what separates "went quiet" from "never spoke".
   */
  produced: boolean
  /**
   * How the CHILD said this turn ended, if it has said so at all.
   *
   * Undefined until something the child produced closes the turn: its own `Stop`, a
   * `SessionEnd`, the process exiting, or -- on Codex -- the transcript recording how the turn
   * finished. Conclave typing ESC does NOT set it, and that distinction is the whole reason
   * the field exists: `cancel()` closes the transport and mints a `cancelled` verdict from our
   * own record of the keystroke at `assumed` confidence, so a turn that was cancelled looks
   * closed from in here whether or not the child ever stopped running it.
   *
   * Read by the #174 retry, which may only re-type a message once the child itself has been
   * heard from. See `#recoverForRetry`.
   */
  childClosure: string | undefined
}

export interface CodexAdapterOptions {
  cwd: string
  role: Role
  inputOwnership?: InputOwnership | undefined
  /** Extra CLI args from the participant spec. */
  args?: string[] | undefined
  /**
   * The program to spawn. Defaults to `codex` on PATH.
   *
   * Threaded from `AgentDefinition.launch.command` by the registry (#51), for the reason
   * `ClaudeAdapterOptions.command` gives: the availability preflight validates
   * `launch.command`, and an adapter that hardcodes its own filename would let a wrapper or an
   * absolute path be checked and then not be the thing that runs.
   */
  command?: string | undefined
  readyTimeoutMs?: number | undefined
  /**
   * Overrides the view's `READ_LEASE_MS` for this session's transcript reads.
   *
   * A TEST seam, and it is here rather than in a test's own prototype patch because the thing
   * worth exercising is the real adapter over the real view: what a caller does when a read
   * does not answer is scheduling behaviour, and a stand-in for the view is a stand-in for the
   * behaviour under test. The production default is ten seconds, chosen to sit far above any
   * read that is merely slow (`READ_LEASE_MS`), and a suite that has to wait it out several
   * times over spends most of its life asleep for nothing: nothing in those tests is about the
   * VALUE, only about what happens once it is spent.
   *
   * Not for production use. A lease short enough to be convenient is short enough to abandon
   * healthy reads on a loaded machine, which turns a slow filesystem into a stream of callers
   * being told the transcript could not be read.
   */
  readLeaseMs?: number | undefined
  /**
   * Overrides `CANCEL_EVIDENCE_BUDGET_MS` and `CANCEL_EVIDENCE_POLL_MS` for this session.
   *
   * The same TEST seam as `readLeaseMs`, and for the same reason: what a cancellation costs is
   * a relationship between three numbers -- the budget, the poll interval and the view's read
   * lease -- and the tests that pin it have to spend all three in real wall time. Injected
   * together and scaled together, those tests keep every claim they make, because every claim
   * is about the RATIOS. Scaled apart they would be about a configuration nobody runs.
   *
   * Not for production use. The shipped values are chosen against a real child writing
   * `turn_aborted` after the fact; a budget short enough to be convenient in a test reports
   * `assumed` on cancellations the transcript was about to prove.
   */
  cancelEvidenceBudgetMs?: number | undefined
  cancelEvidencePollMs?: number | undefined
  /**
   * How long the #174 recovery may wait for the CHILD to confirm the malformed turn ended,
   * before the send is refused instead of re-sent. Defaults to `PROMPT_RECOVERY_MS`.
   *
   * Not for production use. Shortening it makes a session give up on a confirmation that was
   * merely slow, which turns a recoverable corruption into a refusal.
   */
  promptRecoveryMs?: number | undefined
  /**
   * How long a turn may run in total before the watchdog calls it uncertain.
   *
   * The whole turn, a busy one included: no child output extends it. `idleMs` runs alongside
   * it and is the clock that catches an ordinary hang -- twelve minutes of silence rather than
   * forty-five of anything -- while this one is what guarantees the run stops WAITING on the
   * turn at all. It ends no turn and touches no child: what it produces is a `timed_out`
   * verdict, and the transport stays open until a cancellation, terminal evidence, or the
   * child's exit. The released wait is still what the run needs, because its ceilings are
   * checked at turn boundaries and nowhere else.
   */
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

/**
 * A second `send()` while the first has not yet become a turn.
 *
 * `#pendingPrompt` is ONE slot and the second send overwrote it, so the first caller's promise
 * was left for nobody to resolve: it waited out the hook timeout and then reported a hook
 * failure for a prompt the child had accepted. The keystrokes interleave too -- `InputQueue`
 * serialises typing, not sends -- so the composer can end up holding two prompts spliced
 * together, which is a corrupted turn rather than a slow one.
 *
 * Rejecting is the only honest answer available here. Queueing the second send would mean
 * holding a prompt whose turn the caller is already awaiting, and the caller is the relay,
 * which has its own idea of when a turn may start.
 */
const SEND_ALREADY_SENDING =
  'a send is already in flight on this session and has not yet been acknowledged by a hook; wait for it to resolve or fail before sending again'

/**
 * A `send()` while a turn is still open.
 *
 * Neither CLI accepts input mid-turn, and a send that lands there does not queue -- it ends the
 * run (#117). The relay already waits (`#awaitSendable`), so this refuses a caller that did not,
 * rather than duplicating a guard that was working.
 *
 * It is also what makes the watchdog's per-turn touch correct: exactly one turn is open at a
 * time, so activity belongs to the live turn and nowhere else.
 *
 * How long the refusal can last is a separate question, and the absolute deadline is not the
 * answer to it. That clock bounds what the RUN waits for -- it emits a `timed_out` verdict and
 * releases the exchange (`outcomes/watchdog.ts`) -- and it neither ends the turn nor reopens the
 * transport, so a send is still refused after it fires, which is #117 rather than an oversight.
 * What lifts this refusal is a cancellation, terminal evidence in the transcript or a hook, or
 * the child exiting.
 */
/**
 * How long a cancellation waits for the child to write the evidence that proves it.
 *
 * Codex records `turn_aborted` after the fact, so when the ESC returns the proof does not exist
 * yet and the verdict rests on our own bookkeeping (`assumed`). This is how long we are willing
 * to keep asking before settling for that.
 *
 * It is a BUDGET, not a latency: see `#awaitTranscriptEvidence` for what the wall clock actually
 * is, which is considerably more than this number.
 */
export const CANCEL_EVIDENCE_BUDGET_MS = 15_000

/**
 * The gap between two attempts to find that evidence.
 *
 * Slept BEFORE each reconcile rather than after, so the first attempt is not made against a
 * transcript the child has had no chance to write to. A single fixed sleep raced the write,
 * which is why this is a poll at all.
 */
export const CANCEL_EVIDENCE_POLL_MS = 750

/**
 * How often the #174 recovery asks whether the child has confirmed the malformed turn ended.
 *
 * A poll, because the confirmation arrives on the hook thread or from a transcript read, and
 * neither of them has anything to notify. Short enough that the common case -- a `Stop` landing
 * a moment after the ESC -- costs the recovery nothing measurable.
 */
const RECOVERY_POLL_MS = 50

const SEND_TURN_IN_FLIGHT =
  'a turn is already open on this session; neither CLI accepts input mid-turn, so this send would be spliced into the running turn rather than queued'

/**
 * How long the deadline's transcript re-check may take before it is abandoned.
 *
 * The read itself cannot hang on the child, and that is the property this bound is NOT relying
 * on: `TranscriptSessionView.snapshot()` reads the transcript FILE and parses it. It never
 * writes to the pty, never waits on a hook, and never takes the input queue -- so it cannot
 * block on the unresponsive child whose silence produced the deadline in the first place. A
 * check that could would be a deadlock in the mechanism meant to rescue the run from one.
 *
 * What the bound is for is the filesystem: a transcript on a network mount, or one large enough
 * that parsing it is measurable -- the largest in evidence is 57,493 records. Two seconds is far
 * past either and far short of anything an operator would notice, because nothing is waiting on
 * this: the `timed_out` verdict has already been emitted by the time it runs.
 *
 * ## What the bound does NOT promise
 *
 * It does not promise the check is over in two seconds, and it does not promise the process is
 * responsive during it. Nothing here cancels anything: the filesystem read keeps running to
 * completion, and the parsing and view rebuilding that follow it are SYNCHRONOUS -- they hold
 * the event loop for as long as they take. A re-check that spends four seconds inside one parse
 * takes four seconds, and nothing can shorten it. The LATENCY bound is soft, irreducibly. The
 * 57,493-record transcript is the size at which that stops being theoretical.
 *
 * What it does promise is that past two seconds the answer is not ACTED ON, however long the
 * loop was blocked. An abandoned re-check may finish updating the session view -- that work is
 * already paid for, and throwing it away only makes the next poll redo it -- but it may not
 * close the transport and it may not emit a `late_signal` revision. Letting it would mean a
 * verdict minted from evidence the deadline had already given up on, landing at an arbitrary
 * later moment: the run would declare a turn finished and a seat sendable long after it
 * concluded the opposite, with nothing in the event stream to say why the order came out that
 * way. Expiry also frees the single-flight slot, so a later deadline starts a fresh attempt
 * instead of attaching to a re-check that has already been written off -- and that attempt is
 * answered rather than parked, because the session view tells a caller its lease is spent
 * instead of leaving it waiting on a read that may never come back. What the fresh attempt does
 * NOT get is a fresh read: the view will not start a second one while the first is unresolved,
 * so an attempt made inside the wedge is told it got no answer, which is the truth.
 *
 * That promise deliberately does not rest on the bound's timer, and it cannot. Microtasks drain
 * before the timers phase, so when a blocked job finally yields, its own continuations run
 * BEFORE the overdue timer callback -- a flag that timer writes still reads `false` at the exact
 * moment the guard consults it, which is precisely the synchronous-parse case above. So
 * abandonment is computed from a deadline captured when the run started and evaluated when READ,
 * and is therefore already true the instant control resumes. See `Abandonment` and
 * `BoundedSingleFlight`.
 */
const DEADLINE_TRANSCRIPT_MS = 2_000

/**
 * The outcomes a DEADLINE can mint, and therefore the ones worth re-reading the transcript for.
 *
 * `timed_out` is the ordinary one. `unknown_abnormal_end` is the same clock under external input
 * ownership: when the orchestrator is not the only writer, the deadline rule degrades its own
 * verdict, because a direct keystroke could have ended the turn unseen and it will not claim
 * otherwise (`classify`, rule 7).
 *
 * Gating on `timed_out` alone therefore skipped the transcript re-check on exactly the sessions
 * where a human is sitting at the same terminal -- so an externally-owned seat whose `Stop` was
 * lost stayed stuck, and #36's recovery quietly did not apply to it.
 *
 * That degradation is about ATTRIBUTION of an unseen ending, and this check does not depend on
 * attribution. A transcript record saying the turn finished is positive proof from the child
 * itself; who else could type at it changes nothing about what it wrote down. So the weakened
 * verdict is re-checked exactly like the strong one, and the recovery it finds is just as good.
 *
 * A set rather than a comparison chain because this is the whole enumeration, and it is
 * meaningful ONLY at this call site: `#reconsiderDeadline` runs from the watchdog callback and
 * nowhere else, so every update it sees came from a clock. `unknown_abnormal_end` reached any
 * other way -- an errored `task_complete`, say (#35) -- is not a deadline and must never be
 * re-read as one.
 */
const DEADLINE_OUTCOMES = new Set(['timed_out', 'unknown_abnormal_end'])


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
  #pendingPrompt: PendingPrompt | undefined
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
      (turn, update) => {
        this.#apply(turn, update, true)
        // Then ask the transcript whether the clock was right. Fire-and-forget on purpose: the
        // verdict is already out, and nothing downstream waits on this. See `#reconsiderDeadline`.
        void this.#reconsiderDeadline(update)
      },
      opts.idleMs,
    )
  }


  /** The pty's child, so a quiet turn can be told from a dead one. See `outcomes/liveness`. */
  get childPid(): number | undefined {
    return this.#pty?.pid
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
      file: this.#opts.command ?? 'codex',
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
    // The child SPOKE, as opposed to the turn merely existing. `isChildOutput` owns which events
    // count and why -- it is the contract's answer rather than this adapter's, because #82's
    // launch diagnosis asks the same question of the same events.
    //
    // What makes the ones it accepts safe to refresh a deadline on is that every one of them is
    // a STRUCTURED transcript record or hook delivery, and neither can exist without new content
    // from the child. The tailer runs on a timer and finds nothing to emit from a silent
    // transcript, so polling cannot manufacture one; and no amount of terminal repaint -- a
    // spinner frame, a keepalive byte, a redrawn status line -- ever becomes one, because
    // nothing here is derived from pty bytes. Those are exactly the signals that would keep a
    // hung turn looking alive, and none of them reaches this branch.
    if (isChildOutput(e)) {
      // The live turn, by the key THIS adapter armed -- not `e.turnKey`, which is whatever
      // produced the event and does not agree: a transcript-sourced event carries the
      // transcript's positional key, never the hook's `prompt_id`. That mismatch is why this
      // was a blanket `touchAll()`; it is a keyed touch again now that `send()` refuses to
      // open a second turn, so "the live turn" names exactly one and the adapter knows which.
      //
      // A sign of life, so the SILENCE deadline moves out. Not the absolute one, which no
      // event refreshes: what the run WAITS for stays bounded even on a turn that keeps
      // producing, because the run's ceilings are only checked between turns (#36). Bounding
      // the wait is not ending the turn -- see `outcomes/watchdog.ts`.
      // The OPEN turn, not the unsettled one: after a deadline fires, output still belongs to
      // the turn that produced it, and crediting it to `#latestLiveTurn()` -- which is now
      // undefined, or worse the NEXT turn -- is how a turn gets marked as having spoken on
      // evidence from its predecessor.
      const turn = this.#openTurn()
      if (turn) this.#watchdog.touch(String(turn.key))
      // Recorded once per turn, on the transition only: this is the hot event path, and a
      // repeat says nothing the first did not.
      // Not on a settled turn. The tracker would reclassify and hand back an update that this
      // path discards, leaving a verdict in the tracker that no `turn_end` ever carried -- so
      // `events()` and `snapshot()` would disagree about a turn already reported.
      if (turn && !turn.tracker.settled && !turn.produced) {
        turn.produced = true
        turn.tracker.observeLaunch({ produced: true })
      } else if (!turn) {
        // The child spoke before its own UserPromptSubmit reached us.
        //
        // Defensive here, unlike on Claude where it is the observed bug (#82). Codex 0.147.0
        // cannot lose this race: `config/templates/codex-hooks.json` declares the hook
        // `async: false`, `hook_runtime.rs::inspect_pending_input` awaits
        // `run_user_prompt_submit`, and `turn.rs::run_hooks_and_record_inputs` has returned
        // before sampling can produce the tool call a `PermissionRequest` reports. So the
        // submit is delivered first by construction -- of that version, which is a fact about
        // a CLI we do not own and cannot pin.
        //
        // Dropping it is not neutral. It is the difference between "this turn produced
        // nothing, so the model it was launched with is a suspect" and the opposite, so
        // losing the race would make conclave blame a model for a turn that spoke.
        this.#producedBeforeTurn = true
      }
    }
    this.#events.push(e)
  }

  /**
   * A child-output event arrived with no live turn to attribute it to.
   *
   * Consumed by the next turn this session opens, once. Not a queue: what matters is only
   * whether the child has spoken at all, and a second early event says nothing the first
   * did not.
   */
  #producedBeforeTurn = false

  #newTracker(): TurnVerdictTracker {
    return new TurnVerdictTracker({
      agent: this.agent,
      orchestrator: {
        sentCancel: false,
        inputIsMediated: this.guarantees.inputOwnership === 'mediated',
      },
      watchdogSeconds: (this.#opts.watchdogMs ?? DEFAULT_WATCHDOG_MS) / 1000,
      // What this child was started with, so a deadline that fires on a turn which never
      // produced anything can name the model as a candidate cause (#82). `#order` is empty for
      // exactly one turn per session, which is the only turn the launch is a suspect on.
      launch: { model: modelFromArgs(this.#opts.args ?? []), firstTurn: this.#order.length === 0, produced: false },
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
        ...(this.#opts.readLeaseMs === undefined ? {} : { readLeaseMs: this.#opts.readLeaseMs }),
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
          produced: false,
          childClosure: undefined,
        }
        if (this.#producedBeforeTurn) {
          this.#producedBeforeTurn = false
          turn.produced = true
          turn.tracker.observeLaunch({ produced: true })
        }
        this.#turns.set(String(key), turn)
        this.#order.push(String(key))
        // The child is now working on this. Nothing but an observed stop closes it again.
        this.#openTurnKey = String(key)
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
        // #174: the hook echoes back the prompt the child ACTUALLY took. Comparing it to what
        // was sent is the one end-to-end check of the transport that does not itself depend on
        // the pty, the tty queue or the composer behaving. The turn above is already open and
        // already recorded against the text the child took -- that is what it is working on,
        // and pretending otherwise would put a lie in the transcript. Only the SEND is refused.
        //
        // An unsolicited hook has no pending send and is not a mismatch: the child is allowed
        // to start turns nobody here asked for, and always was.
        const pending = this.#pendingPrompt
        if (pending) {
          const corrupted = describePromptMismatch(pending.prompt, turn.prompt)
          if (!corrupted) {
            this.#pendingPrompt = undefined
            pending.resolve(key)
          } else {
            // The claim is NOT released here, and that is the point of releasing it in exactly
            // one place instead: `send()` may cancel this turn and type the message once more,
            // and the slot is what stops a second caller from sending into the gap while that
            // is happening. `send()` gives it back on every path out, including this one.
            pending.reject(new CorruptedPromptError(corrupted, String(key)))
          }
        }
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
        // The child's own statement that it is done, which is the only routine way this
        // closes. Keyed, so a late Stop for an earlier turn does not free a running one.
        this.#closeTransport(String(turn.key))
        // And it is the child's, which is what a #174 retry needs before it re-types anything.
        turn.childClosure ??= 'the child sent Stop for it'
        this.#apply(turn, turn.tracker.observeHook('Stop', d.payload), false)
        return
      }

      case 'SessionEnd': {
        // The session is over, so nothing in it is still running.
        this.#closeTransport(undefined)
        // The child's own account of the ending, so a #174 retry may act on it.
        for (const t of this.#liveTurns()) t.childClosure ??= 'the child ended the session'
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

  /**
   * Refuse a send that would overlap another. Both halves are races, not caller stupidity:
   * see `SEND_ALREADY_SENDING` and `SEND_TURN_IN_FLIGHT`.
   *
   * Checked before `#pendingPrompt` is claimed, so a refused send leaves every piece of state
   * belonging to the send already in flight exactly as it found it.
   */
  #refuseOverlappingSend(): void {
    if (this.#pendingPrompt) throw new Error(SEND_ALREADY_SENDING)
    // Transport openness, not `#liveTurns()`. A watchdog verdict settles the tracker while the
    // child carries on; asking the tracker here would hand the next prompt to a busy composer
    // on exactly the turns most likely to be busy. See `#openTurnKey`.
    const open = this.#openTurn()
    if (open) throw new Error(`${SEND_TURN_IN_FLIGHT} (turn ${String(open.key)})`)
  }

  /**
   * The turn the CHILD is still executing, as far as anything observed can say.
   *
   * Deliberately NOT `tracker.settled`, which is what `#liveTurns()` means by live. A verdict is
   * this process's conclusion about a turn; transport openness is a fact about the child, and the
   * watchdog is precisely the case where the two disagree. `timed_out` is synthesized from a
   * clock running out with nothing arriving -- it is not evidence that the child stopped, and the
   * turn it describes may still be editing files. Sending there types a prompt into a composer
   * that is not accepting input: not queued behind the turn, spliced into it, which is the
   * failure #117 is about.
   *
   * Opened by `UserPromptSubmit` and closed only by one of these:
   *
   *   Stop            the child's own hook, for this turn and not an earlier one
   *   SessionEnd      the session is over, so no turn in it is running
   *   child exit      the strongest form of the same statement
   *   cancel()        ESC typed and the input queue drained -- a completed cancellation
   *
   * A deadline expiring closes none of them, which is the whole point.
   *
   * Three of those four are the CHILD's account and the fourth is ours. A completed
   * cancellation is the right rule for THIS question -- may a new send start? -- because a
   * cancelled seat is one an operator has taken back, and refusing forever after an unanswered
   * ESC would leave the seat unusable. It is not evidence that the child stopped: Claude Code
   * records an interruption nowhere and Codex may not write `turn_aborted` for a while. Any
   * decision that turns on the child actually having stopped -- the #174 retry is the one that
   * does -- reads `TurnState.childClosure` instead, which only the child's own signals set.
   *
   * The consequence is deliberate and worth stating: a turn whose `Stop` is LOST stays open here
   * until something cancels it, and sends to that seat are refused meanwhile. That is the same
   * answer `Relay#awaitSendable` already gives a busy seat -- cancel it and close it rather than
   * send into it -- and the recovery is the same call, so the state is escapable.
   */
  #openTurnKey: string | undefined

  /**
   * The turn the child may still be executing. See `#openTurnKey`.
   *
   * Undefined once something observed the child stop, whatever any verdict says.
   */
  #openTurn(): TurnState | undefined {
    return this.#openTurnKey === undefined ? undefined : this.#turns.get(this.#openTurnKey)
  }

  /**
   * Note that the child has stopped working on `key`, if that is the turn that was open.
   *
   * Keyed rather than unconditional: a `Stop` carrying an earlier turn's key is a late signal
   * about a turn already accounted for, and reading it as the end of the turn in flight is how a
   * relay comes to send into a child that is still working -- the same mistake
   * `outcomes/activeTurn.ts` documents on the event stream.
   */
  #closeTransport(key: string | undefined): void {
    if (key === undefined || key === this.#openTurnKey) this.#openTurnKey = undefined
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
      // Whether the CHILD was seen to stop, which no verdict answers. Read straight off the
      // transport state rather than derived from the outcome: a deadline verdict leaves this
      // true, and the transcript re-check that follows it (`#reconsiderDeadline`) is what can
      // turn it false -- by proving the turn ended, which then emits a fresh `turn_end` with
      // this absent. See `TurnEndEvent.transportOpen`.
      ...(this.#openTurnKey === String(turn.key) ? { transportOpen: true } : {}),
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
/**
   * The transcript check that decides what a deadline verdict MEANS (#36).
   *
   * `timed_out` is minted by a clock, and a clock cannot tell two very different children apart:
   * one stuck mid-work, and one that finished normally and whose `Stop` hook never arrived. Both
   * produce exactly the same event -- silence -- and no predicate over the event stream
   * separates them. The child's own transcript does: a turn it finished carries
   * `stop_reason=end_turn`, and a turn it is still working on does not.
   *
   * That evidence was already parsed and already polled, and nothing consulted it at the one
   * moment it decides something. `#reconcileFromTranscript` ran on exit and on close, so a run
   * learned the truth about a lost `Stop` only once the session was over.
   *
   * So the deadline now asks. If the transcript proves the turn finished, the tracker supersedes
   * `timed_out` with `completed` and the ordinary `late_signal` revision goes out -- the same
   * path a late `Stop` hook takes, because it is the same fact arriving by a different road. If
   * it does not, nothing changes: the verdict stands and the turn stays transport-open, which is
   * what keeps a genuinely hung child from being sent to (#117).
   *
   * ## What this does NOT fix
   *
   * A turn that keeps working. This runs when a CLOCK fires, and the two clocks answer
   * different questions: substantive child output refreshes the silence deadline and nothing
   * else, so a continuously productive turn sails past it and meets the absolute cap, which is
   * refreshed by nothing (`outcomes/watchdog.ts`). At that moment the transcript says the turn
   * is `in_progress` -- correctly, because it is -- and `in_progress` is not evidence the turn
   * ended, so this changes nothing and a working turn is reported `timed_out`.
   *
   * That case is open, and it is a gap DERIVED from the mechanism rather than one anybody has
   * reported: the verified #36 incident is the static-transcript hang, where a child took a
   * tool result, produced nothing further and no `Stop`, and the run sat ~44 minutes. What #36
   * did recover is that hang -- the silence clock now reaches it at twelve minutes rather than
   * the absolute one at forty-five -- and a turn whose transcript is terminal because its
   * `Stop` was lost, which is superseded to `completed` here. Nothing below should be read as
   * covering a turn that is genuinely still working.
   *
   * ## What happens when the transcript cannot answer
   *
   * Deliberately, in every case: the deadline's verdict stands and the transport stays open.
   * (`timed_out`, or `unknown_abnormal_end` when input ownership is external and the clock
   * degraded its own claim -- see `DEADLINE_OUTCOMES`. Both are re-checked; neither is
   * strengthened by a read that failed.)
   *
   *   no transcript known    `#view` is unset -- no `SessionStart` has told us where it is
   *   unreadable             a read that throws; `#reconcileFromTranscript` swallows it
   *   still in progress      the turn has no terminal record, which is a real answer: hung
   *   ambiguous              fewer completed records than turns claiming them, so the
   *                          positional credit does not reach this turn
   *   too slow               the bound above expires before the read returns, and the
   *                          abandoned re-check is barred from acting on what it later finds
   *
   * The alternative -- treating "no evidence" as completion -- would reopen #117 on exactly the
   * runs where the evidence is hardest to get, which is not a coincidence: an unreadable
   * transcript and a wedged child have causes in common.
   */
  async #reconsiderDeadline(update: VerdictUpdate | undefined): Promise<void> {
    if (!DEADLINE_OUTCOMES.has(update?.verdict?.outcome as string)) return
    // Everything else happens inside: the reconcile emits its own revision through `#apply`,
    // and closes the transport for any turn the transcript proves ended -- which it must do
    // before applying, so the replacement verdict does not go out still claiming the child may
    // be running.
    await this.#boundedReconcile()
  }

  /**
   * In-flight deadline reconcile, so two clocks firing at once do not double-read the file --
   * and, past `DEADLINE_TRANSCRIPT_MS`, so a third can try again instead of waiting on a read
   * that has already been abandoned.
   */
  #reconciling = new BoundedSingleFlight(DEADLINE_TRANSCRIPT_MS)

  /** `#reconcileFromTranscript` under `DEADLINE_TRANSCRIPT_MS`, and never more than one at a time. */
  async #boundedReconcile(): Promise<void> {
    await this.#reconciling.run((token) => this.#reconcileFromTranscript(token))
  }

  async #reconcileFromTranscript(token?: Abandonment): Promise<void> {
    if (!this.#view) return
    let snap: SessionSnapshot
    try {
      // The bound goes IN, not just around: expiry has to reach the view, or this caller waits
      // out the view's ten-second lease instead of its own two seconds and the slot it exists to
      // free is not freed on time. It does not buy a read -- there is one operation in flight,
      // and this call attaches to it rather than racing it. See `TranscriptSessionView.snapshot`.
      snap = await this.#view.snapshot(token)
    } catch {
      // Unreadable, or a read this caller stopped waiting on before it answered
      // (`TranscriptReadAbandoned`). Both are the same thing here: no evidence arrived, so
      // leave the evidence we already have alone rather than guess.
      return
    }

    // The bound expired while that read was outstanding, so this run is observationally
    // abandoned. The view above is updated and stays updated -- that work is done and discarding
    // it would only make the next poll redo it -- but nothing past this line may be observed by
    // anyone: no transport is closed, no verdict is superseded, no `late_signal` goes out. The
    // deadline already concluded it had no answer, and an answer arriving afterwards would
    // contradict that conclusion at a moment chosen by the filesystem.
    //
    // Read here, and again inside the loop below, and each reading answers for the moment it is
    // taken rather than for the last time a timer got a turn. That matters most in the case
    // this guard exists for: the snapshot above parses synchronously, so the loop can be
    // blocked straight through the bound and this line can be the first thing to run
    // afterwards -- before any overdue timer. See `Abandonment`.
    //
    // `token` is undefined on the exit and close paths, which are not bounded and must run to
    // completion.
    if (token?.abandoned) return

    const byKey = new Map(snap.turns.map((t) => [String(t.key), t]))
    for (const turn of this.#allTurns()) {
      // Asked once per turn, not once before the loop. Every iteration is separately
      // observable -- it can close a transport and emit a replacement verdict -- and the loop
      // is synchronous, so on a session with many turns the bound can expire partway down it.
      // A single check at the top would then let every remaining turn act on an answer the
      // deadline had already written off, which is the thing the bound promises will not
      // happen. Stopping here leaves the turns already updated updated, and that is honest:
      // each of those was decided while this run was still wanted.
      if (token?.abandoned) return
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
      } else if (record.state === 'unknown_abnormal_end') {
        // An errored `task_complete` (#35). Terminal and `proven`, exactly like the two above:
        // the turn's machinery finished and the child said so, and what it finished with was a
        // failure. Rebuilt through `taskCompleteError` rather than trusted as a parsed state,
        // because everything the tracker holds has to be expressible as EVIDENCE -- a verdict
        // the adapter posted around the classifier is how `events()` and `snapshot()` came to
        // disagree in the first place.
        //
        // `taskComplete` is set alongside it. Both are true: the record exists and it carried
        // an error, and the classifier needs the first to know the child announced an ending
        // at all rather than merely dying quietly.
        state.taskComplete = true
        state.taskCompleteError =
          record.provenance
            ?.find((p) => p.detail.startsWith(TASK_COMPLETE_ERROR))
            ?.detail.slice(TASK_COMPLETE_ERROR.length) ?? 'no message'
      }
      // The child's own file saying this turn ended is an OBSERVATION of the child, so it may
      // close the transport -- and it must do so BEFORE the update is applied, or the
      // replacement `turn_end` goes out still claiming the child may be running and every
      // consumer of `transportOpen` keeps refusing to send to a turn that is demonstrably over.
      //
      // The errored case is included deliberately. A turn that ended BADLY is still a turn that
      // ended, and the child is executing nothing: leaving the transport open there would make
      // #35 unrecoverable in a new way -- the seat could not be sent to at all, where before it
      // was merely sent an empty message.
      if (
        record.state === 'completed' ||
        record.state === 'cancelled' ||
        record.state === 'unknown_abnormal_end'
      ) {
        this.#closeTransport(String(turn.key))
      }
      if (record.assistantText) turn.assistantText = record.assistantText
      this.#apply(turn, turn.tracker.resetTranscript(state), true)
    }
  }

  async #onExit(reason: string): Promise<void> {
    this.#pendingPrompt?.reject(new Error(`codex exited (${reason}) before accepting the prompt`))
    this.#pendingPrompt = undefined
    // A dead child is executing nothing. The strongest form of an observed stop.
    this.#closeTransport(undefined)
    for (const t of this.#liveTurns()) t.childClosure ??= `the child exited (${reason})`

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
    this.#refuseOverlappingSend()

    // ONE claim, held across both attempts. See `PROMPT_SEND_ATTEMPTS`: the window between a
    // corrupted prompt and its re-send is exactly when a second caller could type into the
    // gap, so the retry does not release the slot and take it again -- it never lets go.
    let claim: PendingPrompt | undefined
    let first: PromptMismatch | undefined
    try {
      for (let attempt = 1; ; attempt++) {
        const keyed = new Promise<TurnKey>((resolve, reject) => {
          claim = { resolve, reject, prompt: message }
          this.#pendingPrompt = claim
        })
        try {
          return await this.#submitOnce(message, keyed)
        } catch (e) {
          // Only a corrupted prompt is retried. A hook timeout or a dead child are different
          // failures with their own repairs, and typing the message again on top of one of
          // those is how the same prompt gets delivered twice.
          if (!isCorruptedPrompt(e)) throw e
          if (attempt >= PROMPT_SEND_ATTEMPTS) throw new Error(promptRetryExhausted(first ?? e.mismatch, e.mismatch))
          first = e.mismatch
          // Throws if the malformed turn cannot be shown to be over, and that throw is the
          // refusal: nothing below it re-types anything.
          await this.#recoverForRetry(e)
        }
      }
    } finally {
      // Released here and nowhere else on the send path. A send that failed still claimed the
      // slot, and leaving it claimed would make the guard above refuse every later send on this
      // session -- turning one timed-out prompt into a seat that can never be spoken to again.
      // A late hook still opens its turn from its own payload; nothing but this method awaited
      // this promise.
      //
      // By identity, because a resolved send has already had its slot cleared by the hook, and
      // clearing unconditionally here would throw away a claim the NEXT send had made in the
      // meantime -- letting two sends run at once through the guard that exists to stop that.
      if (this.#pendingPrompt === claim) this.#pendingPrompt = undefined
    }
  }

  /** One attempt: type the message, then wait for the hook that says what the child took. */
  async #submitOnce(message: string, keyed: Promise<TurnKey>): Promise<TurnKey> {
    // Cleared on the way out: the loser of the race is a live 60s timer, and leaving it
    // pending keeps the event loop alive long after the send resolved.
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(SEND_HOOK_TIMEOUT)), 60_000)
    })
    try {
      await this.#input.submit(message)
      return await Promise.race([keyed, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Cancel a malformed turn and wait for the CHILD to say it ended.
   *
   * Returns only when a re-send is SAFE. Every other path throws, and the throw is the refusal
   * -- `send()` does not type anything after catching one. That asymmetry is deliberate: the
   * dangerous outcome here is not "gave up too early", it is "typed the message into a turn
   * that was still running", which splices two messages together (#117) and produces a second
   * corrupted prompt out of a mechanism meant to repair the first.
   *
   * ## Why our own cancellation is not evidence
   *
   * The first version of this gate accepted `cancel()` returning, plus a shut transport and a
   * settled verdict. Every one of those is something THIS process did. `cancel()` types ESC,
   * calls `#closeTransport(undefined)` itself, and mints a `cancelled` verdict from our own
   * record of the keystroke at `assumed` confidence -- which is exactly what `assumed` means
   * and why the adapter grades it that way. Claude records a cancellation nowhere at all, and
   * Codex's `turn_aborted` may never arrive within the evidence budget. So a child that took
   * the fragment, ignored the ESC and carried on running it satisfied the whole gate, and the
   * re-send went into a live turn: the precise failure the gate exists to prevent, reached
   * through the mechanism meant to prevent it.
   *
   * What is required now is CHILD-DERIVED closure for the malformed turn specifically -- its
   * own `Stop`, a `SessionEnd`, the process exiting, or, on Codex, the transcript recording how
   * it ended. See `TurnState.childClosure`. The ESC is still typed, because cancelling is the
   * right thing to do with a turn running text nobody sent and because it clears the composer
   * before anything is re-typed; it just no longer counts as the child having answered.
   *
   * The cost is stated rather than hidden: on Claude, which emits nothing when interrupted, a
   * corrupted prompt whose turn does not end on its own will be cancelled and REFUSED rather
   * than retried. That is the intended trade. An unrepaired send is recoverable by an operator;
   * two messages spliced into one turn are not.
   */
  /**
   * Codex adds its cancellation evidence budget to the bound, because here `cancel()` is not
   * finished when the ESC has been typed: it polls the transcript for the child's own record of
   * the abort, which is the closure evidence this gate is waiting for. Bounding the retry more
   * tightly than the cancellation it waits on would refuse every recovery whose evidence was
   * merely slow.
   */
  async #recoverForRetry(bad: CorruptedPromptError): Promise<void> {
    const malformed = this.#turns.get(bad.turnKey)
    // Said out loud, because a silent retry is a run where a corrupted prompt happened and
    // nothing anywhere records it. Non-fatal: this is a repair in progress, not a failure.
    this.#emit({
      type: 'error',
      message:
        `#174: the child accepted a corrupted prompt (${bad.mismatch.shape}, ${bad.mismatch.lostBytes} of ` +
        `${bad.mismatch.sentBytes} bytes lost). Cancelling turn ${bad.turnKey} and sending the message once more.`,
      fatal: false,
      seq: this.#next(),
      at: Date.now(),
      provisional: false,
    })

    const budget = this.#cancelEvidenceBudgetMs + (this.#opts.promptRecoveryMs ?? PROMPT_RECOVERY_MS)
    const refuse = (why: string): Error => new Error(promptRetryNotAttempted(bad.mismatch, why))
    const until = Date.now() + budget

    let timer: NodeJS.Timeout | undefined
    const outcome = await Promise.race([
      this.cancel().then(
        () => 'cancelled' as const,
        (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
      ),
      new Promise<'timeout'>((r) => {
        timer = setTimeout(() => r('timeout'), budget)
      }),
    ]).finally(() => clearTimeout(timer))

    // A cancellation that has not come back is not a completed one, however likely it is to
    // finish a moment later. It keeps running -- nothing here can stop it -- and the seat is
    // left cancelled and idle, which is the state an operator can send into by hand.
    if (outcome === 'timeout') {
      throw refuse(`the cancellation of turn ${bad.turnKey} had not come back after ${budget} ms`)
    }
    if (outcome !== 'cancelled') {
      throw refuse(`the cancellation of turn ${bad.turnKey} failed: ${outcome.message}`)
    }
    // Now the only question that matters: has the CHILD said this turn ended? The ESC above is
    // ours and proves nothing about what the child did with it.
    if (!malformed) {
      throw refuse(`turn ${bad.turnKey} is not on record, so nothing can be said about whether it ended`)
    }
    while (!malformed.childClosure && Date.now() < until) {
      await new Promise((r) => setTimeout(r, RECOVERY_POLL_MS))
    }
    if (!malformed.childClosure) {
      throw refuse(
        `the child never confirmed that turn ${bad.turnKey} ended: ESC was typed and ${budget} ms passed ` +
          `with no Stop, no SessionEnd, no exit, and nothing in the transcript recording the abort. The ` +
          `verdict rests on conclave's own note of having sent ESC, which is not evidence the child ` +
          `stopped -- and it may still be running the fragment`,
      )
    }
    const open = this.#openTurn()
    if (open) throw refuse(`the transport is open again, on turn ${String(open.key)}`)
    if (this.#state !== 'running' || !this.acceptsInput) {
      throw refuse(`the session is ${this.#state} and no longer accepting input`)
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
    // A completed cancellation: ESC is typed and the input queue has drained, so the child has
    // been told to stop by the only means available. This is the escape from a turn whose `Stop`
    // never arrives -- the transport reopens here and nowhere else, so a seat the watchdog gave
    // up on can be recovered rather than being unsendable for the rest of the run.
    this.#closeTransport(undefined)
    // Cancellation has begun, so every read already in flight is a read of the transcript as it
    // was BEFORE the ESC -- it cannot contain the `turn_aborted` the wait below is for, and
    // nothing is lost by giving up on it. What is lost by keeping it is the wait itself:
    // `#awaitTranscriptEvidence` polls on a budget but bounds no single attempt, so a read that
    // is not answering spends the budget parked rather than polling -- and, if it is admitted
    // after the last budget check, runs past the budget entirely. A cancellation that cannot
    // come back is the one thing a seat the watchdog gave up on has left. The read itself is
    // not stopped -- nothing here can stop it -- so it lands and commits in its own time, and
    // what it found is banked for the next reader rather than thrown away.
    this.#view?.abandonReads()
    if (!turn) return undefined
    this.#apply(turn, turn.tracker.observeOrchestrator({ sentCancel: true }), true)
    // The child writes turn_aborted asynchronously, so poll rather than reconcile once.
    // Until it lands the verdict rests on our own ESC record (`assumed`); once it does,
    // the transcript upgrades it to `proven`. A single fixed sleep raced the write.
    await this.#awaitTranscriptEvidence(turn, this.#cancelEvidenceBudgetMs)
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
      if (turnToWatch) await this.#awaitTranscriptEvidence(turnToWatch, this.#cancelEvidenceBudgetMs)
    }
  }

  /**
   * Reconcile repeatedly until this turn's verdict stops resting on our own bookkeeping,
   * or the budget runs out. Codex records `turn_aborted` after the fact, so the evidence
   * that upgrades a verdict from `assumed` to `proven` simply is not there yet when the
   * keystroke returns.
   *
   * ## It stops when the view says it cannot read
   *
   * A wedged transcript read is the case this wait was built for, and it is also the case where
   * waiting accomplishes nothing. `TranscriptSessionView` will not start a second read while the
   * first is unresolved, so once it reports `readsStalled` every remaining iteration is refused
   * on arrival and no `turn_aborted` can reach this loop however long it runs. It returns
   * instead, on the first poll interval, and the verdict stays where the ESC left it -- which is
   * the same answer the budget expiring would have given, fifteen seconds sooner.
   *
   * What it does NOT do is get the verdict upgraded later on its own. Nothing else calls a
   * reconcile between here and `close()`: the tailer emits events, it does not re-adjudicate a
   * turn that has already settled. So a cancellation that met a wedge stays `assumed` --
   * "we typed ESC" -- until the close path reads the file and finds the `turn_aborted` that was
   * there all along, and the record survives to be found because the read that met the wedge
   * consumes it exactly once, whenever it lands. `wedgedTranscriptRead.test.ts` pins both ends of that: the `assumed` verdict while
   * the wedge holds, and the `proven` one after close.
   *
   * ## `budgetMs` is not how long this takes
   *
   * It is checked once per iteration, BEFORE the sleep, and nothing inside the iteration is
   * bounded by it. An iteration admitted with a millisecond of budget left still sleeps its
   * whole `CANCEL_EVIDENCE_POLL_MS`, and then runs a reconcile with no bound at this call
   * site -- `#reconcileFromTranscript()`, not `#boundedReconcile()` -- whose read may take a
   * full `READ_LEASE_MS` to answer. So the wall-clock worst case is
   *
   *   budgetMs + CANCEL_EVIDENCE_POLL_MS + READ_LEASE_MS
   *
   * which for a cancellation is about 25.75 seconds, not the 15 the budget reads like. The
   * unbounded call is deliberate and stays: a cancellation is exactly the moment the strongest
   * available evidence is wanted, and `DEADLINE_TRANSCRIPT_MS` is a bound for a re-check that
   * nothing is waiting on. What was wrong was the documented number, not the call.
   *
   * ## Two leases is the ceiling, and it takes two SLOW reads rather than two stuck ones
   *
   * A read that costs a whole lease leaves the next check at about 10.75s -- still inside the
   * budget -- so another iteration runs and can cost another. A third cannot: 21.5s is past the
   * budget. That shape needs reads that are slow and still answer: a read that costs a lease and
   * answers NOTHING leaves the view stalled, and the exit above ends the loop before a second
   * one is ever attempted.
   *
   * `codexCancelLatency.test.ts` pins the arithmetic; `wedgedTranscriptRead.test.ts` pins the
   * stalled exit against a real wedged view.
   */
  /** The shipped budget unless this session was given another. See `CodexAdapterOptions`. */
  get #cancelEvidenceBudgetMs(): number {
    return this.#opts.cancelEvidenceBudgetMs ?? CANCEL_EVIDENCE_BUDGET_MS
  }

  /** The shipped poll interval unless this session was given another. */
  get #cancelEvidencePollMs(): number {
    return this.#opts.cancelEvidencePollMs ?? CANCEL_EVIDENCE_POLL_MS
  }

  async #awaitTranscriptEvidence(turn: TurnState, budgetMs: number): Promise<void> {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.#cancelEvidencePollMs))
      await this.#reconcileFromTranscript()
      const v = turn.tracker.verdict
      if (v && v.confidence !== 'assumed') {
        // The transcript, not our keystroke: the child wrote down how this turn finished, which
        // is the only Codex evidence a #174 retry can act on. `assumed` is the ESC record and
        // says nothing about whether the child stopped.
        turn.childClosure ??= `the transcript records how it ended (${v.outcome}, ${v.confidence})`
        return
      }
      // The view has an outstanding read it has given up on and will not duplicate, so every
      // further iteration is refused on arrival and the evidence this is waiting for cannot
      // reach it. Spending the rest of the budget here is the parked wait in a different
      // costume: the same `assumed` verdict, fifteen seconds later.
      //
      // What it costs is stated where it is paid, not here: see the header. The record is not
      // consumed, so it is still there for whatever reconciles next.
      if (this.#view?.readsStalled) return
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
        // No view means no read has EVER happened here, which the guards must not mistake for a
        // read that found nothing. `compactionGeneration: 0` below is synthesized, not observed.
        containedFallback: true,
      }
    }
    // Contained, not bounded. This is the session contract's snapshot: the report, the seat
    // record, the relay's compaction checks and rotation's record-at-quiesce all arrive here,
    // none of them carrying a bound and none of them able to do anything useful with "the
    // transcript did not answer". It falls back to the last projection built from records that
    // were actually read, stamped with when that was. The deadline re-check above keeps the
    // rejection, because there it is the signal.
    const snap = await this.#view.snapshotOrLastBuilt()

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

    // Spread first, so everything the view said about this projection survives the turn merge
    // -- `builtAt` and `containedFallback` above all. The merge changes what the TURNS are; it
    // does not make an unverified snapshot into a read one, and rotation reads that flag to
    // decide whether the compaction generation in here is evidence.
    return { ...snap, turns, role: this.#opts.role }
  }

  async fork(): Promise<AgentSession> {
    throw new Error('fork() not implemented for the PTY adapter yet')
  }

  async close(mode: 'graceful' | 'abandoned' = 'graceful'): Promise<void> {
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
      // We are done observing, so the deadline stops applying. Left armed it could fire
      // during the awaits below and race the verdict each branch is deliberately choosing.
      this.#watchdog.disarmAll()

      // Stop reading before deciding what to read. The tailer is on an interval and would
      // otherwise be free to start the view's next read between here and the reconcile below.
      this.#stopTailing()
      // And stop waiting on whatever read is already in flight. `close()` reconciles with no
      // bound of its own, so a read that never returns used to park a shutdown forever rather
      // than delay it, and even a lease is longer than a shutdown should wait.
      //
      // It does not stop the read -- nothing can -- so the reconcile below is refused for as
      // long as that operation lasts, and skipped if it never lands. What it does not lose is
      // evidence: the read commits what it found whenever it lands. See
      // `TranscriptSessionView.abandonReads`.
      this.#view?.abandonReads()

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

      await this.#receiver.stop()
      this.#state = 'terminated'
    } finally {
      this.#events.close()
    }
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
