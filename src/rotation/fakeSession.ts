/**
 * A scriptable `AgentSession` for the rotation tests.
 *
 * Kept out of the test file because three suites need it, and kept out of the adapters
 * because nothing in the product should be able to import it by accident. It records the
 * lifecycle transitions it was put through, which is most of what rotation's tests are
 * actually asserting: the transaction is a state machine, and "which session ended up
 * alive" is the property that matters.
 */

import type {
  AgentEvent,
  AgentSession,
  CloseMode,
  SessionSnapshot,
  SessionState,
  TurnKey,
} from '../contract/session.ts'
import { guaranteesFor, turnKey } from '../contract/session.ts'

export class FakeRotationSession implements AgentSession {
  readonly guarantees = guaranteesFor('mediated')
  readonly received: string[] = []
  readonly transitions: SessionState[] = []
  closedAs: CloseMode | undefined
  compactionGeneration = 0

  #state: SessionState = 'running'
  #replies: string[]
  #turns: { key: TurnKey; prose: string }[] = []
  #queue: AgentEvent[] = []
  #waiters: ((e: IteratorResult<AgentEvent>) => void)[] = []
  #seq = 0

  // Assigned in the body rather than as parameter properties: `erasableSyntaxOnly` is on,
  // so the build has no transform to desugar them.
  readonly sessionId: string
  readonly agent: string
  /**
   * How long a turn takes before `turn_end`. Default 0 — instantaneous, which is what most
   * tests want. A console test does not: with instant turns the whole run completes before
   * scripted stdin delivers its first line, and the test races itself rather than the code.
   */
  delayMs = 0
  /** Compact when this turn index starts (0-based). Deterministic, unlike a timer. */
  compactOnTurn: number | undefined
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
    this.received.push(message)
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
    if (this.compactOnTurn === index) this.compact()
    if (this.#narration && index > 0) {
      const { blocks, report } = this.#narration
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
    if (this.delayMs > 0) {
      setTimeout(() => this.#endTurn(key), this.delayMs).unref()
      return key
    }
    this.#endTurn(key)
    return key
  }

  #endTurn(key: TurnKey): void {
    this.emit({
      type: 'turn_end',
      verdict: { outcome: 'completed', confidence: 'proven', provenance: [{ source: 'hook', detail: 'Stop' }] },
      synthesized: false,
      turnKey: key,
      seq: ++this.#seq,
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
        state: 'completed' as const,
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
