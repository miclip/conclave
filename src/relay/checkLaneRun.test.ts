/**
 * The check lane as the RUN uses it (#64), driven through real worktrees and real merges.
 *
 * `checkLane.test.ts` proves the mechanism. This proves the three claims that are about the
 * relay rather than about the class, and that a unit test of a queue cannot make:
 *
 *   once      every merge boundary takes the lane exactly ONCE. `integrateSeat` runs the
 *             configured checks for itself (#80), so a boundary that also wrapped those checks
 *             would take a one-slot lane twice and wait for itself for the rest of the run.
 *   assigned  a seat queued for the lane keeps its task. `merge_blocked` is git refusing a
 *             merge and `failed` is a boundary that did not complete; a queue position is
 *             neither, and reporting it as either puts a seat in front of an operator to
 *             answer a question that answers itself in a moment.
 *   absent    a default run never touches the lane at all. There is no merge at N=1, so the
 *             station this serialises is not reached -- not by a seat-count branch, by there
 *             being nothing there.
 *
 *   node --test src/relay/checkLaneRun.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { Relay } from './relay.ts'

/** A check that passes, so nothing here is about a red tree -- that is `integrationRed`'s. */
const CHECKS = ['sh check.sh']

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-lane-'))
  git(dir, 'init', '--quiet')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'check.sh'), 'exit 0\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'init', '--quiet')
  return dir
}

function registryOf(advisor: FakeRotationSession, seats: FakeRotationSession[]): AgentRegistry {
  const registry = new AgentRegistry()
  for (const [agent, queue] of [
    ['codex', [advisor]],
    ['claude', seats],
  ] as const) {
    const remaining = [...queue]
    registry.register({
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
  return registry
}

/** Two seats writing disjoint files, so every merge is clean and every tree is green. */
async function twoSeatRelay(repo: string, advisorReplies: string[]): Promise<Relay> {
  const advisor = new FakeRotationSession('advisor', 'codex', advisorReplies)
  const one = new FakeRotationSession('impl', 'claude', ['ack', 'Wrote one.', 'NONE', 'NONE'])
  const two = new FakeRotationSession('impl-2', 'claude', ['ack', 'Wrote two.', 'NONE', 'NONE'])

  const relay = await Relay.start({
    registry: registryOf(advisor, [one, two]),
    cwd: repo,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    implementers: [
      { id: 'implementer', agent: 'claude', role: 'implementer' },
      { id: 'implementer-2', agent: 'claude', role: 'implementer' },
    ],
    maxAdvisorTurns: 6,
    rotation: { checks: CHECKS, checkTimeoutMs: 30_000 },
  })
  const trees = Object.fromEntries(relay.worktrees!.seats.map((s) => [s.seatId, s.worktreePath]))
  one.onSend = () => writeFileSync(join(trees.implementer!, 'one.txt'), 'one\n')
  two.onSend = () => writeFileSync(join(trees['implementer-2']!, 'two.txt'), 'two\n')
  return relay
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('every merge boundary takes the lane exactly once, checks included', async () => {
  const repo = tempRepo()
  try {
    const relay = await twoSeatRelay(repo, ['Write one.', 'Write two.', 'DONE', 'DONE'])
    await relay.run('Keep the work moving.')

    const boundaries = relay.checkLane.history().filter((r) => r.station === 'integration')
    const merged = relay.tasks().filter(({ runtime }) => runtime.integratedAt !== undefined)
    assert.ok(merged.length >= 2, 'the scenario must actually have merged both seats')
    assert.equal(
      boundaries.length,
      merged.length,
      'one lane section per boundary. More would mean the checks `integrateSeat` runs for ' +
        'itself are queueing separately from the boundary that contains them (#80).',
    )
    // The double-queue signature, said as data: the same seat taking the lane twice for the
    // same task is the shape that deadlocks a one-slot lane the moment the two overlap.
    const keys = boundaries.map((r) => `${r.seat}/${r.detail}`)
    assert.deepEqual([...new Set(keys)].sort(), [...keys].sort(), 'no seat may take the lane twice for one task')
    // And nothing else took it: rotation never ran here, and a run that had silently rotated
    // would make the count above mean something different.
    assert.deepEqual(
      relay.checkLane.history().filter((r) => r.station === 'rotation'),
      [],
      'no rotation happened in this scenario',
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a seat queued for the lane stays assigned: not blocked, not failed, and nothing to answer', async () => {
  const repo = tempRepo()
  try {
    const relay = await twoSeatRelay(repo, ['Write one.', 'Write two.', 'DONE', 'DONE'])

    // The lane is held from outside the run, which is the only way to make a boundary WAIT on
    // a machine where both check runners are `spawnSync`: nothing inside one process can
    // overlap them, so the contention D7 designs for cannot be produced by running the relay
    // harder. Held by a claim that is not a seat, so it cannot be mistaken for one.
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const holder = relay.checkLane.run({ seat: 'operator-probe', station: 'integration' }, () => held)

    /** What the run looked like at the moment a seat was queued behind the lane. */
    let waiting: { seats: ReturnType<Relay['seats']>; tasks: ReturnType<Relay['tasks']> } | undefined
    let queuedSeat: string | undefined
    const watcher = (async () => {
      const deadline = Date.now() + 20_000
      while (relay.checkLane.queued().length === 0 && Date.now() < deadline) await sleep(5)
      const queued = relay.checkLane.queued()[0]
      if (queued) {
        queuedSeat = queued.seat
        waiting = { seats: relay.seats(), tasks: relay.tasks() }
        // Held a little longer on purpose. The boundary is already queued -- that is what the
        // poll above just observed -- and this only makes the wait longer than the clock's
        // millisecond resolution, so `waitedMs` below measures a wait rather than a rounding.
        await sleep(25)
      }
      // Always, including on the deadline: a probe that failed to observe a wait must not also
      // hang the run it was observing.
      release()
    })()

    const outcome = await relay.run('Keep the work moving.')
    await Promise.all([holder, watcher])

    assert.ok(queuedSeat, 'a boundary must have queued behind the held lane')
    assert.ok(waiting, 'and the run must have been observable while it did')
    const seat = waiting.seats.find((s) => s.seat === queuedSeat)!
    assert.equal(
      seat.state,
      'integrating',
      'a seat waiting for the lane is at its boundary, not blocked. `merge_blocked` is git ' +
        'refusing a merge, and nothing here has asked git anything yet.',
    )
    assert.deepEqual(
      waiting.seats.filter((s) => s.state === 'merge_blocked').map((s) => s.seat),
      [],
      'no seat may be marked blocked by a queue position',
    )
    // The task is still that seat's, in the assigned family, with a graded verdict and no
    // failure recorded. A dispatcher that released it here would hand the seat other work
    // while its own boundary was still outstanding.
    const mine = waiting.tasks.find(({ runtime }) => runtime.seat === queuedSeat && runtime.state === 'reported')
    assert.ok(mine, 'the waiting seat must still hold a task at its boundary')
    assert.deepEqual(
      waiting.tasks.filter(({ runtime }) => runtime.state === 'failed').map(({ task }) => task.id),
      [],
      'a wait is not a failed boundary',
    )
    assert.deepEqual(
      waiting.tasks.filter(({ runtime }) => runtime.state === 'cancelled').map(({ task }) => task.id),
      [],
      'and it does not cancel anything either',
    )

    // The wait really happened and is legible as a wait rather than as a slow check.
    const waited = relay.checkLane.history().filter((r) => r.station === 'integration' && r.waitedMs > 0)
    assert.ok(waited.length >= 1, 'the boundary must record the time it spent queued')
    // Recorded for the operator, and in the words that say it needs nothing from them.
    const note = relay.log.find((m) => m.text.includes('waiting for the check lane'))
    assert.ok(note, 'a real wait must be in the routing log — a queue is not a hang, and looks like one')
    assert.match(note.text, /stays\s+assigned/)
    assert.match(note.text, /nothing needs an answer/)

    // And the run still ended the way it would have. The lane delays a boundary; it does not
    // change what the boundary decided.
    assert.ok(['done', 'budget'].includes(outcome.reason), `unexpected ending: ${outcome.reason} ${outcome.detail ?? ''}`)
    assert.deepEqual(relay.worktrees!.seats.map((s) => s.mergeState), ['merged', 'merged'])
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a default run never touches the lane, because there is no boundary to serialise', async () => {
  const repo = tempRepo()
  try {
    const advisor = new FakeRotationSession('advisor', 'codex', ['Do the thing.', 'DONE', 'DONE'])
    const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.', 'NONE'])
    const relay = await Relay.start({
      registry: registryOf(advisor, [impl]),
      cwd: repo,
      lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
      implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
      maxAdvisorTurns: 3,
      rotation: { checks: CHECKS, checkTimeoutMs: 30_000 },
    })
    assert.equal(relay.worktrees, undefined, 'one seat means one tree, and it is the operator’s own')
    await relay.run('Keep the work moving.')
    assert.deepEqual(
      relay.checkLane.history(),
      [],
      'nothing at N=1 goes through the lane: there is no merge, so the station it serialises ' +
        'is not reached at all',
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
