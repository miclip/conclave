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

test('each agent pins one version literal, exactly as that CLI reports itself', () => {
  // Verbatim `--version` output, so a freshness check is a string comparison and needs no
  // parser. One literal per agent: two claims for the same CLI read from different versions
  // would make "is this stale" unanswerable for the agent as a whole.
  const literal: Record<string, string> = {
    claude: '2.1.252 (Claude Code)',
    codex: 'codex-cli 0.147.0',
    opencode: '1.18.15',
    kimi: 'kimi, version 1.49.0',
  }
  for (const { agent, capability, claim } of claims()) {
    assert.equal(claim.sourceVersion, literal[agent], `${agent}.${capability} is pinned`)
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
