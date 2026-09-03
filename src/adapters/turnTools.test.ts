/**
 * The tool-call bookkeeping that decides whether a quiet turn is waiting or stopped (#193).
 *
 * A child blocked inside one long tool call emits nothing while it waits — measured across
 * 4,055 real calls, a median of 0.2s but a p99 of 508s and a maximum of 11,912s. A seat running
 * a test suite as its `--checks` is silent for most of the silence budget every time, so the
 * watchdog needs to know the difference between waiting and stopped.
 *
 * Paired by `tool_use_id` rather than counted, and the id is not an assumption: probed against
 * the installed bundle by registering these hooks in a settings file and running `claude -p`,
 * both `PreToolUse` and `PostToolUse` fired and both payloads carried one. Pairing is what makes
 * a stranded start impossible to confuse with a second tool starting.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { TurnTools } from './claude.ts'

test('a turn that has started nothing is waiting on nothing', () => {
  assert.equal(new TurnTools().outstanding, 0)
})

test('concurrent calls are tracked apart, and the turn waits for the last of them', () => {
  // Claude Code runs tool calls in parallel, so this is a set and not a flag. A flag would clear
  // on the FIRST completion and expose the turn to the silence clock while the others were still
  // running — the bug this exists to prevent, in miniature.
  const t = new TurnTools()
  assert.equal(t.start('a'), 'started')
  assert.equal(t.start('b'), 'started')
  assert.equal(t.outstanding, 2)

  assert.equal(t.finish('a'), 'stopped')
  assert.equal(t.outstanding, 1, 'one returning does not free the turn')
  assert.equal(t.finish('b'), 'stopped')
  assert.equal(t.outstanding, 0, 'only the last one makes it measurable again')
})

test('a redelivered start does not double-count the same call', () => {
  // Hook delivery is an HTTP post and nothing promises exactly-once. Counted twice, this call
  // would need two completions to clear, and the second would never come.
  const t = new TurnTools()
  t.start('a')
  assert.equal(t.start('a'), 'duplicate')
  assert.equal(t.outstanding, 1)
  t.finish('a')
  assert.equal(t.outstanding, 0)
})

test('a redelivered completion does not free a call twice', () => {
  const t = new TurnTools()
  t.start('a')
  t.start('b')
  t.finish('a')
  assert.equal(t.finish('a'), 'duplicate', 'the same completion twice is one completion')
  assert.equal(t.outstanding, 1, 'and must not release the call that is still running')
})

test('a completion for a call this turn never saw is unpaired, and frees nothing', () => {
  // Reachable: a hook whose turn key names nothing this adapter armed resolves to the latest
  // live turn, so a completion can land on a turn that never saw its start. Treating it as a
  // completion would free a DIFFERENT call that is still running.
  const t = new TurnTools()
  t.start('mine')
  assert.equal(t.finish('someone-elses'), 'unpaired')
  assert.equal(t.outstanding, 1, 'the call actually in flight is untouched')
})
