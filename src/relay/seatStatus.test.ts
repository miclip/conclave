/**
 * What `conclave status --json` says about a seat, when there is more than one to ask about.
 *
 * The question this file exists for is the one an agent operator asks and had no way to
 * answer: seat-beta is working — on WHAT, in WHICH tree, on WHICH branch, and does the
 * dispatcher agree it is busy? At N=1 all four are answered by the single run everything else
 * in the file already describes; at N>1 they are four separate facts about four different
 * seats, and the status file is the whole interface (#26).
 *
 * Written against a REAL two-seat run read back through `main(['status', '--json'])`, and
 * captured while a seat is mid-turn — which is the only moment `task` exists. `defaultUnchanged`
 * pins the same block at a pause, where no turn is in flight and the busy shape is therefore
 * unreachable; between the two files every shape the block can take is pinned somewhere.
 *
 *   node --test src/relay/seatStatus.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { main } from '../../bin/conclave.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { newSessionId, recordSession, type SessionParticipantStatus } from '../workspace/sessionRecord.ts'
import { Relay } from './relay.ts'

/** One agent per fake session, so a seat's id and the child behind it stay distinguishable. */
function registryOf(sessions: Record<string, FakeRotationSession>): AgentRegistry {
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

/** A repository to run in: two seats mean real worktrees, and those need a real checkout. */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-seat-status-'))
  execFileSync('git', ['init', '--quiet'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'README.md'), '# hello')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: dir })
  return dir
}

async function stdoutOf(work: () => Promise<number>): Promise<string> {
  const [log, error] = [console.log, console.error]
  const lines: string[] = []
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '))
  console.error = () => {}
  try {
    const code = await work()
    assert.equal(code, 0, 'the status command must succeed')
  } finally {
    console.log = log
    console.error = error
  }
  return lines.join('\n')
}

type Seat = NonNullable<SessionParticipantStatus['seat']>

const BOTH = '@seat seat-alpha: rebuild the parser\n@seat seat-beta: rewrite the docs'

/**
 * A two-seat run, with `status --json` read WHILE both seats are working.
 *
 * The capture happens from `beta.onSend` — inside the dispatch, with alpha's turn deliberately
 * long enough to still be running — because a seat's task, and therefore three quarters of
 * this block, exists only between dispatch and grading. Reading the file after the run would
 * show two idle seats and prove nothing about the field that matters most.
 */
async function statusWhileBusy(): Promise<{ participants: SessionParticipantStatus[]; repo: string }> {
  const repo = tempRepo()
  const before = process.cwd()
  const lead = new FakeRotationSession('lead-1', 'lead', [BOTH, 'DONE', 'DONE'])
  const alpha = new FakeRotationSession('alpha-1', 'alpha', ['ack', 'Did it.', 'NONE', 'NONE'])
  const beta = new FakeRotationSession('beta-1', 'beta', ['ack', 'Did that too.', 'NONE', 'NONE'])
  const relay = await Relay.start({
    registry: registryOf({ lead, alpha, beta }),
    cwd: repo,
    lead: { id: 'advisor', agent: 'lead', role: 'advisor' },
    implementer: { id: 'seat-alpha', agent: 'alpha', role: 'implementer' },
    implementers: [
      { id: 'seat-alpha', agent: 'alpha', role: 'implementer' },
      { id: 'seat-beta', agent: 'beta', role: 'implementer' },
    ],
    maxAdvisorTurns: 6,
  })
  const recording = recordSession(relay, {
    repoRoot: repo,
    id: newSessionId(Date.now(), process.pid),
    goal: 'keep the work moving',
    front: 'session',
    startedAt: Date.now(),
    build: 'test',
  })
  try {
    process.chdir(repo)
    // Long enough that alpha is unambiguously still in its turn when beta is dispatched, and
    // when the status is read a moment later. `#exchange` polls every 250ms, so this beats a
    // poll interval several times over rather than by a margin that proves nothing.
    alpha.delayMs = 2000
    let captured: Promise<string> | undefined
    beta.onSend = (message) => {
      if (captured || !/rewrite the docs/.test(message)) return
      captured = (async () => {
        // The console reports its own state changes; this is that call, made where a real
        // console would already have made one. `refresh` then rereads every snapshot, which is
        // what a poller's read is racing anyway.
        recording.set('running')
        await recording.refresh()
        return stdoutOf(() => main(['status', '--json']))
      })()
    }
    const outcome = await relay.run('keep the work moving')
    assert.equal(outcome.reason, 'done', 'the two-seat run must finish')
    assert.ok(captured, 'the capture must have happened: without it this test asserts nothing')
    const status = JSON.parse(await captured) as { participants: SessionParticipantStatus[] }
    return { participants: status.participants, repo }
  } finally {
    process.chdir(before)
    await recording.close()
    await relay.stop()
  }
}

test('every implementer seat of a two-seat run reports its task, tree, branch and scheduler state', async () => {
  const { participants, repo } = await statusWhileBusy()
  try {
    const seats = participants.filter((p) => p.rank === 'implementer')
    assert.deepEqual(
      seats.map((p) => p.id),
      ['seat-alpha', 'seat-beta'],
      'both seats must be in the document, by the ids the operator named',
    )
    // The advisor holds no seat and takes no task, so it gets no block. A build that gave it
    // one would report a queue position it can never occupy.
    const advisor = participants.find((p) => p.rank === 'advisor')!
    assert.equal(advisor.seat, undefined, 'the advisor is not a seat and must not be described as one')

    for (const p of seats) {
      const seat = p.seat as Seat | undefined
      assert.ok(seat, `${p.id} must carry a seat block while the run has two seats`)
      if (!seat) continue

      // The dispatcher's own word for what this seat is doing, and it is BUSY: both were
      // dispatched from one advisor reply and neither has been graded yet.
      assert.equal(seat.state, 'running', `${p.id} must report the scheduler state, not a guess at it`)
      assert.equal(seat.dispatched, 1, `${p.id} has been handed exactly one task`)

      // The task, which is the answer to "what is this seat doing" that nothing else in the
      // document carries: `activity` is the last adapter event, which says `tool_use`, not
      // which of two instructions the seat is acting on.
      assert.ok(seat.task, `${p.id} must name the task in flight`)
      assert.match(seat.task!.id, /^t-\d+$/)
      assert.equal(seat.task!.state, 'running')

      // Its own worktree and its own branch. Two seats never share either, which is the whole
      // reason a status file that could not tell them apart was worth fixing.
      assert.ok(seat.worktree, `${p.id} must name the tree it works in`)
      assert.notEqual(seat.worktree!.path, repo, `${p.id} must not be reported in the integration checkout`)
      assert.match(seat.worktree!.branch, /seat/, 'the branch is the seat’s own')
    }

    // The pairing is the point: the instructions and the trees must belong to the RIGHT seats.
    // Every assertion above passes on a projection that read the first seat twice.
    const [alpha, beta] = seats as [SessionParticipantStatus, SessionParticipantStatus]
    assert.match((alpha.seat as Seat).task!.instruction, /rebuild the parser/)
    assert.match((beta.seat as Seat).task!.instruction, /rewrite the docs/)
    assert.notEqual((alpha.seat as Seat).task!.id, (beta.seat as Seat).task!.id)
    assert.notEqual((alpha.seat as Seat).worktree!.path, (beta.seat as Seat).worktree!.path)
    assert.notEqual((alpha.seat as Seat).worktree!.branch, (beta.seat as Seat).worktree!.branch)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a one-seat run carries no seat block at all, on any participant', async () => {
  // D1's identity case for this field, and the reason the block is gated rather than always
  // emitted: a key that appeared on the single implementer of a default run is a key every
  // existing consumer of `status --json` would start seeing. `defaultUnchanged.test.ts` pins
  // the whole document; this says the same thing about the one field, close to the code that
  // decides it, so a change here fails with the reason rather than as a shape diff.
  const repo = tempRepo()
  const before = process.cwd()
  const lead = new FakeRotationSession('lead-1', 'lead', ['do the thing', 'DONE'])
  const impl = new FakeRotationSession('impl-1', 'impl', ['ack', 'Did it.', 'NONE'])
  const relay = await Relay.start({
    registry: registryOf({ lead, impl }),
    cwd: repo,
    lead: { id: 'advisor', agent: 'lead', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'impl', role: 'implementer' },
    maxAdvisorTurns: 3,
  })
  const recording = recordSession(relay, {
    repoRoot: repo,
    id: newSessionId(Date.now(), process.pid),
    goal: 'keep the work moving',
    front: 'session',
    startedAt: Date.now(),
    build: 'test',
  })
  try {
    process.chdir(repo)
    // Captured mid-turn as well, so this is the same moment as the two-seat test rather than a
    // finished run where the block would be thin for a reason that has nothing to do with N.
    let captured: Promise<string> | undefined
    impl.delayMs = 1200
    impl.onSend = (message) => {
      if (captured || !/do the thing/.test(message)) return
      captured = (async () => {
        recording.set('running')
        await recording.refresh()
        return stdoutOf(() => main(['status', '--json']))
      })()
    }
    await relay.run('keep the work moving')
    assert.ok(captured, 'the capture must have happened')
    const status = JSON.parse(await captured) as { participants: SessionParticipantStatus[] }
    assert.deepEqual(
      status.participants.map((p) => p.id),
      ['advisor', 'implementer'],
      'a default run is the two participants it has always been',
    )
    for (const p of status.participants) {
      assert.equal(p.seat, undefined, `${p.id} must carry no seat block at N=1`)
      assert.ok(!('seat' in p), `${p.id} must not carry the key at all: JSON cannot spell undefined`)
    }
  } finally {
    process.chdir(before)
    await recording.close()
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})
