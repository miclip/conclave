/**
 * The reviewer seat (#72, D9b): opt-in, dispatched as a task purpose, never a hook the
 * merge boundary calls.
 *
 *   node --test src/relay/review.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { Relay } from './relay.ts'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-review-relay-'))
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

test('no reviewer declared: no review task is ever admitted, and the run behaves exactly as before', async () => {
  const dir = repo()
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

test('the reviewer is briefed as a reviewer, not as an implementer, and holds no goal', async () => {
  const dir = repo()
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

test('a run with no reviewer never mentions one to the advisor', async () => {
  const dir = repo()
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

test('an ACCEPTed review admits nothing further and lets the work complete', async () => {
  const dir = repo()
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

test('a REJECTed review admits an automatic repair addressed to the producing seat', async () => {
  const dir = repo()
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
