/**
 * The reviewer seat (#72, D9b): opt-in, dispatched as a task purpose, never a hook the
 * merge boundary calls.
 *
 *   node --test src/relay/review.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { tempDir } from '../testkit/tempDir.ts'
import { newSessionId, recordSession, sessionDir } from '../workspace/sessionRecord.ts'
import { Relay } from './relay.ts'
import type { RunPause } from './run.ts'

function repo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-review-relay')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'init'], {
    cwd: dir,
  })
  return dir
}

function registryOf(queues: Record<string, FakeRotationSession[]>): AgentRegistry {
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

test('no reviewer declared: no review task is ever admitted, and the run behaves exactly as before', async (t) => {
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', ['Write the answer.', 'DONE'])
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Wrote it.'])
  const relay = await Relay.start({
    registry: registryOf({ codex: [advisor], claude: [impl] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 4,
  })
  try {
    const outcome = await relay.run('Keep the work moving.')
    assert.equal(outcome.reason, 'done')
    assert.equal(
      relay.tasks().some(({ task }) => task.purpose === 'review' || task.purpose === 'review_resolution'),
      false,
      'no reviewer seat exists, so no review task may ever appear in the queue',
    )
  } finally {
    await relay.stop()
  }
})

test('the reviewer is briefed as a reviewer, not as an implementer, and holds no goal', async (t) => {
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', ['DONE'])
  const impl = new FakeRotationSession('impl', 'claude', [])
  const reviewer = new FakeRotationSession('reviewer', 'claude', [])
  const relay = await Relay.start({
    registry: registryOf({ codex: [advisor], claude: [impl, reviewer] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    reviewer: { id: 'reviewer', agent: 'claude', role: 'reviewer' },
    maxAdvisorTurns: 1,
  })
  try {
    await relay.run('a goal the reviewer must never see')
    const opening = reviewer.received[0] ?? ''
    assert.match(opening, /^You are the REVIEWER/)
    assert.doesNotMatch(opening, /You are the IMPLEMENTER/)
    assert.doesNotMatch(opening, /a goal the reviewer must never see/)
    assert.match(opening, /holds this session's goal/)

    const implOpening = impl.received[0] ?? ''
    assert.match(implOpening, /^You are the IMPLEMENTER/)

    // The advisor is told a reviewer exists, and how verdicts reach it, only because one
    // was declared.
    const advisorOpening = advisor.received[0] ?? ''
    assert.match(advisorOpening, /THIS RUN ALSO HAS A REVIEWER SEAT/)
  } finally {
    await relay.stop()
  }
})

test('a run with no reviewer never mentions one to the advisor', async (t) => {
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', ['DONE'])
  const impl = new FakeRotationSession('impl', 'claude', [])
  const relay = await Relay.start({
    registry: registryOf({ codex: [advisor], claude: [impl] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 1,
  })
  try {
    await relay.run('a default goal')
    assert.doesNotMatch(advisor.received[0] ?? '', /REVIEWER SEAT/)
  } finally {
    await relay.stop()
  }
})

test('an ACCEPTed review admits nothing further and lets the work complete', async (t) => {
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', ['Write the answer.', 'DONE', 'DONE'])
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Wrote it.'])
  const reviewer = new FakeRotationSession('reviewer', 'claude', ['ack', 'ACCEPT'])
  const relay = await Relay.start({
    registry: registryOf({ codex: [advisor], claude: [impl, reviewer] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    reviewer: { id: 'reviewer', agent: 'claude', role: 'reviewer' },
    maxAdvisorTurns: 6,
  })
  try {
    const outcome = await relay.run('Keep the work moving.')
    assert.equal(outcome.reason, 'done')

    const work = relay.tasks().find(({ task }) => task.purpose === 'work')!
    const review = relay.tasks().find(({ task }) => task.purpose === 'review')!
    assert.equal(review.task.parent, work.task.id, 'the review names the work it reviewed')
    assert.equal(review.runtime.state, 'complete', 'the reviewer seat is released like any other')
    assert.equal(work.runtime.state, 'complete', 'ACCEPT lets the original task finish')
    assert.equal(
      relay.tasks().some(({ task }) => task.purpose === 'review_resolution'),
      false,
      'nothing was rejected, so no repair exists',
    )
  } finally {
    await relay.stop()
  }
})

test('a REJECTed review admits an automatic repair addressed to the producing seat', async (t) => {
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'Write the answer.',
    'DONE',
    'DONE',
    'DONE',
    'DONE',
  ])
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Wrote it.', 'Wrote it again.'])
  const reviewer = new FakeRotationSession('reviewer', 'claude', ['ack', 'REJECT: needs a test.', 'ACCEPT'])
  const relay = await Relay.start({
    registry: registryOf({ codex: [advisor], claude: [impl, reviewer] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    reviewer: { id: 'reviewer', agent: 'claude', role: 'reviewer' },
    maxAdvisorTurns: 8,
  })
  try {
    const outcome = await relay.run('Keep the work moving.')
    assert.equal(outcome.reason, 'done', 'the second review ACCEPTs, so the run finishes normally')

    const work = relay.tasks().find(({ task }) => task.purpose === 'work')!
    const repair = relay.tasks().find(({ task }) => task.purpose === 'review_resolution')!
    assert.equal(repair.task.parent, work.task.id, 'the repair is FOR the original task')
    assert.equal(repair.task.target.kind, 'seat')
    assert.equal((repair.task.target as { kind: 'seat'; seat: string }).seat, 'implementer')
    assert.match(repair.task.instruction, /needs a test\./)
    assert.equal(work.runtime.state, 'failed', 'the rejected task itself never integrates')
    assert.equal(repair.runtime.state, 'complete', 'the repair, once accepted, does')

    // No advisor instruction ever named the reviewer or the repair: review is dispatched by
    // the orchestrator, and the repair reaches the seat by the relay addressing it directly.
    for (const line of advisor.received) {
      assert.doesNotMatch(line, /@seat reviewer/)
      assert.doesNotMatch(line, /@seat implementer: .*needs a test/)
    }
  } finally {
    await relay.stop()
  }
})

/**
 * The `review_blocked` halt reads the producing seat's tree instead of asserting a commit
 * nothing in the relay made (#158).
 *
 * The invariant on this path is narrow and it is about the ORCHESTRATOR, not the tree: no
 * boundary has run. A REJECT crosses none -- `#awaitReview` leaves the task `reported`, and
 * `#crossBoundary` runs from `crossAndSettle` only on ACCEPT -- so `commitSeatWork` has not
 * been called for this work. What the tree holds is then whatever the seat's own child left
 * there, which the relay does not control: an implementer that commits for itself leaves a
 * clean tree, and a repair that changed nothing leaves it as it was.
 *
 * That is why the old evidence line -- "the work is committed and its tree is retained" --
 * is not simply a false statement to be replaced with the opposite one. It was an UNOBSERVED
 * statement, printed identically whether it happened to hold or not, at the one moment an
 * operator is deciding whether a tree is disposable. The repair is to read.
 *
 * A regression test cannot assert every branch of "whatever the child left", so it pins the
 * case that costs an operator work: a seat that reported without committing, holding the
 * rejected work uncommitted when the halt is written. What is proved is that the line is a
 * READING of that seat's tree -- it names the file that is really there -- and not a stored
 * sentence. The clean-tree case is the same one call rendering a different answer.
 *
 * Driven through the real escalation, two REJECTs on the same work with the second landing on
 * a task whose `purpose` is already `review_resolution`, rather than by constructing a pause.
 * The evidence is read back out of the RECORDED pause (`status.json`, written by the same
 * `recordSession` both front-ends use) rather than out of anything the console prints: a
 * console-level assertion would pass on a renderer that invented the line.
 *
 * Two implementer seats, so the seats have real worktrees and `#rootOf` has a wrong answer
 * available to it: `this.#opts.cwd` is the integration checkout, a different directory holding
 * different uncommitted paths. Each seat writes its own uniquely named untracked file, and the
 * assertions below require the evidence to name the PRODUCING seat's file and to name neither
 * the other seat's nor the integration checkout's.
 */
test('a review_blocked halt names the uncommitted work actually sitting in the producing seat tree', async (t) => {
  const dir = repo(t)
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })

  const advisor = new FakeRotationSession('advisor', 'codex', ['Write the answer.', 'DONE', 'DONE', 'DONE', 'DONE'])
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Wrote it.', 'Wrote it again.'])
  const impl2 = new FakeRotationSession('impl2', 'claude', ['ack', 'Wrote it.', 'Wrote it again.'])
  // Rejected twice on the same work: the repair carries `purpose: 'review_resolution'`, and
  // rejecting THAT is what `resolveReview` escalates instead of repairing a third time.
  const reviewer = new FakeRotationSession('reviewer', 'claude', [
    'ack',
    'REJECT: not good enough.',
    'REJECT: still not good enough.',
  ])

  const relay = await Relay.start({
    registry: registryOf({ codex: [advisor], claude: [impl, impl2, reviewer] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    implementers: [
      { id: 'implementer', agent: 'claude', role: 'implementer' },
      { id: 'implementer-2', agent: 'claude', role: 'implementer' },
    ],
    reviewer: { id: 'reviewer', agent: 'claude', role: 'reviewer' },
    maxAdvisorTurns: 8,
  })
  try {
    const trees = Object.fromEntries(relay.worktrees!.seats.map((s) => [s.seatId, s.worktreePath]))
    assert.equal(Object.keys(trees).length, 2, 'two implementer seats must have two real worktrees')
    // Real uncommitted work, written into the tree the seat actually runs in. Nothing commits
    // it: the fake seat is a scripted session with no child of its own, and no boundary runs
    // on a rejected task. Written on every send so it is there at the moment the halt reads
    // the tree, which is the only moment that matters.
    const held: Record<string, string> = {}
    for (const [seatId, session] of [
      ['implementer', impl],
      ['implementer-2', impl2],
    ] as const) {
      const path = join(trees[seatId]!, `held-by-${seatId}.ts`)
      held[seatId] = path
      session.onSend = () => writeFileSync(path, `export const seat = '${seatId}'\n`)
    }

    const recording = recordSession(relay, {
      repoRoot: dir,
      id: newSessionId(Date.now(), process.pid),
      goal: 'Keep the work moving.',
      front: 'session',
      startedAt: Date.now(),
      build: 'test',
    })
    try {
      const run = relay.start('Keep the work moving.')
      const pause = await run.untilPause()
      assert.ok(pause, 'two rejections of the same work must escalate to a pause')
      assert.equal(pause.reason, 'review_blocked')
      // The path really was the second rejection: a repair was admitted and then rejected in
      // its turn, which is the only way `resolveReview` reaches this halt.
      const repair = relay.tasks().find(({ task }) => task.purpose === 'review_resolution')
      assert.ok(repair, 'the escalation must have gone through a real automatic repair')
      assert.equal(repair.runtime.state, 'failed', 'the repair is what the second REJECT failed')
      // What the console does at a pause, and the only reason the pause reaches a reader.
      recording.set('paused', { pause })

      const producing = (pause.resolution.scope as { participantId?: string }).participantId
      assert.ok(producing && producing in held, `the pause must name a producing seat, got ${producing}`)
      const other = producing === 'implementer' ? 'implementer-2' : 'implementer'

      const raw = readFileSync(join(sessionDir(dir, recording.id), 'status.json'), 'utf8')
      const recorded = (JSON.parse(raw) as { pause?: RunPause }).pause
      assert.ok(recorded, 'the pause must be in the status document a reader actually opens')
      const evidence = recorded.evidence

      // The claim the issue is about is gone, from every line, not just from the one it was on.
      for (const line of evidence) assert.doesNotMatch(line, /the work is committed/)

      const clause = evidence.find((e) => e.startsWith(`${trees[producing]!} `))
      assert.ok(
        clause,
        `no evidence line is about ${trees[producing]}, the tree holding ${held[producing]} ` +
          `uncommitted right now: ${JSON.stringify(evidence)}`,
      )
      // The file by name (the clause names paths relative to the tree it is about), and named
      // AS uncommitted, with the count that says how much is there.
      assert.ok(clause.includes(`held-by-${producing}.ts`), `the clause does not name the held file: ${clause}`)
      assert.match(clause, /ALSO holds uncommitted work that no commit and no merge carries/)
      assert.match(clause, /1 untracked/)
      // Retention survives the repair, and is asserted separately because it is true on its
      // own terms rather than as part of the reading: nothing removes a seat worktree while
      // the run is up, so the tree just named is there to be inspected.
      assert.ok(clause.endsWith('; that worktree is retained'), `the retention fact was dropped: ${clause}`)

      // The wrong roots, ruled out by name: the other seat's tree, and the integration
      // checkout that `#rootOf` falls back to when it is handed something it cannot place.
      for (const line of evidence) {
        assert.ok(!line.includes(`held-by-${other}`), `evidence describes the wrong seat's tree: ${line}`)
        assert.ok(!line.startsWith(`${dir} `), `evidence describes the integration checkout, not the seat: ${line}`)
        assert.ok(!line.includes(`in ${dir} is uncommitted`), `evidence describes the integration checkout: ${line}`)
      }
    } finally {
      await recording.close()
    }
  } finally {
    await relay.stop()
  }
})
