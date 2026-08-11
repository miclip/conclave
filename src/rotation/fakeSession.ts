/**
 * A scriptable `AgentSession` for the rotation tests.
 *
 * Kept out of the test file because three suites need it, and kept out of the adapters
 * because nothing in the product should be able to import it by accident. It records the
 * lifecycle transitions it was put through, which is most of what rotation's tests are
 * actually asserting: the transaction is a state machine, and "which session ended up
 * alive" is the property that matters.
 */

import type { Verdict } from '../contract/outcome.ts'
import type {
  AgentEvent,
  AgentSession,
  CloseMode,
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
  #queue: AgentEvent[] = []
  #waiters: ((e: IteratorResult<AgentEvent>) => void)[] = []
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
  endTurn: { index: number; verdict: Verdict; withdraw?: 'no_replacement' | Verdict } | undefined

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
      this.lateSignal(scripted.withdraw === 'no_replacement' ? 'none' : scripted.withdraw)
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
  lateSignal(replacement: Verdict | 'none' = COMPLETED): void {
    if (this.#lastEndSeq === undefined) throw new Error('no turn_end to withdraw')
    this.emit({
      type: 'revision',
      reason: 'late_signal',
      replaces: [this.#lastEndSeq],
      provenance: [{ source: 'hook', detail: 'stronger evidence superseded the reported verdict' }],
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

  /** Push an event to whichever reader is waiting, or queue it. Single-consumer, as ever. */
  emit(e: AgentEvent): void {
    const w = this.#waiters.shift()
    if (w) w({ value: e, done: false })
    else this.#queue.push(e)
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

  async beginRotation(): Promise<void> {
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
    const self = this
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<AgentEvent>>((resolve) => {
            const item = self.#queue.shift()
            if (item) resolve({ value: item, done: false })
            else self.#waiters.push(resolve)
          }),
      }),
    }
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
    }
  }

  async fork(): Promise<AgentSession> {
    throw new Error('not implemented')
  }

  async close(mode: CloseMode = 'graceful'): Promise<void> {
    this.closedAs = mode
    this.#to('terminated')
  }
}

/** The `exchange` rotation is given: send, then read back the scripted reply. */
export async function fakeExchange(session: AgentSession, text: string): Promise<string> {
  await session.send(text, { kind: 'peer_relay' })
  return (session as FakeRotationSession).lastProse()
}
