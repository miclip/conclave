/**
 * Checking a goal before two agents are spawned against it.
 *
 *   node --test src/relay/goalLint.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { lintGoal } from './goalLint.ts'

const codes = (goal: string) => lintGoal(goal).map((f) => f.code)

test('a goal naming something runnable passes clean', () => {
  // The commonest good goal. A lint that fires on this is noise, and noise trains a reader
  // to skip the exact place a real finding appears.
  assert.deepEqual(codes('Make the failing test in src/relay/authority.test.ts pass.'), [])
  assert.deepEqual(codes('Fix the normaliser so the golden fixtures match again.'), [])
  assert.deepEqual(codes('Add a rate limiter and verify it with a benchmark under load.'), [])
})

test('a goal with nothing observable is flagged', () => {
  assert.deepEqual(codes('Make the code nicer.'), [
    'no_acceptance_criteria',
    'unobservable_completion',
  ])
})

test('vagueness WITH a criterion is not flagged', () => {
  // "Refactor X until the suite passes" is a perfectly good goal. Flagging the word
  // "refactor" regardless of context would make this rule fire on half of all real work.
  assert.deepEqual(codes('Refactor the parser until the test suite passes.'), [])
  assert.deepEqual(codes('Clean up the adapter, keeping typecheck green.'), [])
})

test('two asks joined together are flagged, because an outcome is a single value', () => {
  assert.ok(codes('Fix the parser tests and then update the README.').includes('multiple_goals'))
  assert.ok(codes('Add caching; also rewrite the docs.').includes('multiple_goals'))
})

test('a premise stated as fact is flagged, because it is the cheapest place to notice', () => {
  const found = codes('Fix the timeout: the problem is the retry loop never backs off, tests pass after.')
  assert.ok(found.includes('asserted_premise'))
})

test('an ordinary description of work is not mistaken for an asserted premise', () => {
  // The rule must not fire on someone merely describing what they observed.
  assert.ok(!codes('Investigate why the suite is slow and make it faster than 60s.').includes('asserted_premise'))
})

test('every finding says what it costs, not just what it is', () => {
  // A lint that names a defect without saying what happens because of it gets ignored --
  // the same reason `no UserPromptSubmit hook after send` had to grow a remedy.
  for (const f of lintGoal('Make the code nicer.')) {
    assert.ok(f.consequence.length > 20, `${f.code} must say what it costs`)
    assert.ok(!f.consequence.endsWith('.'), 'consequences read as clauses, for one-line output')
  }
})

test('an empty goal produces nothing rather than everything', () => {
  // `session` accepts no goal at all and takes the first typed line as one. Firing four
  // findings at a console that is simply waiting would be absurd.
  assert.deepEqual(lintGoal(''), [])
  assert.deepEqual(lintGoal('   '), [])
})
