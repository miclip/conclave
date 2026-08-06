/**
 * The conformance suite checks that adapters cannot claim more than they have shown.
 *
 *   node --test src/conformance/suite.test.ts
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { ALL_CAPABILITIES, CLAUDE_CAPABILITIES, CODEX_CAPABILITIES } from './capabilities.ts'
import { checkAdapter, runConformance } from './suite.ts'
import { OUTCOMES } from '../contract/outcome.ts'

test('every adapter grades every outcome', () => {
  for (const caps of ALL_CAPABILITIES) {
    for (const outcome of OUTCOMES) {
      assert.ok(
        caps.outcomes[outcome],
        `${caps.agent} does not grade ${outcome}; silence is not a grade`,
      )
    }
  }
})

test('no adapter claims evidence it does not have', () => {
  const report = runConformance(ALL_CAPABILITIES)
  assert.deepEqual(
    report.failures.map((f) => `${f.agent}/${f.outcome}: ${f.note}`),
    [],
  )
})

test('an inflated claim is caught', () => {
  // Claiming an outcome nothing has ever produced must fail, not pass quietly.
  const inflated = {
    ...CLAUDE_CAPABILITIES,
    outcomes: { ...CLAUDE_CAPABILITIES.outcomes, transport_lost: 'observed' as const },
  }
  const rows = checkAdapter(inflated)
  const row = rows.find((r) => r.outcome === 'transport_lost')!
  assert.equal(row.verdict, 'unsupported_claim')
})

test('codex outcomes are graded from live 0.146.0 fixtures, not history', () => {
  const rows = checkAdapter(CODEX_CAPABILITIES)
  for (const outcome of ['completed', 'cancelled', 'permission_refused', 'process_exited'] as const) {
    const row = rows.find((r) => r.outcome === outcome)!
    assert.equal(row.claimed, 'observed', `${outcome} should be observed`)
    assert.equal(row.fixture.found, true)
    assert.equal(row.fixture.historical, false, `${outcome} must rest on a current-version fixture`)
    assert.equal(row.verdict, 'ok')
  }
})

test('codex refusal evidence requires the permission event, not just an abort', () => {
  // turn_aborted alone is byte-identical between a refused permission and a user
  // cancellation, so a fixture citing only the abort would not support the claim.
  const row = checkAdapter(CODEX_CAPABILITIES).find((r) => r.outcome === 'permission_refused')!
  assert.ok(row.fixture.where?.includes('PermissionRequest'))
  assert.ok(row.fixture.where?.includes('turn_aborted'))
})

test('codex process death is evidenced by absence, and says so', () => {
  const row = checkAdapter(CODEX_CAPABILITIES).find((r) => r.outcome === 'process_exited')!
  assert.ok(row.fixture.where?.includes('no terminal record'))
})

test('a contradicted "unsupported" claim is caught', () => {
  const wrong = {
    ...CODEX_CAPABILITIES,
    outcomes: { ...CODEX_CAPABILITIES.outcomes, cancelled: 'unsupported' as const },
  }
  const rows = checkAdapter(wrong)
  const row = rows.find((r) => r.outcome === 'cancelled')!
  assert.equal(row.verdict, 'contradiction')
})

test('finding evidence recommends an upgrade rather than performing one', () => {
  const understated = {
    ...CODEX_CAPABILITIES,
    outcomes: { ...CODEX_CAPABILITIES.outcomes, cancelled: 'reasoned_but_unverified' as const },
  }
  const rows = checkAdapter(understated)
  const row = rows.find((r) => r.outcome === 'cancelled')!
  assert.equal(row.verdict, 'upgrade_available')
  // The claim itself is untouched: whether a fixture really demonstrates an outcome is
  // a judgement about the fixture, not something the suite may decide.
  assert.equal(row.claimed, 'reasoned_but_unverified')
})

test('the adapters disagree, and the contract records how', () => {
  // Not a style check. These differences are why the seam exists, and flattening them
  // would be the failure mode the seam is meant to prevent. Codex's readiness is no
  // longer `unknown` -- it is known, and known to be different.
  assert.notEqual(CLAUDE_CAPABILITIES.turnKeySource, CODEX_CAPABILITIES.turnKeySource)
  assert.notEqual(CLAUDE_CAPABILITIES.readinessSignal, CODEX_CAPABILITIES.readinessSignal)
})

test('codex cancellation is better evidenced than claude cancellation', () => {
  // Claude Code's cancelled outcome exists but is only ever `assumed` in confidence,
  // because nothing in the child records it. Codex proves it from the transcript.
  const claude = checkAdapter(CLAUDE_CAPABILITIES).find((r) => r.outcome === 'cancelled')!
  const codex = checkAdapter(CODEX_CAPABILITIES).find((r) => r.outcome === 'cancelled')!
  assert.ok(claude.fixture.found && codex.fixture.found)
  assert.ok(
    codex.fixture.where!.includes('turn_aborted'),
    'codex evidence should come from an explicit abort record',
  )
})

test('readiness signals differ, and codex now names its own', () => {
  // Observed: no hook fires before the first turn on Codex, so readiness cannot be a
  // lifecycle event there the way SessionStart is for Claude.
  assert.equal(CLAUDE_CAPABILITIES.readinessSignal, 'session_start_hook')
  assert.equal(CODEX_CAPABILITIES.readinessSignal, 'first_turn')
})

test('SessionEnd stays unobserved on codex rather than being called unsupported', () => {
  // It is registered, trusted, and never fired in any scenario -- but no run achieved a
  // clean exit, so absence of evidence is not evidence of absence.
  const codexHooksTemplate = readFileSync(
    join(import.meta.dirname, '..', '..', 'config', 'templates', 'codex-hooks.json'),
    'utf8',
  )
  assert.ok(
    codexHooksTemplate.includes('SessionEnd'),
    'SessionEnd must stay registered so a clean-exit fixture can still be collected',
  )
})
