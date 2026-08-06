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
    const key = turnKey(`${this.sessionId}-turn-${this.#turns.length}`)
    this.#turns.push({ key, prose: this.#replies.shift() ?? '' })
    this.emit({
      type: 'turn_end',
      verdict: { outcome: 'completed', confidence: 'proven', provenance: [{ source: 'hook', detail: 'Stop' }] },
      synthesized: false,
      turnKey: key,
      seq: ++this.#seq,
      at: Date.now(),
      provisional: false,
    })
    return key
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
