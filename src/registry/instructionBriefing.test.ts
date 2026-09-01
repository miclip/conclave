/**
 * The briefing renderer is a pure function of two inputs, and each guard below pins one of the
 * ways that stops being true.
 *
 * The block is not wired into a run yet. That is the reason to pin it now rather than after:
 * every property here is one an edit made under pressure to ship a briefing would quietly drop,
 * and a briefing is the hardest artefact in this system to notice being wrong -- nobody sees it
 * but the advisor, and the advisor cannot tell a capability it was never told about from one the
 * seat does not have.
 *
 *   node --test src/registry/instructionBriefing.test.ts
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  CAPABILITY_DESCRIPTORS,
  instructionBriefingForSeats,
  instructionCapabilityBriefing,
  type CapabilityDescriptor,
} from './instructionBriefing.ts'
import { EVIDENCE_LEVELS } from '../contract/outcome.ts'
import type { GradedClaim, InstructionCapabilities } from './types.ts'

const claim = (over: Partial<GradedClaim> = {}): GradedClaim => ({
  supported: true,
  evidence: 'inferred_from_documented_event',
  source: 'a literal in the installed binary',
  sourceVersion: '1.0.0',
  ...over,
})

/**
 * Every capability declared supported, with the keys written in the REVERSE of the render
 * order. A renderer that iterated the declaration instead of the descriptors would order its
 * block by however this literal happened to be typed, and would pass a test whose fixture was
 * written in the convenient order.
 */
const ALL_SUPPORTED: InstructionCapabilities = {
  autonomousLoop: claim(),
  boundedIteration: claim(),
  asyncPromptSubmission: claim(),
  sessionBackgrounding: claim(),
  turnBoundedLifetime: claim(),
  backgroundTasks: claim(),
  subagents: claim(),
}

test('the seven canonical terms render in the descriptors’ order, not the declaration’s', () => {
  assert.deepEqual(
    CAPABILITY_DESCRIPTORS.map((d) => d.key),
    [
      'subagents',
      'backgroundTasks',
      'turnBoundedLifetime',
      'sessionBackgrounding',
      'asyncPromptSubmission',
      'boundedIteration',
      'autonomousLoop',
    ],
    'all seven §4a terms, with the three background rows adjacent and escalating in scope',
  )
  const text = instructionCapabilityBriefing(CAPABILITY_DESCRIPTORS, ALL_SUPPORTED)
  const at = CAPABILITY_DESCRIPTORS.map((d) => {
    const i = text.indexOf(d.instruction)
    assert.notEqual(i, -1, `${d.key} must be rendered at all`)
    return i
  })
  assert.deepEqual(at, [...at].sort((a, b) => a - b), 'rendered in descriptor order')
})

test('the words come from the descriptors passed in, not from a table inside the renderer', () => {
  // The renderer must be a function OF the descriptors. If it reaches for the canonical table
  // instead, a future caller that wants a different framing -- for a seat rather than the
  // advisor, say -- silently gets the advisor's words back.
  const synthetic: CapabilityDescriptor[] = [
    { key: 'subagents', term: 'made up', instruction: 'do the SYNTHETIC thing this test invented' },
  ]
  const text = instructionCapabilityBriefing(synthetic, { subagents: claim() })
  assert.ok(text.includes('do the SYNTHETIC thing this test invented'), 'renders what it was given')
  const canonical = CAPABILITY_DESCRIPTORS.find((d) => d.key === 'subagents')
  assert.ok(canonical)
  assert.ok(!text.includes(canonical.instruction), 'and nothing it was not given')
  assert.ok(!text.includes(canonical.term), 'the canonical term is not reached for either')
})

test('an absent declaration and a declared false are both silent, exactly', () => {
  // Exactly `''`, not a heading over an empty list: the caller concatenates unconditionally, so
  // an empty block is a paragraph of briefing tokens charged to a run that claims nothing.
  // Absence and a declared false render the same on purpose -- neither is something the advisor
  // should be told the seat can do -- while staying different in the data.
  assert.equal(instructionCapabilityBriefing(CAPABILITY_DESCRIPTORS, undefined), '')
  assert.equal(instructionCapabilityBriefing(CAPABILITY_DESCRIPTORS, {}), '')
  assert.equal(
    instructionCapabilityBriefing(CAPABILITY_DESCRIPTORS, {
      subagents: claim({ supported: false }),
      autonomousLoop: claim({ supported: false }),
    }),
    '',
    'a declaration of nothing but false is as silent as no declaration',
  )
  const mixed = instructionCapabilityBriefing(CAPABILITY_DESCRIPTORS, {
    subagents: claim({ supported: false }),
    backgroundTasks: claim(),
  })
  const dropped = CAPABILITY_DESCRIPTORS.find((d) => d.key === 'subagents')
  assert.ok(dropped)
  assert.ok(!mixed.includes(dropped.instruction), 'the false one is dropped from a block that renders')
})

test('the renderer cannot tell one agent from another', () => {
  // Two halves, because there are two ways an id could get in. The first is a literal branch,
  // which the source scan catches. The second is subtler and is the one an edit would actually
  // reach for: the declaration itself carries `source` and `sourceVersion` strings that NAME the
  // CLI they were read from, so a renderer can identify an agent without ever seeing its id.
  const readFromOne = instructionCapabilityBriefing(CAPABILITY_DESCRIPTORS, {
    subagents: claim({ source: '`--agents` in one CLI’s help', sourceVersion: '2.1.252 (A Vendor)' }),
  })
  const readFromAnother = instructionCapabilityBriefing(CAPABILITY_DESCRIPTORS, {
    subagents: claim({ source: 'a description file in another CLI’s package', sourceVersion: 'v, version 9' }),
  })
  assert.equal(readFromOne, readFromAnother, 'provenance changes the claim, never the rendering')

  const source = readFileSync(join(import.meta.dirname, 'instructionBriefing.ts'), 'utf8')
  for (const id of ['claude', 'codex', 'opencode', 'kimi']) {
    assert.ok(
      !new RegExp(id, 'i').test(source),
      `the renderer must not name '${id}': an id check here is a second capability table in prose`,
    )
  }
})

test('the block says these are instructions, and keeps the three background senses apart', () => {
  // The prose requirement, pinned because it is the whole point of the block. An advisor that
  // reads this as a list of things the ORCHESTRATOR does, or that reads "background" as one
  // capability, has been misinformed by a briefing that looks fine.
  const text = instructionCapabilityBriefing(CAPABILITY_DESCRIPTORS, ALL_SUPPORTED)
  assert.match(text, /CAN BE INSTRUCTED TO/, 'framed as what the seat can be told to do')
  assert.match(text, /the seated agent can be TOLD to do/, 'and said again in plain words')
  assert.match(text, /not a record of what it has already done/, 'distinguished from a record of the past')

  const say = (key: CapabilityDescriptor['key']): string => {
    const d = CAPABILITY_DESCRIPTORS.find((c) => c.key === key)
    assert.ok(d, `${key} must have a descriptor`)
    return d.instruction
  }
  assert.match(say('backgroundTasks'), /says nothing whatsoever about when that task ends/i)
  assert.match(say('turnBoundedLifetime'), /by the time the turn ends/i)
  assert.match(say('sessionBackgrounding'), /not a way to run a task in the background/i)
})

test('the block states no evidence level and no freshness', () => {
  // `GradedClaim` admits every level `EVIDENCE_LEVELS` holds, `observed` included. A sentence
  // asserting that everything listed is an unwatched advertisement is therefore not a caution
  // but a FALSEHOOD waiting on the first fixture -- and false in the direction that understates
  // something already proven. Grades are per claim and readable there; this block must not
  // summarise them, because a generic renderer has no idea which grades it was handed.
  const text = instructionCapabilityBriefing(CAPABILITY_DESCRIPTORS, ALL_SUPPORTED)
  for (const level of EVIDENCE_LEVELS) {
    assert.ok(!text.includes(level), `the block must not name the grade '${level}'`)
  }
  assert.doesNotMatch(text, /advertis|watched|guarantee|fixture|stale/i, 'nor say it in words')
  // Nor promise BEHAVIOUR. A supported claim says the capability is advertised, so "what the
  // model at that seat will act on" -- which stood here -- asserted compliance the declaration
  // never carried. An advisor reading that would treat a failure to comply as a bug in the run
  // rather than as a claim that did not hold up.
  assert.doesNotMatch(text, /will act on|always|guaranteed|reliably/i, 'and promises no compliance')

  // The property behind the wording: the same capabilities at any grade read the same. A
  // renderer that summarised grades would have to differ across these, and one that asserts a
  // single grade unconditionally is caught by the scan above.
  const rendered = new Set(
    EVIDENCE_LEVELS.map((evidence) =>
      instructionCapabilityBriefing(CAPABILITY_DESCRIPTORS, { subagents: claim({ evidence }) }),
    ),
  )
  assert.equal(rendered.size, 1, 'the block is the same at every evidence level')
})

test('one seat renders the singular block, byte for byte', () => {
  // A run with one seat has nothing to disambiguate, so it must not pay for the distinction.
  // Byte equality with the singular renderer is the strong form of that: no preamble, no label,
  // nothing at all that a one-seat run did not have before seats were plural.
  const alone = instructionCapabilityBriefing(CAPABILITY_DESCRIPTORS, ALL_SUPPORTED)
  const composed = instructionBriefingForSeats(CAPABILITY_DESCRIPTORS, [
    { id: 'implementer', declared: ALL_SUPPORTED },
  ])
  assert.equal(composed, alone)
  assert.ok(!composed.includes('implementer'), 'a lone seat is not labelled with its own id')
})

test('more than one seat labels every block, even when only one of them declares', () => {
  // The gate is the SEAT COUNT, not how many blocks came back non-empty. Two seats where only
  // one declares is precisely the case an unlabelled block misleads: the advisor reads one list
  // and has no way to tell which of its two seats it describes.
  const one = instructionBriefingForSeats(CAPABILITY_DESCRIPTORS, [
    { id: 'implementer', declared: ALL_SUPPORTED },
    { id: 'implementer-2', declared: undefined },
  ])
  assert.match(one, /SEAT implementer CAN BE INSTRUCTED TO/, 'the declaring seat is named')
  assert.doesNotMatch(one, /SEAT implementer-2 CAN BE INSTRUCTED TO/, 'the silent seat gets no block')
  assert.match(one, /EACH BLOCK BELOW IS ATTRIBUTED TO ONE SEAT/, 'the lists are attributed, not merged')
  // And the preamble claims ONLY that. Saying the seats differ would be a claim about the run
  // that this function cannot make -- two seats on one agent take identical instructions.
  assert.doesNotMatch(
    one,
    /DO NOT ALL TAKE THE SAME|not interchangeable|seats? .{0,12}differ/i,
    'and claims no more',
  )

  const both = instructionBriefingForSeats(CAPABILITY_DESCRIPTORS, [
    { id: 'alpha', declared: { subagents: claim() } },
    { id: 'beta', declared: { autonomousLoop: claim() } },
  ])
  const say = (key: CapabilityDescriptor['key']): string => {
    const d = CAPABILITY_DESCRIPTORS.find((c) => c.key === key)
    assert.ok(d)
    return d.instruction
  }
  const alphaBlock = both.slice(both.indexOf('SEAT alpha'), both.indexOf('SEAT beta'))
  assert.ok(alphaBlock.includes(say('subagents')), "alpha's block holds alpha's claim")
  assert.ok(!alphaBlock.includes(say('autonomousLoop')), "and not beta's")
})

test('seats that declare nothing supported compose to nothing at all', () => {
  const nothing = [
    [],
    [{ id: 'a', declared: undefined }],
    [{ id: 'a', declared: {} }, { id: 'b', declared: undefined }],
    [
      { id: 'a', declared: { subagents: claim({ supported: false }) } },
      { id: 'b', declared: { autonomousLoop: claim({ supported: false }) } },
    ],
  ] as const
  for (const seats of nothing) {
    assert.equal(instructionBriefingForSeats(CAPABILITY_DESCRIPTORS, seats), '', 'no preamble either')
  }
})

test('every bullet names the canonical term it is describing', () => {
  // `term` is the §4a vocabulary and was declared but never rendered, which made it decoration
  // -- a field nothing reads drifts from the thing it names and no test notices. It is the name
  // the matrix, the design and this repository all use for the capability, so an advisor that
  // has read either can line up what it is being told with what it has read.
  // Pinned as LITERALS. Asserting `text.includes(`${d.term} — ...`)` alone reads the term off
  // the descriptor on both sides of the comparison, so it holds however the term is spelled --
  // a test that cannot fail, which a mutation of 'bounded subagent delegation' proved by
  // killing nothing. The vocabulary is the point, so the vocabulary is what is written down.
  assert.deepEqual(
    CAPABILITY_DESCRIPTORS.map((d) => d.term),
    [
      'bounded subagent delegation',
      'background task execution',
      'turn-bounded lifetime',
      'whole-session backgrounding',
      'async prompt submission',
      'bounded agentic iteration',
      'autonomous cross-turn continuation',
    ],
    'the §4a vocabulary, verbatim',
  )
  const text = instructionCapabilityBriefing(CAPABILITY_DESCRIPTORS, ALL_SUPPORTED)
  for (const d of CAPABILITY_DESCRIPTORS) {
    assert.ok(
      text.includes(`${d.term} — ${d.instruction}.`),
      `${d.key} must be rendered as its term followed by its instruction`,
    )
  }
})
