/**
 * ClaudePtyHookAdapter — the first live adapter.
 *
 * Deliberately mechanical. It owns process lifecycle, sanitized environment, input
 * serialization, hook ingestion, transcript reconciliation and evidence classification.
 * It owns no relay policy, no advisor-turn budgets, no role prompting and no summarisation --
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

import { hookTimeoutSeconds } from './hookTimeout.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, AgentSession, Guarantees, InputOwnership, Role, SendProvenance, SessionSnapshot, SessionState, TurnBudget, TurnKey, TurnRecord } from '../contract/session.ts'
import { guaranteesFor, isChildOutput, turnKey } from '../contract/session.ts'
import { emptyTranscriptState } from '../outcomes/classify.ts'
import { TurnVerdictTracker, type VerdictUpdate } from '../outcomes/tracker.ts'
import type { Verdict } from '../contract/outcome.ts'

import { DEFAULT_WATCHDOG_MS, TAIL_INTERVAL_MS, TurnWatchdog } from '../outcomes/watchdog.ts'
// The same function the run record reads, rather than a second parse of the same argv: what the
// diagnosis names must be what the report says this seat was launched with.
import { modelFromArgs } from '../registry/launch.ts'
import { sanitizedCopy } from '../process/childenv.ts'
import { PtyProcess } from '../process/pty.ts'
import { InputQueue } from '../process/input.ts'
import { HookReceiver } from '../hooks/receiver.ts'
import type { HookDelivery } from '../hooks/journal.ts'
import { TranscriptSessionView } from '../transcript/reconcile.ts'
import { AsyncQueue } from './asyncQueue.ts'
import { BoundedSingleFlight, type Abandonment } from './boundedReconcile.ts'
import {
  CorruptedPromptError,
  describePromptMismatch,
  isHarnessBlock,
  isCorruptedPrompt,
  PROMPT_RECOVERY_MS,
  RAW_ECHO_MEMORY,
  PROMPT_SEND_ATTEMPTS,
  promptRetryExhausted,
  promptRetryNotAttempted,
  type PromptMismatch,
} from './promptFidelity.ts'

const CLIENT = join(import.meta.dirname, '..', 'hooks', 'client.ts')
/**
 * The events this adapter asks Claude Code to report. Every name is a claim about the OTHER
 * program, and `hookEventNames.test.ts` checks each one against the installed binary rather
 * than against this comment -- because Claude Code accepts an unknown event key in silence and
 * simply never fires it, so a rename upstream reads as a seat that boots, runs, and never says
 * it finished. See #36 for what that looks like from the outside.
 *
 * Both halves of the subagent lifecycle are here, and `SubagentStart` was the last to arrive.
 * It was left out twice for two different reasons: Claude Code genuinely had no such event at
 * 2.1.224, and once 2.1.251 dispatched it, nothing here consumed it -- and an event nothing
 * consumes costs a hook subprocess per occurrence and buys a journal entry nobody reads, which
 * is the trade `kimiConfig.ts` spells out. `#onSubagentHook` is that consumer, so the
 * subprocess now buys something: `outstanding` counts up on a start and down on its own stop,
 * and the console says how many are running and since when instead of inferring delegation from
 * the spawning tool's name.
 *
 * The inference is still there and still needed. A CLI that does not dispatch the start -- as
 * 2.1.224 did not -- accepts the key in silence, never fires it, and leaves every stop
 * `unpaired` with `outstanding` at zero; `relay/subagents.ts` falls back to the tool name for
 * exactly that seat. That same silence is why the name below is checked against the installed
 * binary and not against this paragraph.
 */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'PreToolUse',
  // BOTH halves of the completion, and the pair is not optional (#193). The installed bundle
  // documents them as two events -- "Run after successful tool" and "Run after tool fails" --
  // so a run registering only `PostToolUse` never hears about a failing tool and leaves the
  // outstanding count high for the rest of the turn. That is the same
  // an-outstanding-nothing-can-bring-down hazard `SubagentStart` guards against, arrived at
  // from the other direction.
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  // A SEAT CAN BE RECONFIGURED MID-RUN AND THE REPORT WOULD NOT KNOW (#202). The report states
  // the launch model as fact and `#200`'s command policy refuses `/model` on that ground -- but
  // that refusal covers the advisor, not a human typing into the seat's own pane. All three
  // names verified as quoted literals in the installed bundle (2.1.261) before being registered.
  'PreModelSwitch',
  'PostModelSwitch',
  'ConfigChange',
  'Stop',
  'SessionEnd',
]

/**
 * The one send this session is waiting on a hook for. See `#pendingPrompt`, and
 * `PROMPT_SEND_ATTEMPTS` for why a corrupted send keeps it rather than releasing it.
 */
interface PendingPrompt {
  resolve: (k: TurnKey) => void
  reject: (e: Error) => void
  prompt: string
}

/**
 * What one delivery of a subagent hook did to the turn's bookkeeping.
 *
 * `duplicate` is the whole reason this is a pair of SETS rather than a counter: hook delivery
 * is at-most-once and replayed from a local journal on recovery, so a start that arrives twice
 * must count one subagent, and a stop that arrives twice must not take two away.
 */
export type SubagentChange = 'started' | 'stopped' | 'unpaired' | 'duplicate'

/**
 * The subagents one turn started, by the child's own id.
 *
 * Two sets, not one. `#running` answers "how many now", which is what the console shows;
 * `#seen` is what makes a REPLAY distinguishable from a genuine second event, and it has to
 * outlive the running set to do it. With only `#running`, a start redelivered after its stop
 * has already been processed finds the id absent, reads as news, and resurrects a subagent
 * that finished -- leaving a count that never comes down again for the rest of the turn.
 *
 * A stop for an id that never started is neither of those. `HOOK_EVENTS` registers both halves,
 * so it is no longer the ordinary case -- but it survives every CLI that does not dispatch
 * `SubagentStart` (2.1.224), every start lost before the receiver was listening, and every stop
 * whose payload names no id. It is reported as `unpaired` rather than folded into either --
 * nothing was counted up, so the count must stay where it is, and a consumer is entitled to
 * know that what it is looking at is half a lifecycle rather than a completed one.
 */
/**
 * Tool calls this turn has started and not yet been told finished (#193).
 *
 * PAIRED BY `tool_use_id`, like `TurnSubagents` and for the same reason: a count drifts, and a
 * start that never gets its stop would suspend the silence clock for the rest of the turn.
 *
 * The id is not assumed. Probed against the installed bundle (2.1.258) by running `claude -p`
 * with a settings file registering these hooks and reading what arrived: `PreToolUse` and
 * `PostToolUse` both fired, and both payloads carried `tool_use_id`. `PostToolUseFailure` is
 * registered beside them because the bundle documents the pair as two events -- "Run after
 * successful tool" and "Run after tool fails" -- so a failing tool never reaches `PostToolUse`
 * and would otherwise strand its start forever.
 */
export class TurnTools {
  readonly #running = new Set<string>()
  readonly #seen = new Set<string>()

  /** Started and not yet seen to finish. */
  get outstanding(): number {
    return this.#running.size
  }

  start(id: string): SubagentChange {
    if (this.#seen.has(id)) return 'duplicate'
    this.#seen.add(id)
    this.#running.add(id)
    return 'started'
  }

  finish(id: string): SubagentChange {
    if (!this.#seen.has(id)) {
      // Seen, though nothing was counted: a redelivery of this same completion must still be
      // recognisable as the same one rather than read as a second tool finishing.
      this.#seen.add(id)
      return 'unpaired'
    }
    if (!this.#running.delete(id)) return 'duplicate'
    return 'stopped'
  }
}

export class TurnSubagents {
  readonly #running = new Set<string>()
  readonly #seen = new Set<string>()

  /** Started and not yet seen to stop. */
  get outstanding(): number {
    return this.#running.size
  }

  start(id: string): SubagentChange {
    if (this.#seen.has(id)) return 'duplicate'
    this.#seen.add(id)
    this.#running.add(id)
    return 'started'
  }

  stop(id: string): SubagentChange {
    if (!this.#seen.has(id)) {
      // Recorded as seen even though nothing was counted, so a redelivery of this same stop is
      // still recognisable as the same one.
      this.#seen.add(id)
      return 'unpaired'
    }
    if (!this.#running.delete(id)) return 'duplicate'
    return 'stopped'
  }
}

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
  /**
   * Which subagents this turn has started and not yet been told finished.
   *
   * Per turn rather than per session: "what is this seat doing right now" is a question about
   * the turn in flight, and a subagent belonging to a turn that ended two prompts ago is not
   * part of the answer. It is dropped with the turn rather than reconciled.
   */
  subagents: TurnSubagents
  /** Tool calls started and not yet finished, which is why the silence clock waits (#193). */
  tools: TurnTools
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

/**
 * What the adapter knows about a turn, independently of the transcript.
 *
 * Named so the merge below can be tested without booting a pty. The merge is where a
 * hook-derived fallback was being silently discarded, and a defect in a private method of a
 * class that only constructs by spawning a real CLI is a defect with nowhere to put a test.
 */
export interface KnownTurn {
  key: TurnKey
  prompt: string
  /** From `Stop`'s `last_assistant_message`. The fallback when the transcript has nothing. */
  assistantText: string | undefined
  verdict: Verdict | undefined
}

/**
 * Fold what the adapter knows into what the transcript says.
 *
 * Claude Code writes no per-turn id into its transcript, so correspondence is positional.
 * Hook-derived verdicts outrank transcript inference -- `Stop` PROVES completion, the
 * transcript only suggests it -- and a turn the adapter knows about beyond what the
 * transcript has recorded is appended rather than dropped, or a consumer folding `events()`
 * would disagree with `snapshot()`.
 *
 * ## The prose fallback, which used to reach nobody
 *
 * `Stop` carries `last_assistant_message`, and the adapter stores it precisely so a turn
 * whose transcript cannot be read still has SOMETHING to say. That store was never read
 * back out here, so the fallback existed and no consumer could see it: a completed turn
 * whose transcript had not flushed produced an empty report, the relay had nothing to route,
 * and the run ended on an escalation while the work sat on disk (#39).
 *
 * The transcript wins where it has text -- it concatenates every block, which is the full
 * narration the peer is entitled to, and `last_assistant_message` is only the closing
 * paragraph. The fallback applies exactly when there is nothing to lose by applying it.
 */
export function mergeKnownTurns(
  transcriptTurns: readonly TurnRecord[],
  known: readonly (KnownTurn | undefined)[],
): TurnRecord[] {
  const turns = [...transcriptTurns]
  known.forEach((k, i) => {
    if (!k) return
    const base = turns[i] ?? { key: k.key, prompt: k.prompt, state: 'in_progress' as const, toolCalls: [] }
    const merged: TurnRecord = { ...base, key: k.key }
    if (k.verdict) {
      merged.state = k.verdict.outcome
      merged.confidence = k.verdict.confidence
      merged.provenance = k.verdict.provenance
    }
    // Only when the transcript gave nothing. A partial narration is still the fuller
    // account, and replacing it with the closing paragraph would lose the rest of the turn.
    if (!merged.assistantText && k.assistantText) merged.assistantText = k.assistantText
    turns[i] = merged
  })
  return turns
}

export interface ClaudeAdapterOptions {
  cwd: string
  role: Role
  /**
   * How long the #174 recovery may wait for the CHILD to confirm the malformed turn ended,
   * before the send is refused instead of re-sent. Defaults to `PROMPT_RECOVERY_MS`.
   *
   * Not for production use. Shortening it makes a session give up on a confirmation that was
   * merely slow, which turns a recoverable corruption into a refusal.
   */
  promptRecoveryMs?: number | undefined
  inputOwnership?: InputOwnership | undefined
  /** Extra CLI args, e.g. ['--permission-mode', 'default']. */
  args?: string[] | undefined
  /**
   * The program to spawn. Defaults to `claude` on PATH.
   *
   * Threaded from `AgentDefinition.launch.command` by the registry (#51), and that is the
   * point of it rather than a convenience: the availability preflight validates
   * `launch.command`, so an adapter that hardcodes its own filename makes the field a
   * DIFFERENT command from the one that launches -- an absolute path or a wrapper would be
   * checked and then not run. A validated field that nothing spawns is worse than no check,
   * because it reports on a configuration the run does not have.
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
const SEND_HOOK_TIMEOUT = (journal: string): string =>
  `no UserPromptSubmit hook after send, and the prompt IS in the child's transcript -- so the text was accepted and the hook is what did not arrive. Most often the previous turn had not finished -- neither CLI accepts input mid-turn -- so try a longer --settle. If it recurs at the first turn, the hooks are not firing.

Three states produce this, and only one is transient:

  - the hooks are not registered, or registered but untrusted. 'conclave config check'
    distinguishes those two and says so plainly
  - the handler was killed before it could run. Under load a cold 'node' start can exceed the
    hook's own timeout and the CLI kills it. 'config check' reports registration and trust; it
    cannot see this, and will report that everything is fine

${journal} tells them apart. If that file EXISTS the handler ran and could not deliver, which is
a delivery problem. If it is ABSENT the handler never executed, which under load is the timeout
-- and the same command succeeds on a quiet machine, which is why this presents as flakiness
rather than as a resource problem.`

/**
 * The other half of the send failure, and the half that used to be reported as the one above.
 *
 * `#input.submit()` resolving means THIS PROCESS TYPED, not that the child received. When the
 * keystroke is swallowed the prompt never reaches the transcript, no hook can fire for a turn
 * that never started, and the old single message asserted "the child accepted the text" --
 * which was unverified, and in the observed case false (#120). It then named the hooks and
 * `--settle` as the remedies, the two things demonstrably working, and cost two runs
 * misattributed to other causes before anyone read the child's own transcript.
 *
 * Distinguishing the two costs one transcript read, which is already parsed and already polled.
 */
const SEND_NOT_ACCEPTED =
  "the text was typed but never became a prompt: it is absent from the child's transcript after a re-submit, so this is swallowed input rather than a hook failure. Nothing is wrong with the hooks -- `conclave config check` and `--settle` will not help. The turn was not started, so no work was lost."

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


/** How long to wait for a submitted prompt to appear in the transcript before repairing. */
/**
 * How often the #174 recovery asks whether the child has confirmed the malformed turn ended.
 *
 * A poll, because the confirmation arrives on the hook thread or from a transcript read, and
 * neither of them has anything to notify. Short enough that the common case -- a `Stop` landing
 * a moment after the ESC -- costs the recovery nothing measurable.
 */
const RECOVERY_POLL_MS = 50


const SUBMIT_LANDED_MS = 6_000

/** How long to wait after the repair keystroke before concluding the text never landed. */
const SUBMIT_REPAIR_MS = 6_000

/**
 * A pty buffer with escape sequences removed and whitespace collapsed.
 *
 * Shared, because there were two copies and they had already drifted: one wrote the OSC
 * alternative as an EMPTY character class followed by a literal bracket, which matches
 * nothing, so terminal-title writes survived into text that was then pattern-matched. A
 * title containing "trust this folder" would have been read as the folder-trust dialog.
 */
function plainScreen(raw: string): string {
  return raw
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]|\u001b[()][A-Z0-9]|\u001b[\]][^\u0007]*\u0007/g, ' ')
    .replace(/[^\S\n]+/g, ' ')
}

/**
 * The folder-trust dialog, in the two phrasings Claude Code has used for it.
 *
 * Matched against a screen that has been through `plainScreen`: the raw buffer carries
 * cursor-positioning sequences BETWEEN words -- `trust\x1b[20Gthis\x1b[25Gfolder` -- so no
 * phrase appears contiguously and a naive regex silently never matches.
 */
const FOLDER_TRUST_DIALOG = /trust this folder|Is this a project you created/i

/**
 * Whether anything on screen LOOKS like the folder-trust dialog.
 *
 * Deliberately broad, and deliberately not the thing that authorises a keystroke. This is the
 * diagnostic reading: it runs once, after the readiness window has already expired, to explain a
 * failure that has already happened. Over-matching there costs a slightly wrong sentence in a
 * message nobody reads unless something is broken. See `answerableFolderTrustDialog` for the
 * reading that types.
 */
export function folderTrustDialogVisible(raw: string): boolean {
  return FOLDER_TRUST_DIALOG.test(plainScreen(raw).replace(/\s+/g, ' '))
}

/**
 * Every part of the dialog that must be on screen before anything is typed at it.
 *
 * The broad match above is not safe as a write gate, and the asymmetry is the whole point: a
 * false negative delays a boot that then fails with a message naming the remedy, while a false
 * positive types `1` and Enter into a live composer and submits a turn whose entire content is
 * `1`. A model that quotes the phrase "trust this folder" in its own narration, a file listing,
 * a diff of THIS source file on screen -- each of those satisfies the broad reading.
 *
 * So the structure is required, not the phrase:
 *
 *   1. the numbered accept option, `1. Yes, ... trust this folder`
 *   2. the numbered decline option, `2. No`
 *   3. the question, or the confirmation affordance the menu is drawn with
 *
 * The first is doing more work than pattern-matching. The keystroke this authorises is `1`, and
 * this is what checks that `1` is the option that TRUSTS -- rather than assuming an ordering
 * that lives in someone else's interface. On the day those swap, this stops matching and the
 * run fails with a diagnostic instead of confidently pressing "No, exit".
 */
/** The option that grants trust, identified by what it SAYS rather than where it sits. */
const ACCEPT_OPTION = /trust this folder/i
/** The option that declines. Required, so a menu with only one identifiable row is refused. */
const DECLINE_OPTION = /\bNo,?\s*exit\b|\b2\s*[.)]\s*No\b/i
/** The affordance the menu is drawn with, which is what makes Enter mean anything. */
const CONFIRM_AFFORDANCE = /Is this a project you created|Enter to confirm/i
/** The selection cursor. Claude Code draws U+276F; `>` is accepted for a plainer terminal. */
const CURSOR_GLYPH = /[\u276f>]/g
/** The legacy numbered form, kept for older builds. The DIGIT is read, never assumed. */
const NUMBERED_ACCEPT = /(^|[^0-9])([0-9])\s*[.)]\s*Yes\b.{0,24}trust this folder/i

/**
 * What to press to land on "trust this folder", or `undefined` if that cannot be established.
 *
 * BY TEXT, never by position, and #232 is why. The dialog used to be `1. Yes, I trust this folder`
 * / `2. No`, and the old matcher required exactly that shape. Claude Code 2.1.261 renders it with
 * no numbers at all and with the options REVERSED:
 *
 *     ❯ No, exit
 *       Yes, I trust this folder
 *     Enter to confirm · Esc to cancel
 *
 * So `1` selects nothing and Enter confirms the highlighted row -- which is now the one that
 * EXITS. A matcher keyed to a digit or a position would have killed the session silently, and it
 * would have read as a crash rather than a refusal. The old signature's own comment predicted the
 * day: "on the day those swap, this stops matching and the run fails with a diagnostic instead of
 * confidently pressing No, exit". That is what it did, and this keeps that property.
 *
 * ORDERING, NOT ROWS. The raw pty buffer positions rows with cursor moves rather than newlines --
 * `trust\x1b[20Gthis\x1b[25Gfolder` -- so there are no line boundaries to count. What survives
 * normalisation is the ORDER the options were drawn in and where the cursor glyph sits relative to
 * them, which is enough for a two-option menu and does not pretend to more.
 */
export function folderTrustAction(raw: string): { key: string; repeat: number } | undefined {
  const screen = plainScreen(raw).replace(/\s+/g, ' ')
  const accept = screen.search(ACCEPT_OPTION)
  const decline = screen.search(DECLINE_OPTION)
  if (accept < 0 || decline < 0) return undefined

  // TWO OPTIONS, and no more. This knows a menu with one row that trusts and one that declines;
  // a third row is a shape it has not seen, and both readings below would be guessing at it --
  // the ordering one about which row the cursor sits on, the numbered one about whether a digit
  // still selects. The fixture that motivates this is real in spirit: `1. Yes, just this session`
  // above `3. Yes, I trust this folder`, where the narrower grant is the one a positional guess
  // would take. Refusing an unfamiliar menu is the property that made the old signature safe.
  const numbered = [...screen.matchAll(/(^|[^0-9])([0-9])\s*[.)]\s*(?=[A-Za-z])/g)]
  if (numbered.length > 2) return undefined

  // Where the cursor is: the last glyph appearing before one of the two options. A glyph after
  // both is a composer prompt further down the buffer, not this menu's selection.
  let cursor = -1
  for (const m of screen.matchAll(CURSOR_GLYPH)) {
    const i = m.index ?? -1
    if (i >= 0 && i < Math.max(accept, decline)) cursor = i
  }

  if (cursor >= 0) {
    // The option the cursor is on is the first one drawn after it.
    const on = accept > cursor && (accept < decline || decline < cursor) ? accept : decline
    if (on === accept) return { key: '\r', repeat: 0 }
    // One move toward the accepting row, in whichever direction it lies.
    return { key: accept > decline ? '\u001b[B' : '\u001b[A', repeat: 1 }
  }

  // LEGACY, for a build that numbers its options and draws no cursor. The digit is READ off the
  // row whose text grants trust rather than assumed to be 1, so a renumbering of a two-option
  // menu presses the right row instead of refusing -- while a menu with more rows is refused
  // above, unread.
  const accepting = NUMBERED_ACCEPT.exec(screen)
  if (accepting) return { key: accepting[2]!, repeat: 1 }
  return undefined
}

/**
 * Whether the dialog is on screen AND has the shape this knows how to answer.
 *
 * The only reading that authorises a write. See `ANSWERABLE_SIGNATURE`.
 */
export function answerableFolderTrustDialog(raw: string): boolean {
  if (!CONFIRM_AFFORDANCE.test(plainScreen(raw).replace(/\s+/g, ' '))) return false
  return folderTrustAction(raw) !== undefined
}

/**
 * A modal that is DISMISSED rather than answered, and why the two are different.
 *
 * Claude Code can raise setup modals mid-session. The one observed (#120) is
 * `/auto-mode-setup`, which appeared between an implementer's first and second turn and
 * silently ate every subsequent keystroke -- the text was typed, never became a prompt, and
 * the run died reporting a hook failure. It offers to scan shell history and other
 * repositories, so unlike the folder-trust gate this is NOT conclave's to accept: consenting
 * on an operator's behalf to reading their shell history is not implied by asking conclave to
 * drive a coding session in one directory.
 *
 * Esc is therefore the only key sent. It declines, it is the affordance the dialog itself
 * advertises, and it is inert if the match was wrong -- Esc at a live composer clears a draft
 * that this adapter did not put there, where Enter would submit one.
 *
 * Required structurally rather than by phrase, for the reason `ANSWERABLE_SIGNATURE` gives:
 * the title alone appears whenever a model narrates it or this file is on screen.
 */
const DISMISSABLE_MODAL = [
  /auto-mode-setup|Set up auto mode for your environment/i,
  /Esc to cancel/i,
] as const

/** Whether a setup modal conclave should decline is on screen. */
export function dismissableModalVisible(raw: string): boolean {
  const screen = plainScreen(raw).replace(/\s+/g, ' ')
  return DISMISSABLE_MODAL.every((re) => re.test(screen))
}

/**
 * What was sent to clear the dialog, recorded rather than left on a screen to be grepped.
 *
 * The keystrokes are part of the record on purpose. "The dialog was answered" and "option 1
 * was confirmed" are different claims, and the Codex equivalent shipped a version that
 * recorded the opposite of what it intended (`ensureTrust.ts`) precisely because the only
 * evidence kept was that a prompt had appeared.
 */
export interface FolderTrustAcceptance {
  /** The directory the dialog asked about: the session's cwd, verbatim. */
  directory: string
  /** Exactly what was written to the pty, in order. */
  keys: string[]
  at: number
}

/** The slice of a pty this needs, so the acceptance can be driven without spawning claude. */
export interface TrustDialogPty {
  readonly output: string
  write(data: string): void
}

/**
 * Answer Claude Code's folder-trust dialog once, selecting "Yes, I trust this folder".
 *
 * ## Why this is answered rather than reported
 *
 * It used to be reported: the adapter detected the dialog, refused, and told the operator to
 * run `claude` by hand. Under `--operator agent` there is by definition nobody who can carry
 * that out, so the run did not degrade -- it never started (#108). Nor is it a once-per-machine
 * cost: a directory that had been running Conclave for weeks began failing at startup the
 * moment Claude Code auto-updated, because whatever the update changed stopped the previous
 * acceptance from counting.
 *
 * The old comment argued that running Conclave in a directory is not the same as having vetted
 * what is in it. That reasoning does not survive what invoking Conclave for THIS directory
 * actually asks for: a Claude Code session in it, running Conclave's own hook client out of
 * this checkout, which Claude Code will not do until the folder is trusted. Refusing to answer
 * did not withhold the decision -- it withheld the session, and left the identical decision
 * for a human to make by hand with less information about it.
 *
 * ## What this does NOT grant
 *
 * Folder trust only, and for one directory: the one named in `directory`, which is the cwd the
 * session was launched in. It does not touch tool permissions. Every Read, Bash and Edit the
 * model asks for is still gated exactly as before, and `--dangerously-skip-permissions` remains
 * the only thing that changes that -- and, note, does NOT cover this dialog, which is why the
 * two are easy to confuse and why they are named together here.
 *
 * ## Once, and the `prior` argument is what makes that true
 *
 * The pty buffer is CUMULATIVE. The dialog text stays in it forever, so a caller polling until
 * the session is ready sees it on every pass after the first -- and a second pass would type
 * `1` and Enter into a live composer, submitting a turn whose entire content is `1`. Passing
 * back the acceptance already held is what stops that, so it is a parameter rather than a rule
 * in the caller's head. Returns `prior` unchanged and writes nothing when it is set.
 *
 * The other half of that guard is `answerableFolderTrustDialog`, which requires the whole menu
 * rather than a phrase: `prior` stops a SECOND write, and the signature stops a first one at a
 * screen that merely mentions trusting a folder.
 */
export async function acceptFolderTrustDialog(
  pty: TrustDialogPty,
  directory: string,
  opts: { prior?: FolderTrustAcceptance | undefined; settleMs?: number; now?: () => number } = {},
): Promise<FolderTrustAcceptance | undefined> {
  if (opts.prior) return opts.prior
  // The strict reading, never the broad one. Nothing is typed at a screen whose structure has
  // not been confirmed, including the position of the option about to be pressed.
  if (!answerableFolderTrustDialog(pty.output)) return undefined
  // The same shape as the Codex prompt driver: settle, select, settle, confirm. A TUI that
  // is still drawing drops keys, and both halves have been observed to need the gap.
  const settle = opts.settleMs ?? 400
  const keys: string[] = []
  const send = async (k: string) => {
    await new Promise((r) => setTimeout(r, settle))
    pty.write(k)
    keys.push(k)
  }
  // What `folderTrustAction` established, not what this function assumes (#232): a move toward
  // the row whose TEXT grants trust, or the digit that build numbered it with.
  const action = folderTrustAction(pty.output)
  if (!action) return undefined
  for (let i = 0; i < action.repeat; i++) await send(action.key)
  await send('\r')
  return { directory, keys, at: (opts.now ?? Date.now)() }
}

/**
 * Why the session never became ready, in terms the operator can act on.
 *
 * Exported and pure so the message can be tested against the states that produce it, rather
 * than by driving a real `claude` into each of them.
 *
 * Three states read identically from outside and are separated here, because what the operator
 * should do differs in each:
 *
 *   answered, still stuck   the acceptance ran and did not take. Says exactly what it sent, so
 *                           the next person is debugging the acceptance rather than rediscovering
 *                           that there is one. The by-hand remedies are still given: a human at a
 *                           terminal can do what the automation could not, which is the whole
 *                           asymmetry, and withholding them would leave a stuck run with nothing.
 *   visible, unanswerable   the dialog is up in a shape the signature does not cover, so nothing
 *                           was typed at it ON PURPOSE. That is the actionable news, because it
 *                           says the acceptance needs teaching a new shape rather than that it is
 *                           broken.
 *   visible, never answered the acceptance did not run at all -- an older build, or a code path
 *                           that skipped it.
 */
export function bootFailureMessage(state: {
  screen: string
  cwd: string
  alive: boolean
  trust?: FolderTrustAcceptance | undefined
}): string {
  // `claude -p` is named because it is the first thing anyone reaches for, and it is the one
  // check that cannot see this: headless mode never shows the dialog, so it returns a cheerful
  // OK in the very directory where every interactive session is stuck (#108).
  const notATest =
    'Note that `claude -p "say OK"` is NOT a valid test of this condition -- headless mode ' +
    'never shows the dialog -- and --dangerously-skip-permissions does NOT cover it.'
  if (state.trust) {
    return (
      `claude showed its folder-trust dialog for ${state.trust.directory} and conclave answered ` +
      `it (sent ${state.trust.keys.map((k) => (k === '\r' ? 'Enter' : k)).join(' then ')}), but ` +
      'the session still never reported SessionStart, so the acceptance did not take. Run ' +
      `\`claude\` in that directory once and accept it by hand, or set projects["${state.cwd}"]` +
      '.hasTrustDialogAccepted to true in ~/.claude.json. ' +
      notATest
    )
  }
  if (folderTrustDialogVisible(state.screen)) {
    const remedy =
      'run `claude` in that directory once and accept, or set ' +
      `projects["${state.cwd}"].hasTrustDialogAccepted to true in ~/.claude.json. ${notATest}`
    // Nothing was typed, and saying so is the point. The signature requires the menu it is about
    // to press a key on -- `1. Yes, ... trust this folder` and `2. No` -- precisely so that an
    // unfamiliar screen produces this message instead of a keystroke of unknown meaning.
    if (!answerableFolderTrustDialog(state.screen)) {
      return (
        `claude is waiting on its folder-trust dialog for ${state.cwd}, so no hook can fire and ` +
        'the session never becomes ready. Conclave did NOT answer it: the dialog is on screen in ' +
        'a shape it does not recognise, and it will not press a numbered option whose meaning it ' +
        `has not confirmed. ${remedy}`
      )
    }
    return (
      `claude is waiting on its folder-trust dialog for ${state.cwd}, so no hook can fire and ` +
      'the session never becomes ready. Conclave answers this dialog itself, so seeing it here ' +
      `means the acceptance never ran: ${remedy}`
    )
  }
  if (!state.alive) {
    return 'claude exited before reporting SessionStart; run `conclave config check` to verify the hook registration'
  }
  return (
    'claude did not report SessionStart within the readiness window. The hooks may not be ' +
    'registered: run `conclave config check`. If it is merely slow, raise readyTimeoutMs.'
  )
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
  #view: TranscriptSessionView | undefined
  #sessionId = ''
  #transcriptPath: string | undefined
  #seq = 0
  #ready = false
  #closed = false
  #closeMode: 'graceful' | 'abandoned' | undefined
  #pendingPrompt: PendingPrompt | undefined
  /**
   * Text handed to `submitRaw` whose `UserPromptSubmit` hook has not come back yet (#207).
   *
   * A slash command is typed into the same composer a prompt goes into, and the CLI dispatches
   * its ordinary prompt hooks for it. That echo is a turn this adapter did not send -- which
   * was documented on `submitRaw` and then not followed through: when the echo lands while a
   * REAL send is in flight, the correlation in `#onHook` compares the command against the
   * instruction, finds two unrelated strings and calls the send corrupt.
   *
   * So each raw submission is remembered until its echo is seen and matched. A hit means the
   * turn belongs to the command, exactly as an unsolicited turn does, and the pending claim is
   * left alone so the instruction's own echo still resolves it when it arrives.
   *
   * BOUNDED, because a CLI that dispatches no hook for a command would otherwise grow this
   * forever. The bound discards the OLDEST, so the entry most likely to still be in flight is
   * the one kept.
   */
  #rawSubmissions: string[] = []
  #opts: ClaudeAdapterOptions
  #folderTrust: FolderTrustAcceptance | undefined
  #notices: string[] = []
  /**
   * The per-session scratch directory, kept so it can be given back (#203).
   *
   * Was `#settingsDir`, written and never read -- one of the dead fields #212 counted. It is the
   * handle this needs, so it is repurposed rather than joined by a second field naming the same
   * path.
   */
  /**
   * Model switches this seat has been through mid-run (#202).
   *
   * Kept because the launch record cannot be corrected -- it is immutable by construction and
   * that is the point of it -- so the only honest thing to do with a switch is record it beside
   * the record it contradicts.
   */
  readonly #reconfigured: Array<{ from: string; to: string; at: number }> = []
  /**
   * A larger absolute budget requested for the turn now being sent (#193).
   *
   * Held between `send()` and the turn's creation because those are not the same moment on this
   * adapter: the turn state is built when `UserPromptSubmit` comes back, which is the only point
   * the child's own key is known. Cleared as it is consumed, so a request never outlives the one
   * turn it was made for -- that is what makes it a request rather than an exemption.
   */
  #pendingBudget: TurnBudget | undefined
  #runDir: string | undefined
  /**
   * Set when the operator has been told to inspect the attempts journal, which lives in
   * `#runDir` (#203).
   *
   * `SEND_HOOK_TIMEOUT` says: "if that file EXISTS the handler ran and could not deliver... if
   * it is ABSENT the handler never executed". Deleting the directory on close would make it
   * absent every time and turn a delivery problem into a misdiagnosed timeout -- a worse defect
   * than the leak, because it is a wrong answer rather than a full disk. So the one run whose
   * evidence was named to a human is the one run that keeps it.
   */
  #keepRunDir = false
  #watchdog: TurnWatchdog<TurnState>

  private constructor(opts: ClaudeAdapterOptions) {
    this.#opts = opts
    this.guarantees = guaranteesFor(opts.inputOwnership ?? 'mediated')
    // A hung turn produces no hooks, no transcript records and no exit, so the deadline
    // rule has to be driven by a clock rather than by an arrival like everything else.
    // `synthesized: true` -- nothing from the child said this.
    this.#watchdog = new TurnWatchdog<TurnState>(
      opts.watchdogMs ?? DEFAULT_WATCHDOG_MS,
      (turn, update) => {
        const applied = this.#withScreenTail(update)
        this.#apply(turn, applied, true)
        // Then ask the transcript whether the clock was right. Fire-and-forget on purpose: the
        // verdict is already out, and nothing downstream waits on this. See `#reconsiderDeadline`.
        void this.#reconsiderDeadline(applied)
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
    this.#runDir = runDir

    this.#receiver = new HookReceiver(join(runDir, 'hooks.ndjson'))
    this.#attemptJournal = join(runDir, 'attempts.ndjson')
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
        // Recorded on the instance so the diagnostic can name it (#41).
        ORCH_HOOK_TIMEOUT_MS: '5000',
      },
    })

    this.#pty = await PtyProcess.spawn({
      file: this.#opts.command ?? 'claude',
      args: ['--settings', settingsPath, ...(this.#opts.args ?? [])],
      cwd: this.#opts.cwd,
      env,
    })
    this.#input = new InputQueue(this.#pty)
    this.#pty.on('exit', (info) => void this.#onExit(info.reason))

    const deadline = Date.now() + (this.#opts.readyTimeoutMs ?? 60_000)
    while (!this.#ready && Date.now() < deadline && this.#pty.alive) {
      // Inside the readiness wait rather than before it: the dialog is drawn by the very
      // process we are waiting on, and until it is answered no hook fires, so waiting and
      // watching for it are the same activity.
      await this.#answerFolderTrust()
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!this.#ready) throw new Error(this.#whyNotReady())
    // Readiness is not the same as being able to type; wait for both.
    await this.#pty.waitForOutput(() => this.#pty.isInteractive, 30_000)
    await this.#pty.waitQuiet(700, 20_000)
  }

  /**
   * Answer the folder-trust dialog if it is on screen, at most once per session.
   *
   * The commonest reason a session never becomes ready: Claude Code shows this on any
   * directory it has not seen -- including under `--dangerously-skip-permissions`, which does
   * not cover it -- and nothing proceeds until it is answered, so no hook ever fires and the
   * failure looks identical to a broken hook registration.
   *
   * Announced through `startupNotices` rather than an event: the events emitted during boot
   * are buffered and drained when the relay attaches, which is before either front-end
   * subscribes to the activity stream, so a notice sent that way is a notice nobody prints.
   * The relay records these in the routing log, which both front-ends do print and the run
   * record keeps.
   */
  async #answerFolderTrust(): Promise<void> {
    const accepted = await acceptFolderTrustDialog(this.#pty, this.#opts.cwd, {
      prior: this.#folderTrust,
    })
    // Identity, not truthiness: `accepted` is the acceptance that now STANDS, which on every
    // pass after the first is the one already held. Only a new one is announced.
    if (!accepted || accepted === this.#folderTrust) return
    this.#folderTrust = accepted
    // The exact directory, because that is the whole content of the decision and it is not
    // always the one the operator is looking at: a seat working in an isolated worktree is
    // launched in the tree's path, not the checkout the run was started from.
    this.#notices.push(
      `accepted claude's folder-trust dialog for ${accepted.directory} — this grants folder ` +
        'trust only and does not bypass tool permissions',
    )
  }

  /** See `#answerFolderTrust`: what happened at boot that the operator must be told about. */
  get startupNotices(): readonly string[] {
    return this.#notices
  }

  /** Why the session never became ready. See `bootFailureMessage`. */
  #whyNotReady(): string {
    return bootFailureMessage({
      screen: this.#pty?.output ?? '',
      cwd: this.#opts.cwd,
      alive: this.#pty?.alive === true,
      trust: this.#folderTrust,
    })
  }

  /**
   * Attach what the terminal was showing when a turn was declared hung.
   *
   * The adapter reads the TRANSCRIPT, so anything the CLI reports on screen and never writes
   * to the transcript is invisible to it -- and a turn that died on an API error looks
   * identical to one that simply went quiet. That is not hypothetical for this project: the
   * Codex equivalent was `usage_limit_exceeded` arriving as a `task_complete` error and being
   * read as a normal empty completion (#35).
   *
   * A stalled turn is exactly when that difference matters and exactly when nobody can go and
   * look, because unattended runs are the ones that stall. So the last of the screen travels
   * with the verdict, as a caveat: it is context for a human, never evidence for a decision.
   *
   * Bounded and escape-stripped. The raw buffer is megabytes of cursor positioning, and the
   * useful part is the last few lines.
   */
  #withScreenTail(update: VerdictUpdate | undefined): VerdictUpdate | undefined {
    if (!update?.verdict) return update
    const screen = plainScreen(this.#pty?.output ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-6)
      .join(' / ')
    if (!screen) return update
    return {
      ...update,
      verdict: {
        ...update.verdict,
        provenance: [
          ...update.verdict.provenance,
          { source: 'transport', detail: `terminal showed: ${screen.slice(-400)}`, caveat: true },
        ],
      },
    }
  }

  #hookSettings(): unknown {
    const command = `node ${CLIENT} claude`
    const entry = { hooks: [{ type: 'command', command, timeout: hookTimeoutSeconds() }] }
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
      // Recorded once per turn -- the tracker is asked only on the transition -- because this
      // runs on the hot event path, and because a repeat says nothing the first one did not.
      // Not on a settled turn. The tracker would reclassify and hand back an update that this
      // path discards, leaving a verdict in the tracker that no `turn_end` ever carried -- so
      // `events()` and `snapshot()` would disagree about a turn already reported.
      if (turn && !turn.tracker.settled && !turn.produced) {
        turn.produced = true
        turn.tracker.observeLaunch({ produced: true })
      } else if (!turn) {
        // The child spoke before its own UserPromptSubmit reached us. Hooks are delivered as
        // independent POSTs that nobody orders, so a CLI that fires a permission request
        // immediately after submitting a prompt can have the two arrive either way round --
        // reliably in order on one machine and not on another, which is how this was found:
        // green on macOS, red on Linux, on the same commit.
        //
        // Dropping it is not neutral. It is the difference between "this turn produced
        // nothing, so the model it was launched with is a suspect" and the opposite, so
        // losing the race makes conclave blame a model for a turn that spoke (#82).
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
            ...(this.#opts.readLeaseMs === undefined ? {} : { readLeaseMs: this.#opts.readLeaseMs }),
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
          // THE BUDGET THAT WILL ACTUALLY FIRE (#193), so the deadline and the number the
          // verdict quotes are the same. A turn granted more, reported against the run default,
          // would send a reader to the wrong clock.
          watchdogSeconds:
            (this.#pendingBudget?.absoluteMs ?? this.#opts.watchdogMs ?? DEFAULT_WATCHDOG_MS) / 1000,
          // What this child was started with, so a deadline that fires on a turn which never
          // produced anything can name the model as a candidate cause (#82). `#order` is empty
          // for exactly one turn per session, which is the only turn the launch is a suspect on.
          launch: { model: modelFromArgs(this.#opts.args ?? []), firstTurn: this.#order.length === 0, produced: false },
        })
        tracker.observeHook('UserPromptSubmit', d.payload)
        const turn: TurnState = {
          key,
          prompt: String(d.payload.prompt ?? ''),
          startedAt: Date.now(),
          tracker,
          endSeq: undefined,
          assistantText: undefined,
          produced: false,
          childClosure: undefined,
          subagents: new TurnSubagents(),
          tools: new TurnTools(),
          ...(this.#pendingBudget === undefined ? {} : { absoluteMs: this.#pendingBudget.absoluteMs }),
        }
        this.#pendingBudget = undefined
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
        // CLASSIFIED BEFORE IT IS ANNOUNCED (#208). All three inputs are readable here and the
        // consumption of the raw echo is unconditional either way, so moving it ahead of the
        // emit changes nothing except that `turn_start` can now say what kind of turn it is.
        const rawEcho = this.#takeRawEcho(turn.prompt)
        const pending = this.#pendingPrompt
        const harness = isHarnessBlock(turn.prompt)
        // Nothing asked for this and it is not housekeeping: the seat dispatched work itself.
        const unsolicited = pending === undefined && !rawEcho && !harness
        this.#emit({
          type: 'turn_start',
          prompt: turn.prompt,
          turnKey: key,
          seq: this.#next(),
          at: turn.startedAt,
          provisional: false,
          ...(unsolicited ? { unsolicited: true } : {}),
        })
        // #174: the hook echoes back the prompt the child ACTUALLY took. Comparing it to what
        // was sent is the one end-to-end check of the transport that does not itself depend on
        // the pty, the tty queue or the composer behaving. The turn above is already open and
        // already recorded against the text the child took -- that is what it is working on,
        // and pretending otherwise would put a lie in the transcript. Only the SEND is refused.
        //
        // An unsolicited hook has no pending send and is not a mismatch: the child is allowed
        // to start turns nobody here asked for, and always was.
        //
        // A HARNESS block is not an echo either, and unlike an unsolicited turn it arrives
        // while a send IS pending -- which is what made it look like one (#185). The child is
        // genuinely working on it, so the turn above stands; what must not happen is comparing
        // the advisor's envelope against it, calling the send corrupt, and then trying to
        // recover by cancelling a turn that will never report a `Stop`. The claim is left
        // untouched, so the echo of our own send still resolves it when it arrives.
        // #207: the raw echo was taken UNCONDITIONALLY above, before the pending claim was read.
        // A command's echo is its own turn whether or not a send happens to be in flight behind
        // it, and leaving the entry in place because nothing was pending would let it suppress a
        // later prompt that genuinely was corrupt.
        if (pending && !harness && !rawEcho) {
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
      // #193: BOOKKEEPING ONLY -- no event is emitted for either. The transcript already
      // produces `tool_use` and the console already shows it; a second one from the hook stream
      // would double every tool call in the record for a counter nobody reads directly.
      //
      // The turn is resolved the same way the subagent hooks resolve it, and a tool call
      // belonging to no turn of ours is not evidence about a turn of ours.
      case 'PreToolUse': {
        const turn = this.#turnFor(String(d.turnKey ?? '')) ?? this.#latestLiveTurn()
        const id = typeof d.payload.tool_use_id === 'string' ? d.payload.tool_use_id : undefined
        // No id is no pairing, and an unpairable start is worse than an uncounted one: it would
        // hold the silence clock open for the rest of the turn with nothing able to bring it
        // down. Verified present on this bundle; dropped rather than guessed if it ever is not.
        if (turn && id !== undefined) turn.tools.start(id)
        return
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const turn = this.#turnFor(String(d.turnKey ?? '')) ?? this.#latestLiveTurn()
        const id = typeof d.payload.tool_use_id === 'string' ? d.payload.tool_use_id : undefined
        if (turn && id !== undefined) turn.tools.finish(id)
        return
      }
      // PRE is ignored on purpose: a switch that is about to happen has not happened, and a
      // report that named a model the seat never ran would be the same falsehood pointed the
      // other way. Registered anyway, because the pair is how the CLI describes the transition
      // and hearing only the second half of a documented pair is how #193 went wrong.
      case 'PreModelSwitch':
        return
      case 'PostModelSwitch': {
        const from = String(d.payload['from_model'] ?? '')
        const to = String(d.payload['to_model'] ?? '')
        // A switch to the same model is not a switch. The CLI does not dispatch one -- verified,
        // by asking twice for the model already in force and seeing no hook -- so this is a
        // guard against a payload shape rather than an observed case.
        if (to === '' || from === to) return
        this.#reconfigured.push({ from, to, at: Date.now() })
        this.#emit({
          type: 'error',
          // NOT fatal, and not really an error in the seat -- it is an error in the RECORD. The
          // run report states the launch model as fact and #200 refuses `/model` from the
          // advisor on exactly that ground; this is the same falsification arriving by the door
          // that refusal does not cover, a human typing into the seat's own pane. The seat is
          // fine and the run can continue; what is no longer true is what the report says.
          message:
            `this seat is no longer running the model the run report names: ` +
            `${from} -> ${to}` +
            (d.payload['source'] === undefined ? '' : ` (via ${String(d.payload['source'])})`) +
            `. The launch record is immutable by construction, so it still says ${from}. See #202.`,
          fatal: false,
          seq: this.#next(),
          at: Date.now(),
          provisional: false,
        })
        return
      }
      case 'ConfigChange': {
        // Registered and deliberately not interpreted. `PostModelSwitch` carries named fields
        // this adapter has seen fire and can read; `ConfigChange` was verified present in the
        // bundle but has not been observed, and what it carries is therefore a guess. Reading a
        // name as a behaviour is the mistake #217 made on another agent. It is registered so the
        // deliveries are journalled, which is what the next person needs to map it.
        return
      }
      case 'SubagentStart':
      case 'SubagentStop': {
        this.#onSubagentHook(d)
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
        // Session-level, not turn-level. Recorded as evidence on turns still open.
        for (const t of this.#liveTurns()) {
          this.#apply(t, t.tracker.observeHook('SessionEnd', d.payload), true)
        }
        return
      }
    }
  }

  /**
   * A subagent of this child started, or finished.
   *
   * Deliberately NOT fed to the turn's `TurnVerdictTracker`. A subagent is work INSIDE a turn;
   * it says nothing about how that turn ends, and adding it to the hook evidence list would put
   * a name in the provenance of a verdict it played no part in. What it does say is that the
   * child is alive, and that is carried the same way every other sign of life is -- by being an
   * event `isChildOutput` accepts, which `#emit` acts on without being told twice.
   *
   * ## When only the stop arrives
   *
   * Both events are in `HOOK_EVENTS`, so against a CLI that dispatches them this method sees
   * matched pairs and `outstanding` is a real count. Against one that does not dispatch the
   * start -- Claude Code 2.1.224 -- the key is accepted in silence and never fires, so this
   * method sees stops only, every one of them `unpaired`, `outstanding` never leaves zero, and
   * the console falls back to naming the spawning tool. Both readings are supported on purpose;
   * neither is an error state.
   */
  #onSubagentHook(d: HookDelivery): void {
    // Keyed first. `prompt_id` on a subagent hook is the PARENT turn's -- the hook fires in the
    // parent session, and the subagent's own transcript arrives as a separate field -- so the
    // key names the turn the console is showing. `#latestLiveTurn()` is the fallback for a
    // payload whose key names nothing this adapter armed.
    const turn = this.#turnFor(String(d.turnKey ?? '')) ?? this.#latestLiveTurn()
    // Nothing to attribute it to and nothing showing it, so there is nothing to say. A
    // subagent lifecycle outside any turn of ours is not evidence about a turn of ours.
    if (!turn) return

    const agentId = typeof d.payload.agent_id === 'string' ? d.payload.agent_id : undefined
    const agentType = typeof d.payload.agent_type === 'string' ? d.payload.agent_type : undefined
    const at = Date.now()

    if (d.event === 'SubagentStart') {
      // Required by Claude Code's own payload schema, so its absence means the payload is not
      // one this adapter can pair anything with. Counting it would produce an `outstanding`
      // that no stop can ever bring down -- worse than not counting it, because the console
      // would then be wrong for the rest of the turn rather than merely uninformed.
      if (agentId === undefined) return
      if (turn.subagents.start(agentId) === 'duplicate') return
      this.#emit({
        type: 'subagent_start',
        agentId,
        ...(agentType === undefined ? {} : { agentType }),
        outstanding: turn.subagents.outstanding,
        turnKey: turn.key,
        seq: this.#next(),
        at,
        provisional: false,
      })
      return
    }

    // A stop with no id cannot be deduplicated -- there is nothing to compare -- so a
    // redelivery of one emits twice. It is still emitted: something finished, and saying so
    // with `paired: false` and an unchanged count claims no more than that.
    const change = agentId === undefined ? 'unpaired' : turn.subagents.stop(agentId)
    if (change === 'duplicate') return
    this.#emit({
      type: 'subagent_stop',
      ...(agentId === undefined ? {} : { agentId }),
      ...(agentType === undefined ? {} : { agentType }),
      paired: change === 'stopped',
      outstanding: turn.subagents.outstanding,
      turnKey: turn.key,
      seq: this.#next(),
      at,
      provisional: false,
    })
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

    const completedInTranscript = snap.turns.filter((t) => t.state === 'completed').length

    // Only as many turns as the transcript actually evidences may claim completion.
    let credits = Math.max(0, completedInTranscript - this.#provenCompletedCount())

    const turns = this.#allTurns()
    for (let i = 0; i < turns.length; i++) {
      // Asked once per turn, not once before the loop. Every iteration is separately
      // observable -- it can close a transport and emit a replacement verdict -- and the loop
      // is synchronous, so on a session with many turns the bound can expire partway down it.
      // A single check at the top would then let every remaining turn act on an answer the
      // deadline had already written off, which is the thing the bound promises will not
      // happen. Stopping here leaves the turns already updated updated, and that is honest:
      // each of those was decided while this run was still wanted.
      if (token?.abandoned) return
      const turn = turns[i]!
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
      // The child's own file saying this turn ended is an OBSERVATION of the child, so it may
      // close the transport -- and it must do so BEFORE the update is applied, or the
      // replacement `turn_end` goes out still claiming the child may be running and every
      // consumer of `transportOpen` keeps refusing to send to a turn that is demonstrably over.
      if (recovered) this.#closeTransport(String(turn.key))
      const update = turn.tracker.resetTranscript({
        ...emptyTranscriptState(),
        exists: true,
        hasAssistantAfterPrompt: recovered,
        finalStopReason: recovered ? 'end_turn' : undefined,
      })
      this.#apply(turn, update, true)
    }
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
    // A dead child is executing nothing. The strongest form of an observed stop.
    this.#closeTransport(undefined)
    for (const t of this.#liveTurns()) t.childClosure ??= `the child exited (${reason})`

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

  /**
   * A slash command, typed and submitted, with no turn started (#200).
   *
   * Deliberately NOT `send`, and the list of what it skips is the specification. It takes no
   * `PendingPrompt` claim, so it neither waits for a `UserPromptSubmit` hook nor blocks the
   * next real send; it does not call `#refuseOverlappingSend`, because it is not a prompt and
   * cannot be the overlapping one; it verifies no prompt fidelity, because there is no echoed
   * prompt to compare against; and it hands back nothing, because there is no key.
   *
   * The state guards are `send`'s, unchanged and for the same reason: a session that is
   * quiesced, rotating or closed is not accepting input, and typing at it anyway would put
   * characters into a seat the run believes is out of service.
   *
   * What lands afterwards is the CLI's business and is not observed here -- see `submitRaw`
   * on the seam. It is why the relay records a submission and never an outcome.
   *
   * The CLI DOES dispatch its ordinary prompt hooks for a slash command -- observed, in the
   * first live run that ever issued one (#207). So the adapter sees a turn it did not send,
   * and the text is remembered in `#rawSubmissions` until that echo arrives: unremembered, it
   * was correlated against whatever real send happened to be in flight and killed the run.
   */
  /**
   * Whether this prompt is the echo of a raw submission still waiting for one, consuming it.
   *
   * EXACT on the trimmed text, deliberately. A looser match -- a prefix, or the leading verb --
   * would let a genuine corruption of an instruction be mistaken for a command's echo, which is
   * the failure this whole correlation exists to catch, reintroduced through its exemption.
   */
  #takeRawEcho(prompt: string): boolean {
    const i = this.#rawSubmissions.indexOf(prompt.trim())
    if (i < 0) return false
    this.#rawSubmissions.splice(i, 1)
    return true
  }

  async submitRaw(text: string, detail?: string): Promise<void> {
    if (this.#state !== 'running') {
      throw new Error(`session is ${this.#state}; it is not accepting input`)
    }
    if (!this.acceptsInput) throw new Error('session is not accepting input')
    // BEFORE the keystrokes, not after: the hook for this text can land while `submit` is still
    // resolving, and an echo that arrives before it was recorded is the bug itself.
    this.#rawSubmissions.push(text.trim())
    if (this.#rawSubmissions.length > RAW_ECHO_MEMORY) this.#rawSubmissions.shift()
    await this.#input.submit(text, detail ?? `raw command: ${text.slice(0, 80)}`)
  }

  async send(message: string, _provenance: SendProvenance, budget?: TurnBudget): Promise<TurnKey> {
    if (this.#state !== 'running') {
      throw new Error(`session is ${this.#state}; it is not accepting work`)
    }
    if (!this.acceptsInput) throw new Error('session is not accepting input')
    this.#refuseOverlappingSend()
    // Held for the turn this send is about to open; see `#pendingBudget`.
    this.#pendingBudget = budget

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
          return await this.#submit(message, keyed)
        } catch (e) {
          // Only a corrupted prompt is retried. A hook timeout, a swallowed submit or a dead
          // child are different failures with their own repairs, and typing the message again
          // on top of one of those is how the same prompt gets delivered twice.
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
      // session -- turning one failed prompt into a seat that can never be spoken to again. The
      // turn, if the hook does arrive late, is created by `#onHook` from the hook's own payload
      // and does not need this promise; nothing but this method ever awaited it.
      //
      // By identity, because a resolved send has already had its slot cleared by the hook, and
      // clearing unconditionally here would throw away a claim the NEXT send had made in the
      // meantime -- letting two sends run at once through the guard that exists to stop that.
      if (this.#pendingPrompt === claim) this.#pendingPrompt = undefined
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
  async #recoverForRetry(bad: CorruptedPromptError): Promise<void> {
    const malformed = this.#turnFor(bad.turnKey)
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

    const refuse = (why: string): Error => new Error(promptRetryNotAttempted(bad.mismatch, why))
    const until = Date.now() + this.#recoveryMs

    let timer: NodeJS.Timeout | undefined
    const outcome = await Promise.race([
      this.cancel().then(
        () => 'cancelled' as const,
        (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
      ),
      new Promise<'timeout'>((r) => {
        timer = setTimeout(() => r('timeout'), this.#recoveryMs)
      }),
    ]).finally(() => clearTimeout(timer))

    // A cancellation that has not come back is not a completed one, however likely it is to
    // finish a moment later. It keeps running -- nothing here can stop it -- and the seat is
    // left cancelled and idle, which is the state an operator can send into by hand.
    if (outcome === 'timeout') {
      throw refuse(`the cancellation of turn ${bad.turnKey} had not come back after ${this.#recoveryMs} ms`)
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
        `the child never confirmed that turn ${bad.turnKey} ended: ESC was typed and ${this.#recoveryMs} ms ` +
          `passed with no Stop, no SessionEnd and no exit. Claude Code records an interruption nowhere, so ` +
          `conclave's own note of having sent ESC is not evidence the child stopped -- and it may still be ` +
          `running the fragment`,
      )
    }
    const open = this.#openTurn()
    if (open) throw refuse(`the transport is open again, on turn ${String(open.key)}`)
    if (this.#state !== 'running' || !this.acceptsInput) {
      throw refuse(`the session is ${this.#state} and no longer accepting input`)
    }
  }

  /** The shipped recovery bound unless this session was given another. */
  get #recoveryMs(): number {
    return this.#opts.promptRecoveryMs ?? PROMPT_RECOVERY_MS
  }

  /** The body of `send()`, after the guards and the pending-prompt slot are settled. */
  async #submit(message: string, keyed: Promise<TurnKey>): Promise<TurnKey> {
    // Serialized against cancel() and decidePermission() by the shared queue.
    const before = await this.#promptOccurrences(message)
    await this.#input.submit(message)

    // Did it actually arrive? `submit()` resolving means this process TYPED -- the pty took the
    // bytes -- and says nothing about whether the child turned them into a prompt. Observed on
    // this repository (#120): a second send was typed, never became a prompt, and the failure was
    // reported as a hook problem because nothing had checked. The child's transcript is the
    // independent witness, already parsed and already polled, and it does not depend on the hook
    // path being healthy to answer.
    //
    // The repair is a bare Enter, not a re-send of the text. If the composer holds the message and
    // only the submit keystroke was swallowed, Enter completes it; if the text never landed either,
    // Enter is a no-op on an empty composer. Re-sending the text could not tell those apart and
    // would concatenate in the first case, which is why the verification comes first and the
    // repair is the weaker action rather than the more thorough one.
    // Only when the hook is LATE. A healthy send resolves here in well under a second, and
    // making every send wait for the transcript to catch up would tax the common path to
    // diagnose the rare one -- the transcript settles behind the hook by design, so it is the
    // slower of the two witnesses and must not gate the faster.
    const early = await Promise.race([
      keyed.then(() => 'hooked' as const),
      new Promise<'late'>((r) => setTimeout(() => r('late'), SUBMIT_LANDED_MS)),
    ])
    if (early === 'late' && !(await this.#promptLanded(message, before, 0))) {
      // A modal ate it. Checked before either repair, because both of them type at whatever has
      // focus, and typing a prompt into a settings dialog is how a keystroke gets turned into a
      // configuration change nobody asked for. Esc declines and returns focus to the composer.
      if (dismissableModalVisible(this.#pty?.output ?? '')) {
        await this.#input.cancel('Esc: declining a setup modal that was blocking input')
        this.#emit({
          type: 'error',
          message:
            'declined a Claude Code setup modal that was blocking input (Esc). It was not accepted: it offers to read shell history and other repositories, which is not conclave\'s to agree to.',
          fatal: false,
          seq: this.#next(),
          at: Date.now(),
          provisional: false,
        })
        await new Promise((r) => setTimeout(r, 500))
        await this.#input.submit(message, 're-typed: a setup modal had swallowed the send')
        if (await this.#promptLanded(message, before, SUBMIT_REPAIR_MS)) return await keyed
      }
      await this.#input.submit('', 'bare Enter: prompt had not reached the transcript')
      if (!(await this.#promptLanded(message, before, SUBMIT_REPAIR_MS))) {
        // Now, and only now, re-type the whole message. The two checks above have established
        // what makes this safe: the text is not in the composer, because if it were, the bare
        // Enter would have submitted it and the transcript would show a turn. So there is
        // nothing to concatenate with. Observed live on #120 -- a swallowed second send leaves
        // the composer empty rather than holding an unsubmitted line, so the weaker repair
        // cannot recover it and the stronger one cannot duplicate.
        await this.#input.submit(message, 're-typed: composer was empty after bare Enter')
        if (!(await this.#promptLanded(message, before, SUBMIT_REPAIR_MS))) {
          throw new Error(SEND_NOT_ACCEPTED)
        }
      }
    }

    // Cleared on the way out: the loser of the race is a live 30s timer, and leaving it
    // pending keeps the event loop alive long after the send resolved.
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // The operator is about to be pointed at the attempts journal, so this run keeps its
        // directory. See `#keepRunDir`.
        this.preserveRunDir()
        reject(new Error(SEND_HOOK_TIMEOUT(this.#attemptJournal)))
      }, 30_000)
    })
    try {
      return await Promise.race([keyed, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * How many turns the child's transcript shows whose prompt is EXACTLY this message.
   *
   * `undefined` before the view exists, which is correct rather than convenient: a send before
   * the transcript is readable cannot be verified, and `#promptLanded` treats "cannot see" as
   * "landed" so an unverifiable send behaves exactly as it did before this check existed.
   *
   * A count of matches rather than an index, because the transcript is not append-only from
   * this side of it: a compaction rewrites the view, and an index captured before a send would
   * point somewhere else afterwards. A count of a specific string survives that, and it also
   * gives the right answer for the case an index cannot express -- the same instruction sent
   * twice, where the second send's witness is a SECOND occurrence and not the first one.
   */
  async #promptOccurrences(message: string): Promise<number | undefined> {
    if (!this.#view) return undefined
    try {
      return (await this.#view.snapshot()).turns.filter((t) => t.prompt === message).length
    } catch {
      return undefined
    }
  }

  /**
   * Whether THIS prompt has appeared in the transcript since `before`, polled until `budgetMs`.
   *
   * The count used to be of turns, not of this prompt, and that is a different claim: it says
   * the transcript grew, and a transcript grows for reasons that have nothing to do with the
   * send. The case that matters is the one this check exists for -- a prior turn that ended
   * UNCERTAIN and is in fact still generating. Such a turn goes on appending to the transcript
   * while the new prompt is being typed into a child that is not accepting input, so a
   * turn-count check sees growth, calls the send landed, and hands back the exact false
   * positive #120 was about: the text was swallowed, nothing is wrong with the hooks, and the
   * run is told the child accepted it.
   *
   * Matching the prompt text is what makes the witness independent of the prior turn. Nothing
   * the still-generating turn writes carries the new message as its `prompt`.
   */
  async #promptLanded(message: string, before: number | undefined, budgetMs: number): Promise<boolean> {
    // No baseline means no view, and a check that cannot run must not fail the send.
    if (before === undefined) return true
    const deadline = Date.now() + budgetMs
    for (;;) {
      const now = await this.#promptOccurrences(message)
      if (now === undefined || now > before) return true
      if (Date.now() >= deadline) return false
      await new Promise((r) => setTimeout(r, 400))
    }
  }

  async cancel(): Promise<TurnKey | undefined> {
    const turn = this.#latestLiveTurn()
    await this.#input.cancel(turn ? String(turn.key) : 'no live turn')
    // A completed cancellation: ESC is typed and the input queue has drained, so the child has
    // been told to stop by the only means available. This is the escape from a turn whose `Stop`
    // never arrives -- the transport reopens here and nowhere else, so a seat the watchdog gave
    // up on can be recovered rather than being unsendable for the rest of the run.
    this.#closeTransport(undefined)
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

    const turns = mergeKnownTurns(
      snap.turns,
      this.#order.map((key) => {
        const known = this.#turns.get(key)
        if (!known) return undefined
        return {
          key: known.key,
          prompt: known.prompt,
          assistantText: known.assistantText,
          verdict: known.tracker.verdict,
        }
      }),
    )
    // Spread first, so everything the view said about this projection survives the turn merge
    // -- `builtAt` and `containedFallback` above all. The merge changes what the TURNS are; it
    // does not make an unverified snapshot into a read one, and rotation reads that flag to
    // decide whether the compaction generation in here is evidence.
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
  /**
   * Where the hook client records an attempt it could not deliver (#41).
   *
   * Held so the send-timeout diagnostic can name it by path. Its ABSENCE is the finding: the
   * handler never ran, which under load is the hook's own timeout killing a cold `node` start.
   * Its presence means the handler ran and could not POST, which is a different fault with a
   * different remedy.
   */
  #attemptJournal = ''

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
      // Before either branch: we are done observing, so the deadline stops applying. Left
      // armed it could fire during the awaits below and race the verdict each branch is
      // deliberately choosing.
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
        // Reconcile BEFORE terminating. A verdict already established by stronger evidence
        // must not be replaced by a weaker causal guess just because cleanup killed the
        // process; the classifier's rule order enforces the same thing from the other side.
        await this.#reconcileFromTranscript()
        const exit = await this.#pty.terminate()
        // Anything still live at this point had no verdict from the transcript, and the child is
        // now definitively gone -- `terminate()` escalates to SIGKILL and returns only once it
        // has exited. So the turn ended, and the only honest account of HOW is the child's death.
        //
        // `#onExit` already draws exactly this conclusion, but it is wired fire-and-forget, so
        // nothing orders it against the `#events.close()` below: the verdict it produced could
        // land after the queue had closed and be buffered where no consumer would ever read it.
        // That is #146's race, and `abandonReads` did not close it -- it made the handler FAST,
        // which is not the same as making it ORDERED.
        //
        // Drawn here instead, where it is sequenced. Not duplicated work: the tracker returns
        // `undefined` from an observation that does not change the verdict, so `#onExit` running
        // afterwards emits nothing a second time. And nothing is synthesised, which is the rule
        // #146 sets -- the evidence is the exit this call just awaited, and the classifier grades
        // it. A turn whose outcome was already established by stronger evidence keeps it: process
        // death is rule 4, and the hook and transcript rules are ahead of it.
        for (const turn of this.#liveTurns()) {
          this.#apply(turn, turn.tracker.observeProcess({ alive: false, howEnded: exit.reason }), true)
        }
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

      await this.#receiver.stop()
      this.#state = 'terminated'
    } finally {
      // GIVEN BACK (#203). Measured on one machine: 4,936 `orch-claude-` and 5,207
      // `orch-codex-` directories against a single `orch-kimi-`, which is the adapter that
      // already did this -- 10,143 directories and 55 MB of hook journals and generated
      // settings in a world-readable temp root, one per session ever started.
      //
      // AFTER the receiver stops, so nothing is still writing into it. In the `finally` for the
      // same reason the queue close is: a close that threw anywhere above still gives the
      // directory back, and a leak that only happens on the failing path is the one nobody
      // notices.
      this.#removeRunDir()
      this.#events.close()
    }
  }

  /**
   * Remove the scratch directory, unless its evidence was named to the operator.
   *
   * `force` swallows a directory that is already gone; a failure to remove one that is not is
   * swallowed too, deliberately. This runs while a session is being torn down, often because
   * something else already went wrong, and turning "the temp directory would not delete" into
   * the error a caller sees would bury the reason they are here.
   */
  #removeRunDir(): void {
    if (!this.#runDir || this.#keepRunDir) return
    try {
      rmSync(this.#runDir, { recursive: true, force: true })
    } catch {
      // Left behind. One directory is the cost; masking a teardown failure is not worth it.
    }
    this.#runDir = undefined
  }

  /**
   * Keep the run directory past `close()`, because its contents have been named to a human.
   *
   * Called from the send-timeout path, whose message tells the operator that the attempts
   * journal EXISTING means the handler ran and could not deliver, and its being ABSENT means the
   * handler never executed. Cleanup would make it absent every time and answer that wrongly.
   *
   * A named operation rather than a private flag, so the test for this exercises the same call
   * production makes instead of reaching into the instance.
   */
  preserveRunDir(): void {
    this.#keepRunDir = true
  }

  /** Model switches seen mid-run, oldest first. Empty on a seat nobody reconfigured (#202). */
  get reconfigured(): ReadonlyArray<{ from: string; to: string; at: number }> {
    return this.#reconfigured
  }

  /** Test/diagnostic access. */
  get runDir(): string | undefined {
    return this.#runDir
  }
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
