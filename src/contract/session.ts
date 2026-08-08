/**
 * The adapter seam.
 *
 * Two channels, on purpose:
 *
 *   events()    live and provisional. Low latency, may be wrong, may be revised.
 *   snapshot()  canonical and rebuildable. Derived from the transcript as it now is.
 *
 * They are separate because the transcript is not append-only. Compaction rewrites
 * history, so any derived state built by tailing byte offsets will eventually
 * contradict its own source. An event model that can only append facts cannot express
 * "that turn you were told about has been rewritten". Rather than pretend otherwise,
 * events() is allowed to emit revisions and snapshot() is always authoritative.
 *
 * Consumers use events() for responsiveness and reconcile against snapshot() after
 * compaction, restart, or known delivery loss.
 */

import type { Confidence, Outcome, Provenance, TurnLiveness, Verdict } from './outcome.ts'

/** Opaque. `prompt_id` on Claude Code, `turn_id` on Codex. Never parse it. */
export type TurnKey = string & { readonly __brand: unique symbol }

export function turnKey(raw: string): TurnKey {
  return raw as TurnKey
}

/**
 * Open on purpose. Project configuration assigns agents to roles, so a config naming a
 * role the code has not heard of must be a validation error with a useful message, not
 * a compile error in someone else's checkout. Definitions live in registry/roles.ts.
 */
export type Role = string

/**
 * Who is allowed to put bytes into the child.
 *
 * `mediated` is the default product mode and the only one under which the adapter can
 * make authoritative lifecycle claims without interpreting the screen. On Claude Code a
 * cancelled turn produces no signal anywhere -- not a hook, not a transcript record --
 * so cancellation is knowable only because we are the ones who caused it.
 *
 * `external` is the escape hatch. Entering it must visibly degrade guarantees rather
 * than silently weaken them: see `degradedGuarantees`.
 */
export type InputOwnership = 'mediated' | 'external'

export interface Guarantees {
  inputOwnership: InputOwnership
  /** False once anyone else can type into the child. */
  cancellationAttributable: boolean
  /** What an unmatched turn may resolve to under this ownership mode. */
  unmatchedTurnsResolveAs: TurnLiveness[]
}

export function guaranteesFor(ownership: InputOwnership): Guarantees {
  return ownership === 'mediated'
    ? {
        inputOwnership: 'mediated',
        cancellationAttributable: true,
        unmatchedTurnsResolveAs: ['in_progress', 'timed_out'],
      }
    : {
        inputOwnership: 'external',
        cancellationAttributable: false,
        unmatchedTurnsResolveAs: ['in_progress', 'unknown_abnormal_end'],
      }
}

// --- events ------------------------------------------------------------------------

export interface EventBase {
  turnKey?: TurnKey | undefined
  /** Adapter-local monotonic sequence. Not comparable across adapters. */
  seq: number
  at: number
  /**
   * Provisional events may be revised or retracted later. Anything derived from a
   * provisional event must be re-derivable.
   */
  provisional: boolean
}

export interface TurnStartEvent extends EventBase {
  type: 'turn_start'
  prompt: string
}

export interface MessageEvent extends EventBase {
  type: 'message'
  role: 'assistant' | 'user'
  text: string
}

export interface ToolUseEvent extends EventBase {
  type: 'tool_use'
  tool: string
  input: unknown
  /** Set once the result is known; a tool failing is not a turn failing. */
  failed?: boolean | undefined
}

export interface PermissionRequestedEvent extends EventBase {
  type: 'permission_requested'
  tool: string
  input: unknown
}

/**
 * The terminal statement. Never a bare `turn_end` -- it always carries what it claims
 * and how strongly, because the adapters genuinely differ in what they can know.
 */
export interface TurnEndEvent extends EventBase {
  type: 'turn_end'
  verdict: Verdict
  /**
   * True when nothing from the child announced this and we concluded it ourselves --
   * from process state, a watchdog, or our own input bookkeeping.
   */
  synthesized: boolean
}

/**
 * Emitted when earlier events are no longer true: compaction rewrote history, or a
 * late signal contradicts an inference. `replaces` names the events being withdrawn.
 *
 * The common case is a turn we called `timed_out` that a late `Stop` proves was
 * `completed` all along.
 */
export interface RevisionEvent extends EventBase {
  type: 'revision'
  reason: 'compaction' | 'late_signal' | 'resync'
  replaces: number[]
  supersededBy?: AgentEvent | undefined
  provenance: Provenance[]
}

export interface AdapterErrorEvent extends EventBase {
  type: 'error'
  message: string
  fatal: boolean
}

export type AgentEvent =
  | TurnStartEvent
  | MessageEvent
  | ToolUseEvent
  | PermissionRequestedEvent
  | TurnEndEvent
  | RevisionEvent
  | AdapterErrorEvent

// --- snapshot ----------------------------------------------------------------------

export interface TurnRecord {
  key: TurnKey
  prompt: string
  state: TurnLiveness
  confidence?: Confidence | undefined
  provenance?: Provenance[] | undefined
  /**
   * Everything the model wrote this turn, in order, blocks separated by a blank line.
   *
   * This is the NARRATION — running commentary between tool calls, "now let me check X",
   * as well as the closing message. It is what a human following along would see, and it
   * was previously concatenated with no separator at all, producing "…exists.Now let me…".
   */
  assistantText?: string | undefined
  /**
   * The closing message alone: the turn's actual report.
   *
   * Separate from `assistantText` because the two have different audiences. The brief
   * originally routed full narration to the other participant; a live session showed why
   * that is wrong. An advisor receiving "I'll start by finding the relevant code" will
   * respond to a stated intention rather than to a result, and steering on intentions is
   * how an advisor ends up re-asking for work already done.
   *
   * So: the human sees narration, live. The other participant sees the report.
   *
   * The two adapters silently disagreed about this. Codex set `assistantText` from
   * `last_agent_message` — the closing message only — while Claude concatenated every
   * block. Same field, two meanings, and no test could tell because each adapter was only
   * ever compared against itself.
   */
  report?: string | undefined
  /**
   * `args` is the tool's input, serialized. Retained because it is the only per-participant
   * evidence of which files a session touched: no adapter emits `tool_use`, and
   * `PermissionRequest` does not fire for in-workspace writes. See `relay/authority.ts`.
   *
   * Deliberately a raw string rather than parsed fields. The two agents share no structured
   * path field -- Claude has `file_path` on 19% of calls, Codex has `apply_patch` headers on
   * 0.2% -- so the only representation both express is the text itself.
   */
  toolCalls: { tool: string; failed: boolean; args?: string | undefined }[]
  startedAt?: number | undefined
  endedAt?: number | undefined
}

export interface SessionSnapshot {
  sessionId: string
  agent: string
  cwd: string
  role?: Role | undefined
  turns: TurnRecord[]
  guarantees: Guarantees
  /** Bumped whenever the underlying transcript was rewritten under us. */
  compactionGeneration: number
  /** When this snapshot was rebuilt from the transcript. */
  builtAt: number
}

// --- the interface -----------------------------------------------------------------

export interface StartOptions {
  cwd: string
  role: Role
  systemContext?: string | undefined
  inputOwnership?: InputOwnership | undefined
}

export type Provenanced<T> = { value: T; provenance: Provenance[] }

/**
 * Why a message is being sent. Relayed peer opinion and an authoritative human
 * constraint must not look alike to the child (brief section 6), and the adapter needs
 * to know which it is to route it correctly.
 */
export interface SendProvenance {
  kind: 'human_constraint' | 'peer_relay' | 'orchestrator'
  /** Whether to name the peer as the source. Brief section 5: attribution is a variable. */
  attributed?: boolean | undefined
  attributedTo?: string | undefined
}

export type CloseMode = 'graceful' | 'abandoned'

/**
 * Lifecycle, not teardown style. `close()` cannot express this because rotation needs a
 * state that is neither running nor gone.
 *
 *   running     accepting work
 *   quiesced    alive, holds its context, cannot receive work, still inspectable
 *   rotating    a replacement is proving it can continue
 *   terminated  gone
 *
 * `quiesced` is the one that makes rotation a transaction rather than a hopeful sequence.
 * A quiesced session still knows everything it knew, so if the replacement cannot
 * reproduce the recorded state the original can be un-quiesced and the work is not
 * stranded between two sessions. Without it, a failed transfer fails silently: the
 * replacement carries on from a state it never actually reproduced.
 */
export type SessionState = 'running' | 'quiesced' | 'rotating' | 'terminated'

export interface AgentSession {
  readonly agent: string
  /**
   * The child process, when this adapter has one it can name.
   *
   * Optional because not every transport has a single process to point at, and because a
   * consumer must not come to depend on it: it exists so a watchdog timeout can say whether
   * the child is still computing, which is the fact that decides what an operator does about
   * a quiet turn (#43, #45). Absent means "cannot say", never "not running".
   */
  readonly childPid?: number | undefined
  readonly sessionId: string
  readonly guarantees: Guarantees

  readonly state: SessionState

  send(message: string, provenance: SendProvenance): Promise<TurnKey>

  /**
   * Stop accepting work without ending the session. Cheap: an idle session costs nothing
   * and keeps its context. Reversible by `unquiesce()`.
   */
  quiesce(): Promise<void>

  /** Return a quiesced session to service. The rollback path for a failed rotation. */
  unquiesce(): Promise<void>

  /**
   * Enter `rotating`: a replacement is now proving it can reproduce this session's state.
   *
   * Distinct from `quiesced` because the two differ in what a reader should conclude. A
   * quiesced session is merely paused; a rotating one is mid-transaction and has exactly
   * two ways out -- `close()` once the replacement has demonstrated transfer, or
   * `unquiesce()` when it could not. Requires `quiesced`, so a rotation cannot begin
   * against a session that is still accepting work.
   */
  beginRotation(): Promise<void>

  /** Best-effort cancellation. Resolves to the key it attempted to cancel. */
  cancel(): Promise<TurnKey | undefined>

  /** Respond to a pending permission request. Only meaningful under mediated input. */
  decidePermission(decision: 'allow' | 'deny'): Promise<void>

  /** Live, provisional, revisable. */
  events(): AsyncIterable<AgentEvent>

  /** Canonical, rebuilt from the transcript as it currently exists. */
  snapshot(): Promise<SessionSnapshot>

  fork(): Promise<AgentSession>

  /**
   * How a session ends. These are distinct INPUTS to classification, not styles of
   * teardown -- see the brief, §7a.
   *
   *   graceful   we are finished with it; reconcile, then SIGTERM and wait
   *   abandoned  we are walking away from the transport; asserts nothing about the child,
   *              which may still be running
   *
   * Always SIGTERM and wait before escalating: SIGKILL leaves no transcript at all, while
   * SIGTERM leaves a truncated but real one, and discarding the transcript discards the
   * only durable record of the session.
   *
   * `quiesced` and `rotating` are deliberately NOT modes here. They are lifecycle states
   * rather than teardown -- a quiesced session is alive, holds its context, and can be
   * unquiesced if a replacement fails to prove itself -- so they live in `state` and its
   * transitions instead of becoming another argument to this.
   */
  close(mode?: CloseMode): Promise<void>
}

/**
 * What an adapter claims it can do. The conformance suite checks claims against
 * fixtures, so an adapter cannot quietly assert support it has never demonstrated.
 */
export interface AdapterCapabilities {
  agent: string
  readinessSignal: 'session_start_hook' | 'first_turn' | 'unknown'
  /** `run_invocation`: the agent has no per-turn id, so the adapter mints one. */
  turnKeySource: 'prompt_id' | 'turn_id' | 'run_invocation'
  outcomes: Record<Outcome, import('./outcome.ts').EvidenceLevel>
}
