/**
 * What counts as the child having spoken, at the one boundary where the type tag is not enough.
 *
 * `isChildOutput` was a set of type tags, and `message` was in it. The contract permits
 * `role: 'user'` on a message -- the adapters emit only assistant text today, but that is a
 * property of `transcript/reconcile.ts` as it currently stands and nothing holds it there. A
 * user message is the orchestrator's own prompt coming back, so accepting one would let a turn
 * prove it was alive by having been asked a question.
 *
 * The consequences are both silent, which is why this is tested at the predicate rather than
 * only through a session. A false positive holds the watchdog's silence deadline open on a turn
 * that never spoke and clears the launched model of #82's diagnosis; a false negative starves
 * that same deadline and kills a turn that was working.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { AgentEvent } from './session.ts'
import { isChildOutput } from './session.ts'

const base = { seq: 1, at: 1_700_000_000_000, provisional: false }

/**
 * One case per event type, keyed by the type itself.
 *
 * A `Record` over `AgentEvent['type']` on purpose: an event type added to the union without a
 * case here fails to compile, so "the predicate has an answer for everything the contract can
 * produce" is checked by the type system rather than by a list someone has to remember.
 */
const CASES: Record<AgentEvent['type'], { what: string; event: AgentEvent; counts: boolean }[]> = {
  message: [
    {
      what: 'assistant text is the child speaking',
      event: { ...base, type: 'message', role: 'assistant', text: 'let me check that file' },
      counts: true,
    },
    {
      what: 'a user message is the prompt this turn was given, not an answer to it',
      event: { ...base, type: 'message', role: 'user', text: 'refactor the watchdog' },
      counts: false,
    },
    {
      what: 'replayed assistant text is a rewritten transcript re-announcing itself',
      event: { ...base, type: 'message', role: 'assistant', text: 'let me check that file', replay: true },
      counts: false,
    },
  ],
  thinking: [
    {
      // #198: the case this event exists for. A seat in extended thinking emits no assistant
      // text, no tool call and no hook, so by every other clause here it has gone silent --
      // while being at its most productive, on precisely the hard problems an advisor delegates.
      what: 'reasoning is the child working, even though it is not the child speaking',
      event: { ...base, type: 'thinking' },
      counts: true,
    },
    {
      // The same rule every other event obeys, and it matters more here: a transcript replayed
      // after a rotation carries every thinking block the old turn ever wrote, and counting them
      // would hold the silence deadline open on a seat that has said nothing since.
      what: 'a replayed thinking block is history, not a seat that is thinking now',
      event: { ...base, type: 'thinking', replay: true },
      counts: false,
    },
  ],
  tool_use: [
    {
      what: 'a tool call is work',
      event: { ...base, type: 'tool_use', tool: 'Bash', input: { command: 'ls' } },
      counts: true,
    },
    {
      what: 'a replayed tool call is history the transcript re-emitted, not work happening now',
      event: { ...base, type: 'tool_use', tool: 'Bash', input: { command: 'ls' }, replay: true },
      counts: false,
    },
  ],
  permission_requested: [
    {
      what: 'a permission request is the child having decided to do something',
      event: { ...base, type: 'permission_requested', tool: 'Bash', input: { command: 'rm' } },
      counts: true,
    },
  ],
  subagent_start: [
    {
      what: 'a subagent starting is the child having delegated -- work it did, reported by its own hook',
      event: { ...base, type: 'subagent_start', agentId: 'a1', agentType: 'Explore', outstanding: 1 },
      counts: true,
    },
  ],
  subagent_stop: [
    {
      what: 'a subagent finishing is the child still there to be told about it',
      event: { ...base, type: 'subagent_stop', agentId: 'a1', paired: true, outstanding: 0 },
      counts: true,
    },
    {
      what: 'and an unpaired stop is no weaker as evidence of life -- only as evidence of a count',
      event: { ...base, type: 'subagent_stop', agentId: 'a1', paired: false, outstanding: 0 },
      counts: true,
    },
  ],
  turn_start: [
    {
      what: 'the adapter announcing it armed a clock says nothing about the child',
      event: { ...base, type: 'turn_start', prompt: 'refactor the watchdog' },
      counts: false,
    },
  ],
  turn_end: [
    {
      what: 'a verdict is the conclusion, not evidence for one',
      event: {
        ...base,
        type: 'turn_end',
        synthesized: true,
        verdict: {
          outcome: 'timed_out',
          confidence: 'uncertain',
          provenance: [{ source: 'watchdog', detail: 'no output for 720s, and no Stop' }],
        },
      },
      counts: false,
    },
  ],
  revision: [
    {
      what: 'a revision is the adapter withdrawing its own earlier claim',
      event: {
        ...base,
        type: 'revision',
        reason: 'late_signal',
        replaces: [1],
        provenance: [{ source: 'hook', detail: 'Stop arrived after the deadline' }],
      },
      counts: false,
    },
  ],
  error: [
    {
      what: 'an adapter error is the adapter reporting on itself',
      event: { ...base, type: 'error', message: 'transcript unreadable', fatal: false },
      counts: false,
    },
  ],
}

test('only assistant messages, tool calls, permission requests and subagent lifecycle count as the child speaking', () => {
  for (const cases of Object.values(CASES)) {
    for (const c of cases) {
      assert.equal(isChildOutput(c.event), c.counts, c.what)
    }
  }
})

test('a user message never counts, whatever else is true of it', () => {
  // Stated separately because it is the one case the old type-tag set got wrong, and a loop
  // over a table is easy to weaken without noticing which row went missing.
  const asked: AgentEvent = { ...base, type: 'message', role: 'user', text: 'are you still there?' }
  assert.equal(isChildOutput(asked), false)
  // The same event with the role flipped is the whole of the difference.
  assert.equal(isChildOutput({ ...asked, role: 'assistant' }), true)
})

test('a replay never counts, whatever it carries', () => {
  // The rule kept apart from the type table because it cuts ACROSS it: replay is a property of
  // how the event reached us, not of what kind of event it is, and the reason it belongs in the
  // predicate rather than in each reader is that a prefix rewrite re-emits the whole transcript
  // at once. See `EventBase.replay`; `adapters/watchdogWiring.test.ts` proves what it buys a
  // stalled turn.
  for (const cases of Object.values(CASES)) {
    for (const c of cases) {
      assert.equal(
        isChildOutput({ ...c.event, replay: true }),
        false,
        `replayed: ${c.what}`,
      )
    }
  }
})
