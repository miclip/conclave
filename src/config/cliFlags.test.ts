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
import {
  PASS_THROUGH_FLAGS,
  beforeEndOfOptions,
  flagReader,
  nearestFlag,
  parseArgv,
  unknownFlagMessage,
} from './cliFlags.ts'
import type { FlagSurface } from './cliFlags.ts'

const VALUED = ['rounds', 'checks', 'implementer', 'implementer-args', 'advisor-args', 'reviewer-args']

/**
 * A surface shaped like the real ones and small enough to read.
 *
 * The commands' own surfaces are declared in `bin/conclave.ts` and compared against their call
 * sites by `frontEndParity.test.ts`. What is pinned here is the RULE a surface is applied by,
 * which is one function and is what both commands inherit.
 */
const SURFACE: FlagSurface = {
  valued: VALUED,
  boolean: ['bypass', 'dry-run', 'force', 'json'],
  optionalValues: { bypass: ['claude', 'codex'] },
}

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

test('a flag nobody declared is named, not skipped with its value (#172)', () => {
  // The falsifier this was written for. `--goal-file` matched nothing, so the scan skipped it
  // and skipped `/tmp/goal.txt` with it, and the console came up asking for the goal it had
  // just been handed. Both halves are asserted: the flag is REPORTED, and its value did not
  // quietly become nothing -- it is a bare token, which is its own refusal one level up.
  const parsed = parseArgv(['--goal-file', '/tmp/goal.txt'], SURFACE)
  assert.deepEqual(parsed.unknown, ['--goal-file'])
  assert.deepEqual(parsed.positionals, ['/tmp/goal.txt'])
  assert.deepEqual(parsed.flags, [], 'nothing about an invented flag is handed on as a flag')
})

test('a switch the surface declares is accepted, and consumes nothing', () => {
  // The reason the boolean half of the surface has to exist at all: without it a parser cannot
  // tell `--force` from `--goal-file`, so it must ignore both.
  const parsed = parseArgv(['--force', '--json', '--rounds', '4'], SURFACE)
  assert.deepEqual(parsed.unknown, [])
  assert.deepEqual(parsed.flags, ['--force', '--json', '--rounds', '4'])
  assert.equal(flagReader(parsed.flags, VALUED)('rounds', '8'), '4')
})

test('a single-dash token is a flag too, and is refused when it is not one', () => {
  assert.deepEqual(parseArgv(['-x'], SURFACE).unknown, ['-x'])
  // But a single-dash VALUE is a value. `--reviewer-args -q` is one flag with one value, and
  // only a leading `--` means a value went missing -- see `flagReader`.
  const parsed = parseArgv(['--reviewer-args', '-q'], SURFACE)
  assert.deepEqual(parsed.unknown, [])
  assert.equal(flagReader(parsed.flags, VALUED)('reviewer-args', ''), '-q')
})

test("a child CLI's argv survives the surface, dashes and all", () => {
  // #81 again, from the other side: strictness must not reach inside a value. `--model foo
  // --verbose` is ONE value belonging to somebody else's command line, and nothing in it is a
  // flag of ours to recognise or refuse.
  const parsed = parseArgv(['--implementer-args', '--model foo --verbose'], SURFACE)
  assert.deepEqual(parsed.unknown, [])
  assert.equal(flagReader(parsed.flags, VALUED)('implementer-args', ''), '--model foo --verbose')
})

test('`--` ends the options, so a goal may begin with a dash', () => {
  const parsed = parseArgv(['--rounds', '4', '--', '--force is broken'], SURFACE)
  assert.deepEqual(parsed.positionals, ['--force is broken'])
  assert.deepEqual(parsed.flags, ['--rounds', '4'], 'nothing after the marker is read as a flag')
  assert.deepEqual(parsed.unknown, [], 'and nothing after it is refused as one either')
  // Exactly `--help` after the marker is a goal, not a request for the usage text: the guard
  // above the dispatch reads only what was typed as options.
  assert.deepEqual(beforeEndOfOptions(['session', '--', '--help']), ['session'])
  assert.deepEqual(beforeEndOfOptions(['session', '--help']), ['session', '--help'])
})

test('a goal is the token no flag claimed, wherever it was typed', () => {
  // It used to be argv[0] and nothing else, which read `session --rounds 4 "<goal>"` as a
  // session with no goal. Every flag's value is consumed by the scan, so what is left over
  // cannot be anything but the goal.
  assert.deepEqual(parseArgv(['--rounds', '4', 'the goal'], SURFACE).positionals, ['the goal'])
  // And a goal that merely CONTAINS the marker is one token, so it is a goal like any other.
  assert.deepEqual(parseArgv(['fix the -- handling'], SURFACE).positionals, ['fix the -- handling'])
  // Two bare tokens is a goal that lost its quotes. Named as two, refused one level up.
  assert.deepEqual(parseArgv(['fix the', 'login bug'], SURFACE).positionals, ['fix the', 'login bug'])
})

test('--bypass absorbs an agent name and nothing else', () => {
  // The enumeration is what keeps a goal a goal: any-non-flag-token meant
  // `session --bypass "fix the login bug"` wrote agents["fix the login bug"] into the project
  // config and dropped the goal on the floor.
  const scoped = parseArgv(['--bypass', 'claude'], SURFACE)
  assert.deepEqual(scoped.flags, ['--bypass', 'claude'])
  assert.deepEqual(scoped.positionals, [])
  const goal = parseArgv(['--bypass', 'fix the login bug'], SURFACE)
  assert.deepEqual(goal.flags, ['--bypass'])
  assert.deepEqual(goal.positionals, ['fix the login bug'])
})

test('a near miss is drawn from the surface itself, and a far one is not guessed at', () => {
  // Drawn from the same declaration the refusal is made against, so a suggestion can never
  // name a flag the parser would then reject.
  assert.equal(nearestFlag('--round', SURFACE), 'rounds')
  assert.equal(nearestFlag('--implemented', SURFACE), 'implementer')
  assert.equal(nearestFlag('--goal-file', SURFACE), undefined, 'a different flag is not a typo')
  const message = unknownFlagMessage(['--goal-file'], 'session', SURFACE)
  assert.match(message, /--goal-file is not a flag this command takes/)
  assert.ok(!/did you mean/.test(message), 'nothing near enough to name')
  assert.match(message, /--rounds/, 'and the flags it does take are listed')
  // `--rounds=4` is not a typo, it is the other spelling of a value, and saying which spelling
  // this cli uses answers it. "did you mean --rounds?" would not.
  assert.match(unknownFlagMessage(['--rounds=4'], 'relay', SURFACE), /a value is a separate token/)
})
