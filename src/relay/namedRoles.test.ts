/**
 * The role a seat was given survives from spec to run state, and is visible where the seat
 * is already named.
 *
 * `ParticipantSpec.role` has existed all along and `#join` read `spec.agent` and dropped it,
 * so "which of the implementers is this" had no answer anywhere in a run's output. These
 * tests hold both halves of that fix at once, because either alone is a bug:
 *
 *   - a NON-DEFAULT role must be legible on every surface that names a seat, or carrying it
 *     is bookkeeping nobody can read
 *   - the DEFAULT role must change nothing an operator sees, because one advisor and one
 *     implementer stays the default (D1) and `defaultUnchanged.test.ts` guards it
 *
 * `Rank` is deliberately untouched: it is an authority ordering feeding `outranks()`, and
 * three implementers are different in job and identical in authority.
 *
 *   node --test src/relay/namedRoles.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgentRegistry } from '../registry/registry.ts'
import type { RoleDefinition } from '../registry/roles.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { readSession, recordSession } from '../workspace/sessionRecord.ts'
import { envelope } from './message.ts'
import { Relay } from './relay.ts'
import { runReport } from './report.ts'

/**
 * A role no build ships. The point of `RoleId` being open is that configuration names roles
 * the code has never heard of; a test that only used the built-ins would prove nothing about
 * that, because `implementer` and `advisor` are exactly the two ids that happen to match a
 * rank.
 */
const API_DEV: RoleDefinition = {
  id: 'api dev',
  displayName: 'API developer',
  description: 'Builds the service side.',
  contextPolicy: 'full',
  mutatesWorkspace: true,
  defaultInputOwnership: 'mediated',
  isModel: true,
}

function registryOf(sessions: Record<string, FakeRotationSession>): AgentRegistry {
  const r = new AgentRegistry()
  r.registerRole(API_DEV)
  for (const [agent, session] of Object.entries(sessions)) {
    r.register({
      id: agent,
      displayName: agent,
      deadlines: NO_DEADLINE_CLOCKS,
      capabilities: {
        agent,
        readinessSignal: 'first_turn',
        turnKeySource: 'run_invocation',
        outcomes: {
          completed: 'observed',
          cancelled: 'reasoned_but_unverified',
          permission_refused: 'unsupported',
          process_exited: 'reasoned_but_unverified',
          timed_out: 'reasoned_but_unverified',
          transport_lost: 'reasoned_but_unverified',
          unknown_abnormal_end: 'reasoned_but_unverified',
        },
      },
      launch: { command: agent, baseArgs: [] },
      create: async () => sessions[agent]!,
    })
  }
  return r
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-roles-'))
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })
  return dir
}

/** One advisor turn: the advisor instructs, the implementer reports, the advisor says DONE. */
async function runWith(implementerRole: string) {
  const dir = repo()
  const lead = new FakeRotationSession('lead-1', 'codex', ['build the thing', 'DONE'])
  const impl = new FakeRotationSession('impl-1', 'claude', ['a report'])
  const relay = await Relay.start({
    registry: registryOf({ codex: lead, claude: impl }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: implementerRole },
    maxAdvisorTurns: 2,
  })
  const startedAt = Date.now()
  const outcome = await relay.run('a goal')
  const report = await runReport(relay, { goal: 'a goal', outcome, startedAt, build: 'test-build' })

  // The status file is written by the recorder, not the relay, so it is exercised here
  // rather than asserted from the relay's own view of itself.
  const recording = recordSession(relay, {
    repoRoot: dir,
    id: 'roles',
    goal: 'a goal',
    front: 'relay',
    startedAt,
    build: 'test-build',
  })
  await recording.refresh()
  const status = readSession(dir, 'roles')?.status
  await recording.close()
  await relay.stop()

  return { relay, report, status, lead, impl, dir }
}

test('envelope renders the default headers unchanged when the role only repeats the rank', () => {
  // Byte-for-byte, because this is the text every default run has always sent. Absent and
  // equal-to-rank must both produce it: the first is a caller that holds no role, the second
  // is the N=1 seat.
  const ADVISOR =
    '[FROM THE ADVISOR (advisor) — a peer AI model, not your user. It outranks you on process ' +
    'and continuity, and it cannot see your tool calls or your code, only what you write. You ' +
    'may disagree: say so plainly, then proceed unless a human overrules.]\n\ndo it'
  const IMPL =
    '[FROM THE IMPLEMENTER (implementer) — a peer AI model doing the work. You cannot see its ' +
    'tool calls or its code, only what it writes.]\n\ndone'

  assert.equal(envelope({ from: 'advisor', fromRank: 'advisor', kind: 'instruction', text: 'do it' }), ADVISOR)
  assert.equal(
    envelope({ from: 'advisor', fromRank: 'advisor', fromRole: 'advisor', kind: 'instruction', text: 'do it' }),
    ADVISOR,
  )
  assert.equal(envelope({ from: 'implementer', fromRank: 'implementer', kind: 'report', text: 'done' }), IMPL)
  assert.equal(
    envelope({ from: 'implementer', fromRank: 'implementer', fromRole: 'implementer', kind: 'report', text: 'done' }),
    IMPL,
  )

  // The human header names no seat at all, so a role cannot leak into it.
  const human = envelope({ from: 'human', fromRank: 'human', fromRole: 'api dev', kind: 'goal', text: 'g' })
  assert.ok(!human.includes('api dev'), 'the human header names no seat and must name no role')
})

test('envelope names a role that differs from the rank, on both ranks', () => {
  const impl = envelope({ from: 'impl-api', fromRank: 'implementer', fromRole: 'api dev', kind: 'report', text: 'done' })
  assert.match(impl, /^\[FROM THE IMPLEMENTER \(impl-api, role: api dev\) —/)
  assert.ok(impl.endsWith('\n\ndone'), 'the body must be untouched')

  const lead = envelope({ from: 'lead', fromRank: 'advisor', fromRole: 'architect', kind: 'instruction', text: 'go' })
  assert.match(lead, /^\[FROM THE ADVISOR \(lead, role: architect\) —/)
})

test('a non-default role reaches the participant, the routing header, the report and status --json', async () => {
  const { relay, report, status, lead, impl, dir } = await runWith('api dev')
  try {
    // 1. run state: #join carries spec.role rather than dropping it.
    const seat = relay.participants.find((p) => p.id === 'implementer')
    assert.equal(seat?.role, 'api dev', 'the participant must carry the role its spec named')
    assert.equal(seat?.rank, 'implementer', 'rank is authority and does not follow the role')

    // 2. the routing header the ADVISOR reads. The implementer's report is enveloped on its
    // way back, which is the one place the advisor learns which seat answered.
    // EVERY such header, not the first one found: the advisor is handed more than one
    // enveloped report in a run, and matching only the first would let a later call site that
    // forgot to pass the role pass this test.
    const inbound = lead.received.filter((m) => m.includes('FROM THE IMPLEMENTER'))
    assert.ok(inbound.length > 0, 'the advisor must receive an enveloped implementer report')
    for (const m of inbound) assert.match(m, /\[FROM THE IMPLEMENTER \(implementer, role: api dev\) —/)
    // And the implementer still reads the advisor as an advisor: the advisor's role is a
    // built-in that matches its rank, so its header is the unchanged one.
    const outbound = impl.received.find((m) => m.includes('FROM THE ADVISOR'))
    assert.ok(outbound?.includes('[FROM THE ADVISOR (advisor) —'), 'the advisor header must be unchanged')

    // 3. the join note, the line naming the seat at startup.
    const joined = relay.log.find((m) => m.kind === 'note' && m.text.startsWith('implementer joined'))
    assert.equal(joined?.text, 'implementer joined as implementer in role api dev (claude)')

    // 4. the run report.
    const reported = report.participants.find((p) => p.id === 'implementer')
    assert.equal(reported?.role, 'api dev')
    assert.equal(reported?.rank, 'implementer')

    // 5. status --json, read back off disk rather than from the recorder's own memory.
    const live = status?.participants.find((p) => p.id === 'implementer')
    assert.equal(live?.role, 'api dev')
    assert.equal(status?.participants.find((p) => p.id === 'advisor')?.role, 'advisor')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the default run reports role implementer and its routing text is unchanged', async () => {
  const { relay, report, status, lead, dir } = await runWith('implementer')
  try {
    assert.equal(relay.participants.find((p) => p.id === 'implementer')?.role, 'implementer')
    assert.equal(report.participants.find((p) => p.id === 'implementer')?.role, 'implementer')
    assert.equal(status?.participants.find((p) => p.id === 'implementer')?.role, 'implementer')

    // Nothing the operator or the advisor reads says the word `role`. This is the half of
    // the change that must be invisible.
    const joined = relay.log.find((m) => m.kind === 'note' && m.text.startsWith('implementer joined'))
    assert.equal(joined?.text, 'implementer joined as implementer (claude)')
    for (const m of relay.log) {
      assert.ok(!m.text.includes('role: '), `no routed text at N=1 may name a role: ${m.text}`)
    }
    const inbound = lead.received.find((m) => m.includes('FROM THE IMPLEMENTER'))
    assert.ok(inbound?.includes('[FROM THE IMPLEMENTER (implementer) —'), 'the N=1 header must be the old one')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
