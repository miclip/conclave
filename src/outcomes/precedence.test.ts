/**
 * Evidence precedence: `turn_aborted` outranks `Stop`.
 *
 * Written BEFORE the August 9 Codex run, on purpose. If the assertion is designed after
 * seeing what Codex emits, the fixture stops answering the question and starts recording
 * whatever happened — and arrival order gets quietly blessed as semantics.
 *
 * These are SYNTHETIC. Whether Codex emits both records on cancellation is unknown; the
 * point is that the classifier is correct either way, and that neither order can produce
 * a different verdict.
 *
 *   node --test src/outcomes/precedence.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { classify, evidence, emptyTranscriptState } from './classify.ts'
import { TurnVerdictTracker } from './tracker.ts'
import type { Verdict } from '../contract/outcome.ts'

const ABORT = { turnAbortedReason: 'interrupted' }

const provenanceText = (v: Verdict) => v.provenance.map((p) => `${p.source}:${p.detail}`).join(' | ')

test('turn_aborted alone establishes cancelled', () => {
  const got = classify(
    evidence({
      agent: 'codex',
      transcript: { ...emptyTranscriptState(), exists: true, ...ABORT },
    }),
  )
  assert.equal(got.state, 'cancelled')
  assert.equal(got.confidence, 'proven')
})

test('Stop alone establishes completed', () => {
  const got = classify(evidence({ agent: 'codex', hooks: ['Stop'] }))
  assert.equal(got.state, 'completed')
  assert.equal(got.confidence, 'proven')
})

test('Stop does NOT upgrade an aborted turn to completed', () => {
  // The failure this exists to prevent: reading "the turn is over" as "the turn
  // succeeded", turning a cancellation into a success on weaker evidence.
  const got = classify(
    evidence({
      agent: 'codex',
      hooks: ['Stop'],
      transcript: { ...emptyTranscriptState(), exists: true, ...ABORT },
    }),
  )
  assert.equal(got.state, 'cancelled')
  assert.notEqual(got.state, 'completed')
})

test('when both appear, provenance names both channels and calls Stop a boundary', () => {
  const got = classify(
    evidence({
      agent: 'codex',
      hooks: ['Stop'],
      transcript: { ...emptyTranscriptState(), exists: true, ...ABORT },
    }),
  )
  const text = provenanceText(got as Verdict)
  assert.ok(text.includes('turn_aborted reason=interrupted'), 'the deciding record must be named')
  assert.ok(text.includes('Stop also fired'), 'the observed-but-outranked channel must be named')
  assert.ok(
    text.includes('terminal boundary'),
    'Stop must be described as a boundary, not as completion',
  )
})

test('agreement between the two channels does not inflate confidence', () => {
  // Both records plausibly come from one internal lifecycle transition, so they
  // corroborate a single source rather than testing it twice. `proven` is where
  // turn_aborted alone already puts it; agreement must not be read as independence.
  const alone = classify(
    evidence({ agent: 'codex', transcript: { ...emptyTranscriptState(), ...ABORT } }),
  )
  const both = classify(
    evidence({ agent: 'codex', hooks: ['Stop'], transcript: { ...emptyTranscriptState(), ...ABORT } }),
  )
  assert.equal(both.confidence, alone.confidence, 'corroboration must not change the grade')
  assert.ok(
    provenanceText(both as Verdict).includes('not independent evidence'),
    'the shared-cause caveat must be stated, not implied',
  )
})

// --- order independence -------------------------------------------------------------

test('SYNTHETIC: turn_aborted then Stop', () => {
  const t = new TurnVerdictTracker({ agent: 'codex' })

  const first = t.observeTranscript({ exists: true, ...ABORT })
  assert.ok(first?.verdict)
  assert.equal(first.verdict.outcome, 'cancelled')
  assert.equal(first.supersedes, undefined, 'nothing to withdraw yet')

  const second = t.observeHook('Stop', { hook_event_name: 'Stop' })
  // The verdict does not change outcome, but provenance gains the corroborating channel,
  // so the tracker reports an update rather than silently dropping the observation.
  assert.equal(t.verdict!.outcome, 'cancelled')
  if (second?.verdict) {
    assert.equal(second.verdict.outcome, 'cancelled')
    assert.equal(second.supersedes?.outcome, 'cancelled', 'outcome must not flip')
  }
})

test('SYNTHETIC: Stop then turn_aborted withdraws the provisional completed', () => {
  const t = new TurnVerdictTracker({ agent: 'codex' })

  const first = t.observeHook('Stop', { hook_event_name: 'Stop' })
  assert.ok(first?.verdict)
  assert.equal(first.verdict.outcome, 'completed', 'with only Stop, completed is correct')
  assert.equal(first.supersedes, undefined)

  const second = t.observeTranscript({ exists: true, ...ABORT })
  assert.ok(second?.verdict, 'the later record must produce an update, not be ignored')
  assert.equal(second.verdict.outcome, 'cancelled')
  assert.ok(second.supersedes, 'the earlier terminal verdict must be withdrawn, not left standing')
  assert.equal(second.supersedes.outcome, 'completed')
})

test('SYNTHETIC: both orders converge on an identical verdict', () => {
  // The property that matters. Evidence is monotonic, so both orders reach the same
  // evidence set and therefore the same verdict and provenance. Only the intermediate
  // events differ, which is what a revision exists to express.
  const abortFirst = new TurnVerdictTracker({ agent: 'codex' })
  abortFirst.observeTranscript({ exists: true, ...ABORT })
  abortFirst.observeHook('Stop', { hook_event_name: 'Stop' })

  const stopFirst = new TurnVerdictTracker({ agent: 'codex' })
  stopFirst.observeHook('Stop', { hook_event_name: 'Stop' })
  stopFirst.observeTranscript({ exists: true, ...ABORT })

  assert.deepEqual(abortFirst.verdict, stopFirst.verdict)
  assert.equal(abortFirst.verdict!.outcome, 'cancelled')
  assert.equal(provenanceText(abortFirst.verdict!), provenanceText(stopFirst.verdict!))
})

test('SYNTHETIC: a Stop arriving after an abort never resurrects completed', () => {
  // Belt and braces on the streaming path: repeated late Stops must not flip it back.
  const t = new TurnVerdictTracker({ agent: 'codex' })
  t.observeTranscript({ exists: true, ...ABORT })
  for (let i = 0; i < 3; i++) t.observeHook('Stop', { hook_event_name: 'Stop' })
  assert.equal(t.verdict!.outcome, 'cancelled')
})

test('the tracker stays silent while evidence is inconclusive', () => {
  const t = new TurnVerdictTracker({ agent: 'codex' })
  assert.equal(t.observeHook('UserPromptSubmit', {}), undefined)
  assert.equal(t.settled, false, 'in_progress is not a terminal verdict')
})

test('claude is unaffected: it has no turn_aborted record to outrank anything', () => {
  // The precedence rule must not change Claude Code's behaviour, where cancellation is
  // recorded nowhere in the child at all.
  const t = new TurnVerdictTracker({ agent: 'claude' })
  const update = t.observeHook('Stop', { hook_event_name: 'Stop' })
  assert.equal(update?.verdict?.outcome, 'completed')
  assert.equal(update?.verdict?.confidence, 'proven')
})
