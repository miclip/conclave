/**
 * An advisor `COMMAND:` line, from the reply that carried it to the keystrokes at the seat (#200).
 *
 *   node --test src/relay/commandDelivery.test.ts
 *
 * The gap this closes is narrow and was invisible: everything the advisor writes is wrapped in
 * an envelope and delivered as prose, so it could DESCRIBE a mode change forever and never
 * cause one. #192 had already told the advisor a Claude seat can be instructed into autonomous
 * continuation, which was untrue in the only sense that matters -- there was no way to ask.
 *
 * The double is unforgiving about the two things that would be worst to get wrong. It records
 * whether a turn was OPEN at the moment a command was typed, so "it waited for the boundary" is
 * a measurement rather than an inference; and it records the submitted bytes verbatim, so
 * "unenveloped" is checked against what arrived rather than against the intent of the caller.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { AsyncQueue } from '../adapters/asyncQueue.ts'
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
import { NO_DEADLINE_CLOCKS, type CommandPolicy } from '../registry/types.ts'
import { NO_COMPOSER_COMMAND_POLICY } from '../registry/commandPolicy.ts'
import type { RelayMessage } from './message.ts'
import type { OperatorDenials } from '../registry/operatorDenied.ts'
import { Relay } from './relay.ts'

/** What a raw submission looked like from the seat's side. */
interface RawSubmit {
  text: string
  detail: string | undefined
  /**
   * Whether a turn was open when this was typed.
   *
   * The whole point of the boundary wait, recorded at the moment it would be violated rather
   * than reconstructed afterwards. A `true` here is #117's hazard: input at a live pty is not
   * queued by either CLI, it is lost, and the run then reports a transport it never lost.
   */
  whileBusy: boolean
}

class CommandSession implements AgentSession {
  readonly guarantees = guaranteesFor('mediated')
  readonly received: string[] = []
  readonly rawSubmits: RawSubmit[] = []
  readonly agent: string
  readonly sessionId: string
  state: SessionState = 'running'
  closedAs: CloseMode | undefined
  /** Turns from this index on stay open until `endTurn()` is called. */
  holdFrom: number | undefined
  /** Called as each turn begins, so a test can make something happen during it. */
  onSend: ((message: string, index: number) => void) | undefined

  /**
   * Assigned in the constructor rather than declared as a method, so a seat can be built
   * WITHOUT one. An adapter that runs a process per turn has no composer, and the seam spells
   * that as an absent method; a double that always had it could not exercise the branch.
   */
  submitRaw?: (text: string, detail?: string) => Promise<void>

  #replies: string[]
  #turns: { key: TurnKey; prose: string }[] = []
  #events = new AsyncQueue<AgentEvent>()
  #seq = 0
  #open: TurnKey | undefined

  constructor(agent: string, sessionId: string, replies: string[], opts: { composer?: boolean } = {}) {
    this.agent = agent
    this.sessionId = sessionId
    this.#replies = [...replies]
    if (opts.composer !== false) {
      this.submitRaw = async (text: string, detail?: string) => {
        this.rawSubmits.push({ text, detail, whileBusy: this.#open !== undefined })
      }
    }
  }

  get busy(): boolean {
    return this.#open !== undefined
  }

  /**
   * A turn the seat began for ITSELF, which is what `/loop` produces (#208).
   *
   * No `send` behind it and no command typed at it: the adapter marks such a turn `unsolicited`
   * and the relay charges it, because a ceiling that counts only what the orchestrator
   * dispatched is counting instructions rather than work.
   */
  selfDispatch(prompt: string, opts: { replay?: boolean } = {}): void {
    const key = turnKey(`${this.sessionId}-self-${this.#seq}`)
    this.#emit({
      type: 'turn_start',
      prompt,
      turnKey: key,
      seq: ++this.#seq,
      at: Date.now(),
      provisional: false,
      unsolicited: true,
      ...(opts.replay ? { replay: true } : {}),
    })
    // A COMPLETE turn, start and end. A looped turn runs and finishes like any other; a start
    // with no end is a dangling turn rather than a self-dispatched one, and modelling it that
    // way tests the relay's handling of a malformed stream instead of the thing this is about.
    // It also does not touch `#open`, because this turn is not the one `send` is holding.
    this.#emit({
      type: 'turn_end',
      verdict: { outcome: 'completed', confidence: 'proven', provenance: [{ source: 'hook', detail: 'Stop' }] },
      synthesized: false,
      turnKey: key,
      seq: ++this.#seq,
      at: Date.now(),
      provisional: false,
    })
  }

  async send(message: string): Promise<TurnKey> {
    this.received.push(message)
    const index = this.#turns.length
    const key = turnKey(`${this.sessionId}-turn-${index}`)
    this.#turns.push({ key, prose: this.#replies.shift() ?? '(no further scripted reply)' })
    this.#open = key
    this.#emit({ type: 'turn_start', prompt: message, turnKey: key, seq: ++this.#seq, at: Date.now(), provisional: false })
    this.onSend?.(message, index)
    if (this.holdFrom !== undefined && index >= this.holdFrom) return key
    this.endTurn()
    return key
  }

  endTurn(): void {
    const key = this.#open
    if (!key) return
    this.#open = undefined
    this.#emit({
      type: 'turn_end',
      verdict: { outcome: 'completed', confidence: 'proven', provenance: [{ source: 'hook', detail: 'Stop' }] },
      synthesized: false,
      turnKey: key,
      seq: ++this.#seq,
      at: Date.now(),
      provisional: false,
    })
  }

  #emit(e: AgentEvent): void {
    this.#events.push(e)
  }

  events(): AsyncIterable<AgentEvent> {
    return this.#events
  }

  async snapshot(): Promise<SessionSnapshot> {
    return {
      sessionId: this.sessionId,
      agent: this.agent,
      cwd: '/tmp',
      turns: this.#turns.map((t, i) => ({
        key: t.key,
        prompt: '',
        state: (this.#open === t.key && i === this.#turns.length - 1 ? 'in_progress' : 'completed') as
          | 'in_progress'
          | 'completed',
        assistantText: t.prose,
        report: t.prose,
        toolCalls: [],
      })),
      guarantees: this.guarantees,
      compactionGeneration: 0,
      builtAt: Date.now(),
    }
  }

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
    const key = this.#open
    if (key) this.endTurn()
    return key
  }
  async decidePermission(): Promise<void> {}
  async fork(): Promise<AgentSession> {
    throw new Error('not implemented')
  }
  async close(mode: CloseMode = 'graceful'): Promise<void> {
    this.closedAs ??= mode
    this.state = 'terminated'
    this.#events.close()
  }
}

/**
 * A policy shaped like a real one, small enough that a test can state what it expects.
 *
 * The allowed verb is SYNTHETIC. It was `/loop` until that command was refused on Claude for
 * putting the seat's turns beyond `--max-turns` and `--rounds`, and a fixture that went on
 * declaring it allowed would read, to anyone who found this before the policy, as evidence the
 * verb is permitted. What these tests need is an allowance that takes arguments; which word it
 * is does not matter, so it is now one no CLI has.
 */
const TEST_POLICY: CommandPolicy = {
  kind: 'declared',
  sourceVersion: 'test',
  commands: [
    { command: '/compact', disposition: 'allowed', description: 'what this invented command does.', reason: 'summarises rather than discards', source: 'test' },
    { command: '/focus', disposition: 'allowed', description: 'what this invented command does.', reason: 'changes how the seat spends its turns', source: 'test' },
    { command: '/clear', disposition: 'refused', description: 'what this invented command does.', reason: 'discards the continuity the relay believes it has', source: 'test' },
  ],
}

function registryWith(
  sessions: Record<string, CommandSession>,
  policies: Record<string, CommandPolicy | undefined> = {},
): AgentRegistry {
  const r = new AgentRegistry()
  for (const [agent, session] of Object.entries(sessions)) {
    const policy = policies[agent]
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
      deadlines: NO_DEADLINE_CLOCKS,
      launch: { command: agent, baseArgs: [] },
      // Absent when the test passes none, which is the third state: nobody read this agent.
      ...(policy ? { commandPolicy: policy } : {}),
      async create() {
        return session
      },
    })
  }
  return r
}

async function run(
  leadReplies: string[],
  opts: {
    policy?: CommandPolicy | undefined
    /** What the project switched off, as `.conclave/config.json` would have said (#203). */
    denied?: OperatorDenials | undefined
    composer?: boolean
    implReplies?: string[]
    onImplSend?: (impl: CommandSession) => (message: string, index: number) => void
  } = {},
) {
  const lead = new CommandSession('fake-lead', 'lead-1', leadReplies)
  const impl = new CommandSession('fake-impl', 'impl-1', opts.implReplies ?? [], {
    ...(opts.composer === false ? { composer: false } : {}),
  })
  if (opts.onImplSend) impl.onSend = opts.onImplSend(impl)
  const log: RelayMessage[] = []
  const relay = await Relay.start({
    // `'policy' in opts` rather than `??`: a test that passes `policy: undefined` is asking for
    // the UNDECLARED state, and a nullish default would silently hand it the declared one --
    // which is exactly the collapse of the three states these tests exist to prevent.
    registry: registryWith(
      { 'fake-lead': lead, 'fake-impl': impl },
      { 'fake-impl': 'policy' in opts ? opts.policy : TEST_POLICY },
    ),
    cwd: '/tmp',
    lead: { id: 'advisor', agent: 'fake-lead', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'fake-impl', role: 'implementer' },
    maxAdvisorTurns: 4,
    ...(opts.denied ? { denied: opts.denied } : {}),
    onLog: (m) => log.push(m),
  })
  await relay.run('do the thing')
  await relay.stop()
  return { relay, lead, impl, log }
}

/** Every note the orchestrator wrote, which is where a command's record lands. */
const orchestratorNotes = (log: RelayMessage[]) =>
  log.filter((m) => m.kind === 'note' && m.from === 'orchestrator').map((m) => m.text)

/**
 * Everything the seat was sent, joined.
 *
 * NOT `received.at(-1)`: the last thing any seat is sent is the closing FLAG prompt the run
 * ends with, so a test reading the tail would be asserting about the wrong message -- and, for
 * the negative assertions below, would pass while a directive sat happily in an earlier one.
 */
const everythingSentTo = (s: CommandSession) => s.received.join('\n--- next message ---\n')

test('a command and an instruction in one reply: the command is typed, the instruction is delivered without it', async () => {
  const { impl, log } = await run(['COMMAND: /compact\nCarry on with the failing test.', 'DONE'])

  assert.deepEqual(
    impl.rawSubmits.map((r) => r.text),
    ['/compact'],
    'the command must reach the composer',
  )
  const instruction = everythingSentTo(impl)
  assert.match(instruction, /Carry on with the failing test\./, 'the remainder is still the instruction')
  assert.doesNotMatch(
    instruction,
    /COMMAND:/,
    'the directive must never be forwarded as prose: delivered as text it is an instruction to the seat to type something, which is the delivery this replaces',
  )
  assert.doesNotMatch(instruction, /\/compact/, 'nor may the command survive inside the instruction')
  assert.ok(orchestratorNotes(log).some((t) => t.includes('/compact')), 'and the submission is recorded')
})

test('a reply that is only a command does not end the run, and the advisor is asked for the instruction', async () => {
  // A command-only reply is the advisor using the channel it was given, exactly as a note-only
  // reply is. Halting there would end a session because the advisor did the permitted thing.
  const { impl, relay } = await run(['COMMAND: /compact', 'Now fix the parser.', 'DONE'])

  assert.deepEqual(impl.rawSubmits.map((r) => r.text), ['/compact'])
  assert.match(everythingSentTo(impl), /Now fix the parser\./, 'the re-ask produced the instruction')
  assert.ok(relay.turnsTaken > 0, 'the run continued rather than halting on an empty instruction')
})

test('several commands in one reply are all typed, in the order written', async () => {
  const { impl } = await run(['COMMAND: /compact\nCOMMAND: /focus on the parser\nGo.', 'DONE'])
  assert.deepEqual(
    impl.rawSubmits.map((r) => r.text),
    ['/compact', '/focus on the parser'],
    'order is the advisor’s, and is preserved: two mode changes applied backwards are not the same request',
  )
})

test('a refused command is never typed, and the advisor is told the command and the policy’s reason', async () => {
  const { impl, lead, log } = await run(['COMMAND: /clear\nCarry on.', 'DONE'])

  assert.deepEqual(impl.rawSubmits, [], 'a refusal must not reach the composer')
  const toAdvisor = lead.received.join('\n')
  assert.match(toAdvisor, /\/clear/, 'the advisor must be told WHICH command was refused')
  assert.match(
    toAdvisor,
    /discards the continuity the relay believes it has/,
    'and the policy’s own reason, not a generic refusal: an advisor told only "no" cannot choose differently next time',
  )
  assert.ok(orchestratorNotes(log).some((t) => t.includes('NOT run')), 'the refusal is in the log too')
})

test('an adapter with no composer refuses every command, whatever the line said', async () => {
  // The `unsupported` arm of the policy. Not a judgement about /compact -- there is nowhere to
  // type it.
  const { impl, lead } = await run(['COMMAND: /compact\nCarry on.', 'DONE'], {
    policy: NO_COMPOSER_COMMAND_POLICY,
    composer: false,
  })
  assert.deepEqual(impl.rawSubmits, [])
  assert.match(lead.received.join('\n'), /run-per-turn, no composer/)
})

test('an agent nobody has read refuses every command, and says that rather than borrowing a rule', async () => {
  // The third state. "Nobody looked" and "this verb is forbidden" are the same outcome and
  // different problems, and an advisor told the wrong one would file the wrong issue.
  const { impl, lead } = await run(['COMMAND: /compact\nCarry on.', 'DONE'], { policy: undefined })
  assert.deepEqual(impl.rawSubmits, [])
  assert.match(lead.received.join('\n'), /no command policy has been declared/)
})

test('a command waits for the turn boundary and is never typed into a live turn', async () => {
  // The measurement, not an inference. The seat holds its first turn open and the relay's
  // command must not land until it closes; a send into a live pty is #117, which ends runs.
  const { impl } = await run(['COMMAND: /compact\nCarry on.', 'DONE'], {
    implReplies: ['working'],
    onImplSend: (session) => (_message, index) => {
      // Hold the briefing turn open briefly, so a command that did not wait would land inside it.
      if (index === 0) setTimeout(() => session.endTurn(), 60).unref()
    },
  })
  assert.deepEqual(impl.rawSubmits.map((r) => r.text), ['/compact'])
  assert.deepEqual(
    impl.rawSubmits.map((r) => r.whileBusy),
    [false],
    'nothing may be typed while a turn is open: neither CLI queues it, and the run then reports a transport it never lost',
  )
})

test('what reaches the composer is the command alone, with no envelope around it', async () => {
  // `envelope()` prefixes a rank header, which is right for participant speech and fatal here:
  // `[advisor] /compact` is not a command, it is a line of text starting with a bracket.
  const { impl } = await run(['COMMAND: /compact\nCarry on.', 'DONE'])
  const submitted = impl.rawSubmits[0]?.text ?? ''
  assert.equal(submitted, '/compact', 'byte-for-byte the command, nothing before it and nothing after')
  assert.doesNotMatch(submitted, /\[/, 'no rank header')
  assert.doesNotMatch(submitted, /advisor/, 'no attribution line')

  // And it is distinguishable at the seat from a prompt, which is what `detail` is for.
  assert.match(impl.rawSubmits[0]?.detail ?? '', /advisor command via advisor/)
})

test('the routing log records an orchestrator action on the advisor’s instruction, with the outcome unobserved', async () => {
  const { log } = await run(['COMMAND: /compact\nCarry on.', 'DONE'])
  const entry = log.find((m) => m.kind === 'note' && m.text.includes('orchestrator submitted'))
  assert.ok(entry, 'the submission must be in the log: a mode change nobody can see afterwards is worse than one that never happened')

  assert.equal(entry.from, 'orchestrator', 'the orchestrator typed it; the advisor did not')
  assert.deepEqual(entry.to, ['implementer'], 'and it names the seat it was typed at')
  assert.match(entry.text, /on advisor's instruction/, 'attributed to the advisor that asked for it')
  assert.match(
    entry.text,
    /Outcome UNOBSERVED/,
    'the outcome must be recorded as unknown: no adapter reads the composer’s reply, and a log claiming the command ran would be inventing the half nobody checked',
  )
})

test('a command is not a turn: it does not count against the turn ceiling', async () => {
  // `--max-turns` and `--rounds` measure work the seat did. A housekeeping keystroke the
  // orchestrator typed is not work, and charging the operator’s allowance for it would be
  // charging them for the orchestration.
  const withCommand = await run(['COMMAND: /compact\nCarry on.', 'DONE'])
  const without = await run(['Carry on.', 'DONE'])
  assert.equal(
    withCommand.relay.turnsTaken,
    without.relay.turnsTaken,
    'the two runs did the same work; only one of them also typed a command',
  )
})

test('#208 a turn the seat started for itself IS a turn, and is charged', async () => {
  // The mirror of the test above, and the reason that one is not the whole rule. `--max-turns`
  // and `--rounds` are meant to measure work the seat did. Until #208 they measured turns this
  // relay DISPATCHED, and the two stopped being the same number when `/loop` was allowed: it
  // hands the seat its own next prompt, deliberately, with the operator's permission and the
  // advisor's decision behind it. Uncharged, a looping seat is a run no ceiling can end.
  const looped = await run(['Carry on.', 'DONE'], {
    // ONCE, on the first turn only. `onSend` fires for every turn the seat is given, so an
    // unguarded call loops as many times as the run has turns and the assertion below stops
    // being about one extra turn.
    onImplSend: (impl) => (_m, index) => {
      if (index === 0) impl.selfDispatch('the next iteration, which nobody sent')
    },
  })
  const plain = await run(['Carry on.', 'DONE'])

  assert.equal(
    looped.relay.turnsTaken,
    plain.relay.turnsTaken + 1,
    'the looped run did one more turn of work, and the ceiling must have seen it',
  )
})

test('#208 a REPLAYED self-dispatched turn is history, and is not charged again', async () => {
  // A rewritten transcript re-emits everything the session ever produced, in one burst, at a
  // moment the FILE chose -- which is why `EventBase.replay` exists. Charging those would end a
  // run for work it has already paid for, and the run would blame a ceiling the operator set.
  const replayed = await run(['Carry on.', 'DONE'], {
    onImplSend: (impl) => (_m, index) => {
      if (index === 0) impl.selfDispatch('a turn from before the rewrite', { replay: true })
    },
  })
  const plain = await run(['Carry on.', 'DONE'])

  assert.equal(
    replayed.relay.turnsTaken,
    plain.relay.turnsTaken,
    'replayed history is not new work, however unsolicited it was the first time',
  )
})

test('a reply with no command leaves the run exactly as it was', async () => {
  // The default identity. Every run before #200 had no directives in it, and none of them may
  // change: no raw submission, no orchestrator note about a command, and the instruction
  // delivered byte-for-byte as the advisor wrote it.
  const { impl, log } = await run(['Carry on with the failing test.', 'DONE'])

  assert.deepEqual(impl.rawSubmits, [], 'nothing is typed at a seat when nothing was asked for')
  assert.deepEqual(
    orchestratorNotes(log).filter((t) => t.includes('orchestrator submitted') || t.includes('NOT run')),
    [],
    'and nothing about commands reaches the log',
  )
  assert.match(everythingSentTo(impl), /Carry on with the failing test\./)
})

test('a command the operator switched off is not offered at startup and is refused if asked for', async () => {
  // ONE TEST FOR BOTH HALVES, because the guarantee is that they AGREE. `Relay#effectivePolicy`
  // is the single narrowing both readers go through: the block lists what may be asked for and
  // delivery decides what is typed, and an advisor offered a verb that delivery refuses spends
  // turns discovering it. Splitting this into two tests would let one drift green.
  const { impl, lead, log } = await run(['COMMAND: /focus on the parser\nCarry on.', 'DONE'], {
    denied: { capabilities: [], commands: ['/focus'] },
  })
  const opening = lead.received[0] ?? ''
  assert.ok(!opening.includes('/focus'), 'the advisor is never offered a command this project disabled')
  assert.deepEqual(impl.rawSubmits, [], 'and asking for it types nothing into the composer')
  // NOT the undeclared reason, rather than a match on the operator one. "Nobody read this CLI"
  // and "the operator declined this verb" are different problems with different repairs, and
  // the first would send the advisor to a human. The operator reason's own wording is
  // `operatorDenied.test.ts`'s to pin.
  assert.doesNotMatch(
    orchestratorNotes(log).join('\n'),
    /not declared in this agent/,
    'a disabled command is refused as disabled, never as one nobody declared',
  )
})
