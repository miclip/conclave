/**
 * A clean merge is not a correct merge (#80), driven through a real two-seat run.
 *
 * `integrate.test.ts` proves the measurement: two individually green trees, disjoint files, a
 * merge git has nothing to say about, and a tree that fails its checks. This proves what the
 * RUN does with that measurement, which is the half the issue's addendum is about — the same
 * failure means two different things depending on whether a seat is left to repair it:
 *
 *   mid-run   a repair the advisor dispatches, naming BOTH contributing tasks. Neither seat
 *             is blocked, neither is at fault, and the orchestrator does not pick one.
 *   final     nothing to dispatch it to, so it is an OUTCOME the run reports. Before this,
 *             the run said `done` and exited zero on a tree that does not build, and the
 *             operator found out later from a tree they did not watch being assembled.
 *
 * Both are provoked with real worktrees, real merges and real check commands. The scenario is
 * the one the issue describes: seat `implementer` renames a symbol, seat `implementer-2` adds
 * a guard requiring the old name. Different files, so nothing conflicts; each seat's tree is
 * green when measured in that seat's tree.
 *
 *   node --test src/relay/integrationRed.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { Relay } from './relay.ts'

/** The check the merged tree is measured against, and it lives IN the tree. */
const CHECKS = ['sh check.sh']

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * A repository with a symbol and a check that says nothing about it yet.
 *
 * The guard arrives as one seat's WORK, which is what makes each half individually green: it
 * does not exist in the other seat's tree, and the rename has not happened in its own.
 */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-red-'))
  git(dir, 'init', '--quiet')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'api.txt'), 'alpha\n')
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

/**
 * Two seats whose work is correct apart and broken together.
 *
 * The writes are attached to the SESSIONS rather than to task ids, so the scenario does not
 * depend on which seat the dispatcher picks for which instruction. Either order gives a green
 * first merge and a red second one: the guard passes against the original name, and the rename
 * passes against the check that has not been written yet.
 */
async function twoSeatRun(
  repo: string,
  advisorReplies: string[],
  maxAdvisorTurns: number,
): Promise<{ relay: Relay; advisor: FakeRotationSession; outcome: { reason: string; detail?: string | undefined } }> {
  const advisor = new FakeRotationSession('advisor', 'codex', advisorReplies)
  const one = new FakeRotationSession('impl', 'claude', ['ack', 'Renamed it.', 'NONE', 'NONE'])
  const two = new FakeRotationSession('impl-2', 'claude', ['ack', 'Added the guard.', 'NONE', 'NONE'])

  const relay = await Relay.start({
    registry: registryOf(advisor, [one, two]),
    cwd: repo,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    implementers: [
      { id: 'implementer', agent: 'claude', role: 'implementer' },
      { id: 'implementer-2', agent: 'claude', role: 'implementer' },
    ],
    maxAdvisorTurns,
    integration: { checks: CHECKS, checkTimeoutMs: 30_000 },
  })
  const trees = Object.fromEntries(relay.worktrees!.seats.map((s) => [s.seatId, s.worktreePath]))
  one.onSend = () => writeFileSync(join(trees.implementer!, 'api.txt'), 'gamma\n')
  two.onSend = () => writeFileSync(join(trees['implementer-2']!, 'check.sh'), 'grep -q alpha api.txt\n')

  const outcome = await relay.run('Keep the work moving.')
  return { relay, advisor, outcome }
}

/** Every mechanical notice the advisor was given, which is where a repair would be. */
function orchestratorNotices(advisor: FakeRotationSession): string {
  return advisor.received.filter((m) => m.includes('[ORCHESTRATOR — mechanical')).join('\n\n')
}

test('a red integration tree mid-run becomes a repair naming both tasks, and blames neither seat', async () => {
  const repo = tempRepo()
  try {
    // One instruction per turn, so the second merge happens with the run still admitting work
    // and a seat still available to take a repair.
    const { relay, advisor, outcome } = await twoSeatRun(
      repo,
      ['Rename the symbol.', 'Add the guard.', 'DONE', 'DONE'],
      6,
    )
    try {
      const notices = orchestratorNotices(advisor)
      assert.match(notices, /fails its configured checks/, 'the advisor must be told the tree is red')
      // BOTH tasks, which is the whole of what this issue asks for. The failure exists in
      // neither half, so naming one seat as the cause would be a guess presented as a fact.
      assert.match(notices, /t-1 \(implementer/, 'the first contributing task must be named')
      assert.match(notices, /t-2 \(implementer/, 'the second contributing task must be named')
      assert.match(notices, /COMBINATION/, 'the notice must say what is at fault, and it is the pair')
      assert.match(notices, /No seat is blocked and no seat is at fault/)
      // The failing command travels with it: a repair instruction that says only "it is red"
      // sends a seat to go and find out what this station already knows.
      assert.match(notices, /sh check\.sh/)

      // Not the conflict path. Nothing here marks a seat, and a seat that took ordinary work
      // afterwards must still be able to: `merge_blocked` is git's answer to a textual
      // conflict and would be the wrong claim about a tree that merged cleanly.
      assert.deepEqual(
        relay.worktrees!.seats.map((s) => s.mergeState),
        ['merged', 'merged'],
        'both merges succeeded — nothing about this is a blocked seat',
      )
      assert.deepEqual(
        relay.seats().filter((s) => s.state === 'merge_blocked'),
        [],
        'no seat may be blamed for a defect that exists in neither half',
      )

      // And the run still refuses to report success: the repair was dispatched into an
      // advisor that said DONE, so the tree is red at the end and says so.
      assert.equal(outcome.reason, 'integration_failed')
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a red tree after the final merge is a reported outcome rather than a task nobody can take', async () => {
  const repo = tempRepo()
  try {
    // Both seats dispatched in ONE advisor reply, with a one-turn budget. The second seat's
    // work therefore crosses its boundary during the drain, after the run has decided to end:
    // no admission, no seat left to instruct, exactly the addendum's dangerous case.
    const { relay, advisor, outcome } = await twoSeatRun(
      repo,
      ['@seat implementer: Rename the symbol.\n@seat implementer-2: Add the guard.', 'DONE', 'DONE'],
      1,
    )
    try {
      assert.equal(
        outcome.reason,
        'integration_failed',
        'a run whose final merge broke the tree must not report an ending that reads as success',
      )
      assert.match(outcome.detail ?? '', /fails its configured checks/)
      assert.match(outcome.detail ?? '', /t-1 \(implementer/)
      assert.match(outcome.detail ?? '', /t-2 \(implementer/)
      // The tree really is red, measured here rather than taken from the outcome that is
      // being tested. The operator's own checkout is what the run left behind.
      assert.notEqual(
        spawnSync('sh', ['check.sh'], { cwd: repo, encoding: 'utf8' }).status,
        0,
        'the run must be reporting a tree that genuinely does not pass',
      )

      // No repair was queued, because there is nobody to take one. The orchestrator says what
      // happened on the routing log instead; a task admitted here would sit in the queue of a
      // run that has already stopped admitting work.
      assert.doesNotMatch(
        orchestratorNotices(advisor),
        /dispatch a repair task/,
        'a repair nobody can take is the silent failure wearing a different hat',
      )
      assert.ok(
        relay.log.some((m) => m.kind === 'note' && /no seat remains to repair it/.test(m.text)),
        'the run must record why it reported this rather than queueing it',
      )
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a green integration tree changes nothing about the run', async () => {
  const repo = tempRepo()
  try {
    // The same two seats and the same arming, with the guard REMOVED from the scenario: both
    // seats do work that survives the merge. Nothing is told to the advisor and the run ends
    // as it always did — the station must be silent when the tree is fine.
    const advisor = new FakeRotationSession('advisor', 'codex', ['Do a thing.', 'Do another.', 'DONE', 'DONE'])
    const one = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.', 'NONE', 'NONE'])
    const two = new FakeRotationSession('impl-2', 'claude', ['ack', 'Did it.', 'NONE', 'NONE'])
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
      integration: { checks: CHECKS, checkTimeoutMs: 30_000 },
    })
    const trees = Object.fromEntries(relay.worktrees!.seats.map((s) => [s.seatId, s.worktreePath]))
    one.onSend = () => writeFileSync(join(trees.implementer!, 'one.txt'), 'from one\n')
    two.onSend = () => writeFileSync(join(trees['implementer-2']!, 'two.txt'), 'from two\n')
    try {
      const outcome = await relay.run('Keep the work moving.')
      assert.equal(outcome.reason, 'done', 'a green tree must end exactly as it did before this existed')
      assert.doesNotMatch(orchestratorNotices(advisor), /fails its configured checks/)
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
