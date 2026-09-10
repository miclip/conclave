/**
 * A harness block landing on an open turn is not a new turn (#255).
 *
 * `<task-notification>` and `<system-reminder>` are injected into the child's session by its own
 * harness and fire `UserPromptSubmit` like any other prompt. Measured on a real 11-hour session:
 * 23 of the implementer's 32 `turn_start` events were these, against 8 real turns, so anything
 * counting the stream reported four times the work that happened.
 *
 * The miscount was the visible half. The `UserPromptSubmit` case builds a FRESH `TurnState` and
 * overwrites the entry for that key, so a block arriving mid-turn also discarded the in-flight
 * turn's accumulated tools, subagents and `produced` flag.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { isHarnessBlock } from './promptFidelity.ts'

test('#255 the blocks a harness injects are recognised, and ordinary prompts are not', () => {
  // The discriminator the fix leans on, asserted directly: if this drifts, the guard silently
  // stops suppressing anything and the miscount returns with no test failing.
  assert.equal(isHarnessBlock('<task-notification>\n<task-id>abc</task-id>'), true)
  assert.equal(isHarnessBlock('<system-reminder>be sure to adhere</system-reminder>'), true)

  assert.equal(isHarnessBlock('[FROM THE ADVISOR (advisor) — a peer AI model]'), false, 'a real turn')
  assert.equal(isHarnessBlock('fix the build'), false)
  assert.equal(
    isHarnessBlock('the log contained <task-notification> in its output'),
    false,
    'mentioning one is not being one -- a turn that quotes a block must still count as a turn',
  )
})

test('#255 the guard is in the UserPromptSubmit path and requires the turn to be open', () => {
  // Pinned on the source because the condition is what matters and the behavioural case needs a
  // live child mid-turn, which this suite cannot schedule. Read the file rather than claim a
  // behavioural test that does not exist.
  //
  // BOTH halves are asserted. Suppressing on the block alone would drop a turn that genuinely
  // opened with one; suppressing on the open key alone would drop a real prompt re-using it.
  const text = readFileSync(fileURLToPath(new URL('./claude.ts', import.meta.url)), 'utf8')
  // Matched on the LINE rather than with a paren-counting regex: `isHarnessBlock(String(...))`
  // nests, and `[^)]*` stops at the first close -- a first version of this test failed on the
  // guard it was written for, which is a good way to learn that the pattern was the bug.
  const guardLine = text
    .split('\n')
    .find((l) => /^\s*if \(isHarnessBlock\(/.test(l) && l.includes('&&') && l.includes('this.#turns.has('))
  assert.ok(guardLine, 'the guard must test the block AND an already-open turn, not either alone')

  const caseAt = text.indexOf("case 'UserPromptSubmit': {")
  const guardAt = text.indexOf(guardLine)
  const buildAt = text.indexOf('const tracker = new TurnVerdictTracker({', caseAt)
  assert.ok(caseAt > 0 && guardAt > caseAt, 'the guard belongs inside the UserPromptSubmit case')
  assert.ok(
    guardAt < buildAt,
    'and BEFORE the fresh TurnState is built -- after it, the overwrite has already happened',
  )
})
