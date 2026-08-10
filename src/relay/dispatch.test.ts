/**
 * The dispatcher at N=1, and the rules it will still be following at N>1.
 *
 * Two things are being pinned here, and they are pinned differently.
 *
 * **The schedule.** At N=1 the dispatcher must produce exactly the turn sequence the round
 * loop produced: advisor, implementer, advisor, implementer, and a closing question. Asserted
 * against the real order the two sessions were sent to — not against each session separately,
 * because two correct-looking per-seat sequences can still interleave wrongly, and the
 * interleaving is the whole property.
 *
 * **The grading rule.** A seat is free when its turn ended AND its verdict is graded (D4). A
 * `timed_out (uncertain)` seat must not be handed more work, so a dispatch that happened before
 * grading would be a scheduling decision made on a verdict nobody had read. Ordinals, not
 * timestamps: two transitions in the same millisecond are indistinguishable, and that is
 * exactly the pair this is watching for.
 *
 *   node --test src/relay/dispatch.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AgentSession, TurnKey } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import {
  dependenciesMet,
  nextDispatch,
  parseDecisions,
  recordCompletion,
  refuseDispatch,
  routedSuccessfully,
  seatFor,
  type SeatExecution,
  type Task,
  type TaskEvent,
  type TaskRuntime,
} from './dispatch.ts'
import { Relay, type RelayOptions } from './relay.ts'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-dispatch-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'work.ts'), 'export const answer = 42\n')
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

/**
 * A fake that records its sends into a list SHARED with the other seat.
 *
 * The point of the sharing. `advisor.received` and `implementer.received` each say what one
 * seat was asked, in order, and both can look perfectly correct while the run alternated
 * wrongly — two implementer turns back to back, say, or an advisor turn taken before the
 * previous report was graded. Only a single ordered list across both seats can say that, and
 * nothing in the existing fakes produces one.
 */
class TracedSession extends FakeRotationSession {
  readonly #trace: string[]
  readonly #label: string
  constructor(label: string, trace: string[], sessionId: string, agent: string, replies: string[]) {
    super(sessionId, agent, replies)
    this.#label = label
    this.#trace = trace
  }
  override async send(message: string): Promise<TurnKey> {
    this.#trace.push(this.#label)
    return super.send(message)
  }
}

function registryOf(queues: Record<string, AgentSession[]>): AgentRegistry {
  const r = new AgentRegistry()
  for (const [agent, sessions] of Object.entries(queues)) {
    const remaining = [...sessions]
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
        const next = remaining.shift()
        if (!next) throw new Error(`no session left for ${agent}`)
        return next
      },
    })
  }
  return r
}

async function relayOf(
  cwd: string,
  advisor: FakeRotationSession,
  implementer: FakeRotationSession,
  over: Partial<RelayOptions> = {},
): Promise<Relay> {
  return Relay.start({
    registry: registryOf({ codex: [advisor], claude: [implementer] }),
    cwd,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxRounds: 4,
    ...over,
  })
}

/** The ordinal a task's transition was stamped with, or -1 if it never happened. */
function at(runtime: TaskRuntime, event: TaskEvent): number {
  return runtime.marks.find((m) => m.event === event)?.ordinal ?? -1
}

function seat(over: Partial<SeatExecution> = {}): SeatExecution {
  return { seat: 'implementer', role: 'implementer', state: 'idle', idleSince: 0, dispatched: 0, ...over }
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't-1',
    seq: 1,
    origin: 0,
    instruction: 'do the thing',
    target: { kind: 'role', role: 'implementer' },
    dependsOn: [],
    restrictedOrigins: [],
    admittedAt: 0,
    ...over,
  }
}

test('the N=1 schedule is advisor, implementer, advisor, implementer, and a closing question', async (t) => {
  const dir = repo()
  const trace: string[] = []
  const advisor = new TracedSession('advisor', trace, 'advisor-1', 'codex', [
    'Do the first thing.',
    'Do the second thing.',
    'DONE',
  ])
  const impl = new TracedSession('implementer', trace, 'impl-1', 'claude', [
    'ack',
    'Did the first thing.',
    'Did the second thing.',
    'NONE',
  ])
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())

  const outcome = await relay.run('build the thing')
  assert.equal(outcome.reason, 'done')

  // The whole run, in the order it actually happened. Both briefings, then one advisor turn
  // per instruction with the implementer's turn between them, then the closing question --
  // which is the implementer's turn and has no advisor turn after it, because the run has
  // already been decided by then.
  assert.deepEqual(trace, [
    'implementer', // briefing
    'advisor', // briefing, and the first instruction comes back on it
    'implementer', // task t-1
    'advisor', // t-1's report routed; the second instruction comes back
    'implementer', // task t-2
    'advisor', // t-2's report routed; DONE comes back
    'implementer', // the closing question
  ])

  // And the two tasks are the two instructions, in admission order, each with the advisor turn
  // it came from recorded on it.
  assert.deepEqual(
    relay.tasks().map((e) => [e.task.id, e.task.seq, e.task.instruction]),
    [
      ['t-1', 1, 'Do the first thing.'],
      ['t-2', 2, 'Do the second thing.'],
    ],
  )
  // DONE admitted nothing. It is a decision, not a task, and a queue that recorded it would be
  // claiming the advisor asked for work it never asked for.
  assert.equal(relay.tasks().length, 2)
})

test('admission order is the order the routing log recorded the instructions in', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor-1', 'codex', [
    'Do the first thing.',
    'Do the second thing.',
    'Do the third thing.',
    'DONE',
  ])
  const impl = new FakeRotationSession('impl-1', 'claude', ['ack', 'one', 'two', 'three', 'NONE'])
  const relay = await relayOf(dir, advisor, impl, { maxRounds: 5 })
  t.after(() => relay.stop())

  await relay.run('build the thing')

  // The routing log is the reproducibility record, not the dispatcher's ordinals. `#seq` is one
  // global counter stamped at record time, and it is what `audit()`, `asymmetryAt()` and a
  // later `resume` all read; the marks are private and exist only to make an ordering testable.
  // So admission order has to BE log order -- if the queue ever disagreed with the log, the
  // record a run is replayed from would describe a schedule that never happened.
  const logged = relay.log.filter((m) => m.kind === 'instruction')
  assert.deepEqual(
    relay.tasks().map((e) => e.task.instruction),
    logged.map((m) => m.text),
  )
  // Ascending `Task.seq` and ascending log `seq` are the same ordering, not merely the same
  // set: zipping two lists that happen to be sorted differently would still pass a deepEqual on
  // one of them alone.
  assert.deepEqual(
    relay.tasks().map((e) => e.task.seq),
    [1, 2, 3],
  )
  const logSeqs = logged.map((m) => m.seq)
  assert.deepEqual([...logSeqs].sort((a, b) => a - b), logSeqs)

  // And each task's report was recorded after its own instruction and before the next one's,
  // which is what makes `reportSeq` the task's place in real time rather than a task index.
  for (const [i, entry] of relay.tasks().entries()) {
    assert.ok(entry.runtime.reportSeq! > logSeqs[i]!)
    if (logSeqs[i + 1] !== undefined) assert.ok(entry.runtime.reportSeq! < logSeqs[i + 1]!)
  }
})

test('every task runs the full transition sequence, in order, and ends routed and integrated', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor-1', 'codex', ['Do the thing.', 'DONE'])
  const impl = new FakeRotationSession('impl-1', 'claude', ['ack', 'Did it.', 'NONE'])
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())

  await relay.run('build the thing')

  const [entry] = relay.tasks()
  assert.ok(entry, 'one task was admitted')
  assert.deepEqual(
    entry.runtime.marks.map((m) => m.event),
    ['admitted', 'ready', 'assigned', 'sent', 'ended', 'reported', 'graded', 'integrated', 'released', 'routed'],
  )
  // Ordinals from a single counter, so "in order" is a claim about the run and not about the
  // order this array happens to have been built in.
  const ordinals = entry.runtime.marks.map((m) => m.ordinal)
  assert.deepEqual([...ordinals].sort((a, b) => a - b), ordinals)

  // Both completion facts hold, so the task is terminally successful. Neither is inferred from
  // the other, and neither is inferred from `state` -- `state` is derived from them.
  assert.equal(entry.runtime.state, 'complete')
  assert.ok(entry.runtime.integratedAt !== undefined, 'integrated')
  assert.ok(entry.runtime.routedAt !== undefined, 'routed')
  assert.equal(entry.runtime.seat, 'implementer')
  assert.deepEqual(entry.runtime.grade, { outcome: 'completed', superseded: false })
  // The report's place in real time, which is the global routing-log seq and not a task index.
  assert.equal(relay.log.find((m) => m.kind === 'report')?.seq, entry.runtime.reportSeq)
})

test('the recorded turn_end is the one the verdict was read from, not the withdrawn one', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor-1', 'codex', ['Do the thing.', 'DONE'])
  const impl = new FakeRotationSession('impl-1', 'claude', ['ack', 'Did it.', 'NONE'])
  // Turn 1 is the first that does work; turn 0 is the briefing. It ends `timed_out` and a late
  // signal immediately withdraws that and replaces it with `completed`.
  impl.endTurn = {
    index: 1,
    verdict: { outcome: 'timed_out', confidence: 'assumed', provenance: [{ source: 'watchdog', detail: 'no Stop' }] },
    withdraw: { outcome: 'completed', confidence: 'proven', provenance: [{ source: 'hook', detail: 'Stop' }] },
  }
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())

  const outcome = await relay.run('build the thing')
  // No pause: the verdict the run acts on is the replacement, so there is nothing to escalate.
  assert.equal(outcome.reason, 'done')

  const [entry] = relay.tasks()
  assert.ok(entry)
  assert.deepEqual(entry.runtime.grade, { outcome: 'completed', superseded: true })
  // The event, not just the grade. Recording the first `turn_end` here would leave the task
  // saying it finished on a verdict the relay had already stopped believing -- and `end` is
  // what a later reader would reach for to ask why the grade says what it says.
  assert.equal(entry.runtime.end?.verdict.outcome, 'completed')
  assert.deepEqual(entry.runtime.end?.verdict.provenance, [{ source: 'hook', detail: 'Stop' }])
  // And it is the replacement EVENT, not merely an event carrying the same verdict. Read off
  // the events the relay itself accumulated, so this is the same stream supersession was
  // resolved against, and matched by turn key -- the implementer takes a later turn for the
  // closing question, so "the last turn_end in the stream" is a different turn entirely.
  const seen = relay.participants.find((p) => p.rank === 'implementer')!.events
  const ends = seen.filter((e) => e.type === 'turn_end')
  const thisTurn = ends.filter((e) => e.turnKey === entry.runtime.end?.turnKey)
  assert.equal(thisTurn.length, 2, 'the turn ended twice: withdrawn, then replaced')
  assert.equal(thisTurn[0]?.verdict.outcome, 'timed_out', 'the first is the one that was withdrawn')
  assert.equal(entry.runtime.end?.seq, thisTurn[1]?.seq, 'the task holds the replacement')
  assert.notEqual(entry.runtime.end?.seq, thisTurn[0]?.seq)
})

test('no task is dispatched until the previous one has a graded verdict', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor-1', 'codex', [
    'Do the first thing.',
    'Do the second thing.',
    'DONE',
  ])
  const impl = new FakeRotationSession('impl-1', 'claude', ['ack', 'First done.', 'Second done.', 'NONE'])
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())

  await relay.run('build the thing')

  const [first, second] = relay.tasks()
  assert.ok(first && second, 'two tasks were admitted')

  // The invariant. If a later change frees the seat at `turn_end` -- before supersession is
  // resolved and the verdict judged -- this is the assertion that fails, and it fails whether
  // or not the two transitions land in the same millisecond.
  assert.ok(
    at(second.runtime, 'assigned') > at(first.runtime, 'graded'),
    'the second task was assigned before the first verdict was graded',
  )
  // And the release, which is what actually made the seat available, came after the grade too.
  assert.ok(at(first.runtime, 'released') > at(first.runtime, 'graded'))
  assert.ok(at(second.runtime, 'assigned') > at(first.runtime, 'released'))

  // The seat ends idle, holding nothing, having taken exactly the two tasks.
  assert.deepEqual(
    relay.seats().map((s) => [s.seat, s.state, s.current, s.dispatched]),
    [['implementer', 'idle', undefined, 2]],
  )
})

test('a seat whose report is in but whose verdict is not graded refuses a dispatch', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor-1', 'codex', ['Do the thing.', 'DONE'])
  const impl = new FakeRotationSession('impl-1', 'claude', [
    'ack',
    'Started, but the scope is not settled.\n\nUNANSWERED: should this replace the old path or sit beside it?',
  ])
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())

  // The `implementer_unanswered` halt is the one place a default run stops between the report
  // being recorded and the verdict being graded, which makes it the only way to observe the
  // window this rule exists to close from outside the dispatcher.
  const run = relay.start('build the thing')
  await run.untilPause()

  const [entry] = relay.tasks()
  assert.ok(entry, 'the task is admitted and its report is in')
  assert.equal(entry.runtime.state, 'reported')
  assert.equal(entry.runtime.grade, undefined, 'the verdict has not been graded yet')

  const [held] = relay.seats()
  assert.ok(held)
  assert.equal(held.state, 'integrating', 'not running, and not available')
  assert.equal(held.current, 't-1')
  assert.match(
    refuseDispatch(held, new Map([[entry.task.id, entry.runtime]])) ?? '',
    /whose verdict is not graded/,
  )

  await run.abort('enough')
  await run.result()
})

test('the dispatcher itself refuses a seat holding an ungraded verdict, not just the guard', () => {
  // The window between `#reported` and `#grade`: the turn ended, the report is recorded, and
  // the verdict has not been resolved through supersession yet. The seat is `integrating`.
  const held = task({ id: 't-1', seq: 1 })
  const byRole = task({ id: 't-2', seq: 2, target: { kind: 'role', role: 'implementer' } })
  const bySeat = task({ id: 't-3', seq: 3, target: { kind: 'seat', seat: 'implementer' } })
  const runtime = new Map<string, TaskRuntime>([
    ['t-1', { state: 'reported', seat: 'implementer', marks: [] }],
    ['t-2', { state: 'ready', marks: [] }],
    ['t-3', { state: 'ready', marks: [] }],
  ])
  const seats = [seat({ state: 'integrating', current: 't-1' })]

  // The DECISION, not the guard behind it. `refuseDispatch` is what `#assign` consults once a
  // seat has already been chosen; if the scan that chooses were to hand this seat a task, the
  // relay would reach that guard and throw -- an invariant violation rather than a schedule.
  // Nothing should get that far: the seat is simply not a candidate.
  assert.equal(nextDispatch([held, byRole, bySeat], runtime, seats), undefined)
  // Both targeting kinds, because they take different routes to the same freedom check and a
  // rule fixed on one of them would leave the other open.
  assert.equal(seatFor(seats, { kind: 'role', role: 'implementer' }), undefined)
  assert.equal(seatFor(seats, { kind: 'seat', seat: 'implementer' }), undefined)
  assert.match(refuseDispatch(seats[0]!, runtime) ?? '', /whose verdict is not graded/)

  // A positive control, so the assertion above is not passing because the queue was empty or
  // the targets never matched. Grade the held task and release the seat exactly as
  // `#grade`/`#integrate` do, and the very same queue dispatches on the next scan.
  runtime.get('t-1')!.grade = { outcome: 'completed', superseded: false }
  recordCompletion(runtime.get('t-1')!, 'integrated', 1)
  seats[0]!.current = undefined
  seats[0]!.state = 'idle'
  const chosen = nextDispatch([held, byRole, bySeat], runtime, seats)
  assert.equal(chosen?.task.id, 't-2', 'the lowest-seq ready task wins once the seat is free')
  assert.equal(chosen?.seat.seat, 'implementer')
  assert.equal(refuseDispatch(seats[0]!, runtime), undefined)
})

test('an advisor reply naming a target the run does not have fails closed', () => {
  const seats = [seat()]
  const unknownRole = parseDecisions('Do the thing.', seats, { kind: 'role', role: 'reviewer' })
  assert.deepEqual(unknownRole, {
    ok: false,
    why: 'unknown_target',
    detail: 'no seat fills the role reviewer',
  })
  const unknownSeat = parseDecisions('Do the thing.', seats, { kind: 'seat', seat: 'implementer-2' })
  assert.equal(unknownSeat.ok, false)

  // The same DISCRIMINANT an empty reply produces, which is the whole of what the loop reads.
  // `why` and `detail` exist for a future change that surfaces them on purpose; nothing
  // branches on them today, so an unparseable reply and an empty one cannot take different
  // paths however they came to fail.
  assert.deepEqual(parseDecisions('', seats, { kind: 'role', role: 'implementer' }), {
    ok: false,
    why: 'empty',
    detail: 'the reply carried no instruction',
  })

  // A BUSY seat is not a parse failure. That is a scheduling wait, and failing closed on it
  // would throw away work the advisor legitimately asked for.
  const busy = [seat({ state: 'running', current: 't-1' })]
  const parsed = parseDecisions('Do the thing.', busy, { kind: 'role', role: 'implementer' })
  assert.equal(parsed.ok, true)
})

test('a reply the dispatcher cannot admit takes the empty-instruction path, in those words', async (t) => {
  const dir = repo()
  // An exhausted script yields '', which is the reachable parse failure: no reply the advisor
  // can currently write carries a target, so `unknown_target` cannot be provoked through a run
  // until target syntax exists. What CAN be pinned is that the operator-visible path has no
  // branch left in it -- one sentence for every failure, and it is this one.
  const advisor = new FakeRotationSession('advisor-1', 'codex', [])
  const impl = new FakeRotationSession('impl-1', 'claude', ['ack'])
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())

  const outcome = await relay.run('build the thing')
  assert.equal(outcome.reason, 'escalated')
  assert.match(outcome.detail ?? '', /advisor produced no instruction/)

  const notes = relay.log.filter((m) => m.kind === 'note').map((m) => m.text)
  assert.ok(
    notes.some((n) => n.startsWith('advisor produced no instruction')),
    'the operator is told the reply produced no instruction',
  )
  // Nothing about targets, seats, roles or parsing reaches the operator. The dispatcher's
  // vocabulary is its own; the log stays the account of what moved between participants.
  assert.ok(!notes.some((n) => /target|parse|unparseable|role /i.test(n)), notes.join('\n'))
  // And nothing was admitted, because a failure admits nothing.
  assert.equal(relay.tasks().length, 0)
})

test('DONE and ESCALATE parse as decisions rather than as instructions', () => {
  const seats = [seat()]
  const target = { kind: 'role', role: 'implementer' } as const
  assert.deepEqual(parseDecisions('DONE', seats, target), {
    ok: true,
    decisions: [{ kind: 'done', instruction: 'DONE' }],
  })
  // Matched exactly as the round loop matched them: leading keyword, case-insensitive, and a
  // word boundary -- so `DONENESS` is an instruction and `done: the tests pass` is not.
  assert.equal(parseDecisions('done: the tests pass', seats, target).ok, true)
  assert.deepEqual(parseDecisions('doneness is not a verdict', seats, target), {
    ok: true,
    decisions: [{ kind: 'instruct', instruction: 'doneness is not a verdict', target }],
  })
  const escalated = parseDecisions('ESCALATE: the tests contradict the goal', seats, target)
  assert.equal(escalated.ok && escalated.decisions[0]?.kind, 'escalate')
})

test('role-targeted work goes to the longest-idle seat, with the id as tie-breaker', () => {
  const busiest = seat({ seat: 'b', idleSince: 500 })
  const longest = seat({ seat: 'a', idleSince: 100 })
  assert.equal(seatFor([busiest, longest], { kind: 'role', role: 'implementer' })?.seat, 'a')

  // Identical idle timestamps are not a coin toss. Map iteration order would make the choice
  // depend on insertion, which is not something a test can assert or an operator can predict.
  const tied = [seat({ seat: 'z', idleSince: 7 }), seat({ seat: 'q', idleSince: 7 })]
  assert.equal(seatFor(tied, { kind: 'role', role: 'implementer' })?.seat, 'q')

  // A seat targeted by id gets the work even when a longer-idle peer exists.
  assert.equal(seatFor([longest, busiest], { kind: 'seat', seat: 'b' })?.seat, 'b')
  // And a busy seat takes nothing, however it was targeted.
  assert.equal(seatFor([seat({ state: 'running', current: 't-9' })], { kind: 'seat', seat: 'implementer' }), undefined)
})

test('a blocked task does not hold the queue behind it', () => {
  const blocked = task({ id: 't-2', seq: 2, dependsOn: ['t-1'] })
  const free = task({ id: 't-3', seq: 3 })
  const runtime = new Map<string, TaskRuntime>([
    ['t-1', { state: 'running', marks: [] }],
    ['t-2', { state: 'admitted', marks: [] }],
    ['t-3', { state: 'ready', marks: [] }],
  ])
  // t-2 is older and cannot run; t-3 overtakes it. Head-of-line blocking on `dependsOn` would
  // idle every other seat for the length of a serial chain, which is the lockstep the
  // dispatcher exists to remove.
  assert.equal(nextDispatch([blocked, free], runtime, [seat()])?.task.id, 't-3')

  // Success, not merely terminality: a dependency that failed did not produce the state its
  // dependent was written against, so the dependent does not become ready off the back of it --
  // even though its report WAS routed before it failed.
  const routedThenFailed: TaskRuntime = { state: 'failed', routedAt: 5, marks: [] }
  assert.equal(dependenciesMet(blocked, new Map([['t-1', routedThenFailed]])), false)
  assert.equal(dependenciesMet(blocked, new Map([['t-1', { state: 'reported', marks: [] }]])), false)

  // Integration alone is not it either. A dependent is written against the advisor having heard
  // its dependency's report; whether that seat's tree merged is a question it has no stake in.
  const integratedOnly: TaskRuntime = { state: 'reported', integratedAt: 9, marks: [] }
  assert.equal(dependenciesMet(blocked, new Map([['t-1', integratedOnly]])), false)
  const routedOnly: TaskRuntime = { state: 'reported', routedAt: 9, marks: [] }
  assert.equal(dependenciesMet(blocked, new Map([['t-1', routedOnly]])), true)
})

test('integration and routing are independent facts, recorded in either order', () => {
  const dependent = task({ id: 't-2', seq: 2, dependsOn: ['t-1'] })

  // Routed FIRST, integrated later. This is the order N=1 never produces and the design
  // requires: reports dispatch to the advisor immediately, so a slow merge must not hold the
  // report back, and the merge landing afterwards must not erase the fact that it went.
  const routedFirst: TaskRuntime = { state: 'reported', marks: [] }
  recordCompletion(routedFirst, 'routed', 10)
  assert.equal(routedFirst.routedAt, 10)
  assert.equal(routedFirst.integratedAt, undefined)
  assert.equal(routedFirst.state, 'reported', 'one fact is not completion')
  assert.ok(routedSuccessfully(routedFirst))
  // The dependent is eligible on the routed fact alone, before integration has happened.
  assert.equal(dependenciesMet(dependent, new Map([['t-1', routedFirst]])), true)

  recordCompletion(routedFirst, 'integrated', 20)
  // Both facts survive. Under the old single-field model this second call overwrote `routed`
  // and the dependent above became permanently ineligible for something that had already
  // happened -- silently, because nothing was left that remembered it.
  assert.equal(routedFirst.routedAt, 10)
  assert.equal(routedFirst.integratedAt, 20)
  assert.equal(routedFirst.state, 'complete', 'terminal success needs both')
  assert.equal(dependenciesMet(dependent, new Map([['t-1', routedFirst]])), true)

  // Integrated first reaches exactly the same place, which is what "independent" has to mean.
  const integratedFirst: TaskRuntime = { state: 'reported', marks: [] }
  recordCompletion(integratedFirst, 'integrated', 30)
  assert.equal(integratedFirst.state, 'reported')
  assert.equal(dependenciesMet(dependent, new Map([['t-1', integratedFirst]])), false)
  recordCompletion(integratedFirst, 'routed', 40)
  assert.equal(integratedFirst.state, 'complete')
  assert.equal(integratedFirst.integratedAt, 30)
  assert.equal(integratedFirst.routedAt, 40)

  // A terminal failure is not overwritten by a boundary that ran anyway, and the fact is still
  // recorded -- what happened does not become less true because the task ended badly.
  const failed: TaskRuntime = { state: 'failed', marks: [] }
  recordCompletion(failed, 'routed', 50)
  recordCompletion(failed, 'integrated', 60)
  assert.equal(failed.state, 'failed')
  assert.equal(failed.routedAt, 50)
  assert.equal(failed.integratedAt, 60)
  assert.equal(routedSuccessfully(failed), false)
})

test('the queue and the seat table handed out share nothing with the originals', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor-1', 'codex', ['Do the thing.', 'DONE'])
  const impl = new FakeRotationSession('impl-1', 'claude', ['ack', 'Did it.', 'NONE'])
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())
  await relay.run('build the thing')

  // Only `Relay` mutates either structure (D4). A caller holding a live reference is the second
  // writer the rule exists to prevent, and the routing log would stop being able to say who
  // changed what. `readonly` on `Task` stops the compiler and stops nothing at runtime, so the
  // casts below are the check: they do exactly what a caller with a bug would do.
  const before = JSON.stringify(relay.tasks())
  const seatsBefore = JSON.stringify(relay.seats())

  const entry = relay.tasks()[0]!
  // Every level of the task record, not just its top: a shallow copy passes on the first line
  // here and fails on the third. `id` is left until last, deliberately -- a shared `id` breaks
  // the runtime lookup `tasks()` itself does, so mutating it first turns every assertion below
  // into a TypeError from inside the accessor, and a crash says far less about what went wrong
  // than a diff of the two structures does.
  ;(entry.task as { instruction: string }).instruction = 'do something else entirely'
  ;(entry.task as { target: { kind: string; role?: string } }).target.kind = 'seat'
  ;(entry.task.dependsOn as string[]).push('t-99')
  ;(entry.task.restrictedOrigins as number[]).push(42)

  // And every level of the runtime, including the verdict the grade was read off.
  entry.runtime.state = 'failed'
  entry.runtime.seat = 'somebody-else'
  entry.runtime.cancelledBy = 't-99'
  entry.runtime.integratedAt = -1
  entry.runtime.routedAt = -1
  entry.runtime.marks.push({ event: 'cancelled', ordinal: 999 })
  entry.runtime.marks[0]!.event = 'failed'
  entry.runtime.marks[0]!.ordinal = -1
  entry.runtime.grade!.outcome = 'timed_out'
  entry.runtime.grade!.superseded = true
  entry.runtime.end!.verdict.outcome = 'timed_out'
  entry.runtime.end!.verdict.confidence = 'assumed'
  entry.runtime.end!.verdict.provenance.push({ source: 'watchdog', detail: 'invented' })
  entry.runtime.end!.seq = -1

  const seatCopy = relay.seats()[0]!
  seatCopy.state = 'merge_blocked'
  seatCopy.current = 'invented'
  seatCopy.idleSince = -1
  seatCopy.dispatched = 99

  // Byte-for-byte what it was. Comparing the whole serialised structure rather than a handful
  // of fields is what makes this survive a field being added later: a new nested value that the
  // copy shares fails here without anyone having to remember to assert it.
  assert.equal(JSON.stringify(relay.tasks()), before)
  assert.equal(JSON.stringify(relay.seats()), seatsBefore)
  // Spot-checked as well as compared, so a failure says which invariant broke rather than
  // printing two long JSON blobs at each other.
  assert.equal(relay.tasks()[0]?.task.instruction, 'Do the thing.')
  assert.deepEqual(relay.tasks()[0]?.task.dependsOn, [])
  assert.equal(relay.tasks()[0]?.runtime.state, 'complete')
  assert.ok(relay.tasks()[0]!.runtime.integratedAt! > 0)
  assert.ok(relay.tasks()[0]!.runtime.routedAt! > 0)
  assert.equal(relay.tasks()[0]?.runtime.grade?.outcome, 'completed')
  assert.equal(relay.tasks()[0]?.runtime.end?.verdict.outcome, 'completed')
  assert.equal(relay.tasks()[0]?.runtime.end?.verdict.provenance.length, 1)
  assert.ok(!relay.tasks()[0]?.runtime.marks.some((m) => m.event === 'cancelled'))
  assert.equal(relay.seats()[0]?.state, 'idle')
  assert.equal(relay.seats()[0]?.current, undefined)

  // The dispatcher is still able to schedule against its own state after all that, which is the
  // thing a shared reference would actually have broken.
  assert.equal(refuseDispatch(relay.seats()[0]!, new Map()), undefined)

  // Last, because a shared `id` does not merely leak state -- it desynchronises the queue from
  // the runtime map keyed on it, and `tasks()` throws on the very next call. Asserted rather
  // than left implicit: the id is the one field the dispatcher looks work up by.
  ;(relay.tasks()[0]!.task as { id: string }).id = 'rewritten'
  assert.equal(relay.tasks()[0]?.task.id, 't-1')
})
