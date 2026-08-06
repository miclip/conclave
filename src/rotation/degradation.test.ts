/**
 * Degradation is mechanical; the complaint is a claim. §7a's three rows.
 *
 *   node --test src/rotation/degradation.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { AgentEvent } from '../contract/session.ts'
import { assess, ComplaintLedger, detectComplaint, detectDegradation } from './degradation.ts'

function revision(declared: boolean): AgentEvent {
  return {
    type: 'revision',
    reason: 'compaction',
    replaces: [1, 2],
    provenance: [
      { source: 'transcript', detail: 'transcript prefix changed; history was rewritten' },
      {
        source: 'transcript',
        detail: declared
          ? 'transcript declares a compaction'
          : 'rewrite detected by prefix digest; no compaction marker recognised',
        caveat: !declared,
      },
    ],
    seq: 9,
    at: 0,
    provisional: false,
  }
}

test('a risen compaction generation is degradation', () => {
  const d = detectDegradation({ baselineGeneration: 0, currentGeneration: 1 })
  assert.equal(d.degraded, true)
  assert.ok(d.evidence[0]!.includes('0 → 1'))
})

test('an undeclared rewrite still counts, and says so', () => {
  // The transcript may be rewritten without a marker either CLI documents. Requiring the
  // marker would make the signal depend on vendor labelling rather than on what happened.
  const d = detectDegradation({ baselineGeneration: 0, currentGeneration: 0, events: [revision(false)] })
  assert.equal(d.degraded, true)
  assert.ok(d.evidence.some((e) => e.includes('no compaction marker recognised')))
})

test('discussing compaction as a design topic is not a complaint about oneself', () => {
  // Verbatim from a live session. The implementer was building compaction-aware code and
  // listed this as a reliability gap in the feature; it was logged as an unbacked complaint
  // against its own stall metric. First person is the discriminator.
  assert.equal(
    detectComplaint(
      '2. **Compaction can erase evidence.** snapshot() rebuilds from a transcript that ' +
        'compaction rewrites, and attribution is cumulative, so the exposure window is one turn wide.',
    ),
    false,
  )
  assert.equal(
    detectComplaint('The design brief says a fresh session should be started when context is exhausted.'),
    false,
    'quoting the design is not reporting your own state',
  )
  // And the real thing still fires.
  assert.equal(detectComplaint('I was just compacted and have lost the earlier detail.'), true)
  assert.equal(detectComplaint('My context is nearly full; I would like a fresh session.'), true)
})

test('complaints are recognised without firing on any mention of context', () => {
  assert.equal(detectComplaint('My context is nearly full; I should hand over.'), true)
  assert.equal(detectComplaint('I would like a fresh session before continuing.'), true)
  assert.equal(detectComplaint('This got compacted a moment ago.'), true)
  assert.equal(
    detectComplaint('For context, the relay routes prose only.'),
    false,
    'a broad matcher would turn every explanatory turn into evidence of stalling',
  )
  assert.equal(detectComplaint('Done. Tests pass.'), false)
})

const BASE = { participant: 'implementer', baselineGeneration: 0, at: 1 }

test('degradation without complaint rotates', () => {
  // A model may compact without noticing, or notice and not say. Degradation alone is
  // sufficient; the complaint is corroboration, never a precondition.
  const a = assess({ ...BASE, prose: 'Done. Tests pass.', currentGeneration: 1 })
  assert.equal(a.decision, 'rotate')
  assert.equal(a.reason, 'degraded')
  assert.equal(a.complained, false)
})

test('complaint plus degradation rotates, corroborated', () => {
  const a = assess({ ...BASE, prose: 'I am running low on context.', currentGeneration: 1 })
  assert.equal(a.decision, 'rotate')
  assert.equal(a.reason, 'corroborated')
})

test('complaint without degradation continues and increments the metric', () => {
  const ledger = new ComplaintLedger()
  const a = assess({ ...BASE, prose: 'I need a fresh session.', currentGeneration: 0, ledger })
  assert.equal(a.decision, 'continue')
  assert.equal(a.reason, 'unbacked')
  assert.equal(ledger.count('implementer', 'wants-fresh-session'), 1)
})

test('neither signal is not a decision', () => {
  const a = assess({ ...BASE, prose: 'Added the rollback path.', currentGeneration: 0 })
  assert.equal(a.decision, 'continue')
  assert.equal(a.reason, 'nothing')
  assert.deepEqual(a.evidence, [])
})

test('the ledger is scoped to participant and topic', () => {
  const l = new ComplaintLedger()
  l.record('implementer', 'context-exhausted', 1)
  l.record('implementer', 'context-exhausted', 2)
  l.record('advisor', 'context-exhausted', 3)
  assert.equal(l.count('implementer', 'context-exhausted'), 2)
  assert.equal(l.count('advisor', 'context-exhausted'), 1)
  assert.equal(l.count('implementer', 'other'), 0)
})

test('verified progress decays the count, so one early complaint is not a grudge', () => {
  // Without decay a single complaint in round one poisons the whole session and the stall
  // detector stops being a detector.
  const l = new ComplaintLedger()
  l.record('implementer', 'context-exhausted', 1)
  l.record('implementer', 'context-exhausted', 2)
  l.progressed('implementer')
  assert.equal(l.count('implementer', 'context-exhausted'), 1)
  l.progressed('implementer')
  assert.equal(l.count('implementer', 'context-exhausted'), 0)
  assert.deepEqual(l.entries(), [], 'a decayed entry is dropped rather than kept at zero')
})

test('another participant’s progress does not clear this one’s record', () => {
  const l = new ComplaintLedger()
  l.record('implementer', 'context-exhausted', 1)
  l.progressed('advisor')
  assert.equal(l.count('implementer', 'context-exhausted'), 1)
})
