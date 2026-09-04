/**
 * A capability an agent can be TOLD to use is a claim with a source and an expiry date, and
 * these guards are what keep it from decaying into a boolean.
 *
 * Nothing renders this data yet. That is precisely why it is pinned now: an undeclared field is
 * meant to mean "nobody said" and a declared one is meant to carry where it came from, and both
 * properties are trivial to lose in the edit that first needs them for a briefing.
 *
 *   node --test src/registry/instructionCapabilities.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { defaultRegistry } from './builtin.ts'
import {
  CLAUDE_INSTRUCTION_CAPABILITIES,
  CODEX_INSTRUCTION_CAPABILITIES,
  KIMI_INSTRUCTION_CAPABILITIES,
  OPENCODE_INSTRUCTION_CAPABILITIES,
} from './instructionCapabilities.ts'
import { ABSENT_LITERAL_CANARY, installedBundle } from './installedBundle.ts'
import { NO_DEADLINE_CLOCKS, type GradedClaim, type InstructionCapabilities } from './types.ts'

const DECLARED: ReadonlyArray<readonly [string, InstructionCapabilities]> = [
  ['claude', CLAUDE_INSTRUCTION_CAPABILITIES],
  ['codex', CODEX_INSTRUCTION_CAPABILITIES],
  ['opencode', OPENCODE_INSTRUCTION_CAPABILITIES],
  ['kimi', KIMI_INSTRUCTION_CAPABILITIES],
]

/** Every declared claim, flattened, so a guard cannot silently iterate nothing. */
function claims(): Array<{ agent: string; capability: string; claim: GradedClaim }> {
  const out: Array<{ agent: string; capability: string; claim: GradedClaim }> = []
  for (const [agent, caps] of DECLARED) {
    for (const [capability, claim] of Object.entries(caps)) {
      if (claim) out.push({ agent, capability, claim })
    }
  }
  assert.ok(out.length >= 14, 'the guards below are worthless over an empty list')
  return out
}

test('a definition that declares nothing claims nothing: no default is invented', () => {
  // The asymmetry with `deadlines` in one assertion. A missing `deadlines` had to be refused
  // because its absence would report as a deadline the adapter does not run; silence HERE
  // removes a claim instead. If the registry defaulted this to `{}`, "nobody said" and "asked
  // and told no" would become the same answer, which is the distinction the field exists for.
  const r = defaultRegistry().register({
    id: 'future-agent',
    displayName: 'Not built yet',
    capabilities: { ...defaultRegistry().get('codex').capabilities, agent: 'future-agent' },
    deadlines: NO_DEADLINE_CLOCKS,
    launch: { command: 'future', baseArgs: [] },
    unavailableReason: 'adapter not written',
  })
  assert.equal(r.get('future-agent').instructionCapabilities, undefined)
})

test('every built-in wires its declaration, and declares exactly what §4b resolved', () => {
  // Read through the registry rather than off the constants, so this pins the WIRING too. An
  // absent capability is UNRESOLVED -- not advertised in any source searched -- and that is a
  // statement about our searching, not about the CLI. `turnBoundedLifetime` is absent from all
  // four: every one of them advertises starting background work, none advertises when it ends.
  const expected: Record<string, string[]> = {
    claude: ['autonomousLoop', 'backgroundTasks', 'sessionBackgrounding', 'subagents'],
    codex: ['backgroundTasks', 'subagents'],
    opencode: ['asyncPromptSubmission', 'backgroundTasks', 'boundedIteration', 'subagents'],
    kimi: ['autonomousLoop', 'backgroundTasks', 'boundedIteration', 'subagents'],
  }
  const r = defaultRegistry()
  for (const [agent, keys] of Object.entries(expected)) {
    const declared = r.get(agent).instructionCapabilities
    assert.ok(declared, `${agent} must carry its declaration`)
    assert.deepEqual(Object.keys(declared).sort(), keys, `${agent} declares exactly §4b`)
  }
})

test('no claim is graded observed: an advertisement is not a behaviour', () => {
  // The masquerade `EVIDENCE_LEVELS` exists to prevent. `observed` requires a real run against
  // the installed version with a fixture captured; not one of these was performed. Promoting a
  // `--help` string to `observed` is the single most damaging edit possible to this file.
  for (const { agent, capability, claim } of claims()) {
    assert.equal(
      claim.evidence,
      'inferred_from_documented_event',
      `${agent}.${capability} is derived from what the binary declares, nothing more`,
    )
  }
})

test('every claim names a source and pins the version it was read from', () => {
  for (const { agent, capability, claim } of claims()) {
    assert.ok(claim.source.trim().length > 0, `${agent}.${capability} must say where it came from`)
    assert.ok(
      claim.sourceVersion.trim().length > 0,
      `${agent}.${capability} must pin what it was read from`,
    )
  }
})

test('each agent pins ONE version literal, so "is this stale" has a single answer', () => {
  // Consistency WITHIN an agent, which is all this can honestly check. Two claims for the same
  // CLI read from different versions would make staleness unanswerable for the agent as a whole.
  //
  // What this deliberately no longer does is compare the pin against a hardcoded copy of itself
  // (#201). That assertion passed while the Claude pin drifted eight versions behind the
  // installed CLI, because both sides of it said the same thing -- a claim about another program
  // checked against a restatement of itself, which is the failure `hookEventNames.test.ts` was
  // written to prevent. Whether a claim is still TRUE is answered by the probe search below;
  // this only answers whether the file disagrees with itself.
  const seen = new Map<string, string>()
  for (const { agent, capability, claim } of claims()) {
    const first = seen.get(agent)
    if (first === undefined) seen.set(agent, claim.sourceVersion)
    else assert.equal(claim.sourceVersion, first, `${agent}.${capability} pins a different version from its siblings`)
  }
  assert.ok(seen.size > 0, 'the walk must find claims, or this asserts nothing')
})

test('#201 every claim can still be re-derived from the installed bundle', (t) => {
  // THE CHECK THAT WAS MISSING. `sourceVersion` was the staleness rule and nothing enforced it,
  // so four Claude claims sat unverified for eight releases while a briefing was built on one of
  // them (`autonomousLoop`, #192). A stale claim there is a promise nobody re-checked.
  //
  // Version-agnostic on purpose. Every contributor's install moves independently of this repo --
  // Claude Code went 2.1.252 to 2.1.260 while this file sat still -- so failing on drift would
  // fail the suite for everyone whose CLI updated overnight, on a day when nothing was wrong.
  // What matters is whether the literal is STILL THERE, and that question does not need the
  // version to answer it.
  let checked = 0
  for (const { agent, capability, claim } of claims()) {
    const probes = claim.probes
    if (!probes || probes.length === 0) continue
    const found = installedBundle(agent)
    if ('why' in found) {
      t.diagnostic(`${agent}: skipped -- ${found.why}`)
      continue
    }
    assert.equal(
      found.bytes.includes(ABSENT_LITERAL_CANARY),
      false,
      `${agent}: the canary was found, so the search matches anything and the assertions below are vacuous`,
    )
    for (const probe of probes) {
      assert.ok(
        found.bytes.includes(probe),
        `${agent}.${capability}: ${JSON.stringify(probe)} is no longer in the installed bundle (${found.at}). ` +
          `The claim was read at ${claim.sourceVersion} and is now WRONG rather than merely old -- re-derive it or withdraw it.`,
      )
      checked += 1
    }
  }
  t.diagnostic(`${checked} probe(s) re-derived`)
})

test('#201 a claim that is graded on evidence carries something to re-derive it from', () => {
  // The hole this would otherwise leave: probes are optional on the type, because a claim about
  // an agent with no searchable bundle cannot have them. So "the search passed" could also mean
  // "nothing was searched". Every claim that names a bundle as its source must carry probes, or
  // the guard above is opt-in and the next claim added quietly opts out.
  for (const { agent, capability, claim } of claims()) {
    if (claim.evidence === 'unsupported') continue
    if (!/installed (bundle|binary)/.test(claim.source)) continue
    assert.ok(
      claim.probes && claim.probes.length > 0,
      `${agent}.${capability} cites the installed bundle as its source but carries no probe, so nothing can re-derive it`,
    )
  }
})

test('a gap is spelled by absence, never by a declared false', () => {
  // Nothing searched establishes that any of these four CANNOT do one of these things -- an
  // absent literal proves a capability is not advertised, not that it is missing. A
  // `supported: false` would assert a gap nobody verified, which is the same overclaim as an
  // ungrounded true pointing the other way.
  for (const { agent, capability, claim } of claims()) {
    assert.equal(claim.supported, true, `${agent}.${capability} claims only what was found`)
  }
})
