/**
 * `COMMAND:` is a directive the orchestrator INTERPRETS rather than forwards, and the whole
 * value of it is in the second half of that sentence.
 *
 *   node --test src/relay/commandDirective.test.ts
 *
 * An advisor that writes "run /compact" into an instruction has asked the implementer to type
 * something; whether it happens is the implementer's choice, and the run has no record either
 * way. A `COMMAND:` line is lifted out of the reply exactly as a `NOTE:` line is, so it can
 * never arrive as prose after an envelope header. These tests pin the lifting -- both that the
 * line is captured and that it is GONE from what the implementer receives, because a directive
 * that is also delivered as text is the worst of both.
 *
 * Nothing submits a command yet. The parser is proven on its own so the wiring that follows
 * has something already checked to build on.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { splitCommands, splitNotes } from './relay.ts'

test('a COMMAND line is captured and removed from the instruction', () => {
  const { commands, rest } = splitCommands('COMMAND: /compact\nCarry on with the failing test.')
  assert.deepEqual(commands, ['/compact'])
  assert.equal(
    rest,
    'Carry on with the failing test.',
    'a directive left in the remainder would reach the implementer as prose telling it to run something, which is the delivery this exists to replace',
  )
})

test('the remainder is still the instruction, exactly as with a note', () => {
  const { commands, rest } = splitCommands('Fix the parser.\nCOMMAND: /compact\nThen re-run the tests.')
  assert.deepEqual(commands, ['/compact'])
  assert.equal(rest, 'Fix the parser.\n\nThen re-run the tests.')
})

test('several commands in one reply are all captured, in the order written', () => {
  const { commands, rest } = splitCommands('COMMAND: /compact\nCOMMAND: /loop 20m keep checking CI\nGo.')
  assert.deepEqual(commands, ['/compact', '/loop 20m keep checking CI'])
  assert.equal(rest, 'Go.')
})

test('a reply with no directive is returned untouched, marker word and all', () => {
  // The fixture carries `COMMAND:` MID-LINE on purpose. Without the colon it would prove
  // nothing: an unanchored marker would not have matched it either, and the test would pass
  // over exactly the regression it names.
  const prose = 'Explain to the seat that a COMMAND: line must start the line, and carry on.'
  const { commands, rest } = splitCommands(prose)
  assert.deepEqual(commands, [], 'the marker is line-initial, or a sentence about a directive becomes one')
  assert.equal(rest, prose)
})

test('a malformed request is lifted out rather than delivered as an instruction', () => {
  // The marker takes the line unconditionally, including a payload that is not a slash command.
  // Matching only `/`-prefixed payloads would look stricter and be worse: `COMMAND: compact`
  // would fall through and reach the implementer as prose telling it to do something. Lifted
  // out, it is refused by `ruleOnCommand` and recorded instead.
  const { commands, rest } = splitCommands('COMMAND: compact please\nDo the work.')
  assert.deepEqual(commands, ['compact please'])
  assert.equal(rest, 'Do the work.')
})

test('a directive with nothing after it captures nothing, and is left where it stands', () => {
  // Byte-for-byte what `NOTE:` does with an empty payload, and matched deliberately rather
  // than improved on. The marker requires a payload, so a bare `COMMAND:` is not a directive
  // at all and never enters the removal; what reaches the implementer is the literal word,
  // which is noise and not an instruction. Diverging from `NOTE:` here would mean two markers
  // of the same shape with different edge behaviour, which is a worse thing to have than a
  // stray line.
  const { commands, rest } = splitCommands('COMMAND:\nDo the work.')
  assert.deepEqual(commands, [], 'a directive with no command is not a command')
  assert.equal(rest, 'COMMAND:\nDo the work.')
  assert.equal(splitNotes('NOTE:\nDo the work.').rest, 'NOTE:\nDo the work.', 'the behaviour above is the one already shipped, not a new one')
})

test('notes and commands are lifted independently, and neither eats the other', () => {
  // They are separate markers over the same reply, so the order they are applied in must not
  // matter. If either regex were loose enough to consume the other's line, one directive would
  // be silently lost in whichever order the caller happened to pick.
  const prose = 'NOTE: the branch is dirty.\nCOMMAND: /compact\nCarry on.'
  const notesFirst = splitNotes(prose)
  const then = splitCommands(notesFirst.rest)
  assert.deepEqual(notesFirst.notes, ['the branch is dirty.'])
  assert.deepEqual(then.commands, ['/compact'])
  assert.equal(then.rest, 'Carry on.')

  const commandsFirst = splitCommands(prose)
  const after = splitNotes(commandsFirst.rest)
  assert.deepEqual(commandsFirst.commands, ['/compact'])
  assert.deepEqual(after.notes, ['the branch is dirty.'])
  assert.equal(after.rest, 'Carry on.')
})

test('the marker tolerates the leading whitespace and casing a model actually produces', () => {
  const { commands, rest } = splitCommands('  command: /loop\nGo.')
  assert.deepEqual(commands, ['/loop'], 'the same tolerance NOTE_MARKER has; a directive that fails on an indent is a directive that fails')
  assert.equal(rest, 'Go.')
})
