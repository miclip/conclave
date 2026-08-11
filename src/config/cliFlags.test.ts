/**
 * The one flag reader both front-ends use.
 *
 * `frontEndParity.test.ts` proves that `relay` and `session` AGREE about values, by driving
 * both commands. It cannot say whether they agree on the right answer -- two commands calling
 * one function agree by construction -- so the rules themselves are pinned here, on the
 * function, where a change to them is a change to what both commands accept at once.
 *
 *   node --test src/config/cliFlags.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { PASS_THROUGH_FLAGS, flagReader } from './cliFlags.ts'

const VALUED = ['rounds', 'checks', 'implementer', 'implementer-args', 'advisor-args']

test('a flag that was not given falls back, and one that was is read', () => {
  const flag = flagReader(['--rounds', '4'], VALUED)
  assert.equal(flag('rounds', '8'), '4')
  assert.equal(flag('checks', ''), '', 'a flag nobody typed is the fallback, not an empty read')
  assert.equal(flag.missing, undefined)
})

test('a flag whose value went missing is named, and reads as its fallback', () => {
  // Both shapes: the next token is another flag, and there is no next token at all. The first
  // is the one that bites in practice -- `--rounds --json` used to run four hundred rounds
  // named `--json` on one front-end and refuse on the other.
  for (const argv of [['--rounds', '--json'], ['--checks', 'npm test', '--rounds']]) {
    const flag = flagReader(argv, VALUED)
    assert.equal(flag.missing, 'rounds', `${JSON.stringify(argv)} lost the value of --rounds`)
    assert.equal(flag('rounds', '8'), '8', 'a value that went missing must not be half-read')
  }
})

test('a pass-through flag takes an argv fragment, leading dashes and all', () => {
  // #81. `--model x` is a value here, not a value that went missing, because the value is a
  // command line for somebody else's CLI.
  const flag = flagReader(['--implementer-args', '--model gpt-5'], VALUED)
  assert.equal(flag('implementer-args', ''), '--model gpt-5')
  assert.equal(flag.missing, undefined)
  assert.deepEqual([...PASS_THROUGH_FLAGS].sort(), ['advisor-args', 'implementer-args', 'lead-args'])
})

test("a pass-through flag's value is consumed, so it is not read as a flag of its own", () => {
  // The half an `indexOf` cannot do. `--implementer-args --rounds` passes `--rounds` to the
  // child; searching the argv for `--rounds` afterwards finds that VALUE, and reads `4` --
  // meant for nobody -- as the round count.
  const flag = flagReader(['--implementer-args', '--rounds', '4'], VALUED)
  assert.equal(flag('implementer-args', ''), '--rounds')
  assert.equal(flag('rounds', '8'), '8', '--rounds was an argument to the child, not to conclave')
  assert.equal(flag.missing, undefined, 'a consumed token is not a flag that lost its value')
})

test('the first spelling wins, as it did before there was one reader', () => {
  const flag = flagReader(['--rounds', '2', '--rounds', '9'], VALUED)
  assert.equal(flag('rounds', '8'), '2')
})

test('reading a flag the command did not declare is a programming error, not a fallback', () => {
  // Silence here would be the bug this whole file is about, one level up: an undeclared flag is
  // one the missing-value scan never looked at, so it would be parsed by a rule nobody chose.
  const flag = flagReader(['--settle', '5'], VALUED)
  assert.throws(() => flag('settle', ''), /not one of this command's valued flags/)
})
