/**
 * Relay routing and the audit trail behind restricted asides.
 *
 * Fake sessions rather than live agents: this is about who saw what, which is
 * deterministic and belongs in the offline suite. The live behaviour of the adapters is
 * covered by their own acceptance suites.
 *
 * The aside tests exercise the hazard rather than the string. Asserting that `say()`
 * appends to a log proves nothing — the point of the label is that a human reading the
 * log afterwards can tell genuine model disagreement from disagreement manufactured by
 * unequal context.
 *
 *   node --test src/relay/relay.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import type {
  AgentEvent,
  AgentSession,
  CloseMode,
  SessionSnapshot,
  TurnKey,
} from '../contract/session.ts'
import { guaranteesFor, turnKey } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { Relay } from './relay.ts'
import { outranks } from './message.ts'

/** Records everything it was sent and replies with scripted prose. */
class FakeSession implements AgentSession {
  readonly guarantees = guaranteesFor('mediated')
  readonly received: string[] = []
  #replies: string[]
  #turns: { key: TurnKey; prose: string }[] = []
  #queue: AgentEvent[] = []
  #waiters: ((e: IteratorResult<AgentEvent>) => void)[] = []
  #seq = 0
  closedAs: CloseMode | undefined
  // Declared explicitly rather than as constructor parameter properties: erasableSyntaxOnly
  // rejects those, since native type stripping cannot erase them.
  readonly agent: string
  readonly sessionId: string

  constructor(agent: string, sessionId: string, replies: string[]) {
    this.agent = agent
    this.sessionId = sessionId
    this.#replies = [...replies]
  }

  async send(message: string): Promise<TurnKey> {
    this.received.push(message)
    const key = turnKey(`${this.sessionId}-turn-${this.#turns.length}`)
    const prose = this.#replies.shift() ?? '(no further scripted reply)'
    this.#turns.push({ key, prose })
    this.#emit({
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

  #emit(e: AgentEvent): void {
    const w = this.#waiters.shift()
    if (w) w({ value: e, done: false })
    else this.#queue.push(e)
  }

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
      cwd: '/tmp',
      turns: this.#turns.map((t) => ({
        key: t.key,
        prompt: '',
        state: 'completed' as const,
        assistantText: t.prose,
        toolCalls: [],
      })),
      guarantees: this.guarantees,
      compactionGeneration: 0,
      builtAt: Date.now(),
    }
  }

  async cancel(): Promise<TurnKey | undefined> {
    return undefined
  }
  async decidePermission(): Promise<void> {}
  async fork(): Promise<AgentSession> {
    throw new Error('not implemented')
  }
  async close(mode: CloseMode = 'graceful'): Promise<void> {
    this.closedAs = mode
  }
}

function registryWith(sessions: Record<string, FakeSession>): AgentRegistry {
  const r = new AgentRegistry()
  for (const [agent, session] of Object.entries(sessions)) {
    r.register({
      id: agent,
      displayName: agent,
      capabilities: {
        agent,
        readinessSignal: 'unknown',
        turnKeySource: 'prompt_id',
        outcomes: {
          completed: 'observed',
          cancelled: 'reasoned_but_unverified',
          permission_refused: 'reasoned_but_unverified',
          process_exited: 'reasoned_but_unverified',
          timed_out: 'reasoned_but_unverified',
          transport_lost: 'reasoned_but_unverified',
          unknown_abnormal_end: 'reasoned_but_unverified',
        },
      },
      launch: { command: agent, baseArgs: [] },
      async create() {
        return session
      },
    })
  }
  return r
}

async function twoParty(leadReplies: string[], implReplies: string[]) {
  const lead = new FakeSession('fake-lead', 'lead-1', leadReplies)
  const impl = new FakeSession('fake-impl', 'impl-1', implReplies)
  const relay = await Relay.start({
    registry: registryWith({ 'fake-lead': lead, 'fake-impl': impl }),
    cwd: '/tmp',
    lead: { id: 'advisor', agent: 'fake-lead', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'fake-impl', role: 'implementer' },
    maxRounds: 3,
  })
  return { relay, lead, impl }
}

// --- visibility ---------------------------------------------------------------------

test('ordinary point-to-point relay traffic is NOT restricted', async () => {
  // The bug the first live run exposed: visibility derived from recipient count marked
  // every advisor instruction as hidden influence, which makes the label worthless.
  const { relay } = await twoParty(['do the thing', 'DONE'], ['done it'])
  await relay.run('a goal')

  const instruction = relay.log.find((m) => m.kind === 'instruction')!
  assert.equal(instruction.to.length, 1, 'an instruction reaches exactly one participant')
  assert.equal(instruction.visibility, 'normal', 'and that is entirely ordinary')
  assert.deepEqual(instruction.excluded, [])

  const report = relay.log.find((m) => m.kind === 'report')!
  assert.equal(report.visibility, 'normal')

  assert.deepEqual(relay.audit(), [], 'nothing was withheld, so the audit is empty')
})

test('orchestrator notes are internal, never participant speech', async () => {
  const { relay } = await twoParty(['DONE'], [])
  await relay.run('a goal')
  const notes = relay.log.filter((m) => m.kind === 'note')
  assert.ok(notes.length > 0)
  for (const n of notes) {
    assert.equal(n.visibility, 'internal')
    assert.deepEqual(n.to, [], 'internal state is delivered to nobody')
  }
})

test('a human message to everyone is normal, not restricted', async () => {
  const { relay } = await twoParty(['DONE'], [])
  const m = relay.say('applies to both of you', 'all')
  assert.equal(m.visibility, 'normal')
  assert.deepEqual(m.excluded, [])
})

// --- the restricted aside, end to end ------------------------------------------------

test('a restricted aside reaches only its recipient, once, and is auditable', async () => {
  const { relay, lead, impl } = await twoParty(
    ['first instruction', 'second instruction', 'DONE'],
    ['first report', 'second report', 'third report'],
  )

  // 1. a normal exchange is under way
  const aside = relay.say('we have already ruled out Postgres', { only: 'implementer' }, 'aside')

  // 5. the log marks it restricted and names who was excluded
  assert.equal(aside.visibility, 'restricted')
  assert.deepEqual(aside.to, ['implementer'])
  assert.deepEqual(aside.excluded, ['advisor'])

  await relay.run('a goal')

  // 3. drained exactly once into the next implementer turn
  const carrying = impl.received.filter((r) => r.includes('ruled out Postgres'))
  assert.equal(carrying.length, 1, 'delivered exactly once')
  assert.ok(
    carrying[0]!.includes('FROM THE HUMAN'),
    'and at human privilege, not as advisor prose',
  )

  // 4. the advisor never receives it, directly or by relay
  assert.equal(
    lead.received.filter((r) => r.includes('ruled out Postgres')).length,
    0,
    'the excluded participant must never see it through any path',
  )

  // 6. later exchanges do not replay it
  assert.ok(impl.received.length > 1, 'there were later turns to replay into')
  for (const later of impl.received.slice(carrying.length + 1)) {
    assert.ok(!later.includes('ruled out Postgres'), 'an aside is not re-sent every turn')
  }

  // 7. a subsequent disagreement is attributable to asymmetric information
  const report = relay.log.find((m) => m.kind === 'report')!
  const asym = relay.asymmetryAt(report.seq)
  assert.deepEqual(asym.informed, ['implementer'])
  assert.deepEqual(asym.excluded, ['advisor'])

  const entry = relay.audit()[0]!
  assert.equal(entry.seq, aside.seq)
  assert.deepEqual(entry.excluded, ['advisor'])
  assert.ok(entry.text.includes('Postgres'), 'the audit records what was withheld, not just that something was')
})

test('with nothing withheld, a disagreement cannot be blamed on us', async () => {
  // The other half of the same property: the audit must not manufacture an explanation
  // for a disagreement that was genuinely about the work.
  const { relay } = await twoParty(['instruction', 'DONE'], ['I disagree, and here is why'])
  await relay.run('a goal')
  const report = relay.log.find((m) => m.kind === 'report')!
  const asym = relay.asymmetryAt(report.seq)
  assert.deepEqual(asym.informed, [])
  assert.deepEqual(asym.excluded, [])
})

// --- rank and routing ----------------------------------------------------------------

test('rank is legible in what a participant actually receives', async () => {
  const { relay, impl } = await twoParty(['do the thing', 'DONE'], ['done it'])
  await relay.run('a goal')
  const instruction = impl.received.find((r) => r.includes('do the thing'))!
  assert.ok(instruction.includes('FROM THE ADVISOR'), 'the source must be named')
  assert.ok(
    instruction.includes('peer AI model, not your user'),
    "an unattributed instruction would carry the human's authority and stop pushback",
  )
  assert.ok(instruction.includes('You may disagree'))
})

test('rank ordering is human > advisor > implementer', () => {
  assert.ok(outranks('human', 'advisor'))
  assert.ok(outranks('advisor', 'implementer'))
  assert.ok(outranks('human', 'implementer'))
  assert.ok(!outranks('implementer', 'advisor'))
})

test('DONE and ESCALATE hand back to the human rather than being acted on', async () => {
  const done = await twoParty(['DONE'], [])
  assert.equal((await done.relay.run('goal')).reason, 'done')

  const esc = await twoParty(['ESCALATE: the tests contradict the goal'], [])
  const outcome = await esc.relay.run('goal')
  assert.equal(outcome.reason, 'escalated')
  assert.ok(outcome.detail?.includes('contradict'))
})

test('the round budget stops an unbounded loop', async () => {
  const { relay } = await twoParty(
    ['a', 'b', 'c', 'd', 'e', 'f'],
    ['1', '2', '3', '4', '5', '6'],
  )
  assert.equal((await relay.run('goal')).reason, 'budget')
})

test('an unknown recipient is rejected rather than silently dropped', async () => {
  const { relay } = await twoParty(['DONE'], [])
  assert.throws(() => relay.say('hello', { only: 'nobody' }), /unknown participant/)
})

test('stopping closes every session gracefully', async () => {
  const { relay, lead, impl } = await twoParty(['DONE'], [])
  await relay.stop()
  assert.equal(lead.closedAs, 'graceful')
  assert.equal(impl.closedAs, 'graceful')
})
