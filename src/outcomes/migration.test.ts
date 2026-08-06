/**
 * Proofs required of the tracker migration.
 *
 * The migration exists because Codex outcome classification draws on four channels that
 * do not arrive together:
 *
 *   transcript          turn_aborted
 *   hook stream         PermissionRequest, Stop, SessionEnd
 *   mediated input log  deny versus user cancel
 *   ownership policy    whether attribution is available at all
 *
 * A one-shot finalisation cannot represent that honestly. These tests pin the properties
 * that make the tracker a faithful replacement rather than a more complicated one.
 *
 *   node --test src/outcomes/migration.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { emptyTranscriptState } from './classify.ts'
import { TurnVerdictTracker } from './tracker.ts'

const abort = { ...emptyTranscriptState(), exists: true, turnAbortedReason: 'interrupted' }

// --- (2) verdicts are revisable when stronger cross-channel evidence arrives ---------

test('a permission deny recorded after PermissionRequest revises the verdict', () => {
  // The Codex shape: the hook says a decision was pending, the input log says which way
  // it went, and they arrive separately.
  const t = new TurnVerdictTracker({ agent: 'codex' })

  const pending = t.observeHook('PermissionRequest', { tool_name: 'apply_patch' })
  assert.equal(pending?.verdict?.outcome, 'permission_refused')
  assert.equal(pending?.verdict?.confidence, 'inferred')
  assert.ok(
    pending!.verdict!.provenance.some((p) => p.detail.includes('no allow recorded')),
    'with no decision recorded it must rest on the mediated-input inference',
  )

  const decided = t.observeOrchestrator({ sentPermissionDecision: 'deny' })
  assert.ok(decided, 'the explicit decision must produce an update, not be swallowed')
  assert.equal(decided.verdict?.outcome, 'permission_refused')
  assert.ok(decided.supersedes, 'the weaker inference must be withdrawn by name')
  assert.ok(
    decided.verdict!.provenance.some((p) => p.source === 'orchestrator' && p.detail === 'denied'),
    'the stronger verdict must cite the decision it now rests on',
  )
})

test('a transcript abort revises a verdict that rested on the hook stream alone', () => {
  const t = new TurnVerdictTracker({ agent: 'codex' })
  t.observeHook('PermissionRequest', { tool_name: 'apply_patch' })
  const revised = t.observeTranscript({ exists: true, turnAbortedReason: 'interrupted' })
  assert.equal(revised?.verdict?.outcome, 'cancelled')
  assert.equal(revised?.verdict?.confidence, 'proven')
  assert.ok(revised?.supersedes, 'the earlier permission_refused must be superseded')
})

// --- (3) external ownership degrades attribution ------------------------------------

test('external input ownership degrades cancellation and refusal attribution', () => {
  const external = { sentCancel: false, inputIsMediated: false }

  const cancel = new TurnVerdictTracker({ agent: 'claude', orchestrator: external })
  const c = cancel.observeOrchestrator({ sentCancel: true })
  assert.equal(c?.verdict?.outcome, 'cancelled')
  assert.equal(c?.verdict?.confidence, 'uncertain', 'mediated would be `assumed`')

  const refusal = new TurnVerdictTracker({ agent: 'codex', orchestrator: external })
  const r = refusal.observeHook('PermissionRequest', { tool_name: 'apply_patch' })
  assert.equal(r?.verdict?.outcome, 'permission_refused')
  assert.equal(r?.verdict?.confidence, 'uncertain')
  assert.ok(
    r!.verdict!.provenance.some((p) => p.caveat && p.detail.includes('not mediated')),
    'the degradation must be stated in the provenance, not merely in the grade',
  )
})

test('even an explicit deny is only uncertain when input is not ours', () => {
  const t = new TurnVerdictTracker({
    agent: 'codex',
    orchestrator: { sentCancel: false, inputIsMediated: false },
  })
  t.observeHook('PermissionRequest', { tool_name: 'apply_patch' })
  const decided = t.observeOrchestrator({ sentPermissionDecision: 'deny' })
  assert.equal(decided?.verdict?.confidence, 'uncertain')
})

// --- (5) reconciliation rebuilds rather than inherits --------------------------------

test('resetTranscript rebuilds transcript evidence instead of merging it', () => {
  // Compaction is the one place monotonicity breaks. A rewritten transcript that no
  // longer contains an abort must not leave the tracker asserting one.
  const t = new TurnVerdictTracker({ agent: 'codex' })
  t.observeTranscript(abort)
  assert.equal(t.verdict?.outcome, 'cancelled')

  const withdrawn = t.resetTranscript(emptyTranscriptState())
  assert.ok(withdrawn, 'removing the evidence must produce an update')
  assert.equal(withdrawn.verdict, undefined, 'no replacement verdict exists')
  assert.equal(withdrawn.supersedes?.outcome, 'cancelled')
  assert.equal(t.verdict, undefined, 'the turn is open again')
  assert.equal(t.settled, false)
})

test('resetTranscript leaves hook and orchestrator evidence untouched', () => {
  // Compaction rewrites the transcript. It does not un-fire a hook or un-send an ESC.
  const t = new TurnVerdictTracker({ agent: 'claude' })
  t.observeHook('Stop', { hook_event_name: 'Stop' })
  assert.equal(t.verdict?.outcome, 'completed')

  const after = t.resetTranscript(emptyTranscriptState())
  assert.equal(after, undefined, 'the Stop-backed verdict is unaffected by a rewrite')
  assert.equal(t.verdict?.outcome, 'completed')
  assert.equal(t.verdict?.confidence, 'proven')
})

test('a merge would have kept stale evidence; reset does not', () => {
  const t = new TurnVerdictTracker({ agent: 'codex' })
  t.observeTranscript(abort)
  // A merging update keeps turnAbortedReason and stays cancelled...
  t.observeTranscript({ exists: true })
  assert.equal(t.verdict?.outcome, 'cancelled')
  // ...whereas a rebuild reflects what the transcript now says.
  t.resetTranscript({ ...emptyTranscriptState(), exists: true })
  assert.equal(t.verdict, undefined)
})

// --- (6) closing must not weaken an established verdict -------------------------------

test('process death does not downgrade a completed turn', () => {
  const t = new TurnVerdictTracker({ agent: 'claude' })
  t.observeHook('Stop', { hook_event_name: 'Stop' })
  const onClose = t.observeProcess({ alive: false, howEnded: 'sigterm' })
  assert.equal(onClose, undefined, 'shutting down must not change a proven completion')
  assert.equal(t.verdict?.outcome, 'completed')
})

test('process death does not downgrade a turn we cancelled ourselves', () => {
  // The case that made the rule reorder necessary. We ended the turn; the session was
  // then closed. Reporting process_exited would be cleanup manufacturing an outcome.
  const t = new TurnVerdictTracker({ agent: 'claude' })
  t.observeOrchestrator({ sentCancel: true })
  assert.equal(t.verdict?.outcome, 'cancelled')

  t.observeProcess({ alive: false, howEnded: 'sigterm' })
  assert.equal(t.verdict?.outcome, 'cancelled', 'close() must not overwrite this')
  assert.equal(t.verdict?.confidence, 'assumed')
})

test('process death does not downgrade an explicitly refused permission', () => {
  const t = new TurnVerdictTracker({ agent: 'codex' })
  t.observeHook('PermissionRequest', { tool_name: 'apply_patch' })
  t.observeOrchestrator({ sentPermissionDecision: 'deny' })
  t.observeProcess({ alive: false, howEnded: 'sigterm' })
  assert.equal(t.verdict?.outcome, 'permission_refused')
})

test('process death DOES claim a turn with no explanation of its own', () => {
  // The guard must not overreach: a pending permission with no decision recorded is an
  // inference from silence, and a dead process explains that silence at least as well.
  const t = new TurnVerdictTracker({ agent: 'codex' })
  t.observeHook('PermissionRequest', { tool_name: 'apply_patch' })
  const dead = t.observeProcess({ alive: false, howEnded: 'sigterm' })
  assert.equal(dead?.verdict?.outcome, 'process_exited')
})

test('a killed turn that finished in the transcript is recovered, not called a death', () => {
  const t = new TurnVerdictTracker({ agent: 'claude' })
  t.observeHook('UserPromptSubmit', {})
  t.observeProcess({ alive: false, howEnded: 'sigterm' })
  assert.equal(t.verdict?.outcome, 'process_exited')

  const recovered = t.resetTranscript({
    ...emptyTranscriptState(),
    exists: true,
    hasAssistantAfterPrompt: true,
    finalStopReason: 'end_turn',
  })
  assert.equal(recovered?.verdict?.outcome, 'completed')
  assert.equal(recovered?.supersedes?.outcome, 'process_exited')
  assert.ok(
    recovered!.verdict!.provenance.some((p) => p.caveat && p.detail.includes('no Stop delivery')),
    'recovery must stay visible rather than passing as a normal completion',
  )
})
