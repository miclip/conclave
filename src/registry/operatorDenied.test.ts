/**
 * Narrowing is subtraction, and these pin the two properties that makes it (#203).
 *
 * IDENTITY WHEN NOTHING IS DENIED, asserted as OBJECT identity rather than deep equality. A
 * copy that happens to be equal today is a copy that stops being equal the first time either
 * function learns to normalise something, and the failure would land in the advisor's opening
 * prompt where nothing else is watching. `assert.equal` on objects is reference equality, and
 * that is what is wanted here.
 *
 * SUBTRACTION ONLY. There is no argument that adds, so the tests below say what a denial does
 * to something absent, to something already refused, and to something belonging to a different
 * agent -- the three ways "deny" could accidentally become "set".
 *
 *   node --test src/registry/operatorDenied.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { narrowCapabilities, narrowPolicy, type OperatorDenials } from './operatorDenied.ts'
import type { CommandPolicy, GradedClaim, InstructionCapabilities } from './types.ts'

const claim = (): GradedClaim => ({
  supported: true,
  evidence: 'inferred_from_documented_event',
  source: 'a literal in the installed binary',
  sourceVersion: '1.0.0',
})

const DECLARES: InstructionCapabilities = { subagents: claim(), backgroundTasks: claim() }

const POLICY: CommandPolicy = {
  kind: 'declared',
  sourceVersion: 'test',
  commands: [
    { command: '/allowed', disposition: 'allowed', reason: 'allowed in this test.', source: 'test' },
    { command: '/already-refused', disposition: 'refused', reason: 'refused for correctness.', source: 'test' },
  ],
}

const deny = (over: Partial<OperatorDenials> = {}): OperatorDenials => ({
  capabilities: [],
  commands: [],
  ...over,
})

test('a project that denies nothing gets back the very objects it passed in', () => {
  // The identity rule, in its strong form. Every project that existed before this file is in
  // this case, and their runs must be the runs they were -- which an equal copy makes true
  // today and true only by inspection.
  assert.equal(narrowCapabilities(DECLARES, undefined), DECLARES, 'no denials at all')
  assert.equal(narrowCapabilities(DECLARES, deny()), DECLARES, 'empty denials')
  assert.equal(narrowPolicy(POLICY, undefined), POLICY, 'no denials at all')
  assert.equal(narrowPolicy(POLICY, deny()), POLICY, 'empty denials')
})

test('narrowing carries every capability it did not deny across UNCHANGED', () => {
  // That the DENIED one goes is proved through a run, in `capabilityBriefing.test.ts`, where it
  // is the whole of what that test says. What is proved here is the other half, which a run
  // cannot see as sharply: the survivors are the very claims that were declared -- same objects,
  // same grades, same provenance -- rather than reconstructed ones that merely render the same.
  const out = narrowCapabilities(DECLARES, deny({ capabilities: ['subagents'] }))
  assert.equal(out?.backgroundTasks, DECLARES.backgroundTasks, 'an undenied claim crosses untouched')
})

test('a denied command becomes a refusal that names the operator, rather than vanishing', () => {
  // Deleting it would refuse it too -- `ruleOnCommand` fails closed on anything undeclared --
  // with the reason "not declared in this agent's command policy". That is false, and false in
  // the direction that costs a turn: the advisor reads it as nobody having looked at the verb.
  const out = narrowPolicy(POLICY, deny({ commands: ['/allowed'] }))
  assert.equal(out?.kind, 'declared')
  const entry = out?.kind === 'declared' ? out.commands.find((c) => c.command === '/allowed') : undefined
  assert.equal(entry?.disposition, 'refused', 'still declared, now refused')
  // Pinned as a LITERAL. `assert.equal(entry.reason, operatorDisabledReason('/allowed'))` reads
  // the same function on both sides of the comparison, so it holds however the sentence is
  // reworded -- a test that cannot fail, which a mutation of that sentence proved by killing
  // nothing. The WORDS are the point here, because they are what the advisor reads.
  assert.match(
    entry?.reason ?? '',
    /is allowed by this agent's policy but is switched off for this project/,
    'and says the operator switched it off, rather than that the seat cannot do it',
  )
})

test('denying something already refused leaves the policy’s own reason in place', () => {
  // The correctness reason is the one that matters to whoever reads the refusal later, and an
  // operator's preference must not overwrite it -- `/clear` is not refused because someone
  // preferred that, and a log saying so would misdescribe why the run held together.
  const out = narrowPolicy(POLICY, deny({ commands: ['/already-refused'] }))
  const entry = out?.kind === 'declared' ? out.commands.find((c) => c.command === '/already-refused') : undefined
  assert.equal(entry?.reason, 'refused for correctness.', 'the policy’s reason survives the denial')
})

test('a transport with no composer is returned untouched, whatever is denied', () => {
  // Not "refused with an operator reason": there is no verb to refuse. Denying against an
  // `unsupported` policy has nothing to subtract from, and inventing an entry here would turn
  // a statement about the transport into a statement about a command.
  const unsupported: CommandPolicy = { kind: 'unsupported', reason: 'no composer' }
  assert.equal(narrowPolicy(unsupported, deny({ commands: ['/allowed'] })), unsupported)
  assert.equal(narrowPolicy(undefined, deny({ commands: ['/allowed'] })), undefined, 'and so is an unread agent')
})

test('a denial naming no command this policy has returns the policy itself', () => {
  // One config file covers a run whose seats may be on different agents, so most denials name
  // a verb some other agent declares. Those must cost that agent's seat nothing at all.
  assert.equal(narrowPolicy(POLICY, deny({ commands: ['/belongs-to-another-agent'] })), POLICY)
})
