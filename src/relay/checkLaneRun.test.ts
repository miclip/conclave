/**
 * How the RUN uses the check lane (#64), driven through real worktrees and real merges.
 *
 * `checkLane.test.ts` proves the mechanism. This proves the two things about the WIRING that a
 * unit test of the class cannot, and both are claims a run can actually make:
 *
 *   once      every merge boundary takes the lane exactly ONCE. `integrateSeat` runs the
 *             configured checks for itself (#80), so a boundary that also wrapped those checks
 *             would take a one-slot lane twice and wait for itself for the rest of the run.
 *             That is the one way the lane could BREAK a run today, so it is the one thing
 *             worth driving a real two-seat run to assert.
 *   absent    a default run never touches the lane at all. There is no merge at N=1, so the
 *             station it wraps is not reached -- not by a seat-count branch, by there being
 *             nothing there.
 *
 * What is NOT here, and was: a test that held the lane from outside the run so a boundary would
 * queue behind it. It asserted a state no production path constructed -- checks are `spawnSync`,
 * so they already serialise, and the second station did not exist. Per-seat rotation (#78) has
 * since added it, and a wait is now reachable: `Relay.rotateSeat` can be called while the loop is
 * running, and the rotation holds this lane across a whole agent turn. It is still not reachable
 * from the LOOP, which processes one completion at a time, so manufacturing the interleaving here
 * would be testing the fixture again -- the wait itself is asserted against the class in
 * `checkLane.test.ts`. See `CheckLane` for exactly what is and is not reachable.
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
