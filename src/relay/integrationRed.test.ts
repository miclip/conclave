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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  /** What the repairing seat writes into ITS OWN tree when told to repair, if it is. */
  repair?: { marker: string; write: (ownTree: string) => void },
): Promise<{
  relay: Relay
  advisor: FakeRotationSession
  seats: Record<string, FakeRotationSession>
  outcome: { reason: string; detail?: string | undefined }
}> {
  const advisor = new FakeRotationSession('advisor', 'codex', advisorReplies)
  const one = new FakeRotationSession('impl', 'claude', ['ack', 'Renamed it.', 'Repaired it.', 'NONE', 'NONE'])
  const two = new FakeRotationSession('impl-2', 'claude', ['ack', 'Added the guard.', 'Repaired it.', 'NONE', 'NONE'])

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
    // The run's ORDINARY checks — the ones an operator passes as `--checks` and the only ones
    // there are. #80's ruling: a station that has to be armed separately is a station the run
    // that needs it will not have armed.
    rotation: { checks: CHECKS, checkTimeoutMs: 30_000 },
  })
  const trees = Object.fromEntries(relay.worktrees!.seats.map((s) => [s.seatId, s.worktreePath]))
  // Keyed off the instruction rather than off a turn counter: which seat is told to repair is
  // the advisor's decision, and a test that assumed one would be asserting its own scripting.
  const work = (session: FakeRotationSession, tree: string, ordinary: () => void): void => {
    session.onSend = (message: string) => {
      if (repair && message.includes(repair.marker)) repair.write(tree)
      else ordinary()
    }
  }
  work(one, trees.implementer!, () => writeFileSync(join(trees.implementer!, 'api.txt'), 'gamma\n'))
  work(two, trees['implementer-2']!, () =>
    writeFileSync(join(trees['implementer-2']!, 'check.sh'), 'grep -q alpha api.txt\n'),
  )

  const outcome = await relay.run('Keep the work moving.')
  return { relay, advisor, seats: { implementer: one, 'implementer-2': two }, outcome }
}

/** Every mechanical notice the advisor was given, which is where a repair would be. */
function orchestratorNotices(advisor: FakeRotationSession): string {
  return advisor.received.filter((m) => m.includes('[ORCHESTRATOR — mechanical')).join('\n\n')
}

test('a red integration tree mid-run is repaired: a task is dispatched, taken, merged, and the tree measured green', async () => {
  const repo = tempRepo()
  try {
    // One instruction per turn, so the second merge happens with the run still admitting work
    // and a seat still free to take a repair. The third reply is the advisor acting on the
    // notice — this test's subject is that the repair becomes REAL WORK, not that prose asking
    // for it arrived.
    const { relay, advisor, seats, outcome } = await twoSeatRun(
      repo,
      [
        'Rename the symbol.',
        'Add the guard.',
        '@seat implementer-2: Repair the integration failure — point the guard at the new name.',
        'DONE',
        'DONE',
      ],
      8,
      // A real repair, in the repairing seat's own worktree: the guard is moved onto the name
      // the other seat renamed to. Neither half is reverted, which is the point — the defect
      // was in the combination and so is the fix.
      { marker: 'Repair the integration failure', write: (tree) => writeFileSync(join(tree, 'check.sh'), 'grep -q gamma api.txt\n') },
    )
    try {
      const notices = orchestratorNotices(advisor)
      assert.match(notices, /fails its configured checks/, 'the advisor must be told the tree is red')
      // BOTH tasks, which is the whole of what this issue asks for. The failure exists in
      // neither half, so naming one seat as the cause would be a guess presented as a fact.
      assert.match(notices, /t-1 \(implementer\)/, 'the first contributing task must be named')
      assert.match(notices, /t-2 \(implementer-2\)/, 'the second contributing task must be named')
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

      // THE REPAIR AS WORK, which is what a queued repair means. A notice the advisor could
      // act on and a task that actually ran are different claims, and only the second one
      // closes the loop this issue opened: the earlier version of this test asserted prose.
      const repairTask = relay
        .tasks()
        .find(({ task }) => task.instruction.includes('Repair the integration failure'))
      assert.ok(repairTask, 'the advisor’s repair must have been ADMITTED as a task, not just spoken')
      assert.equal(repairTask.runtime.seat, 'implementer-2', 'and dispatched to the seat it was addressed to')
      assert.ok(repairTask.runtime.sentAt, 'and sent to that seat')
      assert.ok(
        repairTask.runtime.integratedAt,
        'and carried across the boundary — a repair that never merged has repaired nothing',
      )
      assert.ok(
        seats['implementer-2']!.received.some((m) => m.includes('Repair the integration failure')),
        'the seat itself must have been given the instruction, not merely nominated for it',
      )

      // And the measurement that says the repair worked: the tree is green again, the run
      // reports the ordinary ending, and the operator is told so.
      assert.match(notices, /passes its checks again/, 'a tree measured green again must be said out loud')
      assert.equal(
        spawnSync('sh', ['check.sh'], { cwd: repo, encoding: 'utf8' }).status,
        0,
        'the repaired tree must actually pass — the run’s claim is checked here, not trusted',
      )
      assert.equal(outcome.reason, 'done', 'a repaired run ends normally; the red state is cleared by measurement')
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('an unrepaired red tree still ends the run unsuccessfully, however ordinary the advisor thinks it went', async () => {
  const repo = tempRepo()
  try {
    // The same mid-run failure with no repair dispatched: the advisor is told, does nothing
    // about it, and calls the work done. The tree is what it is.
    const { relay, advisor, outcome } = await twoSeatRun(
      repo,
      ['Rename the symbol.', 'Add the guard.', 'DONE', 'DONE'],
      8,
    )
    try {
      assert.match(orchestratorNotices(advisor), /dispatch a repair task/, 'the repair must have been asked for')
      assert.equal(
        outcome.reason,
        'integration_failed',
        'an advisor saying the work is done is a claim; the checks are the measurement',
      )
      assert.match(outcome.detail ?? '', /t-1 \(implementer\) \+ t-2 \(implementer-2\)/)
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

/**
 * The half the reuse decision has to buy, and the one a reused option could most easily break.
 *
 * `--checks` now feeds two stations, so the claim "a single-seat run is unaffected" stops being
 * free and becomes something to prove. It holds by construction rather than by a seat count:
 * without seat worktrees there is no merge, so the boundary these run in is never reached.
 * Proved by counting EXECUTIONS — a check that fired once would append a line here — rather
 * than by asserting the outcome, which would pass just as well if the command ran and passed.
 */
test('one seat runs the configured checks exactly as often as it did before: never, at the boundary', async () => {
  const repo = tempRepo()
  try {
    const marks = join(repo, 'ran.log')
    const advisor = new FakeRotationSession('advisor', 'codex', ['Do the thing.', 'DONE', 'DONE'])
    const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.', 'NONE'])
    const relay = await Relay.start({
      registry: registryOf(advisor, [impl]),
      cwd: repo,
      lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
      implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
      // Armed exactly as an operator arms rotation today, and with a command that records that
      // it ran. Nothing else about the run is unusual.
      rotation: { checks: [`echo ran >> ${marks}`], checkTimeoutMs: 30_000 },
    })
    // A real file change, so the run is not silent for want of anything to integrate.
    impl.onSend = () => writeFileSync(join(repo, 'api.txt'), 'gamma\n')
    try {
      const outcome = await relay.run('Keep the work moving.')
      assert.equal(outcome.reason, 'done')
      assert.equal(relay.worktrees, undefined, 'one seat means no seat worktrees, which is why nothing runs')
      assert.equal(
        existsSync(marks),
        false,
        'a single-seat run must not acquire a per-task CI step from a flag that used to mean rotation alone',
      )
      // And the run SAYS so (#153). The behaviour above is deliberate; what was not is that
      // the run then reported `done` in the same words it uses when every check passed, so an
      // operator who armed the flag to avoid taking the run on trust was invited to trust it.
      const summary = relay.integrationSummary()
      assert.match(summary ?? '', /NOT MEASURED/, 'the run must not imply the tree was checked')
      assert.match(summary ?? '', /no merge for the integration check to run at/, 'and must say why')
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
      rotation: { checks: CHECKS, checkTimeoutMs: 30_000 },
    })
    const trees = Object.fromEntries(relay.worktrees!.seats.map((s) => [s.seatId, s.worktreePath]))
    one.onSend = () => writeFileSync(join(trees.implementer!, 'one.txt'), 'from one\n')
    two.onSend = () => writeFileSync(join(trees['implementer-2']!, 'two.txt'), 'from two\n')
    try {
      const outcome = await relay.run('Keep the work moving.')
      assert.equal(outcome.reason, 'done', 'a green tree must end exactly as it did before this existed')
      assert.doesNotMatch(orchestratorNotices(advisor), /fails its configured checks/)
      // The other half of #153: where the tree WAS measured, the run says that too, and how
      // often. A line that only ever appears to disclaim is one nobody reads on the run where
      // it reports a real measurement.
      const measured = relay.integrationSummary() ?? ''
      assert.match(measured, /measured after each of \d+ merge/, 'a measured tree says it was measured')
      assert.doesNotMatch(measured, /NOT MEASURED|RED/, 'and neither disclaims nor alarms when green')
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
