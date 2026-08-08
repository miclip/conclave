/**
 * Folding what the adapter knows into what the transcript says.
 *
 * Extracted from `snapshot()` to be testable at all: the adapter only constructs by spawning
 * a real CLI under a pty, so a defect in its private merge had nowhere to put a test — and
 * one lived there long enough to end a live run and discard a turn's report (#39).
 *
 *   node --test src/adapters/claudeMerge.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mergeKnownTurns, type KnownTurn } from './claude.ts'
import { turnKey } from '../contract/session.ts'
import type { TurnRecord } from '../contract/session.ts'
import type { Verdict } from '../contract/outcome.ts'

const completed: Verdict = {
  outcome: 'completed',
  confidence: 'proven',
  provenance: [{ source: 'hook', detail: 'Stop' }],
}

function known(over: Partial<KnownTurn> = {}): KnownTurn {
  return {
    key: turnKey('t1'),
    prompt: 'do the work',
    assistantText: undefined,
    verdict: completed,
    ...over,
  }
}

test('a hook verdict outranks what the transcript inferred', () => {
  const transcript: TurnRecord[] = [
    { key: turnKey('t1'), prompt: 'do the work', state: 'in_progress', toolCalls: [] },
  ]
  const [turn] = mergeKnownTurns(transcript, [known()])
  // Stop PROVES completion; the transcript only ever suggests it.
  assert.equal(turn?.state, 'completed')
  assert.equal(turn?.confidence, 'proven')
  assert.deepEqual(turn?.provenance, [{ source: 'hook', detail: 'Stop' }])
})

test("the hook's closing message is used when the transcript has no prose", () => {
  // The case that cost a run. `Stop` fires when the turn ends; the final assistant message
  // may not have been flushed yet, so the transcript holds a turn with no text. The adapter
  // stores `last_assistant_message` for exactly this — and `snapshot()` did not read it back
  // out, so the fallback existed and no consumer could see it. The relay got an empty
  // report, had nothing to route, and ended the run while the work sat on disk (#39).
  const transcript: TurnRecord[] = [
    { key: turnKey('t1'), prompt: 'do the work', state: 'in_progress', toolCalls: [] },
  ]
  const [turn] = mergeKnownTurns(transcript, [known({ assistantText: 'Rewrote the record: seven new sections.' })])
  assert.equal(turn?.assistantText, 'Rewrote the record: seven new sections.')
})

test('the transcript wins where it has prose, because it has more of it', () => {
  // `last_assistant_message` is the closing paragraph alone; the transcript concatenates
  // every block, which is the running narration the peer is entitled to. Preferring the
  // fallback would throw away the rest of the turn to gain nothing.
  const transcript: TurnRecord[] = [
    {
      key: turnKey('t1'),
      prompt: 'do the work',
      state: 'in_progress',
      toolCalls: [],
      assistantText: 'First I read the parser.\n\nThen I rewrote it.\n\nDone.',
    },
  ]
  const [turn] = mergeKnownTurns(transcript, [known({ assistantText: 'Done.' })])
  assert.match(turn?.assistantText ?? '', /First I read the parser/)
})

test('a turn the transcript has not recorded yet is appended, not dropped', () => {
  // Otherwise a consumer folding `events()` and a consumer reading `snapshot()` would
  // disagree about how many turns there were.
  const merged = mergeKnownTurns([], [known({ assistantText: 'the report' })])
  assert.equal(merged.length, 1)
  assert.equal(merged[0]?.state, 'completed')
  assert.equal(merged[0]?.assistantText, 'the report')
})

test('a transcript turn the adapter knows nothing about is left exactly as it was', () => {
  // Positional correspondence has a tail: the transcript can hold turns from before this
  // process attached. Merging onto them would attribute this session's verdicts to someone
  // else's work.
  const transcript: TurnRecord[] = [
    { key: turnKey('old'), prompt: 'earlier', state: 'completed', toolCalls: [], assistantText: 'earlier text' },
    { key: turnKey('t1'), prompt: 'do the work', state: 'in_progress', toolCalls: [] },
  ]
  const merged = mergeKnownTurns(transcript, [undefined, known()])
  assert.equal(merged[0]?.key, turnKey('old'))
  assert.equal(merged[0]?.assistantText, 'earlier text')
  assert.equal(merged[1]?.state, 'completed')
})

test('no verdict yet leaves the transcript state alone', () => {
  const transcript: TurnRecord[] = [
    { key: turnKey('t1'), prompt: 'do the work', state: 'in_progress', toolCalls: [] },
  ]
  const [turn] = mergeKnownTurns(transcript, [known({ verdict: undefined, assistantText: 'partial' })])
  assert.equal(turn?.state, 'in_progress', 'a turn still running must not be reported as finished')
  // ...and the fallback still applies: the two are independent.
  assert.equal(turn?.assistantText, 'partial')
})
