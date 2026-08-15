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
import { listSessions, type SessionStatus } from '../workspace/sessionRecord.ts'
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
    purpose: 'work' as const,
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

// ---------------------------------------------------------------------------------------
// Saying what they are (#119). A ceiling that is obeyed silently is a ceiling the operator
// cannot confirm, and the run that produced this issue was stopped by one nobody had chosen.
// ---------------------------------------------------------------------------------------

/**
 * Everything a front-end printed, and the status document it recorded, for one real run.
 *
 * Both readings from ONE run rather than two, because the whole claim is that the banner and
 * the record agree with the loop -- and a helper that ran the CLI twice could report a banner
 * from one process and a document from another without either being wrong about its own.
 *
 * The console writes to its `output` stream and `relay` writes to stdout, so both are captured:
 * a helper that watched only one would test the front-end it happened to be written for, which
 * is how a capability comes to exist on one command and not the other for the tenth time.
 */
async function launchVia(
  command: 'relay' | 'session',
  flags: string[],
): Promise<{ text: string; status: SessionStatus }> {
  const dir = repo()
  const before = process.cwd()
  const [advisor, impl] = participants()
  const registry = registryOf({ 'fake-advisor': [advisor], 'fake-impl': [impl] })
  const chunks: string[] = []
  const out = new Writable({
    write(c, _e, cb) {
      chunks.push(String(c))
      cb()
    },
  })
  const [log, error] = [console.log, console.error]
  try {
    process.chdir(dir)
    console.log = (...a: unknown[]) => void chunks.push(`${a.join(' ')}\n`)
    console.error = (...a: unknown[]) => void chunks.push(`${a.join(' ')}\n`)
    await main(
      [command, 'Keep the work moving.', '--advisor', 'fake-advisor', '--implementer', 'fake-impl', '--rounds', '2', ...flags],
      command === 'session' ? { registry, input: new PassThrough(), output: out } : { registry },
    )
    const sessions = listSessions(dir)
    assert.equal(sessions.length, 1, `conclave ${command} must have recorded exactly one session`)
    return { text: chunks.join(''), status: sessions[0]!.status }
  } finally {
    console.log = log
    console.error = error
    process.chdir(before)
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const command of ['relay', 'session'] as const) {
  test(`\`conclave ${command}\` names every ceiling before it starts work`, async () => {
    // The run that produced #119 was launched with `--max-turns 40` to raise the advisor
    // budget. It does not raise it -- `--rounds` does -- so the run ended at the default while
    // the flag the operator typed bounded something else entirely. Both numbers on one line,
    // before any work exists to lose, is the whole of suggestion 1.
    const { text } = await launchVia(command, ['--max-turns', '40'])
    const line = text.split('\n').find((l) => l.includes('ceilings:'))
    assert.ok(line, `${command} must print a ceilings line at launch`)
    // The two adjacent flags, with the values that were actually in force. Asserted against
    // `--rounds 2` rather than a default, so a banner printing a constant cannot pass.
    assert.match(line, /--rounds 2\b/, `${command} must say what bounds the advisor`)
    assert.match(line, /--max-turns 40\b/, `${command} must say what --max-turns was read as`)
    // And the ones nobody set, named as unset rather than left out. A line that listed only
    // what was configured would have been empty on the run this issue was filed from.
    assert.match(line, /--max-minutes none/)
    assert.match(line, /--max-queue-depth none/)
    assert.match(line, /--max-concurrent-seats none/)
  })

  test(`\`conclave ${command}\` records every ceiling in the status document`, async () => {
    // Suggestion 3, and the same argument #103 made for rotation state: an agent operator has
    // no console to read the banner from, so a flag it passed is unconfirmable and a
    // misunderstood ceiling is invisible to the interface that exists to replace the console.
    const { status } = await launchVia(command, ['--max-minutes', '5', '--max-queue-depth', '3'])
    assert.deepEqual(
      status.ceilings,
      {
        // From `--rounds 2`, resolved by the same reader the dispatcher counts against.
        advisorTurns: 2,
        // Never set on this run, and said so rather than omitted.
        maxTurns: null,
        // Minutes in, milliseconds out, as the run itself holds it.
        maxDurationMs: 300_000,
        maxQueueDepth: 3,
        maxConcurrentSeats: null,
      },
      `${command} must record the ceilings the run was actually given`,
    )
  })
}

test('the recorded ceilings are the ones the run obeyed, not the ones it was asked for', async () => {
  // The sharpest version of the claim, and the reason the document is built from
  // `Relay.ceilings` rather than from the front-end's own flags: a run given NO ceiling flags
  // still has an advisor budget, and the document must carry the number the loop will stop at.
  // Read against the reason it stopped, so a document agreeing with the flags while the loop
  // used something else would be caught here rather than believed.
  const { status } = await launchVia('relay', [])
  assert.equal(status.ceilings?.advisorTurns, 2)
  assert.equal(status.outcome?.reason, 'budget', 'the run must have ended on that budget')
  assert.match(status.outcome?.detail ?? '', /2 of a maximum 2/, 'and the ending must quote the same number')
})

test('a detached run reports its ceilings from the first status, before the child exists', async () => {
  // The window an agent operator actually polls. `--detach` returns an id immediately and the
  // child takes seconds to come up, so a `ceilings` block written only by the recorder would be
  // missing for exactly as long as the operator is waiting to find out what they launched --
  // and permanently for a child that dies during startup, whose placeholder is the only status
  // anyone ever reads. The parent knows the answer: it parsed the argv it is about to pass on.
  //
  // Driven as a real subprocess rather than through `main()` in-process, and that is not
  // fastidiousness: the detach path re-executes `process.argv[1]`, which under `node --test` is
  // THIS FILE. Calling it here would spawn the test file as a program, which would run this
  // test again, which would spawn again.
  const dir = repo()
  const bin = join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts')
  /** The child's pid, off the document, so the test can end the run it just started. */
  let detached: number | undefined
  try {
    // The grandchild this spawns gets agent names no registry knows, so it fails at resolution
    // and never records a status of its own. What is asserted below is therefore the parent's
    // document, which is the one under test.
    execFileSync(
      process.execPath,
      [bin, 'relay', 'Keep the work moving.', '--detach', '--advisor', 'fake-advisor', '--implementer', 'fake-impl', '--rounds', '12', '--max-turns', '40'],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
    )
    const sessions = listSessions(dir)
    assert.equal(sessions.length, 1, 'the parent must record the session it just handed off')
    const status = sessions[0]!.status
    detached = status.pid
    // A placeholder in every other respect -- nothing has joined, nothing has been routed --
    // and NOT a placeholder here. This is the field the parent can answer and the child cannot
    // yet, which is the whole reason it is written twice.
    assert.equal(status.state, 'starting')
    assert.deepEqual(status.participants, [])
    assert.deepEqual(status.ceilings, {
      advisorTurns: 12,
      maxTurns: 40,
      maxDurationMs: null,
      maxQueueDepth: null,
      maxConcurrentSeats: null,
    })
  } finally {
    // Detaching means nothing here owns the child, so this test ends what it started. It
    // should already be gone -- `fake-advisor` is in no registry, and the CLI refuses an
    // unknown agent before it creates anything -- but "should already be gone" is not a
    // reason to leave a detached process to chance. The pid comes off the document, which is
    // what the parent records it for.
    if (detached !== undefined) {
      try {
        process.kill(detached, 'SIGKILL')
      } catch {
        // Already gone, which is the other legitimate ending.
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
