/**
 * The dispatcher at N=1, and the rules it will still be following at N>1.
 *
 * Two things are being pinned here, and they are pinned differently.
 *
 * **The schedule.** At N=1 the dispatcher must produce exactly the turn sequence the exchange
 * loop it replaced produced: advisor, implementer, advisor, implementer, and a closing
 * question. Asserted
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
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type { AgentSession, TurnKey } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { tempDir } from '../testkit/tempDir.ts'
import { MAX_TURN_BUDGET_MIN, canTake, cancelledByFailedDependencies, dependenciesMet, isFree, nextDispatch, parseDecisions, recordCompletion, refuseDispatch, routedSuccessfully, seatFor, type SeatExecution, type Task, type TaskEvent, type TaskGrade, type TaskRuntime, type TaskTarget } from './dispatch.ts'
import { InvariantViolatedError, Relay, type RelayOptions } from './relay.ts'

function repo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-dispatch')
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
    maxAdvisorTurns: 4,
    ...over,
  })
}

/** The ordinal a task's transition was stamped with, or -1 if it never happened. */
function at(runtime: TaskRuntime, event: TaskEvent): number {
  return runtime.marks.find((m) => m.event === event)?.ordinal ?? -1
}

test('#74 an invariant the orchestrator broke is not reported as a transport failure', async (t) => {
  // The reason the invariant above is worth having, and what #74 asks for: `#loop` catches
  // everything a run can throw and reported all of it as `transport_failed`. That tells the
  // operator the connection to a child failed. Nothing did -- they go and check the CLI, the
  // network and the provider, and every one of them is fine.
  //
  // Injected rather than provoked, and that is deliberate. The throw it stands for is
  // `#assign` refusing a seat `nextDispatch` chose, which the test above asserts CANNOT happen
  // and which the code is written to keep unreachable. Provoking it would mean breaking the
  // invariant on purpose to watch the guard fire, and the guard is not what would be tested
  // then. What is tested here is the mapping: this error class, out of the loop, must not land
  // in the transport bucket.
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor-1', 'codex', ['Do the thing.', 'DONE'])
  const impl = new FakeRotationSession('impl-1', 'claude', ['ack', 'Did it.', 'NONE'])
  impl.onSend = () => {
    throw new InvariantViolatedError(
      'a seat chosen by nextDispatch is accepted by refuseDispatch',
      'dispatcher refused t-1: implementer still holds t-0, whose verdict is not graded',
    )
  }
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())

  const outcome = await relay.run('build the thing')

  assert.equal(outcome.reason, 'invariant_violated', `the ending must name it: ${JSON.stringify(outcome)}`)
  assert.notEqual(outcome.reason, 'transport_failed', 'no transport was asked to carry anything')
  // The invariant, not only the message. A reader should not have to parse prose to learn
  // which rule broke, and the detail is where an operator meets it.
  assert.match(outcome.detail ?? '', /a seat chosen by nextDispatch is accepted by refuseDispatch/)
  assert.match(outcome.detail ?? '', /dispatcher refused t-1/, 'and what it was doing at the time')
})

test('#74 every seat nextDispatch picks is one refuseDispatch accepts', () => {
  // THE invariant, asserted directly. `#assign` calls `refuseDispatch` on the seat
  // `nextDispatch` already chose through `seatFor`, so a refusal there is the dispatcher
  // contradicting itself -- "a dispatcher deadlocking on itself", as `refuseDispatch` puts it.
  //
  // Worth stating as a property rather than as one example, because the throw it guards is
  // unreachable at N=1 by construction and is meant to stay unreachable at N>1. A test that
  // only checked the error type would pass while the invariant itself rotted.
  const states: SeatExecution['state'][] = ['idle', 'running', 'integrating', 'merge_blocked']
  const targets: Task['target'][] = [
    { kind: 'role', role: 'implementer' },
    { kind: 'seat', seat: 'implementer' },
    { kind: 'seat', seat: 'implementer-2' },
  ]
  // Ungraded is the case `refuseDispatch` exists for, so both sides of it are covered.
  const grades: (TaskGrade | undefined)[] = [
    undefined,
    { outcome: 'completed', superseded: false },
    { outcome: 'timed_out', superseded: true },
  ]

  let picked = 0
  for (const state of states) {
    for (const target of targets) {
      for (const grade of grades) {
        for (const current of [undefined, 't-held']) {
          const t = task({ id: 't-1', seq: 1, target })
          const seats = [seat({ state, ...(current === undefined ? {} : { current }) })]
          const runtime = new Map<string, TaskRuntime>([
            ['t-1', { state: 'ready', marks: [] }],
            ['t-held', { state: 'assigned', seat: 'implementer', marks: [], ...(grade ? { grade } : {}) }],
          ])
          const d = nextDispatch([t], runtime, seats)
          if (!d) continue
          picked += 1
          assert.equal(
            refuseDispatch(d.seat, runtime, d.task),
            undefined,
            `nextDispatch chose ${d.seat.seat} for ${d.task.id} (state=${state}, held=${current}, ` +
              `grade=${grade?.outcome ?? 'ungraded'}) and refuseDispatch then refused it`,
          )
        }
      }
    }
  }
  // The loop must actually have exercised dispatches, or it asserts nothing at all.
  assert.ok(picked > 0, `no combination produced a dispatch to check (${picked})`)
})

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
    purpose: 'work',
    dependsOn: [],
    restrictedOrigins: [],
    admittedAt: 0,
    ...over,
  }
}

test('the N=1 schedule is advisor, implementer, advisor, implementer, and a closing question', async (t) => {
  const dir = repo(t)
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
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor-1', 'codex', [
    'Do the first thing.',
    'Do the second thing.',
    'Do the third thing.',
    'DONE',
  ])
  const impl = new FakeRotationSession('impl-1', 'claude', ['ack', 'one', 'two', 'three', 'NONE'])
  const relay = await relayOf(dir, advisor, impl, { maxAdvisorTurns: 5 })
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
  const dir = repo(t)
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
  const dir = repo(t)
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
  const dir = repo(t)
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
  const dir = repo(t)
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
  assert.equal(seatFor(seats, { target: { kind: 'role', role: 'implementer' }, purpose: 'work' }), undefined)
  assert.equal(seatFor(seats, { target: { kind: 'seat', seat: 'implementer' }, purpose: 'work' }), undefined)
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
    // The fallback is the ORCHESTRATOR's target: this reply named nobody, even though the
    // refusal is about a target. See `ParseRefusal.named`.
    form: 'unaddressed',
    named: [],
    why: 'unknown_target',
    detail: 'no seat fills the role reviewer',
  })
  const unknownSeat = parseDecisions('Do the thing.', seats, { kind: 'seat', seat: 'implementer-2' })
  assert.equal(unknownSeat.ok, false)

  // The same DISCRIMINANT an empty reply produces, which is the whole of what the DISPATCH path
  // reads: `ok` is false either way, so an unparseable reply and an empty one still halt and
  // re-ask identically however they came to fail.
  //
  // `form`, `named`, `why` and `detail` ride alongside for the instrument (#79), which does read
  // them -- an addressed refusal is counted as the advisor having used the syntax. That is an
  // OBSERVATION and changes no path here; `assignmentSyntax.test.ts` pins what each refusal
  // carries.
  assert.deepEqual(parseDecisions('', seats, { kind: 'role', role: 'implementer' }), {
    ok: false,
    form: 'unaddressed',
    named: [],
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
  const dir = repo(t)
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
  // `form` rides along on every ok result (#79). `unaddressed` here is not incidental: DONE and
  // ESCALATE are reachable ONLY from the no-directive path -- an addressed reply carrying either
  // is a `mixed_keyword` refusal -- so a `done` decision that ever reported `addressed` would
  // mean the parser had admitted the reply it exists to refuse.
  assert.deepEqual(parseDecisions('DONE', seats, target), {
    ok: true,
    form: 'unaddressed',
    decisions: [{ kind: 'done', instruction: 'DONE' }],
  })
  // Matched exactly as the exchange loop this replaced matched them: leading keyword, case-insensitive, and a
  // word boundary -- so `DONENESS` is an instruction and `done: the tests pass` is not.
  assert.equal(parseDecisions('done: the tests pass', seats, target).ok, true)
  assert.deepEqual(parseDecisions('doneness is not a verdict', seats, target), {
    ok: true,
    form: 'unaddressed',
    decisions: [{ kind: 'instruct', instruction: 'doneness is not a verdict', target }],
  })
  const escalated = parseDecisions('ESCALATE: the tests contradict the goal', seats, target)
  assert.equal(escalated.ok && escalated.decisions[0]?.kind, 'escalate')
})

test('role-targeted work goes to the longest-idle seat, with the id as tie-breaker', () => {
  const busiest = seat({ seat: 'b', idleSince: 500 })
  const longest = seat({ seat: 'a', idleSince: 100 })
  assert.equal(seatFor([busiest, longest], { target: { kind: 'role', role: 'implementer' }, purpose: 'work' })?.seat, 'a')

  // Identical idle timestamps are not a coin toss. Map iteration order would make the choice
  // depend on insertion, which is not something a test can assert or an operator can predict.
  const tied = [seat({ seat: 'z', idleSince: 7 }), seat({ seat: 'q', idleSince: 7 })]
  assert.equal(seatFor(tied, { target: { kind: 'role', role: 'implementer' }, purpose: 'work' })?.seat, 'q')

  // A seat targeted by id gets the work even when a longer-idle peer exists.
  assert.equal(seatFor([longest, busiest], { target: { kind: 'seat', seat: 'b' }, purpose: 'work' })?.seat, 'b')
  // And a busy seat takes nothing, however it was targeted.
  assert.equal(seatFor([seat({ state: 'running', current: 't-9' })], { target: { kind: 'seat', seat: 'implementer' }, purpose: 'work' }), undefined)
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
  const dir = repo(t)
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

// ---------------------------------------------------------------------------
// Work that can never run is taken out of the queue, rather than detected in it.
// ---------------------------------------------------------------------------

/**
 * What `Relay.#cancelUnrunnable` does with the sweep, minus the marks it stamps.
 *
 * The transition belongs to the relay -- only it owns the objects and the ordinal counter --
 * so a test of the rule has to perform it. Kept to the two fields the relay writes, so this
 * cannot pass by doing something the production path does not.
 */
function applySweep(queue: readonly Task[], runtime: Map<string, TaskRuntime>): string[] {
  const swept = cancelledByFailedDependencies(queue, runtime)
  for (const { task, cancelledBy } of swept) {
    const r = runtime.get(task.id)!
    r.state = 'cancelled'
    r.cancelledBy = cancelledBy
  }
  return swept.map((s) => s.task.id)
}

test('a failed task takes its dependents and their dependents out of the queue', () => {
  // The state this prevents: `dependenciesMet` reads a PERSISTENT routed fact, so t-1 keeps
  // having failed and t-2 can never become ready. Left alone it sits at `admitted` forever --
  // no seat holds it, nothing is outstanding, every individual state reports healthy, and the
  // run simply stops progressing. That is why this is a sweep and not a detector.
  const queue = [
    task({ id: 't-1', seq: 1 }),
    task({ id: 't-2', seq: 2, dependsOn: ['t-1'] }),
    task({ id: 't-3', seq: 3, dependsOn: ['t-2'] }),
  ]
  const runtime = new Map<string, TaskRuntime>([
    ['t-1', { state: 'failed', routedAt: 5, marks: [] }],
    ['t-2', { state: 'admitted', marks: [] }],
    ['t-3', { state: 'admitted', marks: [] }],
  ])

  assert.equal(dependenciesMet(queue[1]!, runtime), false, 'the dependent could never have become ready')
  assert.deepEqual(applySweep(queue, runtime), ['t-2', 't-3'])
  // Each records the dependency that killed it, not the bare fact: t-3 died of t-2, which is
  // the edge the operator has to walk back to reach t-1. A shared cause would say all three
  // failed together, which is not what happened.
  assert.equal(runtime.get('t-2')?.cancelledBy, 't-1')
  assert.equal(runtime.get('t-3')?.cancelledBy, 't-2')
  assert.equal(runtime.get('t-1')?.state, 'failed', 'the causal task keeps its own terminal state')

  // The FAILED dependency, not merely the first one listed. With one edge per task the two
  // are the same string and a sweep recording either would pass everything above, which is
  // the kind of agreement that only holds until a task has two dependencies.
  const multi = [
    task({ id: 'm-1', seq: 1 }),
    task({ id: 'm-2', seq: 2 }),
    task({ id: 'm-3', seq: 3, dependsOn: ['m-1', 'm-2'] }),
  ]
  const mixed = new Map<string, TaskRuntime>([
    ['m-1', { state: 'complete', routedAt: 1, integratedAt: 2, marks: [] }],
    ['m-2', { state: 'failed', marks: [] }],
    ['m-3', { state: 'admitted', marks: [] }],
  ])
  assert.deepEqual(applySweep(multi, mixed), ['m-3'])
  assert.equal(mixed.get('m-3')?.cancelledBy, 'm-2')
})

test('the sweep reaches the whole chain in one pass, in seq order', () => {
  // A four-deep chain, admitted out of order, so passing this cannot be an artifact of the
  // queue happening to be sorted. One pass, because a sweep that took a hop per dispatch
  // boundary would leave the tail queued in exactly the state it exists to remove.
  const queue = [
    task({ id: 't-4', seq: 4, dependsOn: ['t-3'] }),
    task({ id: 't-2', seq: 2, dependsOn: ['t-1'] }),
    task({ id: 't-3', seq: 3, dependsOn: ['t-2'] }),
    task({ id: 't-1', seq: 1 }),
  ]
  const runtime = new Map<string, TaskRuntime>([
    ['t-1', { state: 'cancelled', marks: [] }],
    ['t-2', { state: 'ready', marks: [] }],
    ['t-3', { state: 'admitted', marks: [] }],
    ['t-4', { state: 'admitted', marks: [] }],
  ])
  // A CANCELLED dependency propagates as a failed one does, which is what makes the chain
  // transitive at all: every hop past the first is a dependency on something this same sweep
  // cancelled a moment ago.
  assert.deepEqual(applySweep(queue, runtime), ['t-2', 't-3', 't-4'])
  assert.deepEqual(
    ['t-2', 't-3', 't-4'].map((id) => runtime.get(id)?.cancelledBy),
    ['t-1', 't-2', 't-3'],
  )
})

test('unrelated ready work survives the sweep and is still dispatchable', () => {
  // The false-positive case, and it matters more than the positive one: a sweep that took out
  // work with no failed dependency would silently delete the run's remaining agenda, and
  // nothing downstream would report anything wrong.
  const queue = [
    task({ id: 't-1', seq: 1 }),
    task({ id: 't-2', seq: 2, dependsOn: ['t-1'] }),
    task({ id: 't-3', seq: 3 }),
    task({ id: 't-4', seq: 4, dependsOn: ['t-3'] }),
  ]
  const runtime = new Map<string, TaskRuntime>([
    ['t-1', { state: 'failed', marks: [] }],
    ['t-2', { state: 'admitted', marks: [] }],
    ['t-3', { state: 'ready', marks: [] }],
    ['t-4', { state: 'admitted', marks: [] }],
  ])
  assert.deepEqual(applySweep(queue, runtime), ['t-2'], 'only the dependent of the failure')
  assert.equal(runtime.get('t-3')?.state, 'ready')
  assert.equal(runtime.get('t-4')?.state, 'admitted', 'blocked on work that has not failed, so still waiting')
  assert.equal(runtime.get('t-3')?.cancelledBy, undefined)
  // And the dispatcher can still see it. The sweep runs immediately before `nextDispatch`, so
  // "survived" has to mean dispatchable rather than merely still present in the queue.
  assert.equal(nextDispatch(queue, runtime, [seat()])?.task.id, 't-3')
})

test('the sweep leaves work that already belongs to a seat alone', () => {
  // `admitted` and `ready` only. Anything further along is a seat's turn to finish, and
  // cancelling it from the queue side would abandon a child mid-turn -- a running task's
  // dependency having failed does not make the turn it is executing stop existing.
  const queue = [
    task({ id: 't-1', seq: 1 }),
    task({ id: 't-2', seq: 2, dependsOn: ['t-1'] }),
    task({ id: 't-3', seq: 3, dependsOn: ['t-1'] }),
  ]
  const runtime = new Map<string, TaskRuntime>([
    ['t-1', { state: 'failed', marks: [] }],
    ['t-2', { state: 'running', seat: 'implementer', marks: [] }],
    ['t-3', { state: 'reported', marks: [] }],
  ])
  assert.deepEqual(cancelledByFailedDependencies(queue, runtime), [])
})

test('a queue with nothing failed in it is untouched', () => {
  const queue = [task({ id: 't-1', seq: 1 }), task({ id: 't-2', seq: 2, dependsOn: ['t-1'] })]
  const runtime = new Map<string, TaskRuntime>([
    ['t-1', { state: 'ready', marks: [] }],
    ['t-2', { state: 'admitted', marks: [] }],
  ])
  assert.deepEqual(cancelledByFailedDependencies(queue, runtime), [])
  const done = new Map<string, TaskRuntime>([
    ['t-1', { state: 'complete', routedAt: 3, integratedAt: 4, marks: [] }],
    ['t-2', { state: 'admitted', marks: [] }],
  ])
  assert.deepEqual(cancelledByFailedDependencies(queue, done), [], 'a satisfied dependency is not a failure')
  assert.equal(dependenciesMet(queue[1]!, done), true)
})

test('the sweep is wired into the dispatch boundary and cancels nothing in a real run', async (t) => {
  // The wiring, and the whole of what can be observed of it today: no advisor reply can carry
  // a dependency, so `dependsOn` is empty on every admitted task and the sweep has nothing to
  // condemn. Asserted anyway, because "runs at the dispatch boundary and is inert" is the
  // claim being made -- a sweep that cancelled work in an ordinary run would be the worst
  // possible regression and nothing else in the suite is watching for it.
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor-1', 'codex', ['Do the thing.', 'And again.', 'DONE'])
  const impl = new FakeRotationSession('impl-1', 'claude', ['ack', 'Did it.', 'ack', 'Did that too.', 'NONE'])
  const relay = await relayOf(dir, advisor, impl, { maxAdvisorTurns: 5 })
  t.after(() => relay.stop())
  await relay.run('build the thing')

  const tasks = relay.tasks()
  assert.ok(tasks.length >= 2, 'more than one dispatch boundary was crossed')
  for (const { task: admitted, runtime } of tasks) {
    assert.deepEqual(admitted.dependsOn, [], 'nothing can express an edge yet')
    assert.notEqual(runtime.state, 'cancelled')
    assert.equal(runtime.cancelledBy, undefined)
    assert.ok(!runtime.marks.some((m) => m.event === 'cancelled'))
  }
})

/**
 * The one thing a behavioural test cannot reach: that the sweep is CALLED.
 *
 * Deleting `this.#cancelUnrunnable()` from the dispatch loop changes nothing observable
 * today. No advisor reply can carry a dependency and nothing anywhere sets a task's state to
 * `failed`, so the sweep condemns nothing in any run that can be constructed through the
 * public API — every behavioural assertion in this file passes with the call removed. That
 * was measured, not assumed: the mutation survived the whole suite.
 *
 * So the wiring is pinned by reading the source. That is a blunt instrument and it is the
 * honest one here: the alternative is a test-only injection point in `Relay`, which is
 * production API existing for a test's benefit, and the whole reason this sweep was built
 * instead of a detector is that machinery nobody can check is worse than none.
 *
 * It goes stale the day the call is renamed or moved, which is the intended failure: both
 * are exactly the change that must not happen silently.
 */
test('Relay calls #cancelUnrunnable immediately before nextDispatch (source inspection)', () => {
  const src = readFileSync(new URL('./relay.ts', import.meta.url), 'utf8')

  // One dispatch boundary, so "before nextDispatch" names a single place. If a second one is
  // ever added, this fails and whoever added it has to sweep there too — which is the real
  // requirement, and the reason this counts rather than merely finding.
  assert.equal(src.split('nextDispatch(').length - 1, 1, 'exactly one dispatch boundary in relay.ts')
  const call = src.indexOf('this.#cancelUnrunnable()')
  const boundary = src.indexOf('nextDispatch(')
  assert.notEqual(call, -1, 'the dispatch loop calls the sweep')
  assert.ok(call < boundary, 'the sweep runs BEFORE the queue is asked what to do next')

  // Immediately before: nothing between the two but comments. A statement slipped in here
  // would be a statement that reads or schedules against a queue still holding work nothing
  // can ever run, which is the state the sweep exists to have already removed.
  const between = src.slice(call + 'this.#cancelUnrunnable()'.length, src.lastIndexOf('\n', boundary))
  for (const line of between.split('\n').map((l) => l.trim())) {
    assert.ok(
      line === '' || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*'),
      `only comments may sit between the sweep and the dispatch, found: ${line}`,
    )
  }
})

/**
 * A blocked seat is reachable by NAME and by nothing else.
 *
 * The two halves are one rule and are asserted together, because either alone is a bug. Only
 * excluding it strands the conflict: the sole way out is a task that resolves it in that
 * seat's own worktree, and a seat nothing can be sent to is a seat nothing can repair. Only
 * including it makes the block decorative: ordinary work keeps landing there, every task adds
 * another commit to a branch that will not merge, and the conflict grows while the run reports
 * healthy.
 */
test('a merge_blocked seat takes a task addressed to it, and no role-targeted work at all', () => {
  const blocked = seat({ seat: 'impl-a', state: 'merge_blocked' })
  const free = seat({ seat: 'impl-b', state: 'idle', idleSince: 5 })
  const byRole: TaskTarget = { kind: 'role', role: 'implementer' }
  const byName: TaskTarget = { kind: 'seat', seat: 'impl-a' }

  assert.equal(canTake(blocked, { target: byRole, purpose: 'work' }), false, 'ordinary work must route past a blocked seat')
  assert.equal(canTake(blocked, { target: byName, purpose: 'merge_resolution' }), true, 'the repair has to be able to reach it')
  assert.equal(isFree(blocked), false, 'and it is still not FREE — the two questions differ')

  // Addressing is NOT enough, and this is the loophole the purpose field closes. An ordinary
  // task that merely names the seat is still ordinary work landing on a branch that will not
  // merge — every turn adding another commit to the conflict while the run reports healthy.
  assert.equal(canTake(blocked, { target: byName, purpose: 'work' }), false)
  // Nor is the purpose enough on its own: a repair designated for one seat must not be able to
  // unlock a different blocked seat, and a role-targeted "repair" names no tree to resolve in.
  assert.equal(canTake(blocked, { target: { kind: 'seat', seat: 'impl-b' }, purpose: 'merge_resolution' }), false)
  assert.equal(canTake(blocked, { target: byRole, purpose: 'merge_resolution' }), false)
  // A free seat is unaffected by any of it: purpose gates a BLOCKED seat and nothing else.
  assert.equal(canTake(free, { target: byRole, purpose: 'work' }), true)
  assert.equal(canTake(free, { target: { kind: 'seat', seat: 'impl-b' }, purpose: 'merge_resolution' }), true)

  // Role-targeted work goes to the other seat even though the blocked one has been idle
  // longer, which is the ordering rule losing to the block on purpose.
  assert.equal(seatFor([blocked, free], { target: byRole, purpose: 'work' })?.seat, 'impl-b')
  assert.equal(seatFor([blocked, free], { target: byName, purpose: 'merge_resolution' })?.seat, 'impl-a')

  // The last seat standing does not make a blocked one eligible: a run whose only compatible
  // seat is blocked has nowhere to put role-targeted work, and waiting is the correct answer.
  assert.equal(seatFor([blocked], { target: byRole, purpose: 'work' }), undefined)

  // `refuseDispatch` must agree with `seatFor`, or the dispatcher deadlocks on itself: a seat
  // the scan chose and the guard then refused would throw an invariant violation.
  assert.equal(refuseDispatch(blocked, new Map(), { target: byName, purpose: 'merge_resolution' }), undefined)
  assert.match(refuseDispatch(blocked, new Map(), { target: byRole, purpose: 'work' }) ?? '', /impl-a is merge_blocked/)
  assert.match(refuseDispatch(blocked, new Map(), { target: byName, purpose: 'work' }) ?? '', /impl-a is merge_blocked/)
  assert.match(refuseDispatch(blocked, new Map()) ?? '', /impl-a is merge_blocked/)

  // And a blocked seat holding a turn is still busy first. Blocked is about where work may
  // go next, not about abandoning work in flight.
  const busy = seat({ seat: 'impl-a', state: 'merge_blocked', current: 't-9' })
  assert.equal(canTake(busy, { target: byName, purpose: 'merge_resolution' }), false)
})

/**
 * A `review_blocked` seat, the same rule as `merge_blocked` with `review_resolution` in
 * place of `merge_resolution` (#72). Mirrors the test above deliberately: the two purposes
 * are gated by an identical shape, and a divergence between them would be a bug in whichever
 * one this test does not also cover.
 */
test('a review_blocked seat takes a task addressed to it, and no role-targeted work at all', () => {
  const blocked = seat({ seat: 'impl-a', state: 'review_blocked' })
  const free = seat({ seat: 'impl-b', state: 'idle', idleSince: 5 })
  const byRole: TaskTarget = { kind: 'role', role: 'implementer' }
  const byName: TaskTarget = { kind: 'seat', seat: 'impl-a' }

  assert.equal(canTake(blocked, { target: byRole, purpose: 'work' }), false, 'ordinary work must route past a blocked seat')
  assert.equal(canTake(blocked, { target: byName, purpose: 'review_resolution' }), true, 'the repair has to be able to reach it')
  assert.equal(isFree(blocked), false, 'and it is still not FREE — the two questions differ')

  // Addressing alone is not enough, same as merge_resolution.
  assert.equal(canTake(blocked, { target: byName, purpose: 'work' }), false)
  // Nor is a `merge_resolution` purpose -- the two blocked-state gates must not cross-unlock
  // each other, since they answer different questions (a git conflict vs. a review verdict).
  assert.equal(canTake(blocked, { target: byName, purpose: 'merge_resolution' }), false)
  // Nor is the purpose enough on its own without the right seat named.
  assert.equal(canTake(blocked, { target: { kind: 'seat', seat: 'impl-b' }, purpose: 'review_resolution' }), false)
  assert.equal(canTake(blocked, { target: byRole, purpose: 'review_resolution' }), false)
  // A free seat is unaffected: purpose gates a BLOCKED seat and nothing else.
  assert.equal(canTake(free, { target: byRole, purpose: 'work' }), true)
  assert.equal(canTake(free, { target: { kind: 'seat', seat: 'impl-b' }, purpose: 'review_resolution' }), true)

  // A `merge_blocked` seat must not be reachable by a `review_resolution` task, symmetrically.
  const mergeBlocked = seat({ seat: 'impl-c', state: 'merge_blocked' })
  assert.equal(canTake(mergeBlocked, { target: { kind: 'seat', seat: 'impl-c' }, purpose: 'review_resolution' }), false)

  // `review_pending` grants NOTHING: there is no repair to dispatch until a verdict exists,
  // unlike a blocked seat which at least has a designated way out.
  const pending = seat({ seat: 'impl-d', state: 'review_pending' })
  assert.equal(isFree(pending), false)
  assert.equal(canTake(pending, { target: { kind: 'seat', seat: 'impl-d' }, purpose: 'review_resolution' }), false)
  assert.equal(canTake(pending, { target: { kind: 'seat', seat: 'impl-d' }, purpose: 'work' }), false)

  assert.equal(seatFor([blocked, free], { target: byRole, purpose: 'work' })?.seat, 'impl-b')
  assert.equal(seatFor([blocked, free], { target: byName, purpose: 'review_resolution' })?.seat, 'impl-a')
  assert.equal(seatFor([blocked], { target: byRole, purpose: 'work' }), undefined)

  assert.equal(refuseDispatch(blocked, new Map(), { target: byName, purpose: 'review_resolution' }), undefined)
  assert.match(refuseDispatch(blocked, new Map(), { target: byRole, purpose: 'work' }) ?? '', /impl-a is review_blocked/)
  assert.match(refuseDispatch(pending, new Map()) ?? '', /impl-d is review_pending/)
})

test('a queue scan sends the repair to the blocked seat and ordinary work to its neighbour', () => {
  const repair = task({ id: 't-1', seq: 1, target: { kind: 'seat', seat: 'impl-a' }, purpose: 'merge_resolution' })
  const impostor = task({ id: 't-0', seq: 0, target: { kind: 'seat', seat: 'impl-a' } })
  const ordinary = task({ id: 't-2', seq: 2, target: { kind: 'role', role: 'implementer' } })
  const runtime = new Map<string, TaskRuntime>([
    ['t-0', { state: 'ready', marks: [] }],
    ['t-1', { state: 'ready', marks: [] }],
    ['t-2', { state: 'ready', marks: [] }],
  ])
  const seats = [seat({ seat: 'impl-a', state: 'merge_blocked' }), seat({ seat: 'impl-b', idleSince: 9 })]

  // `t-0` is ordinary work addressed at the blocked seat and has the LOWEST seq, so a scan that
  // let addressing alone through would pick it first. It goes nowhere.
  const first = nextDispatch([impostor, repair, ordinary], runtime, seats)
  assert.equal(first?.task.id, 't-1')
  assert.equal(first?.seat.seat, 'impl-a', 'the repair is addressed and must arrive')

  // With the repair taken out, the ordinary task still refuses to land on the blocked seat.
  runtime.get('t-1')!.state = 'running'
  const second = nextDispatch([impostor, repair, ordinary], runtime, seats)
  assert.equal(second?.task.id, 't-2')
  assert.equal(second?.seat.seat, 'impl-b')
})

test('#193 an advisor can ask for a larger turn, and the request rides the task', () => {
  // `deadlines.ts` states the ordinary rule: the clocks are the policy a seat is under for the
  // WHOLE run. An advisor delegating a deliberately larger chunk had no way to say "this one is
  // big", and the operator's only lever was raising the clock for every turn -- which gives up
  // the instrument everywhere to accommodate a few.
  //
  // Spelled on the directive that already addresses the seat, so the advisor is not learning a
  // second convention for the same idea.
  const r = parseDecisions('@seat implementer +90m: Rewrite the parser and its tests.', [seat()], { kind: 'role', role: 'implementer' })
  assert.ok(r.ok)
  assert.equal(r.decisions.length, 1)
  const d = r.decisions[0]!
  assert.equal(d.kind, 'instruct')
  assert.equal(d.kind === 'instruct' ? d.budgetMin : undefined, 90)
  assert.equal(d.kind === 'instruct' ? d.instruction : '', 'Rewrite the parser and its tests.')
})

test('#193 a directive without a budget is unchanged, body and all', () => {
  // The ordinary case has to stay exactly as it was: the optional group must not eat any part of
  // a normal instruction.
  const r = parseDecisions('@seat implementer: Do the ordinary thing.', [seat()], { kind: 'role', role: 'implementer' })
  assert.ok(r.ok)
  const d = r.decisions[0]!
  assert.equal(d.kind === 'instruct' ? d.budgetMin : 'set', undefined)
  assert.equal(d.kind === 'instruct' ? d.instruction : '', 'Do the ordinary thing.')
})

test('#193 a budget past the ceiling is refused, not clamped', () => {
  // Clamping would grant a number nobody asked for and let the advisor believe it had more time
  // than it has -- the same class of falsehood as a report naming a model the seat is not on.
  const r = parseDecisions(`@seat implementer +${MAX_TURN_BUDGET_MIN + 1}m: Too much.`, [seat()], { kind: 'role', role: 'implementer' })
  assert.equal(r.ok, false)
  assert.equal(r.ok === false ? r.why : '', 'budget_out_of_range')
  assert.match(r.ok === false ? r.detail : '', new RegExp(String(MAX_TURN_BUDGET_MIN)))
})

test('#193 a zero budget is refused too', () => {
  // `+0m` is not "no budget", it is a request for a turn that cannot finish. Refusing says so
  // rather than arming a clock that fires immediately.
  const r = parseDecisions('@seat implementer +0m: Nothing.', [seat()], { kind: 'role', role: 'implementer' })
  assert.equal(r.ok, false)
  assert.equal(r.ok === false ? r.why : '', 'budget_out_of_range')
})

test('#193 the budget belongs to one directive, not to the reply', () => {
  // Two seats, one asking for more. A request that leaked to its neighbour would widen a clock
  // nobody asked to widen.
  const r = parseDecisions(
    ['@seat implementer +30m: The big one.', '@seat implementer-2: The ordinary one.'].join('\n'),
    [seat(), seat({ seat: 'implementer-2' })],
    { kind: 'role', role: 'implementer' },
  )
  assert.ok(r.ok)
  assert.equal(r.decisions[0]!.kind === 'instruct' ? r.decisions[0]!.budgetMin : undefined, 30)
  assert.equal(r.decisions[1]!.kind === 'instruct' ? r.decisions[1]!.budgetMin : 'set', undefined)
})
