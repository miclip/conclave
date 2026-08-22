/**
 * A scriptable `AgentSession` for the rotation tests.
 *
 * Kept out of the test file because three suites need it, and kept out of the adapters
 * because nothing in the product should be able to import it by accident. It records the
 * lifecycle transitions it was put through, which is most of what rotation's tests are
 * actually asserting: the transaction is a state machine, and "which session ended up
 * alive" is the property that matters.
 */

import { AsyncQueue } from '../adapters/asyncQueue.ts'
import type { Verdict } from '../contract/outcome.ts'
import type {
  AgentEvent,
  AgentSession,
  CloseMode,
  RevisionEvent,
  SessionSnapshot,
  SessionState,
  TurnKey,
} from '../contract/session.ts'
import { guaranteesFor, turnKey } from '../contract/session.ts'

const COMPLETED: Verdict = {
  outcome: 'completed',
  confidence: 'proven',
  provenance: [{ source: 'hook', detail: 'Stop' }],
}

export class FakeRotationSession implements AgentSession {
  readonly guarantees = guaranteesFor('mediated')
  readonly received: string[] = []
  readonly transitions: SessionState[] = []
  closedAs: CloseMode | undefined
  compactionGeneration = 0
  /**
   * Answer `snapshot()` the way a real adapter does when the transcript will not answer:
   * the last projection it was in a position to build, flagged as unverified.
   *
   * A boolean rather than a wedge because what is under test downstream is what a consumer
   * DOES with the flag, and the machinery that produces it has its own tests over the real
   * view (`transcript/readLease.test.ts`) and the real adapters (`adapters/containedSnapshot.test.ts`).
   */
  containedFallback = false
  /**
   * Make the Nth `send` throw, simulating a transport failure.
   *
   * Real adapters do this when a send is never acknowledged by a hook: the child took the
   * text and nothing came back. It ended a 12-turn run with no verdict and no summary
   * (issue #32), so the relay must be able to be put in that state by a test.
   */
  failSendOnTurn: number | undefined
  /**
   * Tool names to emit as `tool_use` events on each turn.
   *
   * The fake emitted none, so anything keyed to what a participant DID with its turn -- as
   * opposed to what it said -- could not be exercised at all. Subagent detection reads
   * exactly that.
   */
  toolsPerTurn: string[] = []
  /**
   * Called with the prompt as a turn begins, so a test can make the turn DO something.
   *
   * The fake could only ever talk. Anything keyed to a participant changing the tree -- the
   * worktree boundary most of all, where a run with clean trees merges nothing and proves
   * nothing -- had no way to be exercised at all. `DefaultRunFakeSession` in
   * `defaultUnchanged.test.ts` grew the same hook for the same reason; this is that hook on
   * the shared double, so three suites do not each carry a private copy of the session.
   */
  onSend: ((message: string) => void) | undefined

  #state: SessionState = 'running'
  #replies: string[]
  /**
   * `verdict` is set when the turn ends and cleared by a withdrawal, so `snapshot()` can
   * report the GRADE and not just the state. The fake reported neither confidence nor
   * provenance, which meant nothing keyed to how strongly a verdict was evidenced could be
   * exercised at all -- the status file and the run report both carry those fields, and a
   * test built on this session could only ever assert that the key existed.
   */
  #turns: { key: TurnKey; prose: string; verdict?: Verdict | undefined }[] = []
  /**
   * The one delivery mechanism, shared with the adapters rather than reimplemented.
   *
   * Every double in this project used to carry its own copy of a single-consumer queue, and every
   * copy had the same hole: nothing ended the iteration, so a consumer's `for await` parked
   * forever after `close()`. `AgentSession.events()` is required to END once `close()` has
   * returned -- `Relay.stop()` waits for exactly that before it calls a turn abandoned (#143) --
   * and a double that cannot do it is a double that cannot be stopped.
   */
  #events = new AsyncQueue<AgentEvent>()
  #seq = 0

  // Assigned in the body rather than as parameter properties: `erasableSyntaxOnly` is on,
  // so the build has no transform to desugar them.
  readonly sessionId: string
  readonly agent: string
  /**
   * Optional child pid, so tests can exercise the console's liveness guard without a real
   * adapter. Set by the test; the fake itself has no child process.
   */
  childPid?: number
  /**
   * How long a turn takes before `turn_end`. Default 0 — instantaneous, which is what most
   * tests want. A console test does not: with instant turns the whole run completes before
   * scripted stdin delivers its first line, and the test races itself rather than the code.
   */
  delayMs = 0
  /** Compact when this turn index starts (0-based). Deterministic, unlike a timer. */
  compactOnTurn: number | undefined
  /**
   * Hold this turn open until `releaseTurn()` instead of ending it, indexed like the two above.
   *
   * `delayMs` is the only other way to keep a turn in flight, and it is a race dressed as a
   * fixture: a test that needs one seat still working while something happens to another seat
   * has to pick a number bigger than everything that follows, and it is correct only for as
   * long as that guess holds. One of them was a ten-second turn that had to outlast an
   * eleven-second pause -- true on the machine it was written on, and an untraceable
   * intermittent everywhere else.
   *
   * The turn STARTS normally: `turn_start` is emitted, tools are emitted, the dispatcher
   * assigns the seat and marks the task running. Only `turn_end` is withheld, which is exactly
   * the state a long real turn is in, and `Relay#exchange` polls for that event with no timeout
   * of its own -- so the hold is bounded by the test and by nothing else.
   */
  holdTurn: number | undefined
  /** The withheld `#endTurn` call, present only while a turn is being held. */
  #held: (() => void) | undefined

  /**
   * Whether a turn is being held right now.
   *
   * Exported as state rather than left implicit, because it is also the cleanest proof a test
   * has that the child was sent work and has not been allowed to answer -- `session.state` says
   * `running` whether or not a turn is in flight, so it cannot say this.
   */
  get holding(): boolean {
    return this.#held !== undefined
  }

  /**
   * End the held turn now.
   *
   * Throws when nothing is held, deliberately: a release that silently does nothing would let
   * a test believe it had unblocked a turn that was never blocked -- which is the same test
   * passing for the wrong reason, one layer down from the race this exists to remove.
   */
  releaseTurn(): void {
    const end = this.#held
    if (!end) throw new Error(`${this.sessionId} has no held turn to release`)
    this.#held = undefined
    end()
  }
  /**
   * Narration blocks emitted as `message` deltas during the turn, then a closing report.
   * The two have different audiences and the console must show that; see repl/session.ts.
   */
  #narration: { blocks: string[]; report: string } | undefined
  narrate(blocks: string[], report: string): void {
    this.#narration = { blocks, report }
  }

  constructor(sessionId: string, agent: string, replies: string[] = []) {
    this.sessionId = sessionId
    this.agent = agent
    this.#replies = [...replies]
  }

  get state(): SessionState {
    return this.#state
  }

  #to(s: SessionState): void {
    this.#state = s
    this.transitions.push(s)
  }

  async send(message: string): Promise<TurnKey> {
    if (this.#state !== 'running') {
      throw new Error(`cannot send to a session in state '${this.#state}'`)
    }
    if (this.failSendOnTurn !== undefined && this.#turns.length === this.failSendOnTurn) {
      throw new Error('no UserPromptSubmit hook after send')
    }
    this.received.push(message)
    this.onSend?.(message)
    const index = this.#turns.length
    const key = turnKey(`${this.sessionId}-turn-${index}`)
    this.#turns.push({ key, prose: this.#replies.shift() ?? '' })
    // Real adapters emit this; the fake did not, so anything keyed to a turn beginning was
    // never exercised — including the console's status line.
    this.emit({
      type: 'turn_start',
      prompt: message,
      turnKey: key,
      seq: ++this.#seq,
      at: Date.now(),
      provisional: false,
    })
    for (const tool of this.toolsPerTurn) {
      this.emit({
        type: 'tool_use',
        tool,
        input: undefined,
        turnKey: key,
        seq: ++this.#seq,
        at: Date.now(),
        provisional: false,
      })
    }
    if (this.compactOnTurn === index) this.compact()
    if (this.#narration && index > 0) {
      const { blocks, report } = this.#narration
      // One-shot. A real participant does not repeat the same narration verbatim on a later
      // turn, and replaying it made the closing message appear twice once the relay started
      // asking a closing question -- which read as the console double-printing it.
      this.#narration = undefined
      const step = Math.max(1, Math.floor(this.delayMs / (blocks.length + 2)))
      blocks.forEach((text, n) => {
        setTimeout(
          () => this.emit({ type: 'message', role: 'assistant', text, seq: ++this.#seq, at: Date.now(), provisional: true }),
          step * (n + 1),
        ).unref()
      })
      // The closing message arrives as a delta too — the console must hold it back.
      setTimeout(
        () => this.emit({ type: 'message', role: 'assistant', text: report, seq: ++this.#seq, at: Date.now(), provisional: true }),
        step * (blocks.length + 1),
      ).unref()
      this.#turns[index]!.prose = report
    }
    // Held before the timer is consulted: a turn cannot be both gated and scheduled, and the
    // gate is the stronger statement of the two.
    if (this.holdTurn === index) {
      this.#held = () => this.#endTurn(key, index)
      return key
    }
    if (this.delayMs > 0) {
      setTimeout(() => this.#endTurn(key, index), this.delayMs).unref()
      return key
    }
    this.#endTurn(key, index)
    return key
  }

  /**
   * How one turn ends, when `completed` is not what the test needs. Indexed by turn like
   * `compactOnTurn` and for the same reason — the implementer's turn 0 is the briefing, so
   * the first turn that does work is 1, and a test that means that should say so.
   *
   * `withdraw` fires a late signal the instant the verdict is reported. Deliberately not a
   * timer: it reproduces the window the relay actually loses the race in — between
   * `turn_end` and the relay's own reading of it, across the transcript settle wait — and
   * does it deterministically, which a `setTimeout` racing a 250ms poll would not.
   */
  endTurn:
    | {
        index: number
        verdict: Verdict
        withdraw?: 'no_replacement' | Verdict
        /**
         * Which revision reason the withdrawal carries. `late_signal` unless a test says
         * otherwise, because that is the spelling the ADAPTERS produce: `Claude#apply` and
         * Codex's equivalent both emit `reason: 'late_signal'` when a verdict is withdrawn.
         *
         * `'compaction'` is the other one worth writing, and it is not synthetic. The reason
         * comes from the transcript layer rather than an adapter: `TranscriptSessionView` emits
         * it two ways, and only one of them can withdraw anything.
         *
         *   - a transcript that DECLARES a compaction yields `replaces: []`
         *     (`src/transcript/reconcile.ts:679`), which withdraws nothing;
         *   - a rewrite yields `reason: fresh > 0 ? 'compaction' : 'rewrite'`
         *     (`src/transcript/reconcile.ts:593`) over whatever it found already emitted
         *     (`src/transcript/reconcile.ts:594`).
         *
         * So `compaction` WITH a withdrawal is one shape rather than a guarantee of the rewrite
         * path: a fresh compaction marker, and a verdict already emitted for the rewrite to
         * find. That shape is #66 -- the evidence a verdict rested on is no longer in the file,
         * so the claim goes with it. A rewrite with no fresh marker is `'rewrite'`, and one that
         * finds nothing emitted replaces nothing, neither of which is this case.
         *
         * Nothing downstream branches on the reason -- the relay matches a revision by the
         * sequence it replaces -- which is what a test asserting the compaction case has to be
         * able to show, and what the console test above shows end to end.
         */
        withdrawReason?: RevisionEvent['reason']
      }
    | undefined

  /** Seq of the last `turn_end`, so a revision can withdraw it by number as the adapters do. */
  #lastEndSeq: number | undefined
  #lastKey: TurnKey | undefined

  #endTurn(key: TurnKey, index: number): void {
    const scripted = this.endTurn?.index === index ? this.endTurn : undefined
    this.#lastKey = key
    this.#lastEndSeq = ++this.#seq
    const verdict = scripted?.verdict ?? COMPLETED
    // The same verdict the event carries, kept where `snapshot()` can find it. The two
    // sides of the seam must agree: `events()` is revisable and `snapshot()` is canonical,
    // but they are not allowed to describe different turns.
    const turn = this.#turns[index]
    if (turn) turn.verdict = verdict
    this.emit({
      type: 'turn_end',
      verdict,
      synthesized: false,
      turnKey: key,
      seq: this.#lastEndSeq,
      at: Date.now(),
      provisional: false,
    })
    if (scripted?.withdraw) {
      this.lateSignal(
        scripted.withdraw === 'no_replacement' ? 'none' : scripted.withdraw,
        scripted.withdrawReason ?? 'late_signal',
      )
    }
  }

  /**
   * A late signal that withdraws the last `turn_end` and optionally replaces it — the shape
   * the adapters emit from `#apply`, including withdrawal BY SEQUENCE NUMBER, which is what
   * lets a consumer match the revision to the verdict it retracts.
   *
   * `'none'` is the `resetTranscript` case: the verdict is gone and the turn is open again.
   * A sentinel rather than `undefined`, which a default parameter cannot distinguish from
   * an omitted argument.
   */
  lateSignal(replacement: Verdict | 'none' = COMPLETED, reason: RevisionEvent['reason'] = 'late_signal'): void {
    if (this.#lastEndSeq === undefined) throw new Error('no turn_end to withdraw')
    this.emit({
      type: 'revision',
      reason,
      replaces: [this.#lastEndSeq],
      provenance: [
        reason === 'compaction'
          ? { source: 'transcript', detail: 'the transcript no longer holds the evidence the verdict rested on' }
          : { source: 'hook', detail: 'stronger evidence superseded the reported verdict' },
      ],
      seq: ++this.#seq,
      at: Date.now(),
      provisional: false,
    })
    this.#lastEndSeq = undefined
    // Withdrawn in the snapshot too, and not only in the stream: `'none'` is the
    // `resetTranscript` case, where the verdict is gone and the turn is open again.
    const withdrawn = this.#turns.find((t) => t.key === this.#lastKey)
    if (withdrawn) withdrawn.verdict = replacement === 'none' ? undefined : replacement
    if (replacement === 'none') return
    this.#lastEndSeq = ++this.#seq
    this.emit({
      type: 'turn_end',
      verdict: replacement,
      synthesized: false,
      ...(this.#lastKey === undefined ? {} : { turnKey: this.#lastKey }),
      seq: this.#lastEndSeq,
      at: Date.now(),
      provisional: false,
    })
  }

  /**
   * A `turn_start` the child is SEEN making, after the relay has stopped dispatching to it.
   *
   * The counterpart to `endTurnLate` for the other end of a turn. `send` is the only other way
   * to open one and it is the relay's to call, so a test that needs the child observed
   * beginning a turn while the run is PAUSED -- nothing is being dispatched, and the console is
   * about to decide whether it may send -- has no other lever.
   *
   * That state is not hypothetical: a watchdog calls a long turn `timed_out`, a late signal
   * withdraws the verdict, and the child, which was working all along, starts its next turn.
   * Under #66 the withdrawal alone would wave `/continue` through; a `turn_start` after it is
   * an OBSERVATION and puts the guard back (`ActiveTurn.withdrawn`), and the difference is only
   * testable if a fixture can produce one.
   *
   * Registered as a turn like any other, so `endTurnLate` ends THIS one: a `turn_end` carrying
   * an older key belongs to an earlier turn, and `activeTurn` is right to leave the open turn
   * open when it sees one.
   */
  startTurnLate(prompt = 'still going'): TurnKey {
    const key = turnKey(`${this.sessionId}-turn-${this.#turns.length}`)
    this.#turns.push({ key, prose: '' })
    this.emit({
      type: 'turn_start',
      prompt,
      turnKey: key,
      seq: ++this.#seq,
      at: Date.now(),
      provisional: false,
    })
    return key
  }

  /**
   * A `turn_end` arriving late for the turn that is currently open.
   *
   * The counterpart to `lateSignal` for the case it cannot express: after a withdrawal with no
   * replacement, `#lastEndSeq` is cleared and `lateSignal` refuses to run again -- deliberately,
   * since there is no longer a verdict to withdraw. But the turn is open, and the thing that
   * happens next in the real world is that it ends. Nothing could say so (#117).
   *
   * Not `completed` by default: a completed replacement is the one outcome that makes the
   * console's `/continue` bypass its guard entirely, so a fixture reaching for "the turn ended"
   * would silently be testing the bypass instead.
   */
  endTurnLate(verdict: Verdict = { outcome: 'cancelled', confidence: 'proven', provenance: [{ source: 'hook', detail: 'Stop' }] }): void {
    const turn = this.#turns.at(-1)
    if (!turn) throw new Error(`${this.sessionId} has no turn to end`)
    turn.verdict = verdict
    // The snapshot key moves with the stream. `lateSignal` withdraws by SEQUENCE and mutates the
    // turn named by `#lastKey`; leaving an older key here would have it rewrite a turn the
    // withdrawal is not about.
    this.#lastKey = turn.key
    this.#lastEndSeq = ++this.#seq
    this.emit({
      type: 'turn_end',
      verdict,
      synthesized: false,
      turnKey: turn.key,
      seq: this.#lastEndSeq,
      at: Date.now(),
      provisional: false,
    })
  }

  /** Push an event to whichever reader is waiting, or queue it. Single-consumer, as ever. */
  emit(e: AgentEvent): void {
    this.#events.push(e)
  }

  /** Simulate a compaction: both the snapshot generation and the live revision event. */
  compact(): void {
    this.compactionGeneration += 1
    this.emit({
      type: 'revision',
      reason: 'compaction',
      replaces: [],
      provenance: [
        { source: 'transcript', detail: 'transcript prefix changed; history was rewritten' },
        { source: 'transcript', detail: 'transcript declares a compaction' },
      ],
      seq: ++this.#seq,
      at: Date.now(),
      provisional: false,
    })
  }

  /** The reply to the most recent send. The tests' stand-in for `Relay#exchange`. */
  lastProse(): string {
    return this.#turns.at(-1)?.prose ?? ''
  }

  async quiesce(): Promise<void> {
    if (this.#state === 'terminated') throw new Error('cannot quiesce a terminated session')
    this.#to('quiesced')
  }

  async unquiesce(): Promise<void> {
    if (this.#state === 'terminated') throw new Error('cannot unquiesce a terminated session')
    this.#to('running')
  }

  /**
   * Make `beginRotation()` reject without moving the state, as a real adapter can.
   *
   * The transition is not just a field assignment on a real session -- it is announced over the
   * same transport as everything else -- so it can fail on a session that quiesced perfectly
   * well a moment earlier. That is the one failure with both a frozen original and a started
   * replacement live at once, and it cannot be provoked through the state machine alone.
   */
  beginRotationThrows: string | undefined

  async beginRotation(): Promise<void> {
    if (this.beginRotationThrows) throw new Error(this.beginRotationThrows)
    if (this.#state !== 'quiesced') {
      throw new Error(`cannot begin rotation from '${this.#state}': quiesce the session first`)
    }
    this.#to('rotating')
  }

  async cancel(): Promise<TurnKey | undefined> {
    return undefined
  }

  async decidePermission(): Promise<void> {}

  events(): AsyncIterable<AgentEvent> {
    return this.#events
  }

  async snapshot(): Promise<SessionSnapshot> {
    return {
      sessionId: this.sessionId,
      agent: this.agent,
      cwd: process.cwd(),
      turns: this.#turns.map((t) => ({
        key: t.key,
        prompt: '',
        // A turn with no verdict yet still reads `completed`, as it always has. Reporting
        // `in_progress` would be more faithful, and it would also put every test using a
        // delayed fake through the relay's transcript settle loop -- a real behaviour
        // change to unrelated suites, made as a side effect of teaching the fake to grade.
        state: t.verdict?.outcome ?? ('completed' as const),
        confidence: t.verdict?.confidence,
        provenance: t.verdict?.provenance,
        assistantText: t.prose,
        toolCalls: [],
      })),
      guarantees: this.guarantees,
      compactionGeneration: this.compactionGeneration,
      builtAt: Date.now(),
      ...(this.containedFallback ? { containedFallback: true } : {}),
    }
  }

  async fork(): Promise<AgentSession> {
    throw new Error('not implemented')
  }

  /**
   * Make `close()` reject with the state ALREADY `terminated`.
   *
   * NOT an adapter reproduction, and it must not be read as one. All four adapters assign
   * `#state = 'terminated'` as the last statement of their `try`, and the only thing past it is
   * the `finally` that ends the event queue -- which cannot throw. So no adapter in this tree
   * can reject from this position at all; `closeThrowsBeforeTerminated` is the one that models
   * what they do. What a real adapter CAN do is reject from a close, and #143 is about the
   * consequence this field was originally added for: the event queue has to end however the
   * close went, and the relay has to drain it before abandoning a turn, or a verdict already in
   * flight is thrown away by the teardown that provoked it. That property does not depend on
   * where in the close the rejection happened, which is why the older caller can use this one.
   *
   * It is kept because it is a legal `AgentSession`. Nothing in `contract/session.ts` requires
   * an adapter to record `terminated` last, an embedder's adapter may not, and one of ours may
   * stop doing so in a refactor nobody thinks of as behavioural. What the position exposes is a
   * state-machine edge rather than an adapter bug: the session is gone and says so, so anything
   * reaching for `unquiesce()` on the strength of the rejection is reaching for a transition
   * that will be refused -- and the code that reached for it did not survive the refusal.
   */
  closeThrows: string | undefined

  /**
   * Make `close()` reject with the transport gone but `terminated` NOT yet recorded.
   *
   * This is the ordering all four adapters have, established by reading them. `#state =
   * 'terminated'` is the last statement of the `try`, after the pty has been terminated, the
   * receiver stopped and -- on `kimi` -- the generated run directory removed. Every one of those
   * can reject, and when one does the session is left holding whatever state it had when
   * `close()` was entered: `rotating`, on the only path that closes a session mid-transaction.
   * So this, not `closeThrows`, is what a real close failure looks like from outside.
   *
   * Which of those steps rejected is not modelled, and cannot be: this fixture reproduces the
   * ONE sub-case where the rejecting step had already done its work, so `transportDisposed` is
   * set before the throw. A real close could equally have rejected AT the terminate with the
   * transport untouched. Both leave the same state and the same rejection, which is the whole
   * problem -- see `transportDisposed` and `rotated_cleanup_failed` in `rotation/rotate.ts`.
   *
   * The state is then a lie in the direction that matters. `rotating` and `quiesced` both accept
   * `unquiesce()`, so a rollback reached from here is told the original is back in service by a
   * session that cannot answer. Nothing about `state` can see that, which is what
   * `transportDisposed` is for -- and neither field can say whether the CHILD survived, because
   * a step that rejects may have completed its work first (see #146).
   */
  closeThrowsBeforeTerminated: string | undefined

  /**
   * Reject `close()` mid-teardown with a value that is NOT an `Error`.
   *
   * Wrapped in an object so `{ value: undefined }` is expressible: `throw undefined` is the case
   * that matters, because `(err as Error).message` on it is `undefined`, and a consumer using
   * that message as its "did the close fail" flag reads the failure as a clean success. A bare
   * `unknown` field could not say the difference between "throw undefined" and "not set".
   *
   * Not a hypothetical shape. A rejected promise carries whatever it was rejected with, and the
   * layers under an adapter -- node-pty, a fetch, an HTTP server's `close` callback -- are not
   * all obliged to reject with an `Error`.
   */
  closeRejectsWith: { value: unknown } | undefined

  /**
   * A TEST FACT: this fixture's teardown ran, whatever `state` says.
   *
   * Not a general claim about closes, and specifically not the claim that a real close which
   * rejects has disposed of its transport. It has not necessarily done anything -- the
   * rejection may have come FROM the terminate. What this fixture reproduces is the other
   * sub-case, the one that is invisible from outside: the step that rejected had already done
   * its work, so the transport is gone and the state was never updated to say so.
   *
   * That sub-case is worth a fixture because it is the one where `state` actively misleads.
   * The adapters record `terminated` LAST, so `state` still reads `rotating`, `unquiesce()`
   * accepts `rotating`, and a rollback is told the original is back in service by a session
   * with nothing behind it. A test asserting only `state` would accept that. This field is how
   * such a test says "and there was nothing left to restore" -- a statement about the fixture it
   * set up, never evidence a consumer could have read.
   *
   * Nothing in production reads it, and nothing should: the whole point of
   * `rotated_cleanup_failed` is that no consumer CAN know this.
   */
  transportDisposed = false

  async close(mode: CloseMode = 'graceful'): Promise<void> {
    this.closedAs = mode
    try {
      // Teardown first, then the state, in that order -- the adapters' order, and the reason a
      // failed close is not the same thing as a session that is still there.
      //
      // Unconditional, which is a fixture choice rather than a model of every close: it puts
      // this double in the sub-case where the teardown completed and the rejection came after.
      // A close that rejected AT the terminate is equally real and leaves the same state; it is
      // simply not what any test here needs to set up. See `transportDisposed`.
      this.transportDisposed = true
      if (this.closeRejectsWith) throw this.closeRejectsWith.value
      if (this.closeThrowsBeforeTerminated) throw new Error(this.closeThrowsBeforeTerminated)
      this.#to('terminated')
      if (this.closeThrows) throw new Error(this.closeThrows)
    } finally {
      // The stream ENDS with the session, which is the half of the contract every one of these
      // doubles used to omit, and it ends however the close went. See `#events`.
      this.#events.close()
    }
  }
}

/** The `exchange` rotation is given: send, then read back the scripted reply. */
export async function fakeExchange(session: AgentSession, text: string): Promise<string> {
  await session.send(text, { kind: 'peer_relay' })
  return (session as FakeRotationSession).lastProse()
}
