/**
 * The one predicate that says whether a child is mid-turn.
 *
 * Unit tests, because both callers that matter -- the relay's peer send and the console's
 * `/continue` -- are about to put bytes into a child on the strength of this answer, and a
 * wrong answer costs a run in one direction and an hour of an operator's time in the other.
 * Driving it from event lists is also the only way to state the cases that are hard to produce
 * live: a withdrawn verdict, and an end that belongs to somebody else's turn.
 *
 *   node --test src/outcomes/activeTurn.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { AgentEvent, TurnKey } from '../contract/session.ts'
import { turnKey } from '../contract/session.ts'
import { activeTurn, describeActiveTurn } from './activeTurn.ts'

const T1 = turnKey('t1')
const T2 = turnKey('t2')

let seq = 0
const start = (key: TurnKey, at = 1_000): AgentEvent => ({
  type: 'turn_start',
  prompt: 'do the work',
  turnKey: key,
  seq: ++seq,
  at,
  provisional: false,
})
const end = (key: TurnKey | undefined, at = 2_000): AgentEvent => ({
  type: 'turn_end',
  verdict: { outcome: 'completed', confidence: 'proven', provenance: [{ source: 'hook', detail: 'Stop' }] },
  synthesized: false,
  ...(key === undefined ? {} : { turnKey: key }),
  seq: ++seq,
  at,
  provisional: false,
})
const tool = (name: string, at = 1_500): AgentEvent => ({
  type: 'tool_use',
  tool: name,
  input: {},
  seq: ++seq,
  at,
  provisional: false,
})
const withdraws = (endSeq: number, at = 2_100): AgentEvent => ({
  type: 'revision',
  reason: 'late_signal',
  replaces: [endSeq],
  provenance: [{ source: 'hook', detail: 'stronger evidence superseded the reported verdict' }],
  seq: ++seq,
  at,
  provisional: false,
})

test('a participant with no events, and one whose turn has ended, are both idle', () => {
  assert.equal(activeTurn([]), undefined)
  assert.equal(activeTurn([start(T1), end(T1)]), undefined)
})

test('a turn that started and has not ended is active, and carries when it started', () => {
  const turn = activeTurn([start(T1, 5_000)])
  assert.ok(turn)
  assert.equal(turn.since, 5_000)
  assert.equal(turn.turnKey, T1)
})

test('a turn with no tool call in flight is still a turn', () => {
  // The false negative that would put the CPU reading's failure back, in tidier clothes: a
  // child composing a long reply runs no tool and is emphatically mid-turn.
  assert.ok(activeTurn([start(T1)]), 'no tool_use, still active')
  const working = activeTurn([start(T1), tool('Bash')])
  assert.equal(working?.tool, 'Bash', 'the tool is a label on an already-active turn')
})

test("an end belonging to another turn does not end this one", () => {
  // The shape that makes the relay send into a live child. `Relay#exchangeTurn` waits for the
  // first `turn_end` it sees and never checks the key, so a late end for the PREVIOUS turn
  // releases it while the current turn is still running. This is the check that catches it at
  // the next send.
  const turn = activeTurn([start(T1), end(T1), start(T2), end(T1, 3_000)])
  assert.ok(turn, 'the second turn is still running')
  assert.equal(turn.turnKey, T2)
})

test('an end with no key closes the turn, because a transport that mints none must not hang', () => {
  assert.equal(activeTurn([start(T1), end(undefined)]), undefined)
})

test('a withdrawn verdict puts the turn back, and a replacement takes it away again', () => {
  // The watchdog case, and the reason this cannot read `turn_end` alone: a long turn is called
  // `timed_out`, a late Stop takes that back, and between the two the child never stopped
  // working. `resetTranscript` is the same shape with no replacement at all.
  const opened = start(T1)
  const closed = end(T1)
  const reopened = activeTurn([opened, closed, withdraws(closed.seq)])
  assert.ok(reopened, 'a withdrawn end leaves the turn open')
  assert.equal(reopened.turnKey, T1)

  assert.equal(
    activeTurn([opened, closed, withdraws(closed.seq), end(T1, 4_000)]),
    undefined,
    'and the replacement end closes it',
  )
})

test('a revision that withdraws something else leaves the turn closed', () => {
  // A compaction rewrites history and says nothing about whether a child is working. Reading
  // every revision as a reopening would refuse sends for the rest of the run.
  const compaction: AgentEvent = {
    type: 'revision',
    reason: 'compaction',
    replaces: [],
    provenance: [{ source: 'transcript', detail: 'transcript declares a compaction' }],
    seq: ++seq,
    at: 3_000,
    provisional: false,
  }
  assert.equal(activeTurn([start(T1), end(T1), compaction]), undefined)
})

test('the description says how long and what, and never mentions CPU', () => {
  const line = describeActiveTurn({ since: 0, tool: 'Edit' }, 43_000)
  assert.equal(line, 'its turn has been running 43s and its last tool call was Edit')
  assert.equal(describeActiveTurn({ since: 0 }, 125_000), 'its turn has been running 2m5s')
})
