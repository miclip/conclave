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

/**
 * What the seat does with a command, as the real PTY adapters observe it (#300).
 *
 * The composer takes the keystrokes and the seat is busy from that instant; the hook that
 * makes the turn VISIBLE lands later -- about 100 ms on both #300 runs -- and the turn ends
 * later still. Modelled with three moments rather than one, because the gap between the first
 * two is where the relay used to send. `undefined` for a seat whose commands open no turn.
 */
interface CommandTurn {
  /** Delay from the keystrokes to the `turn_start` the relay can see. */
  openAfterMs: number
  /** Delay from the keystrokes to the turn's `turn_end`. */
  endAfterMs: number
}

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
  /**
   * Whether a turn was open when each `send` was typed, in `received` order.
   *
   * The same measurement `RawSubmit.whileBusy` makes for a command, taken for the instruction
   * that follows one: the #300 hazard is the instruction going into the command's live turn.
   */
  readonly sentWhileBusy: boolean[] = []
  readonly rawSubmits: RawSubmit[] = []
  readonly agent: string
  readonly sessionId: string
  state: SessionState = 'running'
  closedAs: CloseMode | undefined
  /** Turns from this index on stay open until `endTurn()` is called. */
  holdFrom: number | undefined
  /**
   * Called as each turn begins, so a test can make something happen during it.
   *
   * Returning `true` HOLDS the turn: it stays open until `endTurn()` is called. Without that,
   * `send` ends the turn before it returns, and a timer that calls `endTurn()` later finds
   * nothing open -- a test that believed it was holding a turn was holding nothing.
   */
  onSend: ((message: string, index: number) => void | boolean) | undefined

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
  #commandTurn: CommandTurn | undefined
  /** Turns whose `turn_end` has been emitted, so the snapshot can say which are still running. */
  readonly #ended = new Set<TurnKey>()

  constructor(
    agent: string,
    sessionId: string,
    replies: string[],
    opts: { composer?: boolean; commandTurn?: CommandTurn | undefined } = {},
  ) {
    this.agent = agent
    this.sessionId = sessionId
    this.#replies = [...replies]
    this.#commandTurn = opts.commandTurn
    if (opts.composer !== false) {
      this.submitRaw = async (text: string, detail?: string) => {
        this.rawSubmits.push({ text, detail, whileBusy: this.#open !== undefined })
        const shape = this.#commandTurn
        if (!shape) return
        // Busy NOW: the composer has the command. Visible LATER: the hook is what tells the
        // relay, and it has not fired yet. That ordering is the defect, so it is the model.
        const key = turnKey(`${this.sessionId}-command-${this.rawSubmits.length}`)
        this.#open = key
        setTimeout(() => {
          // The seat's transcript gets a turn for the command, with prose of its own: what a
          // relay reading the wrong turn's report would route as the reply to the instruction.
          this.#turns.push({ key, prose: `(the seat working on ${text}, which nobody asked it to report)` })
          this.#emit({ type: 'turn_start', prompt: text, turnKey: key, seq: ++this.#seq, at: Date.now(), provisional: false })
        }, shape.openAfterMs).unref()
        setTimeout(() => {
          if (this.#open === key) this.#open = undefined
          this.#ended.add(key)
          this.#emit({
            type: 'turn_end',
            verdict: { outcome: 'completed', confidence: 'proven', provenance: [{ source: 'hook', detail: 'Stop' }] },
            synthesized: false,
            turnKey: key,
            seq: ++this.#seq,
            at: Date.now(),
            provisional: false,
          })
        }, shape.endAfterMs).unref()
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
  selfDispatch(prompt: string, opts: { replay?: boolean; runsForMs?: number } = {}): void {
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
    //
    // `runsForMs` keeps it open that long first, and marks the seat busy meanwhile: the case
    // where the relay has something to type and the seat is mid-turn on its own account, which
    // is the only way a seat can be busy at the moment an advisor reply is acted on.
    const end = () => {
      if (this.#open === key) this.#open = undefined
      this.#ended.add(key)
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
    if (opts.runsForMs === undefined) return end()
    this.#open = key
    setTimeout(end, opts.runsForMs).unref()
  }

  async send(message: string): Promise<TurnKey> {
    this.received.push(message)
    this.sentWhileBusy.push(this.#open !== undefined)
    const index = this.received.length - 1
    const key = turnKey(`${this.sessionId}-turn-${index}`)
    this.#turns.push({ key, prose: this.#replies.shift() ?? '(no further scripted reply)' })
    this.#open = key
    this.#emit({ type: 'turn_start', prompt: message, turnKey: key, seq: ++this.#seq, at: Date.now(), provisional: false })
    const held = this.onSend?.(message, index) === true
    if (held || (this.holdFrom !== undefined && index >= this.holdFrom)) return key
    this.endTurn()
    return key
  }

  endTurn(): void {
    const key = this.#open
    if (!key) return
    this.#open = undefined
    this.#ended.add(key)
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
      // A turn that has not ended has no report yet, as in a real transcript: the prose is
      // what the seat says when it stops. A relay that resolves an exchange on the wrong
      // `turn_end` therefore reads a blank here, rather than a report that is not there yet.
      turns: this.#turns.map((t) => {
        const running = !this.#ended.has(t.key)
        return {
          key: t.key,
          prompt: '',
          state: (running ? 'in_progress' : 'completed') as 'in_progress' | 'completed',
          assistantText: running ? '' : t.prose,
          report: running ? undefined : t.prose,
          toolCalls: [],
        }
      }),
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
    onImplSend?: (impl: CommandSession) => (message: string, index: number) => void | boolean
    /** As each ADVISOR turn begins, with the implementer seat in hand: the moment to make it busy. */
    onLeadSend?: (impl: CommandSession) => (message: string, index: number) => void | boolean
    /** What bounds the run, for the tests about when a ceiling is passed as against acted on. */
    ceilings?: { maxTurns?: number | undefined } | undefined
    /** The turn the seat opens for a command, as the PTY adapters observe one (#300). */
    commandTurn?: CommandTurn | undefined
    /** How long the relay expects a command's turn to take to appear; see `commandTurnOpenMs`. */
    commandTurnOpenMs?: number | undefined
    /** The bound on waiting for a turn the relay did not ask for; see `sendPreconditionMs`. */
    sendPreconditionMs?: number | undefined
    /** The post-turn windows, for the test about an exchange resolved on the wrong turn's end. */
    transcriptSettleMs?: number | undefined
    transcriptSalvageMs?: number | undefined
  } = {},
) {
  const lead = new CommandSession('fake-lead', 'lead-1', leadReplies)
  const impl = new CommandSession('fake-impl', 'impl-1', opts.implReplies ?? [], {
    ...(opts.composer === false ? { composer: false } : {}),
    ...(opts.commandTurn ? { commandTurn: opts.commandTurn } : {}),
  })
  if (opts.onImplSend) impl.onSend = opts.onImplSend(impl)
  if (opts.onLeadSend) lead.onSend = opts.onLeadSend(impl)
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
    // Small by default: a command that opens no turn costs the whole open-wait, and most of
    // this file's seats open none. The production default is 5s and is not what is under test.
    commandTurnOpenMs: opts.commandTurnOpenMs ?? 100,
    ...(opts.sendPreconditionMs !== undefined ? { sendPreconditionMs: opts.sendPreconditionMs } : {}),
    ...(opts.transcriptSettleMs !== undefined ? { transcriptSettleMs: opts.transcriptSettleMs } : {}),
    ...(opts.transcriptSalvageMs !== undefined ? { transcriptSalvageMs: opts.transcriptSalvageMs } : {}),
    ...(opts.ceilings ? { ceilings: opts.ceilings } : {}),
    ...(opts.denied ? { denied: opts.denied } : {}),
    onLog: (m) => log.push(m),
  })
  const outcome = await relay.run('do the thing')
  await relay.stop()
  return { relay, lead, impl, log, outcome }
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
  // The measurement, not an inference. The seat is mid-turn when the advisor's reply is acted
  // on, and the relay's command must not land until that turn closes; a send into a live pty
  // is #117, which ends runs.
  //
  // MID-TURN ON ITS OWN ACCOUNT, which is the only way it can be. This used to hold the
  // briefing turn open with a timer, and the briefing exchange does not return until that
  // turn ends -- so by the time the advisor replied the seat was idle, the command was always
  // typed at a boundary, and removing the wait from the relay did not fail this test. Found
  // while mutating the #300 fix next door. A turn the seat starts for itself while the advisor
  // is composing is the one thing that is still open when the command arrives.
  const { impl } = await run(['COMMAND: /compact\nCarry on.', 'DONE'], {
    implReplies: ['working'],
    onLeadSend: (session) => (_message, index) => {
      // Longer than the relay takes to get from the advisor's reply to the keystrokes, which
      // measured ~270 ms here and is mostly the 250 ms `turn_end` poll. A hold that a slow
      // runner could outlast would make this test pass for the old reason again.
      if (index === 0) session.selfDispatch('a turn nobody sent, still running when the reply lands', { runsForMs: 1500 })
    },
  })
  assert.deepEqual(impl.rawSubmits.map((r) => r.text), ['/compact'])
  assert.deepEqual(
    impl.rawSubmits.map((r) => r.whileBusy),
    [false],
    'nothing may be typed while a turn is open: neither CLI queues it, and the run then reports a transport it never lost',
  )
})

test('#300 a command that opens a turn: the instruction behind it waits for that turn, and is answered by its own', async () => {
  // Both #300 runs, in miniature. The advisor sends `COMMAND: /goal ...` and an instruction in
  // one reply; the relay types the command, and 4 ms later sends the instruction -- into a
  // composer whose turn the hook has not yet announced. Two things then go wrong, and the
  // test measures both rather than the order of the keystrokes: the instruction lands inside
  // the command's live turn (#117's hazard, from the relay's own keystroke), and the exchange
  // takes the command turn's `turn_end` as the instruction's, routing the command turn's
  // report to the advisor as the reply to something it never answered.
  //
  // The timings are chosen so an unfixed relay fails BOTH: the command's turn becomes visible
  // after the instruction would have been sent, and ends before the instruction's turn does.
  const { impl, lead, log } = await run(['COMMAND: /focus on the parser\nCarry on.', 'DONE'], {
    implReplies: ['briefed', 'carried on'],
    commandTurn: { openAfterMs: 30, endAfterMs: 150 },
    onImplSend: (session) => (_message, index) => {
      // The instruction's turn outlives the command's, so a relay waiting for "the first
      // turn_end after the send" gets the wrong one.
      if (index !== 1) return
      setTimeout(() => session.endTurn(), 200).unref()
      return true
    },
  })

  assert.deepEqual(impl.rawSubmits.map((r) => r.text), ['/focus on the parser'])
  // (1) Not sent into the command's turn. The seat was busy from the keystroke; the relay must
  // have waited for the turn it could not yet see, and then for it to end.
  assert.deepEqual(
    impl.sentWhileBusy,
    impl.received.map(() => false),
    `no instruction may be typed while the command's turn is open: ${JSON.stringify(impl.sentWhileBusy)}`,
  )
  // (2) Answered by its own turn. What the advisor receives after its instruction is the
  // instruction's report, not the command turn's -- the relay associated each with its own.
  const reply = lead.received[1] ?? ''
  assert.match(reply, /carried on/, 'the advisor must get the reply to the instruction it sent')
  assert.doesNotMatch(
    reply,
    /nobody asked it to report/,
    'the command turn’s prose must not be routed as the reply to the instruction',
  )
  // (3) And the record says what happened: the turn was seen, and waited for.
  const notes = orchestratorNotes(log)
  assert.ok(
    notes.some((t) => t.includes('opened a turn for `/focus on the parser`')),
    'the command’s turn is the one outcome of a submission that IS observable, and it is recorded',
  )
  assert.ok(
    notes.some((t) => t.includes('was still on the turn its command opened')),
    'the wait is recorded, so a run that pauses for a /goal turn does not read as one that hung',
  )
})

test('#300 a command’s turn is waited for past the send precondition’s bound, because the relay asked for it', async () => {
  // A `/goal` turn is a working turn: the CLI hands the model the condition as its directive
  // and `Stop` fires when it is met, which can be well past five minutes. The send precondition
  // is a bound on waiting for a turn the relay did NOT ask for; expiring it here would cancel
  // and close the seat for doing what the advisor told it to. So a turn the relay's own command
  // opened is tracked, and tracked turns are waited for on the adapter's clock instead.
  const { impl, lead, log, outcome } = await run(['COMMAND: /focus on the parser\nCarry on.', 'DONE'], {
    implReplies: ['briefed', 'carried on'],
    // The command's turn outlives the precondition by a wide margin.
    commandTurn: { openAfterMs: 30, endAfterMs: 600 },
    sendPreconditionMs: 150,
  })
  assert.equal(outcome.reason, 'done', `the run must not end for a command turn that was merely long: ${JSON.stringify(outcome)}`)
  assert.ok(
    !orchestratorNotes(log).some((t) => t.includes('so nothing was sent to it')),
    'and the precondition’s give-up path -- cancel the turn, close the seat -- must not have run',
  )
  assert.deepEqual(impl.sentWhileBusy, impl.received.map(() => false), 'the instruction still waited for the turn to end')
  assert.match(lead.received[1] ?? '', /carried on/, 'and was answered')
})

test('#300 a command’s turn seen only after the open-wait still ends its own turn, never the instruction’s', async () => {
  // The open-wait is a bound, and a hook slower than it means the instruction goes out before
  // the command's turn is visible -- the mid-turn send the bound exists to prevent, and what
  // it costs when it is too short. What must hold even then is the association: the command
  // turn's `turn_end`, arriving after the send and before the instruction's own end, is not
  // the end of the exchange. Taking it was the second half of #300 -- the command turn's report
  // routed to the advisor as the reply to an instruction it never answered.
  //
  // The instruction's turn outlives the settle and salvage windows that follow a resolution,
  // so a relay that resolved on the command turn's end cannot recover by waiting for the
  // record: it routes a blank, with a note that the report may be incomplete. That is the
  // shape #300 would have had if the recovery had not ended the run first.
  const { impl, lead, log } = await run(['COMMAND: /focus on the parser\nCarry on.', 'DONE'], {
    implReplies: ['briefed', 'carried on'],
    commandTurn: { openAfterMs: 200, endAfterMs: 300 },
    commandTurnOpenMs: 40,
    transcriptSettleMs: 100,
    transcriptSalvageMs: 100,
    onImplSend: (session) => (_message, index) => {
      if (index !== 1) return
      setTimeout(() => session.endTurn(), 900).unref()
      return true
    },
  })
  assert.equal(impl.sentWhileBusy[1], true, 'the premise: the instruction went out inside the not-yet-visible command turn')
  const reply = lead.received[1] ?? ''
  assert.match(reply, /carried on/, 'the exchange resolved on the instruction’s own turn_end, and routed its report')
  assert.doesNotMatch(reply, /nobody asked it to report/, 'not on the command turn’s')
  assert.ok(
    !orchestratorNotes(log).some((t) => t.includes('the report below may be incomplete')),
    'and nothing was read before the instruction’s turn had ended',
  )
})

test('#300 a command that opens no turn costs the open-wait and nothing else', async () => {
  // `/compact` with nothing to compact dispatched no hook at all on 2.1.270. The relay must
  // not read that as a failure, and must not wait for a turn that is never coming past the
  // bound it set for it.
  const startedAt = Date.now()
  const { impl, lead, log } = await run(['COMMAND: /compact\nCarry on.', 'DONE'], {
    implReplies: ['briefed', 'carried on'],
    commandTurnOpenMs: 80,
  })
  assert.ok(Date.now() - startedAt >= 80, 'and the bound was actually waited out, not skipped')
  assert.deepEqual(impl.rawSubmits.map((r) => r.text), ['/compact'])
  assert.match(lead.received[1] ?? '', /carried on/, 'the instruction was delivered and answered')
  assert.ok(
    !orchestratorNotes(log).some((t) => t.includes('opened a turn for')),
    'nothing may be recorded as observed when nothing was',
  )
  assert.ok(Date.now() - startedAt < 5_000, 'the default bound must not be what a test with a smaller one paid')
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

test('#208 a ceiling passed by a self-dispatched turn says so WHEN it is passed', async () => {
  // Part one made the count true. This is about the gap between a ceiling being PASSED and
  // being ACTED ON, which stays: ceilings are enforced at turn boundaries, because a run cannot
  // be interrupted mid-turn without discarding the turn's work.
  //
  // What was wrong is that the gap was invisible. The run ended quoting a ceiling with a
  // timestamp from the boundary, and nothing said the turn that passed it had been taken
  // earlier -- so an operator could not tell a ceiling that fired promptly from one that fired
  // late, which is the whole open question about how late it can get.
  const { log } = await run(['Carry on.', 'DONE'], {
    ceilings: { maxTurns: 1 },
    onImplSend: (impl) => (_m, index) => {
      // THREE, not one. A looping seat does not stop when it passes a ceiling -- it keeps going
      // until the boundary -- and every one of those turns re-enters the check. One
      // self-dispatch would leave "said once" true whether or not anything deduplicated it.
      if (index === 0) {
        impl.selfDispatch('the next iteration, which nobody sent')
        impl.selfDispatch('and another')
        impl.selfDispatch('and another still')
      }
    },
  })

  const notes = orchestratorNotes(log)
  const passed = notes.filter((t) => t.includes('passed by a turn a seat started for itself'))
  assert.equal(passed.length, 1, 'said ONCE, though three turns passed the ceiling after it broke')
  // The reading, not just the fact: an operator needs the number the ceiling was checked
  // against, and it comes from the same `breached()` detail the enforcement quotes.
  assert.match(passed[0]!, /turn ceiling reached: \d+ of a maximum 1/)
  // And it says where enforcement happens, because "passed but still running" is otherwise
  // indistinguishable from a ceiling that is not working.
  assert.match(passed[0]!, /enforced at the next turn boundary/)
})

test('#208 a run that passes no ceiling says nothing about one', async () => {
  // The identity case. A note that appeared on ordinary runs would be noise on every run that
  // ever loops within its budget, which is most of them.
  const { log } = await run(['Carry on.', 'DONE'], {
    ceilings: { maxTurns: 50 },
    onImplSend: (impl) => (_m, index) => {
      if (index === 0) impl.selfDispatch('one extra turn, well within the budget')
    },
  })
  assert.deepEqual(
    orchestratorNotes(log).filter((t) => t.includes('passed by a turn a seat started for itself')),
    [],
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
