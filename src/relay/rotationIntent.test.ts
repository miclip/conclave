/**
 * What classifies a rotation, and what deliberately does not.
 *
 * The seam tests in `rotation.test.ts` prove the relay records the right intent through a real
 * transaction. These prove the RULE underneath, in isolation, because the rule's whole value is
 * the two things it refuses to look at -- and a rule that quietly started reading the compaction
 * generation would still pass every seam test written today, since in those runs the generation
 * and the pause agree.
 *
 *   node --test src/relay/rotationIntent.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { resolutionFor, type ResolutionSubject } from './resolution.ts'
import { requiresStatedReason, rotationIntentFor } from './rotationIntent.ts'
import type { RunPause } from './run.ts'

/**
 * A pause as `#halt` builds one. `resolution` is COMPUTED rather than written as a literal,
 * exactly as `run.test.ts` does: a hand-built classification here would be a second opinion
 * about the scope, free to drift from the one the relay actually records against.
 */
function pauseFor(subject: ResolutionSubject, over: Partial<RunPause> = {}): RunPause {
  return {
    reason: subject.reason,
    resolution: resolutionFor(subject, { rotationArmed: true }),
    detail: 'compaction generation rose 0 → 1',
    evidence: [],
    options: ['continue', 'rotate', 'constrain', 'abort'],
    atSeq: 7,
    at: 1,
    ...over,
  }
}

test('a rotation_candidate pause about THIS seat is the operator agreeing with the proxy', () => {
  const pause = pauseFor({ reason: 'rotation_candidate', participant: 'implementer' })
  assert.equal(rotationIntentFor(pause, 'implementer'), 'candidate_accepted')
  // And nothing more is asked of them. The proxy is what spoke; agreement is the whole of the
  // operator's contribution, and a toll on the common case would only teach them to type a
  // word that means nothing.
  assert.equal(requiresStatedReason(pause, 'implementer'), false)
})

test('a rotation_candidate about a DIFFERENT seat does not make this rotation proxy-driven', () => {
  // At N>1 a pause about one seat can be answered by rotating another, and recording that as
  // "the proxy fired and the operator agreed" would attribute one seat's evidence to another
  // seat's replacement -- which is #75's contamination with an extra step.
  const pause = pauseFor({ reason: 'rotation_candidate', participant: 'implementer-2' })
  assert.equal(rotationIntentFor(pause, 'implementer-3'), 'operator_requested')
  assert.equal(requiresStatedReason(pause, 'implementer-3'), true)
})

test('every other pause reason is the operator arriving with their own reason', () => {
  // The whole point of #75 is that these are the rotations #10 has to be able to exclude, and
  // they are the ones that look most like the others: a seat that has been working long enough
  // to reach any of these pauses has compacted, so the generation is attached either way.
  const subjects: ResolutionSubject[] = [
    { reason: 'turn_incomplete', participant: 'implementer' },
    { reason: 'implementer_unanswered', participant: 'implementer' },
    { reason: 'merge_blocked', participant: 'implementer' },
    { reason: 'review_blocked', participant: 'implementer' },
    { reason: 'authority_conflict', workstream: 'implementer' },
    { reason: 'advisor_escalated' },
    { reason: 'operator_requested' },
  ]
  for (const subject of subjects) {
    const pause = pauseFor(subject)
    assert.equal(
      rotationIntentFor(pause, 'implementer'),
      'operator_requested',
      `${subject.reason} is not the degradation proxy asking`,
    )
    assert.equal(requiresStatedReason(pause, 'implementer'), true, `${subject.reason} needs a stated reason`)
  }
})

test('no pause at all is operator-initiated, not an error', () => {
  // An embedder holding a relay can rotate with no run in flight, and that is the plainest
  // possible case of somebody arriving with their own reason.
  assert.equal(rotationIntentFor(undefined, 'implementer'), 'operator_requested')
  assert.equal(requiresStatedReason(undefined, 'implementer'), true)
})

test('the detail is not read, however much it sounds like degradation', () => {
  // The classification MUST NOT come from the reason text. Deciding from prose means grepping
  // free text for "degrad", which is a classification that changes when somebody rephrases a
  // sentence -- and which an operator explaining why they wanted a blind reader would trip by
  // naming the thing they were controlling for.
  const sounds = pauseFor(
    { reason: 'operator_requested' },
    { detail: 'the implementer has degraded; compaction generation rose 3 → 4 and it is repeating itself' },
  )
  assert.equal(rotationIntentFor(sounds, 'implementer'), 'operator_requested')

  // And the converse, which is the one that would corrupt the dataset: a genuine candidate
  // whose operator describes it in method terms is still a candidate they accepted.
  const reads = pauseFor(
    { reason: 'rotation_candidate', participant: 'implementer' },
    { detail: 'a fresh reader applying the committed criterion is a stronger test' },
  )
  assert.equal(rotationIntentFor(reads, 'implementer'), 'candidate_accepted')
})
