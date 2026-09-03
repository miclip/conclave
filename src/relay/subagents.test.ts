/**
 * Naming subagent work.
 *
 *   node --test src/relay/subagents.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { describeSubagentWork, describeTool, isSubagentTool } from './subagents.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { tempDir } from '../testkit/tempDir.ts'

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

test('a counted subagent is described as counted, and a guessed one as guessed', () => {
  // The wording is the difference between the two claims, and it is deliberate. The name list
  // can only say "this seat is inside a tool that usually means delegation" -- so it hedges,
  // and keeps the tool name as the checkable part. An observed count knows how many and since
  // when, and says that instead. Neither says the other's sentence.
  assert.equal(describeSubagentWork('Task', { outstanding: 1, elapsed: '12s' }), '1 subagent running (12s)')
  assert.equal(describeSubagentWork('wait_agent', { outstanding: 3, elapsed: '2m39s' }), '3 subagents running (2m39s)')

  // Singular and plural, because "1 subagents running" is the kind of thing an operator reads
  // as a bug in the tool that is reporting it.
  assert.match(describeSubagentWork('Task', { outstanding: 1, elapsed: '1s' })!, /^1 subagent /)
  assert.match(describeSubagentWork('Task', { outstanding: 2, elapsed: '1s' })!, /^2 subagents /)

  // No start time recorded: the count is still worth saying, and an invented duration is not.
  assert.equal(describeSubagentWork('Task', { outstanding: 1 }), '1 subagent running')
})

test('a parent working alongside its subagents keeps its own tool named', () => {
  // Delegation does not always block the parent. Replacing `Bash` with a subagent count would
  // report a busy seat as doing nothing but waiting, which is the same class of error the name
  // list is kept conservative to avoid -- a line that is false is worse than one that is bare.
  assert.equal(describeSubagentWork('Bash', { outstanding: 2, elapsed: '5s' }), 'Bash · 2 subagents running (5s)')
  // Between tool calls there is no tool to name, and the count stands on its own.
  assert.equal(describeSubagentWork(undefined, { outstanding: 1, elapsed: '5s' }), '1 subagent running (5s)')
})

test('with nothing observed, the reading is exactly the one the console already had', () => {
  // The live path wherever no start arrives -- a CLI that does not dispatch `SubagentStart`,
  // and the stretch of any turn before the first one lands. A change that "improved" this
  // branch would be changing what an operator sees for every seat that cannot be counted.
  for (const observed of [undefined, { outstanding: 0 }, { outstanding: 0, elapsed: '9s' }]) {
    assert.equal(describeSubagentWork('Task', observed), describeTool('Task'))
    assert.equal(describeSubagentWork('wait_agent', observed), 'waiting on a subagent (wait_agent)')
    assert.equal(describeSubagentWork('Bash', observed), undefined, 'an ordinary tool still gets no substitute')
    assert.equal(describeSubagentWork(undefined, observed), undefined, 'and nothing at all is still nothing')
  }
})

test('delegation is detected from participant events, which carry the tool name', async (t) => {
  // The first version of this read the relay's `#evidence`, which keeps tool ARGUMENTS and
  // discards the tool name (#8). It would have reported `delegated: false` for every run
  // while looking entirely correct.
  const { Relay } = await import('./relay.ts')
  const { FakeRotationSession } = await import('../rotation/fakeSession.ts')
  const { AgentRegistry } = await import('../registry/registry.ts')
  const { execFileSync } = await import('node:child_process')

  const dir = tempDir(t, 'conclave-sub')
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
      // An in-memory double: no child process, so no clock of either kind.
      deadlines: NO_DEADLINE_CLOCKS,
      launch: { command: agent, baseArgs: [] },
      create: async () => s as never,
    })
  }
  const relay = await Relay.start({
    registry, cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 2,
  })
  await relay.run('a goal')
  const use = relay.subagentUse()
  await relay.stop()

  assert.equal(use.delegated, true, 'a wait_agent call is delegation')
  // A zero here is frequently correct: a subagent that only reads may use the shared
  // directory. It is evidence to weigh, never a verdict.
  assert.deepEqual(use.worktreesCreated, [])
})

test('a worktree created and removed within the run still counts as compliance', async (t) => {
  // A subagent that FOLLOWS the briefing creates a worktree, works in it, and removes it. An
  // end-of-run diff sees nothing and is indistinguishable from never having made one, so the
  // "no worktree was created" signal fired on the compliant case as readily as on the
  // violation -- worse than not having it.
  const { execFileSync } = await import('node:child_process')
  const { join } = await import('node:path')
  const { worktreePaths } = await import('./subagents.ts')

  const dir = tempDir(t, 'conclave-wt')
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir })

  const before = worktreePaths(dir)
  const wt = join(dir, 'wt')
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'probe', wt], { cwd: dir })
  const during = worktreePaths(dir)
  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: dir })
  const after = worktreePaths(dir)

  assert.equal(during.length, before.length + 1, 'visible while it exists')
  assert.deepEqual(after, before, 'and gone afterwards — which is why one sample is not enough')
})
