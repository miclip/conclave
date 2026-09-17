/**
 * The implementer is told not to end a turn while work it started is still running (#322).
 *
 * A seat whose harness can defer work past the turn (Claude Code background tasks) ended two
 * turns with "still running, I'll wait". Each was graded completed, forwarded as a report,
 * and cost an advisor round; an operator message saying "block on it" fixed it on the first
 * try. This pins that sentence into the opening the seat is actually sent, so it cannot be
 * lost in a rewrite of the briefing.
 *
 *   node --test src/relay/deferredTurn.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { tempDir } from '../testkit/tempDir.ts'
import { Relay } from './relay.ts'

function repo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-deferred-turn')
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

test('the implementer opening tells the seat not to end a turn while its own work is still running', async (t) => {
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
    await relay.run('a goal')
    const opening = impl.received[0] ?? ''
    assert.match(opening, /^You are the IMPLEMENTER/, 'the first message the seat receives is its briefing')
    // The instruction itself, and both halves of it: the prohibition and what to do instead.
    // Unconditional -- no "if", no "when using background tasks" -- because the seat that
    // needs it is the one that has already decided waiting is fine.
    assert.match(
      opening,
      /Do not end a turn while work you started is still running\./,
      'the seat must be told not to end a turn on work it deferred (#322)',
    )
    assert.match(
      opening,
      /block on the\s+work in the foreground and report its result in that same turn/,
      'and told what to do instead: wait, then report, in one turn',
    )
    // Placed with the reporting rule it qualifies, not among the FLAG/UNANSWERED conventions.
    const prose = opening.indexOf('your prose is the entire report')
    const rule = opening.indexOf('Do not end a turn while work you started')
    const outranks = opening.indexOf('outranks you on process')
    assert.ok(prose >= 0 && rule > prose && outranks > rule, 'it follows the prose-is-the-report paragraph')
  } finally {
    await relay.stop()
  }
})
