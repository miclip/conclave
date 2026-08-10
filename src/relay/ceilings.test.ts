/**
 * Ceilings as a RUN-ENDING condition, and as a capability both front-ends have.
 *
 * `guardrails.test.ts` pins the comparisons. This pins the two things that file cannot see:
 * that a ceiling reaches the dispatcher and stops a real run, and that it does so whichever
 * command started it.
 *
 * ## Why the front-end half is asserted behaviourally
 *
 * `frontEndParity.test.ts` compares which flags EXIST, and that is how #69 slipped past it:
 * `--record` was parsed by both front-ends and used by neither, which looks identical to
 * working at every point in the source. A ceiling is the worst place for that bug, because
 * the operator's belief that the run is bounded is the whole product. So these run the CLI
 * and check that the run actually STOPPED, at the exit code an unattended caller reads.
 *
 * ## Why the gauge tests use zero
 *
 * At N=1 the queue never holds more than the one task the advisor just asked for, and one
 * seat can never be two. So `--max-queue-depth 0` and `--max-concurrent-seats 0` are the only
 * values that can fire in a default run -- not a contrivance, but the honest consequence of
 * there being one seat. `0` is a real setting rather than a test-only trick: it means "never
 * let work wait" and "never let a seat work", and both are coherent asks. The comparisons at
 * every other value are pinned in `guardrails.test.ts`, where they can be exercised.
 *
 *   node --test src/relay/ceilings.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import { main } from '../../bin/conclave.ts'
import type { AgentSession } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { concurrentSeats, queueDepth, type SeatExecution, type Task, type TaskRuntime } from './dispatch.ts'
import { Relay, type RelayOptions } from './relay.ts'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-ceilings-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'work.ts'), 'export const answer = 42\n')
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
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

async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const [log, error] = [console.log, console.error]
  console.log = () => {}
  console.error = () => {}
  try {
    return await work()
  } finally {
    console.log = log
    console.error = error
  }
}

function sink(): NodeJS.WritableStream {
  return new Writable({
    write(_c, _e, cb) {
      cb()
    },
  })
}

/** An advisor that keeps steering and an implementer that keeps working, so only a ceiling ends it. */
function participants(): [FakeRotationSession, FakeRotationSession] {
  return [
    new FakeRotationSession('advisor-1', 'codex', Array.from({ length: 40 }, (_, i) => `Do step ${i + 1}.`)),
    new FakeRotationSession('impl-1', 'claude', Array.from({ length: 40 }, (_, i) => `Did step ${i + 1}.`)),
  ]
}

/**
 * Run the relay directly and report why it stopped, plus the dispatcher state it stopped in.
 *
 * The state matters as much as the reason. A ceiling is checked BEFORE the mutation it
 * forbids, so a breached run must leave nothing half-done -- no task admitted that nothing
 * will dispatch, no seat marked `running` that nothing will send to or free. Returning
 * `tasks`/`seats` lets each test assert that, and both accessors deep-copy, so what comes
 * back cannot be mutated by anything the relay does afterwards.
 */
async function outcomeWith(
  over: Partial<RelayOptions>,
): Promise<{ reason: string; detail: string; tasks: { task: Task; runtime: TaskRuntime }[]; seats: SeatExecution[] }> {
  const dir = repo()
  const [advisor, impl] = participants()
  const relay = await Relay.start({
    registry: registryOf({ codex: [advisor], claude: [impl] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 4,
    ...over,
  })
  try {
    const outcome = await relay.run('Keep the work moving.')
    return { reason: outcome.reason, detail: outcome.detail ?? '', tasks: relay.tasks(), seats: relay.seats() }
  } finally {
    relay.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Instructions the implementer was actually dispatched, under a front-end and some flags.
 *
 * The probe is dispatch count rather than exit code, and that is not a detail. `runSession`
 * returns 0 unconditionally -- a console run reports its outcome on screen and has never used
 * the exit code to say how it ended, for a ceiling or for `transport_failed` either -- so an
 * exit-code assertion would read as "the console ignores ceilings" when it does not. Counting
 * what the implementer was sent measures the thing the operator cares about: whether the run
 * was stopped. It is also the probe that would catch a value parsed and dropped, which is the
 * #69 failure this whole test exists for.
 */
async function dispatchesVia(command: 'relay' | 'session', flags: string[]): Promise<number> {
  const dir = repo()
  const before = process.cwd()
  const [advisor, impl] = participants()
  const registry = registryOf({ 'fake-advisor': [advisor], 'fake-impl': [impl] })
  try {
    process.chdir(dir)
    await quietly(() =>
      main(
        [command, 'Keep the work moving.', '--advisor', 'fake-advisor', '--implementer', 'fake-impl', '--rounds', '4', ...flags],
        command === 'session' ? { registry, input: new PassThrough(), output: sink() } : { registry },
      ),
    )
  } finally {
    process.chdir(before)
    rmSync(dir, { recursive: true, force: true })
  }
  // Minus the briefing, which no advisor turn paid for.
  return impl.received.length - 1
}

// ---------------------------------------------------------------------------------------
// The readings themselves, against the states they are derived from.
// ---------------------------------------------------------------------------------------

function task(id: string): Task {
  return {
    id,
    seq: 0,
    instruction: 'do it',
    target: { kind: 'role', role: 'implementer' },
    origin: 0,
    dependsOn: [],
    restrictedOrigins: [],
    admittedAt: 0,
  }
}

function seat(over: Partial<SeatExecution> = {}): SeatExecution {
  return { seat: 'implementer', role: 'implementer', state: 'idle', idleSince: 0, dispatched: 0, ...over }
}

test('queueDepth counts admitted and ready work, and nothing a seat already has', () => {
  const queue = [task('a'), task('b'), task('c'), task('d')]
  const runtime = new Map<string, TaskRuntime>([
    ['a', { state: 'admitted', marks: [] }],
    ['b', { state: 'ready', marks: [] }],
    ['c', { state: 'assigned', marks: [] }],
    ['d', { state: 'complete', marks: [] }],
  ])
  assert.equal(queueDepth(queue, runtime), 2, 'admitted and ready are waiting; assigned and complete are not')
  assert.equal(queueDepth([], runtime), 0)
})

test('concurrentSeats counts seats working, and not seats integrating or idle', () => {
  assert.equal(
    concurrentSeats([
      seat({ seat: 'a', state: 'running', current: 't1' }),
      seat({ seat: 'b', state: 'running', current: 't2' }),
      // Occupied but not working: no agent is running on it and no quota is being spent.
      seat({ seat: 'c', state: 'integrating', current: 't3' }),
      seat({ seat: 'd', state: 'idle' }),
    ]),
    2,
  )
  // `running` with nothing in hand is a bookkeeping fault. Counting it would report phantom
  // work instead of surfacing the fault, so both conditions are required.
  assert.equal(concurrentSeats([seat({ state: 'running' })]), 0)
})

// ---------------------------------------------------------------------------------------
// Firing, against a real run.
// ---------------------------------------------------------------------------------------

test('a queue ceiling ends a real run before admitting the task it would have queued', async () => {
  const { reason, detail, tasks, seats } = await outcomeWith({ ceilings: { maxQueueDepth: 0 } })
  assert.equal(reason, 'ceiling', 'the run must end on the ceiling, not run to its advisor-turn budget')
  assert.match(detail, /queue ceiling exceeded: 1 task\(s\) waiting for a seat, above a maximum of 0/)
  // D8: checked before the mutation it forbids. The projected reading is what makes that
  // possible -- the ceiling asks what the queue WOULD become -- and the proof it was honoured
  // is that the refused task does not exist. A check placed after `#admit` would leave a task
  // here that nothing will ever dispatch.
  assert.deepEqual(tasks, [], 'a refused admission must leave no task record behind')
  assert.deepEqual(
    seats.map((s) => [s.state, s.current]),
    [['idle', undefined]],
    'the seat must be untouched: never assigned, never marked running',
  )
})

test('a concurrency ceiling ends a real run before assigning the seat it would have used', async () => {
  const { reason, detail, tasks, seats } = await outcomeWith({ ceilings: { maxConcurrentSeats: 0 } })
  assert.equal(reason, 'ceiling')
  assert.match(detail, /concurrency ceiling exceeded: 1 seat\(s\) working, above a maximum of 0/)
  // This ceiling stops later than the queue one -- the task IS admitted, because admitting it
  // breached nothing -- so the assertion is about the SEAT. Checking after `#assign` would end
  // the run holding a phantom: a seat `seats()` reports as running, with a task nothing will
  // ever send, end or free.
  assert.deepEqual(
    seats.map((s) => [s.state, s.current]),
    [['idle', undefined]],
    'a refused assignment must leave the seat idle, not running a task that will never be sent',
  )
  assert.deepEqual(
    tasks.map((t) => t.runtime.state),
    ['ready'],
    'the admitted task must still be waiting, never marked assigned',
  )
  assert.deepEqual(
    tasks.flatMap((t) => t.runtime.marks.map((m) => m.event)),
    ['admitted', 'ready'],
    'no assignment transition may have been stamped',
  )
})

test('a ceiling set above what the run reaches never fires', async () => {
  // The other side of every firing test, and the one that would catch a ceiling wired to the
  // wrong comparison: at N=1 a queue never exceeds one and a seat is never two, so neither of
  // these can be reached and the run must finish on its advisor-turn budget instead.
  const { reason } = await outcomeWith({ ceilings: { maxQueueDepth: 1, maxConcurrentSeats: 1 } })
  assert.equal(reason, 'budget', 'a ceiling that permits what the run does must not end it')
})

test('absent ceilings are behaviourless', async () => {
  // The constraint the operator set: a run given no ceiling behaves exactly as it did before
  // any of this existed. Asserted against the same run with ceilings omitted entirely.
  const { reason } = await outcomeWith({})
  assert.equal(reason, 'budget')
})

// ---------------------------------------------------------------------------------------
// Parity, behaviourally. A flag parsed and dropped looks like a working flag everywhere else.
// ---------------------------------------------------------------------------------------

for (const command of ['relay', 'session'] as const) {
  test(`every ceiling flag bounds a run started by \`conclave ${command}\``, async () => {
    // The unbounded baseline first, so each ceiling is compared against what the same run
    // does without it. A hard-coded expectation would pass a front-end that dropped the flag
    // if the number happened to match.
    const unbounded = await dispatchesVia(command, [])
    assert.equal(unbounded, 4, `${command} with no ceiling must run its full --rounds 4`)

    // Fires before the seat is ever assigned, so the implementer is sent nothing at all.
    assert.equal(
      await dispatchesVia(command, ['--max-queue-depth', '0']),
      0,
      `${command} must apply --max-queue-depth, not merely parse it`,
    )
    // Fires after assignment and before the send, so likewise nothing reaches the seat.
    assert.equal(
      await dispatchesVia(command, ['--max-concurrent-seats', '0']),
      0,
      `${command} must apply --max-concurrent-seats, not merely parse it`,
    )
    // `--max-turns` counts turns across BOTH participants, and the advisor has taken one
    // before the first dispatch, so a ceiling of 2 stops the run partway rather than at 2
    // dispatches. The assertion that matters is that it stopped SHORT of the unbounded run.
    const turnBounded = await dispatchesVia(command, ['--max-turns', '2'])
    assert.ok(
      turnBounded < unbounded,
      `${command} must apply --max-turns (${turnBounded} dispatches, unbounded run does ${unbounded})`,
    )
    // `--max-minutes 0` is the only duration this can assert in a test that must not sleep:
    // a run has always been going for at least zero milliseconds, so the ceiling fires at the
    // first boundary. It exercises the whole path the other durations use -- the flag, the
    // minutes-to-milliseconds conversion in `ceilingsFrom`, and the `>=` on elapsed time --
    // and without it this test named every ceiling flag while leaving one unexercised.
    assert.equal(
      await dispatchesVia(command, ['--max-minutes', '0']),
      0,
      `${command} must apply --max-minutes, not merely parse it`,
    )
    // On `session` all three of these are new. `--max-turns` and `--max-minutes` were
    // declared UNRESOLVED in frontEndParity while `--operator agent` was already shipping
    // unattended console runs, which is the gap this closes.
  })
}
