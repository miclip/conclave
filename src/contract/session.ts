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
  /**
   * This event is HISTORY being re-emitted, not something the child has just done.
   *
   * Set only by `TranscriptSessionView` on the prefix-rewrite path: everything already told to
   * consumers is withdrawn by a `revision`, and the surviving history is then emitted again so
   * a consumer that follows `events()` ends up agreeing with `snapshot()`. The records behind
   * those events can be hours old. The only thing that happened NOW is that the file changed
   * underneath us.
   *
   * Distinct from `provisional`, which says an event may later be wrong. A replay is not wrong;
   * it is old, and old is what the liveness readers get wrong. Two of them treat child output
   * as a sign of life -- the watchdog's silence clock and #82's "this turn never spoke"
   * diagnosis -- and a replay is the one case where that reading is false: a rewrite the turn
   * had no part in would push out the deadline of a turn that has been stalled for ten minutes.
   * `isChildOutput` is where that is decided, so neither reader has to remember.
   */
  replay?: boolean | undefined
}

export interface TurnStartEvent extends EventBase {
  type: 'turn_start'
  prompt: string
}

/**
 * The child wrote a block of reasoning (#198).
 *
 * CARRIES NOTHING. Its whole purpose is to be counted as child output, and a payload would
 * invite a consumer to render reasoning as though the seat had said it.
 *
 * It exists because extended thinking is the one state in which a Claude seat is genuinely
 * working and genuinely silent by `isChildOutput`'s definition -- no assistant text, no tool
 * call, no hook -- and it lasts longest on exactly the hard problems an advisor delegates. The
 * silence clock fired on such a turn in session `20260901-112850-98711` while the pause
 * evidence it printed said, in as many words, that output was still arriving.
 */
export interface ThinkingEvent extends EventBase {
  type: 'thinking'
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
 * Another model has started work on behalf of this one.
 *
 * The console could previously say only what the SPAWNING TOOL CALL was called --
 * `relay/subagents.ts` turns `wait_agent` into "waiting on a subagent" from a name list,
 * because no adapter had anything better. A name list cannot say how many are running, cannot
 * say when they started, and is a guess: it fires on a tool that merely looks like delegation
 * and stays silent on one that does not.
 *
 * This pair is the observed alternative, for the adapters that can observe it. The child says
 * a subagent started, says which one, and later says it stopped, so the count is COUNTED
 * rather than inferred. Where no start ever arrives the old reading is still there and still
 * correct; see `describeSubagentWork`.
 *
 * ## Why an id and not just a count
 *
 * Hook delivery is at-most-once, never retried, and replayed from a local journal on recovery
 * -- so a duplicate is a matter of time (`hooks/journal.ts`). A counter that increments on
 * arrival cannot survive one: a redelivered start counts a subagent that does not exist, and
 * nothing ever takes it back, so the console reads "3 subagents" for the rest of the turn. The
 * id is the child's own (`agent_id` on Claude Code 2.1.252, required on both events), and it
 * makes both directions idempotent -- a repeat is recognised as the same subagent rather than
 * as another one.
 */
export interface SubagentStartEvent extends EventBase {
  type: 'subagent_start'
  /** The child's own identifier for it. Opaque: only ever compared for equality. */
  agentId: string
  /** What the child calls this kind of subagent, when it says. `agent_type` on Claude Code. */
  agentType?: string | undefined
  /** Started and not yet seen to stop, on this turn, AFTER this event. */
  outstanding: number
}

export interface SubagentStopEvent extends EventBase {
  type: 'subagent_stop'
  /** Absent only if the child reported a stop without naming what stopped. */
  agentId?: string | undefined
  agentType?: string | undefined
  /**
   * False when no `subagent_start` was ever seen for this id.
   *
   * Not an anomaly. The Claude adapter registers both halves (see `HOOK_EVENTS`), but a CLI
   * that does not dispatch `SubagentStart` accepts the key in silence and never fires it, so
   * against one of those every stop is unpaired and `outstanding` stays at zero. A consumer
   * must therefore never treat a stop as licence to decrement a count it did not count up --
   * which is why the count is carried on the event rather than derived by each reader.
   */
  paired: boolean
  /** Started and not yet seen to stop, on this turn, AFTER this event. */
  outstanding: number
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
  /**
   * The emitter cannot rule out that the child is STILL EXECUTING this turn.
   *
   * A verdict and a transport are different claims, and this is the only place the difference
   * is expressed to anyone downstream. A verdict is what the emitter concluded about a turn;
   * this says whether the child was seen to stop. They come apart in exactly one place and it
   * is the place that matters: a `timed_out` minted by a clock running out with nothing
   * arriving. Nothing observed the child stop -- that is what a deadline IS -- and the child
   * most likely to be still working is the one that has gone quiet mid-work.
   *
   * Consumers about to put bytes into that child need the second claim, not the first. Neither
   * CLI accepts input mid-turn, so a send there is not queued: it is spliced into a running
   * turn, and #117 is four runs lost to exactly that. `outcomes/activeTurn.ts` is the predicate
   * both of them ask, and this field is what it reads.
   *
   * ## Adapters must set it, and absent means CLOSED
   *
   * Stated plainly because the default is the unsafe direction and that is a deliberate,
   * uncomfortable choice. Absent has to mean "the turn is over" -- a transport that mints no
   * such signal would otherwise leave every turn open forever, which hangs a run rather than
   * risking one. So an adapter that can leave a child running past a verdict MUST set this, and
   * `ClaudePtyHookAdapter#apply` / `CodexPtyHookAdapter#apply` do, from the transport state they
   * already keep (`#openTurnKey`).
   *
   * The one-shot adapters (`kimi.ts`, `opencode.ts`) do not, and that is correct rather than an
   * omission: a turn there IS a process invocation, so a turn that has ended is a process that
   * has exited and there is nothing left executing to protect.
   */
  transportOpen?: boolean | undefined
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
  /**
   * `compaction` means the transcript DECLARED one -- a marker the parser recognises. It is
   * evidence that context was discarded, and rotation acts on it.
   *
   * `rewrite` means the bytes changed under us with no such marker. Everything derived from
   * the old bytes is still void, so it is still a revision; but a digest changing is not
   * evidence that the participant lost anything, and it must not be read as one. See #122:
   * nine "compactions" in an afternoon were nine of these, and none of them happened.
   */
  reason: 'compaction' | 'rewrite' | 'late_signal' | 'resync'
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
  | ThinkingEvent
  | ToolUseEvent
  | PermissionRequestedEvent
  | SubagentStartEvent
  | SubagentStopEvent
  | TurnEndEvent
  | RevisionEvent
  | AdapterErrorEvent

/**
 * Whether this event is evidence that the CHILD produced something.
 *
 * Replayed events are never child output, whatever they carry. See `EventBase.replay`: the
 * child did not just produce a record that has been sitting in the transcript for ten minutes,
 * and this predicate is asked precisely by the readers that would mistake the two.
 *
 * Two callers depend on the answer and both act on it silently: `#82`'s launch diagnosis
 * ("this turn never spoke, so suspect the model it was launched with") and the watchdog, where
 * each true pushes the SILENCE deadline out. Getting it wrong in either direction goes
 * unnoticed -- a false positive holds the silence clock open on a turn that has stopped and
 * clears the model of blame it deserved; a false negative kills a turn that was working.
 *
 * A PREDICATE rather than a set of type tags, which is what this was. `message` carries a role
 * and the contract permits `user`: the adapters emit assistant text today and nothing more, but
 * that is a fact about `transcript/reconcile.ts` this month rather than anything the type
 * system holds them to, and the tag alone cannot see the difference. A user message is the
 * ORCHESTRATOR's own bytes coming back -- the prompt this turn was started with -- so counting
 * it would let a turn prove it was alive by being asked a question.
 *
 * The complement is the interesting half. `turn_start` is an adapter announcing that it armed a
 * clock; `revision` and `error` are an adapter reporting on itself; `turn_end` is the verdict
 * rather than evidence for one. None of the four distinguishes a child that is working from one
 * that has never said a word, and each can be emitted while the child is hung.
 */
export function isChildOutput(e: AgentEvent): boolean {
  if (e.replay) return false
  switch (e.type) {
    case 'message':
      return e.role === 'assistant'
    // #198: reasoning is the child working. It is not the child SAYING anything, which is why
    // it carries no text and never reaches narration -- but "has this turn stopped" and "has
    // this turn spoken" are different questions, and this is evidence for the first.
    case 'thinking':
    case 'tool_use':
    case 'permission_requested':
    // A delegating turn is the one that goes quiet for longest -- the parent sits in a single
    // tool call while another model works, producing nothing the tailer can see. These are the
    // only things it does produce, and they are hook deliveries, so they carry the same
    // guarantee the arm above rests on: the child fired them, and no repaint or poll can
    // manufacture one. Counting them keeps the SILENCE deadline off a turn that is delegating
    // exactly as hard as it is working.
    case 'subagent_start':
    case 'subagent_stop':
      return true
    default:
      return false
  }
}

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
  /**
   * How many thinking blocks the child has written this turn (#198).
   *
   * A COUNT, and deliberately not the text. What is needed is proof the child is working, not
   * what it was working on: the reasoning is verbose, it is not the seat's narration, and
   * putting it on the record would send it to every consumer that reads narration -- including
   * the other participant, which is the one audience it is certainly not for.
   *
   * Absent on a transcript with no thinking in it, which is every Codex transcript and any
   * Claude turn that answered without reasoning.
   */
  thinkingCount?: number | undefined
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
  /**
   * Bumped once per compaction the transcript DECLARES. It is the rotation trigger, so it
   * counts only what is evidence of lost context -- not every time the file changed shape.
   */
  compactionGeneration: number
  /**
   * Unexplained prefix rewrites seen so far, when the adapter can tell. Diagnostic only:
   * nothing rotates on this. Separated from `compactionGeneration` by #122, where routine
   * byte-level churn was being counted as compaction and raising rotation candidates.
   */
  rewriteGeneration?: number | undefined
  /** When this snapshot was rebuilt from the transcript. */
  builtAt: number
  /**
   * Set when the numbers in this snapshot are not evidence: nothing here was read just now.
   * TWO conditions reach it, and they are not the same shape.
   *
   *   A STALE projection -- the contained fallback `snapshotOrLastBuilt()` hands back when the
   *   transcript would not answer in time. A read DID happen, earlier, and `builtAt` says when.
   *
   *   A NEVER read -- the adapter has no view at all, so `snapshot()` synthesizes an empty one.
   *   No read has ever happened, `builtAt` is the moment of synthesis rather than of any
   *   observation, and `compactionGeneration: 0` means "not looked" rather than "looked, none".
   *
   * The second was added after the first: a consumer that cannot tell an unread number from a
   * verified one will believe a synthesized zero, and both guards below already refuse a
   * flagged number, so folding it here is what makes the never-read safe. Anything reasoning
   * about WHEN the underlying read happened must therefore check `turns` rather than assume
   * one occurred. Absent still means the read succeeded.
   *
   * `builtAt` already says HOW OLD the answer is, and that is enough for a consumer deciding
   * whether to re-ask. It is not enough for one deciding whether a number in here is EVIDENCE:
   * a fallback is stamped from a read that did happen, so an old `builtAt` on a session nobody
   * has prompted in a while is indistinguishable from a current one. Rotation records
   * `compactionGeneration` as the mechanical proof that the participant lost context, and a
   * generation carried out of a snapshot that could not be verified is a claim about the
   * transcript nobody read. This is the flag that lets it say so instead.
   */
  containedFallback?: boolean | undefined
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
  /**
   * Things an adapter did during boot that the operator has to be told about, in prose.
   *
   * For decisions taken on the operator's machine to make the session possible at all --
   * Claude Code's folder-trust dialog is the one that exists (#108). Deliberately not the
   * event stream: boot events are buffered and drained when the relay attaches, which happens
   * before either front-end subscribes to the activity stream, so nothing prints them. The
   * relay reads this at join and records it in the routing log instead, which both front-ends
   * print and the run record keeps.
   *
   * Notices, not diagnostics. A boot that FAILED throws, and the reason belongs in the throw.
   */
  readonly startupNotices?: readonly string[] | undefined
  readonly sessionId: string
  readonly guarantees: Guarantees

  readonly state: SessionState

  send(message: string, provenance: SendProvenance): Promise<TurnKey>

  /**
   * Type a raw line at the seat's composer and press Enter, WITHOUT starting a turn (#200).
   *
   * The one thing on this seam that is write-only, and the return type is the whole point.
   * `send` hands back a `TurnKey` because a prompt begins a turn the orchestrator will wait
   * for, count against `--max-turns`, and reconcile a report out of. A slash command begins
   * none of that: it is an instruction to the CLI rather than work for the model, so there is
   * no key to give back and nothing to await. Returning `void` is what stops a caller treating
   * it as a turn, because it has nothing it could treat as one.
   *
   * WHAT IT CANNOT TELL YOU, stated here because the omission is permanent rather than
   * pending. It resolves when THIS PROCESS TYPED -- the same limit `InputQueue.submit` has
   * (see the comment above `#input` in the Claude adapter) -- and no adapter reads the
   * composer's reply. So a command the CLI rejects, does not recognise, or has disabled looks
   * from here exactly like one it ran. Any caller that records this must record the
   * submission and NOT the outcome, or it is writing down something nobody checked.
   *
   * OPTIONAL, and its absence is a fact about the transport rather than a gap. An adapter that
   * runs one process per turn with the prompt in argv has no composer to type into and no
   * session between turns to type at; `NO_COMPOSER_COMMAND_POLICY`
   * (`src/registry/commandPolicy.ts`) is the same fact declared where a policy can be read
   * off it. The two must agree, and `commandPolicy.test.ts` pins that they do.
   *
   * Ordering is the queue's, not the caller's: `InputQueue` serialises everything typed at a
   * pty, so two of these submitted in order arrive in that order, and neither can interleave
   * with a `send` on the same seat.
   */
  submitRaw?(text: string, detail?: string): Promise<void>

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

  /**
   * Live, provisional, revisable.
   *
   * Single-consumer, and it MUST END once `close()` has returned. A consumer has no other way to
   * know it has been told everything: a verdict established by a graceful close is emitted during
   * the close and delivered afterwards, so "the close returned" alone does not mean the stream is
   * spent. `Relay.stop()` waits for this iterable to finish before it treats a turn with no
   * `turn_end` as abandoned (#143), and a session that never ends it would park that wait.
   *
   * Every adapter satisfies this by closing its `AsyncQueue` inside `close()`, which drains what
   * is buffered and then reports `done`.
   */
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
