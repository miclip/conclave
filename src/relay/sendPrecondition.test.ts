/**
 * The precondition on a peer send: never send into a live turn (#117).
 *
 * Four runs died of this in one operator session, three of them mid-task, every one reported as
 * `transport_failed` — a sentence that sends the operator to look at the CLI and the provider,
 * neither of which had done anything wrong. The child was still working, neither CLI accepts
 * input mid-turn, so the send produced no `UserPromptSubmit` hook and the relay concluded it had
 * lost the transport. The child was not killed either: it went on writing into the working tree
 * with nothing watching it.
 *
 * The fake here is unforgiving about the thing under test: `send()` THROWS the adapter's own
 * `no UserPromptSubmit hook after send` whenever a turn is open. So "no send occurred while a
 * turn was live" is not an assertion about what the relay probably did — a send one poll early
 * ends the run, and every test in this file would notice.
 *
 * The two near-misses this pins away from matter as much as the property itself:
 *
 *   - a TRANSCRIPT that still reads `in_progress` after `turn_end` is a flush race, not a live
 *     turn. The settle loop already waits that out, and a precondition built on the same field
 *     would block sends that were never in danger.
 *   - a CPU reading is a proxy for the wrong quantity. A child mid-turn inside a `sleep` reads
 *     idle and a finished one twitches; both directions have cost a run or an hour of an
 *     operator's time.
 *
 *   node --test src/relay/sendPrecondition.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AsyncQueue } from '../adapters/asyncQueue.ts'
import type { ChildLiveness } from '../outcomes/liveness.ts'
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
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { Relay } from './relay.ts'

/**
 * A session that can hold a turn open, lag its transcript, or both — and that refuses input
 * exactly when a real CLI would.
 *
 * The two are separate dials on purpose. A turn held open with a settled transcript is the
 * hazard; a transcript lagging behind an ended turn is the flush race the settle loop owns. A
 * double that could not tell them apart could not test that the fix distinguishes them.
 */
class TurnSession implements AgentSession {
  readonly guarantees = guaranteesFor('mediated')
  readonly received: string[] = []
  readonly agent: string
  readonly sessionId: string
  state: SessionState = 'running'
  closedAs: CloseMode | undefined
  cancelled = 0
  /** Sends that landed while a turn was open — the fatal case, counted rather than inferred. */
  sentWhileBusy = 0
  childPid: number | undefined
  /** How long each turn stays open before `turn_end`. */
  turnMs = 0
  /** Turns from this index on stay open until something ends them. */
  holdFrom: number | undefined
  /** How long the SNAPSHOT keeps saying `in_progress` after a turn has actually ended. */
  transcriptLagMs = 0
  /** Called as each turn begins, so a test can make something happen during it. */
  onSend: ((message: string, index: number) => void) | undefined

  #replies: string[]
  #turns: { key: TurnKey; prose: string }[] = []
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
  #open: TurnKey | undefined
  #settlesAt = 0

  constructor(agent: string, sessionId: string, replies: string[]) {
    this.agent = agent
    this.sessionId = sessionId
    this.#replies = [...replies]
  }

  /** Whether a turn is open right now. The fact the relay is supposed to be reading. */
  get busy(): boolean {
    return this.#open !== undefined
  }

  async send(message: string): Promise<TurnKey> {
    if (this.#open) {
      this.sentWhileBusy += 1
      // Verbatim from the adapter: the sentence the operator saw four times in one session.
      throw new Error('no UserPromptSubmit hook after send')
    }
    this.received.push(message)
    const index = this.#turns.length
    const key = turnKey(`${this.sessionId}-turn-${index}`)
    this.#turns.push({ key, prose: this.#replies.shift() ?? '(no further scripted reply)' })
    this.#open = key
    this.#emit({ type: 'turn_start', prompt: message, turnKey: key, seq: ++this.#seq, at: Date.now(), provisional: false })
    this.onSend?.(message, index)
    if (this.holdFrom !== undefined && index >= this.holdFrom) return key
    if (this.turnMs > 0) setTimeout(() => this.endTurn(), this.turnMs).unref()
    else this.endTurn()
    return key
  }

  /** End the open turn, as a `Stop` hook does. */
  endTurn(): void {
    const key = this.#open
    if (!key) return
    this.#open = undefined
    this.#settlesAt = Date.now() + this.transcriptLagMs
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

  /**
   * A `turn_end` for the PREVIOUS turn, emitted while the current one is still open.
   *
   * This is how a relay comes to send into a live child, and as far as the events go it is the
   * only way. `Relay#exchangeTurn` waits for the first `turn_end` it sees after its send and
   * never checks the key, so a late end belonging to an earlier prompt releases it: the relay
   * believes the turn is over, reads a report, routes it, and comes back to send again while the
   * child is still working. Everything the operator then sees — the missing hook, the
   * `transport_failed`, the child that keeps writing files — follows from this one event.
   */
  emitStaleEnd(): void {
    const previous = this.#turns.at(-2)
    if (!previous) throw new Error(`${this.sessionId} has no earlier turn to end`)
    this.#emit({
      type: 'turn_end',
      verdict: { outcome: 'completed', confidence: 'proven', provenance: [{ source: 'hook', detail: 'Stop' }] },
      synthesized: false,
      turnKey: previous.key,
      seq: ++this.#seq,
      at: Date.now(),
      provisional: false,
    })
  }

  /**
   * The watchdog's verdict on the OPEN turn, emitted without the child stopping.
   *
   * The distinction the whole of this is about, and the reason `#open` is deliberately left set:
   * a deadline expiring is the adapter giving up on a turn, not the child finishing one. On a
   * real seat the CLI carries on executing, which is why `send()` below still throws -- so a
   * relay that reads this verdict as the end of the turn does not merely make a bookkeeping
   * error, it ends the run.
   */
  timeOutOpenTurn(): void {
    const key = this.#open
    if (!key) throw new Error(`${this.sessionId} has no open turn to time out`)
    this.#emit({
      type: 'turn_end',
      verdict: {
        outcome: 'timed_out',
        confidence: 'uncertain',
        provenance: [{ source: 'watchdog', detail: 'no output for 720s, and no Stop' }],
      },
      synthesized: true,
      // The claim that makes this a hang rather than a finished turn: the child was never seen
      // to stop. A real adapter sets it from its own transport state, and only after asking the
      // transcript and finding no proof the turn ended. See `TurnEndEvent.transportOpen`.
      transportOpen: true,
      turnKey: key,
      seq: ++this.#seq,
      at: Date.now(),
      provisional: false,
    })
  }

  /** A tool call inside the open turn, so a refusal can say what the child is doing. */
  useTool(tool: string): void {
    this.#emit({ type: 'tool_use', tool, input: {}, seq: ++this.#seq, at: Date.now(), provisional: false })
  }

  #emit(e: AgentEvent): void {
    this.#events.push(e)
  }

  events(): AsyncIterable<AgentEvent> {
    return this.#events
  }

  async snapshot(): Promise<SessionSnapshot> {
    // `in_progress` here means the TRANSCRIPT has not caught up: either the turn really is open,
    // or it ended and the flush is late. The relay must treat those differently, so the fake
    // reports them identically — which is the point of having the second dial at all.
    const lagging = Date.now() < this.#settlesAt
    return {
      sessionId: this.sessionId,
      agent: this.agent,
      cwd: '/tmp',
      turns: this.#turns.map((t, i) => ({
        key: t.key,
        prompt: '',
        state: ((lagging || this.#open === t.key) && i === this.#turns.length - 1 ? 'in_progress' : 'completed') as
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
    this.cancelled += 1
    const key = this.#open
    // A cancelled turn is over, and the fake says so on the stream as an adapter would. Modelled
    // rather than ignored: it is what makes "the child was dealt with" mean anything.
    if (key) this.endTurn()
    return key
  }
  async decidePermission(): Promise<void> {}
  async fork(): Promise<AgentSession> {
    throw new Error('not implemented')
  }
  async close(mode: CloseMode = 'graceful'): Promise<void> {
    // First writer wins: `relay.stop()` closes every session again during teardown, and a test
    // asking how a participant was dealt with means the first time, not the last.
    this.closedAs ??= mode
    this.state = 'terminated'
    // The stream ENDS with the session, which is the half of the contract every one of these
    // doubles used to omit. See `#events`.
    this.#events.close()
  }
}

function registryWith(sessions: Record<string, TurnSession>): AgentRegistry {
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
      deadlines: NO_DEADLINE_CLOCKS,
      launch: { command: agent, baseArgs: [] },
      async create() {
        return session
      },
    })
  }
  return r
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-precondition-'))
  execFileSync('git', ['init', '--quiet'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'README.md'), '# hello')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: dir })
  return dir
}

/** Every sample under the line: what a child blocked in `sleep` inside a Bash call reads. */
const NEAR_IDLE: ChildLiveness = {
  pid: 4242,
  alive: true,
  samples: [0.4, 0.2, 0.3],
  selfSamples: [0.4, 0.2, 0.3],
  busiestDescendant: [],
  descendants: 0,
  workingDescendants: 0,
  idle: true,
  measuredAt: 0,
}
/** A finished child that twitched: the reading that held a run paused for an hour. */
const TWITCHED: ChildLiveness = {
  pid: 4242,
  alive: true,
  samples: [0.3, 0.2, 7.2],
  selfSamples: [0.3, 0.2, 7.2],
  busiestDescendant: [],
  descendants: 0,
  workingDescendants: 0,
  idle: false,
  measuredAt: 0,
}

const ADVISOR_REPLIES = ['Do it.', 'Now the other half.', 'DONE']
const IMPL_REPLIES = ['ack', 'Did the work.', 'Did that too.', 'NONE']

async function twoParty(
  repo: string,
  impl: TurnSession,
  advisor: TurnSession,
  opts: { sendPreconditionMs?: number; liveness?: (pid: number) => Promise<ChildLiveness> } = {},
): Promise<Relay> {
  return Relay.start({
    registry: registryWith({ advisor, implementer: impl }),
    cwd: repo,
    lead: { id: 'advisor', agent: 'advisor', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'implementer', role: 'implementer' },
    maxAdvisorTurns: 3,
    // Small, so a lagging transcript does not spend the settle window in every test that has
    // one. The settle loop's own behaviour is covered in relay.test.ts.
    transcriptSettleMs: 50,
    ...(opts.sendPreconditionMs === undefined ? {} : { sendPreconditionMs: opts.sendPreconditionMs }),
    ...(opts.liveness ? { liveness: opts.liveness } : {}),
  })
}

/** Notes the precondition writes, whether it waited successfully or gave up. */
function preconditionNotes(relay: Relay): string[] {
  return relay.log.filter((m) => m.kind === 'note' && /mid-turn/.test(m.text)).map((m) => m.text)
}

test('a transcript still catching up after turn_end does not hold up the next send', async () => {
  // The near-miss that decided the design. A turn ENDS, the hook says so, and the transcript
  // takes another minute to agree — that is a flush race, and the settle loop already waits it
  // out. A precondition keyed on `snapshot().turns.at(-1).state` would read it as a live child
  // and refuse a send that was never in danger: a guard firing on the wrong event, while looking
  // exactly like a guard that works.
  const repo = tempRepo()
  const impl = new TurnSession('implementer', 'impl-1', [...IMPL_REPLIES])
  impl.transcriptLagMs = 60_000
  const advisor = new TurnSession('advisor', 'advisor-1', [...ADVISOR_REPLIES])
  // Short, so a run that DID wait on the transcript would end `peer_busy` rather than merely
  // take a minute. The failure this pins is loud, not slow.
  const relay = await twoParty(repo, impl, advisor, { sendPreconditionMs: 300 })
  try {
    const outcome = await relay.run('Keep the work moving.')
    assert.equal(outcome.reason, 'done', `a lagging transcript must not end the run: ${JSON.stringify(outcome)}`)
    assert.deepEqual(preconditionNotes(relay), [], 'and must not be waited on at all')
    assert.equal(impl.sentWhileBusy, 0)
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a peer send waits for a live turn instead of ending the run', async () => {
  // A turn that is genuinely open — `turn_start` with no `turn_end` — and stays that way for
  // longer than any poll interval, so a relay that got lucky on timing cannot pass.
  const repo = tempRepo()
  const impl = new TurnSession('implementer', 'impl-1', [...IMPL_REPLIES])
  // The work turn stays open; a stale end for the BRIEFING turn releases the relay's own wait,
  // which is how it comes to be holding the next instruction while the child is still working.
  // 700ms later the turn really ends, so the wait is longer than any poll interval and shorter
  // than the bound.
  impl.holdFrom = 1
  impl.onSend = (_message, index) => {
    if (index !== 1) return
    setTimeout(() => impl.emitStaleEnd(), 50).unref()
    setTimeout(() => {
      impl.holdFrom = undefined
      impl.endTurn()
    }, 700).unref()
  }
  const advisor = new TurnSession('advisor', 'advisor-1', [...ADVISOR_REPLIES])
  const relay = await twoParty(repo, impl, advisor, { sendPreconditionMs: 10_000 })
  try {
    const outcome = await relay.run('Keep the work moving.')

    assert.equal(impl.sentWhileBusy, 0, 'nothing may be sent while a turn is open')
    assert.equal(outcome.reason, 'done', `a merely slow child must not end the run: ${JSON.stringify(outcome)}`)
    assert.ok(
      relay.log.some((m) => m.kind === 'report' && m.text.includes('Did the work.')),
      'the turn the relay waited for must still be routed',
    )
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a child mid-turn is refused however idle its CPU reads, and the transport is not blamed', async () => {
  // The reporter's own test, at the relay. A child blocked in `sleep` inside a Bash tool call is
  // mid-turn and samples at 3.2%; the CPU instrument says go, and the send is fatal. The same
  // path that refuses a busy child must refuse this one — which holds only because CPU is not
  // what either decision is made on.
  const repo = tempRepo()
  const impl = new TurnSession('implementer', 'impl-1', [...IMPL_REPLIES])
  impl.childPid = 4242
  // Open from the work turn on, and never closed. The briefing completes normally, so the run
  // reaches the point where a seat is asked to do something with a turn already in flight.
  impl.holdFrom = 1
  impl.onSend = (_message, index) => {
    if (index !== 1) return
    // The turn is doing something, and reading near-zero while it does. The stale end releases
    // the relay's wait; the turn itself never ends.
    setTimeout(() => impl.useTool('Bash'), 30).unref()
    setTimeout(() => impl.emitStaleEnd(), 60).unref()
  }
  const advisor = new TurnSession('advisor', 'advisor-1', [...ADVISOR_REPLIES])
  const relay = await twoParty(repo, impl, advisor, {
    sendPreconditionMs: 400,
    liveness: async (pid) => ({ ...NEAR_IDLE, pid, measuredAt: Date.now() }),
  })
  try {
    const outcome = await relay.run('Keep the work moving.')

    assert.equal(impl.sentWhileBusy, 0, 'giving up must not mean sending anyway')
    assert.equal(outcome.reason, 'peer_busy', `the ending must name the condition: ${JSON.stringify(outcome)}`)
    assert.notEqual(outcome.reason, 'transport_failed', 'the transport was never asked to carry anything')
    assert.match(outcome.detail ?? '', /implementer: its turn has been running/, 'the turn is what it refused on')
    assert.match(outcome.detail ?? '', /last tool call was Bash/, 'and what the child was doing is on the record')
    // The reading that would have waved this through, kept as colour and labelled as such.
    assert.match(outcome.detail ?? '', /reads not_computing, which decided nothing here/)
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a high CPU reading between turns is sent to immediately', async () => {
  // The obstructive tail, at the relay. A finished child that twitched once is idle for every
  // purpose this code has, and a run that waited on it would be paying for a measurement of the
  // wrong thing. Nothing is open here, so nothing is waited for and nothing is even sampled.
  const repo = tempRepo()
  const impl = new TurnSession('implementer', 'impl-1', [...IMPL_REPLIES])
  impl.childPid = 4242
  const advisor = new TurnSession('advisor', 'advisor-1', [...ADVISOR_REPLIES])
  let sampled = 0
  const relay = await twoParty(repo, impl, advisor, {
    sendPreconditionMs: 300,
    liveness: async (pid) => {
      sampled += 1
      return { ...TWITCHED, pid, measuredAt: Date.now() }
    },
  })
  try {
    const outcome = await relay.run('Keep the work moving.')
    assert.equal(outcome.reason, 'done', `a twitching but finished child must not stall a run: ${JSON.stringify(outcome)}`)
    assert.deepEqual(preconditionNotes(relay), [])
    assert.equal(sampled, 0, 'with no turn open there is nothing to describe, so nothing is sampled')
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('the busy target is cancelled and closed rather than left running', async () => {
  // The half of #117 that outlives the run. The child was never killed: in the run the issue was
  // filed from it went on to produce 764 lines across six files, in a tree whose run record said
  // the transport had failed and nothing more.
  const repo = tempRepo()
  const impl = new TurnSession('implementer', 'impl-1', [...IMPL_REPLIES])
  impl.holdFrom = 1
  impl.onSend = (_message, index) => {
    if (index === 1) setTimeout(() => impl.emitStaleEnd(), 50).unref()
  }
  const advisor = new TurnSession('advisor', 'advisor-1', [...ADVISOR_REPLIES])
  const relay = await twoParty(repo, impl, advisor, { sendPreconditionMs: 400 })
  try {
    const outcome = await relay.run('Keep the work moving.')
    assert.equal(outcome.reason, 'peer_busy')

    // Asserted BEFORE `relay.stop()`, which closes everything: the claim is that the run dealt
    // with this child when it gave up on it, not that teardown eventually did.
    assert.equal(impl.cancelled, 1, 'the live turn must be cancelled')
    assert.equal(impl.closedAs, 'graceful', 'and the session closed, reconciling before it terminates')
    assert.match(outcome.detail ?? '', /its live turn was cancelled, and the session was closed/)

    // The other participant is untouched. Only the seat that would not free up is dealt with.
    assert.equal(advisor.cancelled, 0)
    assert.equal(advisor.closedAs, undefined)
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('the precondition is read on the target, not carried over from the previous exchange', async () => {
  // `#runLoop`'s dispatcher resolves a task to a seat and `launch` looks that participant up, so
  // the exchange before any given send routinely belongs to somebody else. Here the implementer
  // holds a turn open from the work turn on, and the sends that follow go to the ADVISOR, which
  // is idle. Anything carried across that boundary — the settle loop's `unsettled` flag, a
  // remembered "somebody was busy" — would stall the advisor and end the run on a participant
  // that was never busy.
  const repo = tempRepo()
  const impl = new TurnSession('implementer', 'impl-1', [...IMPL_REPLIES])
  impl.holdFrom = 1
  impl.onSend = (_message, index) => {
    if (index === 1) setTimeout(() => impl.emitStaleEnd(), 50).unref()
  }
  const advisor = new TurnSession('advisor', 'advisor-1', [...ADVISOR_REPLIES])
  const relay = await twoParty(repo, impl, advisor, { sendPreconditionMs: 400 })
  try {
    const outcome = await relay.run('Keep the work moving.')

    assert.ok(advisor.received.length >= 2, `the advisor must not be stalled: ${advisor.received.length} send(s)`)
    assert.ok(
      advisor.received.some((m) => m.includes('Did the work.')),
      'the report from the seat that then went quiet still reaches the advisor',
    )
    assert.equal(advisor.sentWhileBusy, 0)

    const notes = preconditionNotes(relay)
    assert.ok(notes.length > 0, 'the precondition must have had something to say')
    assert.deepEqual(
      notes.filter((t) => t.startsWith('advisor ')),
      [],
      `no wait may be attributed to the advisor:\n${notes.join('\n')}`,
    )
    assert.equal((outcome.detail ?? '').startsWith('implementer '), true, 'the run ends on the seat that was busy')
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a turn the watchdog timed out is still a live turn, so the next dispatch never sends', async () => {
  // The relay half of the rule the adapters enforce internally. A watchdog verdict settles this
  // run's opinion of a turn; it observes nothing about the child, and the child it is most often
  // minted for is one that went quiet mid-work. `activeTurn` used to close the turn on it, so
  // `#awaitSendable` returned immediately and the relay sent into a live child -- #117 exactly,
  // reached through the one event that means "we gave up waiting".
  //
  // Driven ATTENDED, because that is the only way the next dispatch happens at all: a `timed_out`
  // verdict escalates first, and an unattended run ends there. So the sequence under test is the
  // real one -- the deadline fires, the operator is asked, the operator says carry on -- and what
  // must happen then is the path the relay already has for a busy seat: wait out the
  // precondition, cancel the child, close the session, end `peer_busy`. Not `transport_failed`:
  // nothing is wrong with the transport, and that ending is what sent four operators to look at
  // their CLI and their provider for a child that was simply still working.
  const repo = tempRepo()
  const impl = new TurnSession('implementer', 'impl-1', [...IMPL_REPLIES])
  impl.childPid = 4242
  // The work turn opens and never ends. Its watchdog fires 50ms in -- the whole event stream a
  // real seat shows for a hang -- and nothing else ever arrives.
  impl.holdFrom = 1
  impl.onSend = (_message, index) => {
    if (index !== 1) return
    setTimeout(() => impl.timeOutOpenTurn(), 50).unref()
  }
  const advisor = new TurnSession('advisor', 'advisor-1', [...ADVISOR_REPLIES])
  const relay = await twoParty(repo, impl, advisor, { sendPreconditionMs: 400 })
  try {
    const run = relay.start('Keep the work moving.')
    const pause = await run.untilPause()
    assert.ok(pause, 'the deadline must reach the operator before anything else happens')
    assert.equal(pause.reason, 'turn_incomplete', 'the deadline is what stopped the run here')
    assert.match(pause.detail, /timed_out/, `the pause must be the deadline's: ${pause.detail}`)

    // The operator carries on, which is the decision this test exists for. The child has said
    // nothing since; nothing has observed it stop.
    await run.continue()
    const outcome = await run.result()

    assert.equal(
      impl.sentWhileBusy,
      0,
      'a timed_out verdict must not be read as permission to send into a turn that is still open',
    )
    assert.equal(
      outcome.reason,
      'peer_busy',
      `the run must end on the busy path, not the transport one: ${JSON.stringify(outcome)}`,
    )
    // The child is dealt with rather than abandoned: #117's other cost was a run that ended
    // while a CLI kept writing into the working tree with nothing watching it.
    assert.equal(impl.cancelled, 1, 'the live turn must be cancelled')
    assert.equal(impl.closedAs, 'graceful', 'and the session closed')
    // And the run says why, in terms an operator can act on.
    const notes = relay.log.filter((m) => m.kind === 'note' && /mid-turn/.test(m.text)).map((m) => m.text)
    assert.ok(notes.length > 0, `the refusal must be recorded:\n${relay.log.map((m) => m.text).join('\n')}`)
    assert.ok(
      notes.some((t) => /timed_out/.test(t)),
      `the note must name the deadline as the reason the turn reads as open:\n${notes.join('\n')}`,
    )
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})
