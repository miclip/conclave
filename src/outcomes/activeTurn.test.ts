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
import type { AgentEvent, RevisionEvent, TurnKey } from '../contract/session.ts'
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
/**
 * The watchdog's verdict: a deadline expired with nothing arriving.
 *
 * `synthesized`, like the ends drawn from a dead process and from the transcript -- which is
 * why the outcome and not that flag is what decides whether a turn is over.
 */
const timedOut = (key: TurnKey | undefined, at = 2_000): AgentEvent => ({
  type: 'turn_end',
  verdict: {
    outcome: 'timed_out',
    confidence: 'uncertain',
    provenance: [{ source: 'watchdog', detail: 'no output for 720s, and no Stop' }],
  },
  synthesized: true,
  // What a pty adapter emits for a deadline it could not talk itself out of: the clock fired,
  // the transcript showed no ending, and the child may still be working.
  transportOpen: true,
  ...(key === undefined ? {} : { turnKey: key }),
  seq: ++seq,
  at,
  provisional: false,
})

/** The same deadline from a transport that cannot leave a child running: no `transportOpen`. */
const timedOutOneShot = (key: TurnKey, at = 2_000): AgentEvent => ({
  type: 'turn_end',
  verdict: {
    outcome: 'timed_out',
    confidence: 'uncertain',
    provenance: [{ source: 'watchdog', detail: 'no output for 720s, and no Stop' }],
  },
  synthesized: true,
  turnKey: key,
  seq: ++seq,
  at,
  provisional: false,
})
const endedAs = (key: TurnKey, outcome: 'cancelled' | 'process_exited', at = 2_000): AgentEvent => ({
  type: 'turn_end',
  verdict: { outcome, confidence: 'assumed', provenance: [{ source: 'orchestrator', detail: 'sent ESC' }] },
  synthesized: true,
  turnKey: key,
  seq: ++seq,
  at,
  provisional: false,
})
const withdraws = (endSeq: number, at = 2_100, reason: RevisionEvent['reason'] = 'late_signal'): AgentEvent => ({
  type: 'revision',
  reason,
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

test('a reopened turn is MARKED as reopened, and only a turn_start clears the mark', () => {
  // The distinction the console's `/continue` resumes on (#66). The turn is open either way --
  // that answer does not change and must not -- but "open because a record was deleted" and
  // "open because the child was seen to begin" are different facts, and only one of them is
  // evidence that a send would land mid-turn.
  const opened = start(T1)
  const closed = end(T1)

  const reopened = activeTurn([opened, closed, withdraws(closed.seq, 2_100, 'compaction')])
  assert.ok(reopened)
  assert.deepEqual(reopened.withdrawn, { at: 2_100, reason: 'compaction' }, 'the mark carries when and why')

  // An ordinary open turn carries no mark, so a caller cannot mistake one for the other by
  // reading a field that is merely absent for a different reason.
  assert.equal(activeTurn([start(T1)])?.withdrawn, undefined)

  // A `turn_start` after the withdrawal clears it: the child was OBSERVED beginning a turn, and
  // the deleted record has nothing to say about that one. This is the case that keeps the
  // mid-turn refusal alive after #66.
  const began = activeTurn([opened, closed, withdraws(closed.seq), start(T2, 5_000)])
  assert.ok(began)
  assert.equal(began.turnKey, T2)
  assert.equal(began.withdrawn, undefined, 'a turn the child began is not a withdrawn one')

  // A `tool_use` does NOT clear it, and that is deliberate rather than an omission: after a
  // rewrite the transcript view re-emits surviving history, and the adapters forward its
  // content events while dropping its lifecycle events. So a tool call may be a replay of the
  // very history the withdrawal came from, where a `turn_start` cannot be.
  const withTool = activeTurn([opened, closed, withdraws(closed.seq), tool('Bash', 5_000)])
  assert.ok(withTool)
  assert.equal(withTool.tool, 'Bash', 'the label still lands')
  assert.ok(withTool.withdrawn, 'and the mark survives it')
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

test('a turn_end that says the child may still be running does not close the turn', () => {
  // The unsafe read this predicate exists to prevent, arriving through the one door left open.
  // `timed_out` is minted by a clock running out with NOTHING arriving -- the state in which a
  // child is most likely still working -- so treating it as the end of the turn makes the
  // strongest reason to think a child is busy read as proof that it is not. `Relay#awaitSendable`
  // then sends, and #117 is back.
  const turn = activeTurn([start(T1), timedOut(T1)])
  assert.ok(turn, 'the turn must still read as open')
  assert.equal(turn.turnKey, T1)
  assert.ok(turn.timedOut, 'and must say WHY it reads as open, for the human who saw the verdict')
  assert.equal(turn.withdrawn, undefined, 'nothing was withdrawn here')
})

test('every end that does not claim otherwise closes the turn, including a deadline', () => {
  // The other half, and the reason the OUTCOME is not the discriminator. Two of these are
  // synthesized; a cancelled turn was ended by us and the child was told; an exited child is
  // running nothing. And the last one matters most: a `timed_out` from a transport that cannot
  // leave a child running -- a one-shot adapter, or any double standing in for one -- closes the
  // turn like anything else. Absent means closed, deliberately: a predicate that left every turn
  // open on a transport minting no such signal would hang runs rather than risk them.
  assert.equal(activeTurn([start(T1), endedAs(T1, 'cancelled')]), undefined, 'cancelled')
  assert.equal(activeTurn([start(T1), endedAs(T1, 'process_exited')]), undefined, 'process_exited')
  assert.equal(activeTurn([start(T1), end(T1)]), undefined, 'completed')
  assert.equal(activeTurn([start(T1), timedOutOneShot(T1)]), undefined, 'timed_out with no claim')
})

test('a late signal that takes back a timed_out closes the turn on its replacement', () => {
  // The recovery, and the sequence an adapter really emits: `#apply` writes the revision first
  // and the replacement verdict immediately after. The turn was never closed by the deadline, so
  // what closes it is the `completed` end -- and the run carries on as if the deadline had never
  // fired, which is the whole point of a late signal.
  const deadline = timedOut(T1)
  const events = [start(T1), deadline, withdraws(deadline.seq), end(T1, 2_200)]
  assert.equal(activeTurn(events), undefined)
})

test('a withdrawal with no replacement leaves the turn open and marked withdrawn (#66)', () => {
  // The compaction case. A rewritten transcript can delete the evidence a verdict rested on, and
  // the tracker withdraws the claim rather than assert what the source of truth now denies. The
  // turn is then open because a RECORD IS GONE, not because a deadline expired -- and the
  // console needs the difference: it refuses on the second and continues on the first, because
  // nothing will ever close a turn whose closing evidence was deleted.
  const deadline = timedOut(T1)
  const turn = activeTurn([start(T1), deadline, withdraws(deadline.seq, 2_100, 'compaction')])
  assert.ok(turn)
  assert.ok(turn.withdrawn, 'the withdrawal must be visible to the caller that bypasses on it')
  assert.equal(turn.withdrawn.reason, 'compaction')
  assert.equal(turn.timedOut, undefined, 'and the deadline no longer explains anything: it was taken back')
})

test('a timed_out end for ANOTHER turn leaves this one alone', () => {
  // Same rule as a stale `completed` end, and it has to hold in both directions: a watchdog
  // standing down over turn one while turn two is running must not annotate turn two.
  const turn = activeTurn([start(T1), end(T1), start(T2, 3_000), timedOut(T1, 3_500)])
  assert.ok(turn)
  assert.equal(turn.turnKey, T2)
  assert.equal(turn.timedOut, undefined)
})

test('the description of a timed-out turn says the deadline decided nothing about the child', () => {
  const turn = activeTurn([start(T1, 1_000), timedOut(T1)])
  const line = describeActiveTurn(turn!, 1_000 + 47_000)
  assert.match(line, /47s/)
  assert.match(line, /timed_out/)
  assert.match(line, /rather than anything having observed the child stop/)
})
