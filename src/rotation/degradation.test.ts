/**
 * Degradation is mechanical; the complaint is a claim. §7a's three rows.
 *
 *   node --test src/rotation/degradation.test.ts
 */

import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { AgentEvent } from '../contract/session.ts'
import { assess, ComplaintLedger, detectComplaint, detectDegradation } from './degradation.ts'

function revision(declared: boolean): AgentEvent {
  return {
    type: 'revision',
    reason: declared ? 'compaction' : 'rewrite',
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

test('an undeclared rewrite is not degradation (#122)', () => {
  // This test asserted the opposite until #122: an unexplained rewrite was counted as a
  // compaction, on the reasoning that requiring a marker would make the signal depend on
  // vendor labelling. The measurement went the other way. Thirteen child transcripts across
  // four runs held zero compaction markers while nine rotation candidates were raised off the
  // digest, and their end state had every UUID-bearing record present and in order. Rotation
  // is premised on a seat having LOST something; a moved byte is not evidence of that. What
  // the bytes did between polls is decided upstream, per poll, by comparing the records
  // themselves -- see `#reserialized` in transcript/reconcile.ts.
  const d = detectDegradation({
    baselineGeneration: 0,
    currentGeneration: 0,
    events: [revision(false)],
  })
  assert.equal(d.degraded, false)
  assert.deepEqual(d.evidence, [])
})

test('a declared compaction is degradation, from the event channel alone', () => {
  // The generation may not have been snapshotted yet; the live event carries it.
  const d = detectDegradation({
    baselineGeneration: 0,
    currentGeneration: 0,
    events: [revision(true)],
  })
  assert.equal(d.degraded, true)
  assert.ok(d.evidence.some((e) => e.includes('declares a compaction')))
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

test('the complaint detector does not fire on prose that discusses the topic', () => {
  // The live failure this guards: an implementer building compaction-aware code had
  // "Compaction can erase evidence" logged as a complaint against its own stall metric.
  // The corpus is the project's own prose — a design brief, findings and pre-registrations
  // that discuss compaction, context exhaustion and fresh sessions at length without any
  // participant reporting any of it about itself.
  //
  // Measured 2026-08-06: 67 adversarial paragraphs of 567, zero fired. This pins that.
  const roots = ['DESIGN-BRIEF.md', 'README.md', 'docs/NOTES.md', 'docs/DESIGN.md']
  const repo = join(import.meta.dirname, '..', '..')
  const paragraphs = roots
    .filter((f) => existsSync(join(repo, f)))
    .flatMap((f) => readFileSync(join(repo, f), 'utf8').split(/\n\s*\n/))
    .filter((p) => p.trim().length > 80)

  const adversarial = paragraphs.filter((p) =>
    /compact|context|fresh session|clean session|losing track/i.test(p),
  )
  assert.ok(adversarial.length > 20, `corpus is not adversarial enough: ${adversarial.length}`)

  const fired = adversarial.filter(detectComplaint)
  assert.deepEqual(
    fired.map((p) => p.replace(/\s+/g, ' ').slice(0, 120)),
    [],
    'discussion of compaction must not read as a report of it',
  )
})
