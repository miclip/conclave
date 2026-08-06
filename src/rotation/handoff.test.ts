/**
 * Parsing the advisor's handoff, and reading the replacement's demonstration.
 *
 *   node --test src/rotation/handoff.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { acceptancePrompt, handoffPrompt, parseClaimedChecks, parseHandoff } from './handoff.ts'
import type { Handoff } from './handoff.ts'

const GOOD = `## GOAL
Add rotation so a degraded implementer can be replaced without losing the work.

## STATE
The lifecycle states are in the contract and both adapters implement them.
The transaction itself is not written yet.

## DECISIONS
- The advisor authors the narrative, because it holds no working set
- The orchestrator captures the record, because the advisor cannot see files

## EVIDENCE
Typecheck is clean. I did not run the suite myself; the implementer reported 169/149/0.

## FILES
- src/contract/session.ts
- \`src/rotation/rotate.ts\`

## DISAGREEMENT
- Whether a failed check should block or merely warn; unresolved

## NEXT
Write the rollback path before the commit path.`

test('a complete handoff parses into its sections, multi-line ones intact', () => {
  const { narrative, missing } = parseHandoff(GOOD)
  assert.deepEqual(missing, [])
  assert.ok(narrative)
  assert.ok(narrative.goal.startsWith('Add rotation'))
  // The first parser stopped every section at its first newline. Two-line STATE is the
  // regression, not a stylistic preference.
  assert.equal(narrative.currentState.split('\n').length, 2)
  assert.equal(narrative.decisions.length, 2)
  assert.equal(narrative.nextAction, 'Write the rollback path before the commit path.')
})

test('backticks around a path are stripped, so the digest looks up the right file', () => {
  const { narrative } = parseHandoff(GOOD)
  assert.deepEqual(narrative!.files, ['src/contract/session.ts', 'src/rotation/rotate.ts'])
})

test('open disagreement survives the handoff', () => {
  // A rotation that drops unresolved disagreement launders it: the replacement then
  // re-derives a settled question as if it were open, or worse, does not.
  const { narrative } = parseHandoff(GOOD)
  assert.equal(narrative!.openDisagreement.length, 1)
  assert.ok(narrative!.openDisagreement[0]!.includes('block or merely warn'))
})

test('"- none" is an empty list rather than a one-item one', () => {
  const { narrative } = parseHandoff(GOOD.replace('- Whether a failed check should block or merely warn; unresolved', '- none'))
  assert.deepEqual(narrative!.openDisagreement, [])
})

test('a missing required section is reported instead of a half-built narrative', () => {
  // This is what makes rotation transactional: an unusable handoff is detected before the
  // replacement is started and before anything is terminated.
  const { narrative, missing } = parseHandoff(GOOD.replace(/## NEXT[\s\S]*$/, ''))
  assert.equal(narrative, undefined)
  assert.deepEqual(missing, ['NEXT'])
})

test('sections that may legitimately be empty do not fail the parse', () => {
  const thin = `## GOAL
g

## STATE
s

## NEXT
n`
  const { narrative, missing } = parseHandoff(thin)
  assert.deepEqual(missing, [])
  assert.deepEqual(narrative!.decisions, [])
  assert.deepEqual(narrative!.files, [])
})

test('the raw prose is kept verbatim, because the parse is lossy', () => {
  assert.equal(parseHandoff(GOOD).narrative!.raw, GOOD)
})

test('the advisor is asked for disagreement explicitly and told not to tidy it away', () => {
  const p = handoffPrompt('context exhausted')
  assert.ok(p.includes('## DISAGREEMENT'))
  assert.ok(/not resolve an\s*open question here just to make the handoff tidy/.test(p))
  assert.ok(p.includes('context exhausted'))
})

function handoff(): Handoff {
  return {
    narrative: parseHandoff(GOOD).narrative!,
    record: {
      root: '/repo',
      head: 'abc',
      branch: 'main',
      dirty: [],
      files: [],
      checks: [
        { command: 'npm test', exitCode: 0, outputDigest: 'x', durationMs: 1 },
        { command: 'npx tsc --noEmit', exitCode: 0, outputDigest: 'y', durationMs: 1 },
      ],
      at: 0,
    },
    constraints: [],
    authoredBy: 'advisor',
    from: { sessionId: 'old', agent: 'claude' },
    compactionGeneration: 1,
    at: 0,
  }
}

test('the acceptance prompt asks for demonstration, not acknowledgement', () => {
  const p = acceptancePrompt(handoff())
  assert.ok(p.includes('npm test'))
  assert.ok(p.includes('npx tsc --noEmit'))
  assert.ok(p.includes('CHECK 1: exit'))
  // The replacement must be told the original is recoverable, or "I can continue" becomes
  // the only answer that does not sound like failure.
  assert.ok(/still alive and\s*frozen/.test(p))
  assert.ok(p.includes('claim to check, not as fact'))
})

test('the reported-format example has exactly one line per declared check', () => {
  // A fixed two-line example invites a model with one check to invent a second. One live
  // replacement did exactly that, producing a claim mismatch the prompt manufactured.
  const two = acceptancePrompt(handoff())
  assert.ok(two.includes('CHECK 1: exit <code>'))
  assert.ok(two.includes('CHECK 2: exit <code>'))
  assert.ok(!two.includes('CHECK 3: exit <code>'))

  const one = handoff()
  one.record.checks = [one.record.checks[0]!]
  const rendered = acceptancePrompt(one)
  assert.ok(rendered.includes('CHECK 1: exit <code>'))
  assert.ok(
    !rendered.includes('CHECK 2'),
    'a single-check handoff must not show an example line for a check that does not exist',
  )
  assert.ok(rendered.includes('1 line(s)'))
})

test('the handoff carries the narrative, and constraints are not folded into it', () => {
  // Human constraints are replayed separately so they arrive at human rank. Quoting them
  // inside advisor prose would silently demote every one of them.
  const p = acceptancePrompt(handoff())
  assert.ok(p.includes('Add rotation so a degraded implementer'))
  assert.ok(!p.includes('FROM THE HUMAN'))
})

test('claimed exit codes are read out of the replacement prose', () => {
  const claimed = parseClaimedChecks('CHECK 1: exit 0\nCHECK 2: exit 1\n\nThe second one fails.')
  assert.deepEqual(claimed, [
    { index: 1, exitCode: 0 },
    { index: 2, exitCode: 1 },
  ])
})

test('a claim glued to the end of a sentence is still a claim', () => {
  // Verbatim from the first live rotation, which rolled back over exactly this. The
  // replacement had run the check and reported it; a missing newline made it invisible.
  const claimed = parseClaimedChecks(
    "I'll verify the state before doing any work.CHECK 1: exit 0\n\nWhat I found. ...",
  )
  assert.deepEqual(claimed, [{ index: 1, exitCode: 0 }])
})

test('a report that cannot be read is no report, not a generous pass', () => {
  // Generosity here means accepting a transfer nobody demonstrated.
  assert.deepEqual(parseClaimedChecks('Everything passes, looks good to me.'), [])
})
