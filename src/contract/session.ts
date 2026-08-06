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
  assistantText?: string | undefined
  toolCalls: { tool: string; failed: boolean }[]
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

export interface AgentSession {
  readonly agent: string
  readonly sessionId: string
  readonly guarantees: Guarantees

  send(message: string, provenance: SendProvenance): Promise<TurnKey>

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
   * `quiesced` and `rotating` (§7a) are not here yet. They are lifecycle states rather
   * than teardown modes -- a quiesced session is alive, holds its context, and can be
   * unquiesced if a replacement fails to prove itself -- so they need a state machine
   * rather than another argument to this.
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
  turnKeySource: 'prompt_id' | 'turn_id'
  outcomes: Record<Outcome, import('./outcome.ts').EvidenceLevel>
}
