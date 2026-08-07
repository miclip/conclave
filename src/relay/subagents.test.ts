/**
 * Naming subagent work.
 *
 *   node --test src/relay/subagents.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { describeTool, isSubagentTool } from './subagents.ts'

test('the tools each agent delegates through are recognised', () => {
  // Four agents, four names, none of which announces "this is delegation" in any structured
  // field. `wait_agent` is the one an operator actually reported staring at.
  for (const tool of ['Task', 'task', 'wait_agent', 'Subagent', 'spawn_agent']) {
    assert.ok(isSubagentTool(tool), `${tool} should be recognised`)
  }
})

test('ordinary tools are left exactly as they were', () => {
  // A false positive tells an operator a subagent is running when none is, which is worse
  // than the raw tool name it replaces -- the raw name is at least true.
  for (const tool of ['Bash', 'read', 'edit', 'grep', 'StrReplaceFile', 'apply_patch']) {
    assert.equal(isSubagentTool(tool), false, `${tool} is not delegation`)
    assert.equal(describeTool(tool), undefined, 'and gets no substitute rendering')
  }
})

test('the description says what is happening and keeps the checkable fact', () => {
  // `⋯ advisor 2m39s · wait_agent` was the whole of what an operator saw. The name stays in
  // parentheses because it is the true, verifiable part; the prose is what it means.
  assert.equal(describeTool('wait_agent'), 'waiting on a subagent (wait_agent)')
  assert.match(describeTool('Task')!, /waiting on a subagent/)
})

test('delegation is detected from participant events, which carry the tool name', async () => {
  // The first version of this read the relay's `#evidence`, which keeps tool ARGUMENTS and
  // discards the tool name (#8). It would have reported `delegated: false` for every run
  // while looking entirely correct.
  const { Relay } = await import('./relay.ts')
  const { FakeRotationSession } = await import('../rotation/fakeSession.ts')
  const { AgentRegistry } = await import('../registry/registry.ts')
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = mkdtempSync(join(tmpdir(), 'conclave-sub-'))
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })

  const impl = new FakeRotationSession('impl', 'claude', ['done', 'NONE'])
  impl.toolsPerTurn = ['wait_agent']
  const registry = new AgentRegistry()
  for (const [agent, s] of [['codex', new FakeRotationSession('advisor', 'codex', ['DONE'])], ['claude', impl]] as const) {
    registry.register({
      id: agent,
      displayName: agent,
      capabilities: { agent, readinessSignal: 'first_turn', turnKeySource: 'run_invocation', outcomes: {
        completed: 'observed', cancelled: 'reasoned_but_unverified', permission_refused: 'unsupported',
        process_exited: 'reasoned_but_unverified', timed_out: 'reasoned_but_unverified',
        transport_lost: 'reasoned_but_unverified', unknown_abnormal_end: 'reasoned_but_unverified' } },
      launch: { command: agent, baseArgs: [] },
      create: async () => s as never,
    })
  }
  const relay = await Relay.start({
    registry, cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxRounds: 2,
  })
  await relay.run('a goal')
  const use = relay.subagentUse()
  await relay.stop()

  assert.equal(use.delegated, true, 'a wait_agent call is delegation')
  // A zero here is frequently correct: a subagent that only reads may use the shared
  // directory. It is evidence to weigh, never a verdict.
  assert.deepEqual(use.worktreesCreated, [])
})
