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
import { checkAdapter, currentVersion, fixtureOutcomesFor, runConformance } from './suite.ts'
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

/**
 * Conformance is a claim about the CLIs installed HERE.
 *
 * `currentVersion` shells out to each CLI and returns `unknown` when it is absent, and
 * unknown compares unequal to everything — so with no CLIs present every fixture is
 * unverifiable and every `observed` claim is correctly downgraded. That is the suite
 * working, not failing.
 *
 * It is skipped rather than relaxed. Making "both unknown" count as a match would let an
 * environment with no evidence at all confirm every claim, which is precisely the inflation
 * this suite exists to catch — and CI, where it would happen silently, is the worst place
 * to allow it.
 */
const missing = ['claude', 'codex'].filter((a) => currentVersion(a) === 'unknown')
const gradable =
  missing.length === 0
    ? false
    : `needs ${missing.join(' and ')} installed: conformance grades claims against the CLI ` +
      `versions present, and with none present nothing is gradable`

test('no adapter claims evidence it does not have', { skip: gradable }, () => {
  const report = runConformance(ALL_CAPABILITIES)
  assert.deepEqual(
    report.failures.map((f) => `${f.agent}/${f.outcome}: ${f.note}`),
    [],
  )
})

test('an inflated claim is caught', () => {
  // Claiming an outcome nothing has ever produced must fail, not pass quietly.
  //
  // This used `transport_lost` as its example until that outcome was actually captured from a
  // live abandoned turn. The example had to move rather than the assertion: a test whose
  // stand-in for "unbacked" quietly becomes backed stops testing anything, and would then
  // pass for the wrong reason.
  const inflated = {
    ...CLAUDE_CAPABILITIES,
    outcomes: { ...CLAUDE_CAPABILITIES.outcomes, timed_out: 'observed' as const },
  }
  const rows = checkAdapter(inflated)
  const row = rows.find((r) => r.outcome === 'timed_out')!
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

test('a recorded fixture backs an outcome a transcript cannot contain', () => {
  // `transport_lost` means the adapter stopped observing, so by construction there is nothing
  // in the file it stopped reading. The evidence has to be the VERDICT the adapter produced,
  // captured by hand from a live run.
  //
  // Without this the outcome could only ever be `reasoned_but_unverified`, not because it is
  // unverified but because the suite had no way to look at the right thing.
  const claude = fixtureOutcomesFor('claude')
  const found = claude.get('transport_lost')
  assert.ok(found?.found, 'the recorded fixture is read')
  assert.match(found!.where!, /claude-transport_lost\.json/)
  assert.equal(found!.historical, false, 'captured against the installed CLI')
})

test('an outcome with no fixture of either kind stays unbacked', () => {
  // The direction that matters. A recorded-fixture mechanism that quietly satisfied every
  // claim would turn the whole suite into a rubber stamp.
  assert.equal(fixtureOutcomesFor('claude').get('timed_out')?.found, undefined)
  assert.equal(fixtureOutcomesFor('codex').get('transport_lost')?.found, undefined)
})
