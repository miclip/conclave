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

test('acceptance criteria are a list of tests, not a list of asks', () => {
  // The two rules were pulling against each other. `no_acceptance_criteria` asks an author to
  // say what would count as done; the natural way to write that is a semicolon-separated
  // list; and `multiple_goals` then flagged the list as two asks. So a goal was penalised
  // for taking the trouble to be checkable.
  //
  // Found by linting a real goal for a real run, which is the only reason it was found: the
  // warning is non-blocking, so it had been mild enough to ignore.
  const goal =
    'Make `conclave status --json` report graded turn verdicts, so a caller confirming a ' +
    'run reads the evidence rather than inferring it. Done means: npm test passes; new ' +
    'tests cover the graded turns; and a finished session prints a non-empty turns array.'
  assert.deepEqual(lintGoal(goal).map((f) => f.code), [])
})

test('a genuinely conjoined ask is still caught', () => {
  // The tightening must not have bought its quiet by going blind. Both forms, and both
  // before any criteria marker, where a conjunction really does join two asks.
  for (const goal of [
    'Add the caching layer and then rewrite the installation docs. The suite must pass.',
    'Add caching; also rewrite the docs. The suite must pass.',
    'Wire up the retry as well as the exponential backoff. The suite must pass.',
  ]) {
    assert.ok(
      lintGoal(goal).some((f) => f.code === 'multiple_goals'),
      `two asks must still be flagged: ${goal}`,
    )
  }
})
