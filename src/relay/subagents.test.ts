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
