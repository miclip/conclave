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
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type {
  AgentEvent,
  AgentSession,
  CloseMode,
  SessionSnapshot,
  SessionState,
  TurnKey,
} from '../contract/session.ts'
import { guaranteesFor, turnKey } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { Relay } from './relay.ts'
import { outranks, type RelayMessage } from './message.ts'
import type { RelayEvent } from './observe.ts'

/** Records everything it was sent and replies with scripted prose. */
class FakeSession implements AgentSession {
  readonly guarantees = guaranteesFor('mediated')
  readonly received: string[] = []
  #replies: string[]
  #turns: { key: TurnKey; prose: string; args: string[] }[] = []
  #queue: AgentEvent[] = []
  #waiters: ((e: IteratorResult<AgentEvent>) => void)[] = []
  #seq = 0
  closedAs: CloseMode | undefined
  // Declared explicitly rather than as constructor parameter properties: erasableSyntaxOnly
  // rejects those, since native type stripping cannot erase them.
  readonly agent: string
  readonly sessionId: string
  /** Emitted before each turn_end, so a turn is not a single instantaneous event. */
  #tools: string[]
  /**
   * Serialized tool inputs this session reports for a turn, chosen from what that turn was
   * asked to do. Attribution reads these and nothing else, so a fake that reports none is a
   * session that touched nothing.
   *
   * A function of the prompt rather than an array indexed by turn number, because the turn
   * numbering is not what a test means. The implementer's turn 0 is the briefing exchange,
   * so `[[], [args]]` puts the args on the briefing's successor and not, as it reads, on
   * the turn after the aside — which is how these tests first failed.
   */
  #toolArgsFor: (message: string) => string[]

  constructor(
    agent: string,
    sessionId: string,
    replies: string[],
    tools: string[] = [],
    toolArgsFor: (message: string) => string[] = () => [],
  ) {
    this.agent = agent
    this.sessionId = sessionId
    this.#replies = [...replies]
    this.#tools = tools
    this.#toolArgsFor = toolArgsFor
  }

  async send(message: string): Promise<TurnKey> {
    this.received.push(message)
    const key = turnKey(`${this.sessionId}-turn-${this.#turns.length}`)
    const prose = this.#replies.shift() ?? '(no further scripted reply)'
    this.#turns.push({ key, prose, args: this.#toolArgsFor(message) })
    for (const tool of this.#tools) {
      this.#emit({
        type: 'tool_use',
        tool,
        input: {},
        turnKey: key,
        seq: ++this.#seq,
        at: Date.now(),
        provisional: true,
      })
    }
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

  /**
   * Emit a tool call after a delay, with nothing driving it. Stands in for a child still
   * emitting while the relay tears down around it.
   */
  emitLate(tool: string, delayMs: number): void {
    setTimeout(() => {
      this.#emit({
        type: 'tool_use',
        tool,
        input: {},
        seq: ++this.#seq,
        at: Date.now(),
        provisional: true,
      })
    }, delayMs).unref()
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
        toolCalls: t.args.map((args) => ({ tool: 'Bash', failed: false, args })),
      })),
      guarantees: this.guarantees,
      compactionGeneration: 0,
      builtAt: Date.now(),
    }
  }


  state: SessionState = 'running'

  async quiesce(): Promise<void> {
    this.state = 'quiesced'
  }

  async unquiesce(): Promise<void> {
    this.state = 'running'
  }

  async beginRotation(): Promise<void> {
    this.state = 'rotating'
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
    this.state = 'terminated'
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

async function twoParty(
  leadReplies: string[],
  implReplies: string[],
  implTools: string[] = [],
  onLog?: (m: RelayMessage) => void,
) {
  const lead = new FakeSession('fake-lead', 'lead-1', leadReplies)
  const impl = new FakeSession('fake-impl', 'impl-1', implReplies, implTools)
  const relay = await Relay.start({
    registry: registryWith({ 'fake-lead': lead, 'fake-impl': impl }),
    cwd: '/tmp',
    lead: { id: 'advisor', agent: 'fake-lead', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'fake-impl', role: 'implementer' },
    maxRounds: 3,
    ...(onLog ? { onLog } : {}),
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

// --- observing a run in progress ------------------------------------------------------

function messagesIn(events: RelayEvent[]): RelayMessage[] {
  return events.flatMap((e) => (e.type === 'message' ? [e.message] : []))
}

/** Reads a subscription to completion. Hangs if the stream never terminates, on purpose. */
async function drain(stream: AsyncIterable<RelayEvent>): Promise<RelayEvent[]> {
  const out: RelayEvent[] = []
  for await (const e of stream) out.push(e)
  return out
}

test('an observer sees the routing log in order, and the turn happening between entries', async () => {
  // The tools are the point. A stream carrying only log entries goes silent from the
  // instruction until the report -- which is the entire duration of the work, and exactly
  // the interval a live view exists to show.
  const { relay } = await twoParty(['do the thing', 'DONE'], ['done it'], ['Read', 'Edit'])
  const collected = drain(relay.observe())
  await relay.run('a goal')
  const events = await collected

  assert.deepEqual(
    messagesIn(events).map((m) => m.seq),
    relay.log.map((m) => m.seq),
    'every log entry reaches the observer, in log order',
  )

  const at = (kind: string) => events.findIndex((e) => e.type === 'message' && e.message.kind === kind)
  const instruction = at('instruction')
  const report = at('report')
  assert.ok(instruction >= 0 && report > instruction, 'an instruction, then the report answering it')
  const during = events
    .slice(instruction, report)
    .filter((e) => e.type === 'activity' && e.event.type === 'tool_use')
  assert.ok(during.length > 0, 'the wait for a turn is not silent')

  const end = events.at(-1)!
  assert.equal(end.type, 'run_end', 'terminal, and the iteration completed rather than hanging')
  if (end.type === 'run_end') assert.equal(end.reason, 'done')
})

test('a subscriber attaching mid-run replays what it missed, then follows live', async () => {
  const { relay } = await twoParty(['do the thing', 'DONE'], ['done it'], ['Read'])
  const running = relay.run('a goal')
  while (!relay.log.some((m) => m.kind === 'instruction')) {
    await new Promise((r) => setTimeout(r, 5))
  }

  const late = drain(relay.observe())
  await running
  const events = await late

  // Including the goal and both briefings, which were routed before it attached. A gap
  // here would be invisible to the subscriber, which is what makes it worth closing.
  assert.deepEqual(
    messagesIn(events).map((m) => m.seq),
    relay.log.map((m) => m.seq),
    'replay covers everything before the attach',
  )
  assert.equal(events.at(-1)?.type, 'run_end')

  const nothing = await drain(relay.observe({ replay: false }))
  assert.deepEqual(nothing, [], 'opting out of replay after the run yields nothing at all')
})

test('two subscribers each receive the whole stream', async () => {
  const { relay } = await twoParty(['do the thing', 'DONE'], ['done it'], ['Read'])
  const a = drain(relay.observe())
  const b = drain(relay.observe())
  await relay.run('a goal')
  const [ea, eb] = await Promise.all([a, b])

  assert.ok(ea.length > 0)
  assert.deepEqual(
    ea.map((e) => e.seq),
    eb.map((e) => e.seq),
    'one shared queue would have them stealing events from each other',
  )
})

test('breaking out of one subscription detaches it and leaves the others intact', async () => {
  const { relay } = await twoParty(['do the thing', 'DONE'], ['done it'], ['Read'])
  const survivor = drain(relay.observe())

  const quitter: RelayEvent[] = []
  for await (const e of relay.observe()) {
    quitter.push(e)
    break
  }

  await relay.run('a goal')
  const events = await survivor

  assert.equal(quitter.length, 1, 'it stopped where it broke rather than draining the run')
  assert.ok(events.length > 1)
  assert.equal(events.at(-1)?.type, 'run_end', 'and the subscriber that stayed ran to completion')
})

test('run_end is terminal for a late subscriber too, not just a live one', async () => {
  // A child does not stop emitting because the relay decided the run was over. If those
  // events reached the history, a subscriber attaching afterwards would replay tool calls
  // sitting AFTER the run they belong to -- a live subscriber and a replayed one would
  // disagree about where the session ended.
  const { relay, impl } = await twoParty(['do the thing', 'DONE'], ['done it'], ['Read'])
  const live = drain(relay.observe())
  await relay.run('a goal')
  const liveEvents = await live

  impl.emitLate('LateWrite', 5)
  impl.emitLate('LaterWrite', 20)
  await new Promise((r) => setTimeout(r, 120))

  assert.equal(liveEvents.at(-1)?.type, 'run_end', 'the subscriber that watched it happen')

  const replayed = await drain(relay.observe())
  assert.equal(replayed.at(-1)?.type, 'run_end', 'and one attaching after the fact')
  assert.deepEqual(
    replayed.map((e) => e.seq),
    liveEvents.map((e) => e.seq),
    'both see exactly the same stream',
  )
  assert.equal(
    replayed.findIndex((e) => e.type === 'activity' && e.event.type === 'tool_use' && /Late/.test(e.event.tool)),
    -1,
    'nothing from after the run appears anywhere in it',
  )

  assert.equal(relay.droppedAfterEnd, 2, 'the refused events are counted, not silently eaten')
  assert.ok(
    relay.participants
      .find((p) => p.id === 'implementer')!
      .events.some((e) => e.type === 'tool_use' && e.tool === 'LateWrite'),
    'and the participant still holds them -- the stream declined them, nothing was destroyed',
  )
})

test('observing changes neither the routing log numbering nor onLog', async () => {
  // audit() and asymmetryAt() are defined over RelayMessage.seq. Interleaving activity
  // into that numbering would silently change what a recorded asymmetry refers to.
  const pushed: RelayMessage[] = []
  const { relay } = await twoParty(['instruction', 'DONE'], ['a report'], ['Read', 'Edit'], (m) =>
    pushed.push(m),
  )
  const aside = relay.say('withheld from the advisor', { only: 'implementer' }, 'aside')
  const collected = drain(relay.observe())
  await relay.run('a goal')
  const events = await collected

  assert.deepEqual(
    relay.log.map((m) => m.seq),
    relay.log.map((_, i) => i + 1),
    'message numbering stays contiguous',
  )
  assert.deepEqual(pushed.map((m) => m.seq), relay.log.map((m) => m.seq), 'onLog still receives every entry')
  assert.equal(relay.audit()[0]!.seq, aside.seq)
  assert.deepEqual(relay.asymmetryAt(relay.log.at(-1)!.seq).excluded, ['advisor'])

  const lastMessageEvent = events.filter((e) => e.type === 'message').at(-1)!
  assert.ok(
    lastMessageEvent.seq > lastMessageEvent.message.seq,
    'the stream counts its own events; activity does not consume message numbers',
  )
})

// --- artifact attribution -----------------------------------------------------------
//
// The evidence question, not the matching question. `authority.test.ts` covers what
// `attributable` decides given evidence; these cover whether the relay hands it the right
// evidence, against a real `git status` in a real repository.

/** A throwaway git repo, so `dirtyPaths` has something true to report. */
function scratchRepo(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-attribution-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  writeFileSync(join(dir, 'seed.txt'), 'seed\n')
  git('add', '-A')
  git('commit', '-qm', 'seed')
  return dir
}

/**
 * Run a two-party relay in `cwd`, sending an aside and dirtying the tree mid-run.
 *
 * `dirty` fires from `onLog` when the first report is recorded — after `say()` has
 * snapshotted the tree and before the turn that triggers attribution — which is the window
 * a real participant writes in.
 *
 * `implToolArgs` is given the prompt of each implementer turn. `ASIDE` appears verbatim in
 * the prompt of the turn that received it, so a test says "the turn that was told the
 * aside" instead of guessing a turn index.
 */
const ASIDE = 'quietly, please'

async function attributionRun(
  cwd: string,
  implToolArgs: (message: string) => string[],
  dirty: () => void,
) {
  // Three advisor replies, so the implementer gets a turn AFTER the aside. With two, the
  // advisor says DONE off the back of the first report and the run ends before the turn
  // that attribution is meant to read.
  const lead = new FakeSession('fake-lead', 'lead-1', ['first instruction', 'second instruction', 'DONE'])
  const impl = new FakeSession('fake-impl', 'impl-1', ['first report', 'second report'], [], implToolArgs)
  let relay: Relay
  let armed = false
  relay = await Relay.start({
    registry: registryWith({ 'fake-lead': lead, 'fake-impl': impl }),
    cwd,
    lead: { id: 'advisor', agent: 'fake-lead', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'fake-impl', role: 'implementer' },
    maxRounds: 3,
    onLog: (m) => {
      if (m.kind !== 'report' || armed) return
      armed = true
      relay.say(ASIDE, { only: 'implementer' }, 'aside')
      dirty()
    },
  })
  await relay.run('a goal')
  return relay.restrictedOrigins.at(-1)!
}

/** A heredoc, not a `Write`. Most file work in this repository looks like this, and a
 *  structured `file_path` rule would see nothing in it. */
const HEREDOC = `python3 - <<'PY'\nopen('asked-for.txt','w').write('x')\nPY`

test('a path the implementer names in a tool call is attributed to the aside', async (t) => {
  const dir = scratchRepo(t)
  const origin = await attributionRun(
    dir,
    (msg) => (msg.includes(ASIDE) ? [HEREDOC] : []),
    () => writeFileSync(join(dir, 'asked-for.txt'), 'x\n'),
  )
  assert.deepEqual(origin.artifacts, ['asked-for.txt'])
})

test('a path another editor dirtied is NOT attributed to the aside', async (t) => {
  // The whole reason this changed. `git status` reports this file exactly as it reports the
  // implementer's; only the absence of participant evidence separates them.
  const dir = scratchRepo(t)
  const origin = await attributionRun(
    dir,
    (msg) => (msg.includes(ASIDE) ? [HEREDOC] : []),
    () => {
      writeFileSync(join(dir, 'asked-for.txt'), 'x\n')
      writeFileSync(join(dir, 'colleague-was-here.txt'), 'not ours\n')
    },
  )
  assert.deepEqual(origin.artifacts, ['asked-for.txt'])
  assert.ok(
    !origin.artifacts.includes('colleague-was-here.txt'),
    'a concurrent editor must not have their work attributed to a message they never saw',
  )
})

test('with no tool evidence at all, nothing is attributed rather than everything', async (t) => {
  // The direction of failure, asserted explicitly. A participant whose transcript yields no
  // tool inputs — an adapter that cannot supply them — attributes nothing. That is
  // under-detection, and it is chosen over reinstating the whole working tree.
  const dir = scratchRepo(t)
  const origin = await attributionRun(dir, () => [], () => {
    writeFileSync(join(dir, 'appeared.txt'), 'x\n')
  })
  assert.deepEqual(origin.artifacts, [])
})

test('tool calls made BEFORE the aside are not evidence for it', async (t) => {
  // Work already done cannot have been caused by a message that had not been sent, so
  // naming the path on an earlier turn must not attribute it.
  const dir = scratchRepo(t)
  const origin = await attributionRun(
    dir,
    (msg) => (msg.includes(ASIDE) ? [] : ['cat asked-for.txt']),
    () => writeFileSync(join(dir, 'asked-for.txt'), 'x\n'),
  )
  assert.deepEqual(origin.artifacts, [])
})
