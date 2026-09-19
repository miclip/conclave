/**
 * The conformance suite checks that adapters cannot claim more than they have shown.
 *
 *   node --test src/conformance/suite.test.ts
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  ALL_CAPABILITIES,
  CLAUDE_CAPABILITIES,
  CODEX_CAPABILITIES,
  OPENCODE_CAPABILITIES,
} from './capabilities.ts'
import {
  checkAdapter,
  currentVersion,
  fixtureOutcomesFor,
  formatReport,
  runConformance,
} from './suite.ts'
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

test('no adapter claims evidence it does not have, nor keeps a stale decline', { skip: gradable }, () => {
  // Failures are `unsupported_claim`, `contradiction` and -- since #338 -- `stale_decline`: a
  // declined upgrade on an outcome with no fixture, or on a claim already upgraded past it. A
  // decline covering nothing is a record nobody checks, which is the shape this file exists
  // to remove.
  const report = runConformance(ALL_CAPABILITIES)
  assert.deepEqual(
    report.failures.map((f) => `${f.agent}/${f.outcome}: ${f.note}`),
    [],
    'every declaration must be backed, and every decline must still have something to decline',
  )
})

test('an inflated claim is caught', () => {
  // Claiming an outcome nothing has ever produced must fail, not pass quietly.
  //
  // Asserted against a FICTIONAL agent with no fixtures, which is the only formulation that
  // survives. Three earlier versions named a real outcome as their stand-in for "unbacked" --
  // transport_lost, then timed_out, then whichever was unbacked at run time -- and each was
  // overtaken as the audit captured evidence. The last one broke when Claude ran out of
  // unbacked outcomes entirely, which is a good thing to have happen and a terrible thing to
  // have a test depend on.
  //
  // An agent with no corpus can never acquire one by accident, so this tests the CHECKER
  // rather than how far the evidence has got.
  const invented = {
    ...CLAUDE_CAPABILITIES,
    agent: 'no-such-agent',
    outcomes: Object.fromEntries(OUTCOMES.map((o) => [o, 'observed' as const])) as typeof CLAUDE_CAPABILITIES.outcomes,
  }
  const rows = checkAdapter(invented)
  assert.equal(rows.length, OUTCOMES.length)
  for (const row of rows) {
    assert.equal(row.verdict, 'unsupported_claim', `${row.outcome} has no evidence and must say so`)
  }
})

test('the fixture path backs nothing for an agent it has never seen', () => {
  // The direction that matters. A mechanism that quietly satisfied every claim would turn the
  // suite into a rubber stamp, and it would look exactly like progress while doing it.
  const none = fixtureOutcomesFor('no-such-agent')
  assert.equal(none.size, 0, 'no corpus, no evidence')
  for (const outcome of OUTCOMES) assert.equal(none.get(outcome)?.found, undefined)
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

// ---- declined upgrades (#338) ------------------------------------------------------------
//
// The suite never upgrades a claim; a fixture found is a recommendation. These cover the other
// half: a human considered one and said no, and the report has to show that as a decision
// rather than as a recommendation still waiting.

/** Codex/cancelled understated, so the suite would recommend upgrading it on a live fixture. */
function understatedCodex() {
  return {
    ...CODEX_CAPABILITIES,
    outcomes: { ...CODEX_CAPABILITIES.outcomes, cancelled: 'reasoned_but_unverified' as const },
  }
}

test('a declined upgrade is reported as declined, not recommended', () => {
  const live = checkAdapter(understatedCodex()).find((r) => r.outcome === 'cancelled')!
  assert.equal(live.verdict, 'upgrade_available', 'precondition: the fixture is live')

  const declined = {
    ...understatedCodex(),
    declinedUpgrades: { cancelled: { fixture: live.fixture.where!, why: 'looked; no' } },
  }
  const row = checkAdapter(declined).find((r) => r.outcome === 'cancelled')!
  assert.equal(row.verdict, 'upgrade_declined')
  assert.equal(row.claimed, 'reasoned_but_unverified', 'the claim itself is untouched')
  assert.deepEqual(row.declined, { fixture: live.fixture.where, why: 'looked; no' })

  const report = runConformance([declined])
  assert.deepEqual(report.recommendations, [], 'a declined upgrade is not a live recommendation')
  assert.deepEqual(report.failures, [], 'nor is it a failure')
  assert.deepEqual(
    report.declined.map((r) => `${r.agent}/${r.outcome}`),
    ['codex/cancelled'],
  )
})

test('the reason travels into the formatted report, under a zero headline', () => {
  const live = checkAdapter(understatedCodex()).find((r) => r.outcome === 'cancelled')!
  const why = 'the fixture is from the old transport and proves a path that never runs'
  const declined = {
    ...understatedCodex(),
    declinedUpgrades: { cancelled: { fixture: live.fixture.where!, why } },
  }
  const text = formatReport(runConformance([declined]))
  const headline = text.indexOf('0 claim(s) could be upgraded:')
  const declinedAt = text.indexOf('1 upgrade(s) considered and declined:')
  assert.notEqual(headline, -1, 'the live count is printed even at zero; its absence is not a zero')
  assert.notEqual(declinedAt, -1)
  assert.ok(headline < declinedAt, 'live recommendations come before declined ones')
  assert.ok(text.includes(`codex/cancelled: ${live.fixture.where}`), 'the declined row names its fixture')
  assert.ok(text.includes(why), 'the reason is printed, not just the fact of a decline')
})

test('a decline pinned to a different fixture does not cover it: the recommendation fires', () => {
  // The decision was about one recording. If the evidence on file is now some other recording,
  // the decision does not transfer, and the suite says what it would have said with no decline
  // at all -- which is the non-zero count #338 wants to be the signal.
  const other = {
    ...understatedCodex(),
    declinedUpgrades: {
      cancelled: { fixture: 'turn_aborted in some-other-rollout.jsonl', why: 'about a different file' },
    },
  }
  const row = checkAdapter(other).find((r) => r.outcome === 'cancelled')!
  assert.equal(row.verdict, 'upgrade_available')
  assert.equal(row.declined, undefined, 'a decline about another recording is not carried as a decision')
  assert.match(row.note!, /some-other-rollout\.jsonl/, 'the older decline is named, so the next decider knows')

  const report = runConformance([other])
  assert.deepEqual(report.recommendations.map((r) => `${r.agent}/${r.outcome}`), ['codex/cancelled'])
  assert.deepEqual(report.failures, [], 'a mismatched pin is a live recommendation, not a failure')
  assert.deepEqual(report.declined, [])
  assert.match(formatReport(report), /1 claim\(s\) could be upgraded:\n  codex\/cancelled: /)
})

test('a decline with no fixture left to decline is stale', () => {
  // Nothing produces the outcome any more; the decline is about evidence that is gone.
  const orphaned = {
    ...CODEX_CAPABILITIES,
    agent: 'no-such-agent',
    outcomes: { ...CODEX_CAPABILITIES.outcomes, cancelled: 'reasoned_but_unverified' as const },
    declinedUpgrades: { cancelled: { fixture: 'anything', why: 'gone' } },
  }
  const row = checkAdapter(orphaned).find((r) => r.outcome === 'cancelled')!
  assert.equal(row.verdict, 'stale_decline')
  assert.match(row.note!, /no recording produces this outcome now; remove the decline/)
})

test('a decline on a claim already graded observed is stale', () => {
  // The claim was upgraded and the decline left behind. There is nothing to decline, and a
  // leftover that says otherwise is exactly the kind of stale record this exists to remove.
  const live = checkAdapter(CODEX_CAPABILITIES).find((r) => r.outcome === 'cancelled')!
  assert.equal(live.verdict, 'ok', 'precondition: codex/cancelled is observed and backed')
  const leftover = {
    ...CODEX_CAPABILITIES,
    declinedUpgrades: { cancelled: { fixture: live.fixture.where!, why: 'stale' } },
  }
  const row = checkAdapter(leftover).find((r) => r.outcome === 'cancelled')!
  assert.equal(row.verdict, 'stale_decline')
  assert.match(row.note!, /the claim is observed and there is nothing to decline/)
})

test('a stale decline does not hide a failure the row already has', () => {
  // Claimed observed with no evidence AND a decline: the unsupported claim is the failure that
  // matters, and the decline is reported beside it rather than replacing it.
  const both = {
    ...CLAUDE_CAPABILITIES,
    agent: 'no-such-agent',
    outcomes: Object.fromEntries(OUTCOMES.map((o) => [o, 'observed' as const])) as typeof CLAUDE_CAPABILITIES.outcomes,
    declinedUpgrades: { completed: { fixture: 'anything', why: 'stale' } },
  }
  const row = checkAdapter(both).find((r) => r.outcome === 'completed')!
  assert.equal(row.verdict, 'unsupported_claim')
  assert.match(row.note!, /claimed observed, but no recording produces this outcome/)
  assert.match(row.note!, /also a stale decline/)
})

test('opencode/completed is declined on the run-per-turn fixture, with the reason attached', () => {
  // The standing case that motivated #338. The recording is real and the suite finds it; the
  // upgrade is declined because it was captured from the adapter this transport replaced.
  // The reason has to say so IN THE REPORT, not in a comment the report never shows.
  const row = checkAdapter(OPENCODE_CAPABILITIES).find((r) => r.outcome === 'completed')!
  assert.equal(row.verdict, 'upgrade_declined')
  assert.equal(row.fixture.where, 'step_finish reason=stop in edit-turn.ndjson')
  assert.match(row.declined!.why, /#217/)
  assert.match(row.declined!.why, /session\.idle/)

  // Only this row is asserted on; a stale decline elsewhere in the declaration is the
  // all-capabilities check's finding, not this test's.
  const report = runConformance([OPENCODE_CAPABILITIES])
  assert.deepEqual(report.recommendations, [], 'the headline recommendation count is zero')
  assert.deepEqual(
    report.declined.map((r) => `${r.agent}/${r.outcome}`),
    ['opencode/completed'],
  )
  assert.ok(!report.failures.some((r) => r.outcome === 'completed'), 'the declined row is not a failure')
  assert.match(formatReport(report), /^0 claim\(s\) could be upgraded:$/m)
})

test('the adapters disagree, and the contract records how', () => {
  // Not a style check. These differences are why the seam exists, and flattening them
  // would be the failure mode the seam is meant to prevent. Codex's readiness is no
  // longer `unknown` -- it is known, and known to be different.
  assert.notEqual(CLAUDE_CAPABILITIES.turnKeySource, CODEX_CAPABILITIES.turnKeySource)
  assert.notEqual(CLAUDE_CAPABILITIES.readinessSignal, CODEX_CAPABILITIES.readinessSignal)
})

test('codex cancellation is better evidenced than claude cancellation', () => {
  // Claude Code's cancelled outcome exists but is only ever `assumed` in confidence, because
  // no hook reports it and the transcript record it does write is not fed to the classifier
  // (#225, #235). Codex proves it from the transcript, which IS fed in.
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
