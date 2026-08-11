/**
 * "Produced nothing at all" is a different finding from "went quiet", and the rule that says so.
 *
 *   node --test src/outcomes/firstTurnDiagnosis.test.ts
 *
 * `watchdogWiring.test.ts` proves the two pty adapters actually feed this -- a rule nothing
 * populates is a rule that never fires. What is proved here is the rule itself, including the
 * three cases an adapter test cannot reach cheaply: a LATER turn that says nothing, an argv that
 * named no model, and evidence from an adapter that reports no launch at all.
 *
 * The gate is narrow on purpose. On a later turn the launch has already been proved to work, so
 * naming the model there would point an operator at the one thing the run has evidence against.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { classify, evidence, type Evidence } from './classify.ts'
import { TurnVerdictTracker } from './tracker.ts'

/** A turn that has been silent for twelve minutes, plus whatever launch state is under test. */
function timedOut(launch?: Evidence['launch']): ReturnType<typeof classify> {
  return classify(evidence({ agent: 'claude', idleSeconds: 720, ...(launch ? { launch } : {}) }))
}

/** The diagnosis, or undefined when the verdict does not carry one. */
const diagnosis = (got: ReturnType<typeof classify>): string | undefined =>
  got.provenance?.find((p) => p.source === 'orchestrator' && /first turn/.test(p.detail))?.detail

test('a first turn that produced nothing names the model, as a candidate', () => {
  const got = timedOut({ model: 'opus-5', firstTurn: true, produced: false })
  assert.equal(got.state, 'timed_out')
  const said = diagnosis(got)
  assert.match(said!, /opus-5/)
  assert.match(said!, /candidate cause/)
  assert.match(said!, /no output at all/)
  // A caveat, not support. `formatVerdict` prefixes these with `!`, and a reader must be able
  // to tell what the clock established from what the orchestrator is speculating about.
  assert.equal(
    got.provenance?.find((p) => /candidate cause/.test(p.detail))?.caveat,
    true,
  )
  // And the deadline is still the most decisive line in the chain: this is an addition to the
  // provenance, not a replacement for it.
  assert.match(got.provenance![0]!.detail, /no output for 720s/)
})

test('a turn that emitted and then went quiet is not diagnosed', () => {
  // The distinction the whole rule exists to draw. Same deadline, same model, one difference.
  assert.equal(diagnosis(timedOut({ model: 'opus-5', firstTurn: true, produced: true })), undefined)
})

test('a LATER turn that produced nothing is not blamed on the launch', () => {
  // The launch has already worked at least once by then, so the model is the one suspect this
  // run has evidence against.
  assert.equal(diagnosis(timedOut({ model: 'opus-5', firstTurn: false, produced: false })), undefined)
})

test('an argv that named no model says that, rather than naming nothing', () => {
  const said = diagnosis(timedOut({ model: null, firstTurn: true, produced: false }))
  assert.match(said!, /named no model/)
  assert.ok(!/null/.test(said!), 'the absence is described, not printed as a value')
})

test('an adapter that reports no launch state at all changes nothing', () => {
  // Every verdict built before this field existed, and every adapter that never fills it in.
  // The old chain is what those still get, byte for byte.
  const before = classify(evidence({ agent: 'claude', idleSeconds: 720 }))
  assert.equal(diagnosis(before), undefined)
  assert.deepEqual(
    before.provenance?.map((p) => p.detail),
    ['no output for 720s, and no Stop', 'completion is uncertain; this is not evidence of cancellation'],
  )
})

test('the ABSOLUTE deadline carries the same diagnosis as the silence one', () => {
  // A child that never speaks on an adapter with no idle clock dies on the absolute deadline
  // instead, and it is the same finding arrived at by a slower route.
  const got = classify(
    evidence({ agent: 'opencode', elapsedSeconds: 400, watchdogSeconds: 300, launch: { model: 'x/y', firstTurn: true, produced: false } }),
  )
  assert.equal(got.state, 'timed_out')
  assert.match(diagnosis(got)!, /'x\/y'/)
})

test('the tracker accumulates the launch the way it accumulates everything else', () => {
  // Reported in two pieces by the adapters -- the model when the turn is armed, the first sign
  // of output whenever it arrives -- so the merge is what makes the rule readable at all.
  const tracker = new TurnVerdictTracker({
    agent: 'claude',
    launch: { model: 'opus-5', firstTurn: true, produced: false },
  })
  assert.equal(tracker.observeLaunch({ produced: true }), undefined, 'output alone settles nothing')
  const update = tracker.observeIdle(720)
  assert.equal(update?.verdict?.outcome, 'timed_out')
  assert.equal(
    update?.verdict?.provenance.some((p) => /candidate cause/.test(p.detail)),
    false,
    'the turn spoke, so the launch is not named',
  )

  // And the same tracker with no output reported reaches the other verdict.
  const silent = new TurnVerdictTracker({
    agent: 'claude',
    launch: { model: 'opus-5', firstTurn: true, produced: false },
  })
  assert.ok(silent.observeIdle(720)?.verdict?.provenance.some((p) => /candidate cause/.test(p.detail)))
})
