/**
 * The advisor's assignment syntax, and everything it refuses.
 *
 * `parseDecisions` is the only thing standing between an advisor's prose and work being
 * created, so its refusals matter more than its successes. A parser that guesses invents work
 * nobody authorised; one that guesses at a target invents a seat, and a hallucinated seat id
 * that silently created capacity would be a scheduling decision nobody made.
 *
 * Two properties are asserted throughout, and they are the ones the relay depends on:
 *
 *   - **atomic**. A reply is admitted whole or not at all. Every failing case below carries a
 *     VALID decision alongside the defect, so a parser that returned what it could would pass
 *     an "it failed" assertion while quietly running three-quarters of a plan.
 *   - **inert when unused**. A reply with no directive is one instruction for the fallback
 *     target, byte for byte what this function did before the syntax existed — which is what
 *     lets the default run's advisor keep its unmodified briefing (D1).
 *
 *   node --test src/relay/assignmentSyntax.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { parseDecisions, type SeatExecution, type TaskTarget } from './dispatch.ts'

const seat = (id: string, role = 'implementer'): SeatExecution => ({
  seat: id,
  role,
  state: 'idle',
  idleSince: 0,
  dispatched: 0,
})

/** Two seats filling one role, plus one filling another: enough to tell the two axes apart. */
const SEATS: SeatExecution[] = [seat('implementer'), seat('implementer-2'), seat('reviewer', 'reviewer')]
const ROLE: TaskTarget = { kind: 'role', role: 'implementer' }

/** The decisions, or the reason there are none — flattened so a failure prints readably. */
function parse(reply: string, seats: readonly SeatExecution[] = SEATS) {
  const r = parseDecisions(reply, seats, ROLE)
  return r.ok ? { ok: true as const, decisions: r.decisions } : { ok: false as const, why: r.why, detail: r.detail }
}

test('a reply with no directive is one instruction for the fallback, exactly as before', () => {
  // The default run's whole path. `MULTI_SEAT_BRIEFING` is only in the advisor's briefing when
  // the run has more than one seat, so this is the only form a default advisor writes.
  assert.deepEqual(parse('Add the parser tests.'), {
    ok: true,
    decisions: [{ kind: 'instruct', instruction: 'Add the parser tests.', target: ROLE }],
  })
  // Multi-line prose is still ONE instruction. A newline is not a delimiter; the directive is.
  assert.deepEqual(parse('Add the tests.\n\nThen run them and report what fails.'), {
    ok: true,
    decisions: [
      { kind: 'instruct', instruction: 'Add the tests.\n\nThen run them and report what fails.', target: ROLE },
    ],
  })
})

test('DONE and ESCALATE are still whole-reply decisions, matched as they always were', () => {
  assert.deepEqual(parse('DONE'), { ok: true, decisions: [{ kind: 'done', instruction: 'DONE' }] })
  assert.deepEqual(parse('DONE — the tests pass.'), {
    ok: true,
    decisions: [{ kind: 'done', instruction: 'DONE — the tests pass.' }],
  })
  assert.equal(parse('ESCALATE: which endpoint?').decisions?.[0]?.kind, 'escalate')
  assert.deepEqual(parse(''), {
    ok: false,
    why: 'empty',
    detail: 'the reply carried no instruction',
  })
})

test('one reply carries several instructions, in the order they were written', () => {
  // The point of the whole syntax: two seats given work in one advisor turn. Order is the
  // advisor's, and it is admission order — not a priority, which is `Task.seq`'s doc comment.
  assert.deepEqual(
    parse('@seat implementer: Add the parser tests.\n@seat implementer-2: Sweep the docs.'),
    {
      ok: true,
      decisions: [
        { kind: 'instruct', instruction: 'Add the parser tests.', target: { kind: 'seat', seat: 'implementer' } },
        { kind: 'instruct', instruction: 'Sweep the docs.', target: { kind: 'seat', seat: 'implementer-2' } },
      ],
    },
  )
})

test('an instruction runs to the next directive, so it can be several lines and blank lines long', () => {
  const reply = [
    '@seat implementer: Add the parser tests.',
    '',
    'Cover the empty case too.',
    '@role reviewer: Read what lands and say whether it holds.',
  ].join('\n')
  assert.deepEqual(parse(reply), {
    ok: true,
    decisions: [
      {
        kind: 'instruct',
        instruction: 'Add the parser tests.\n\nCover the empty case too.',
        target: { kind: 'seat', seat: 'implementer' },
      },
      {
        kind: 'instruct',
        instruction: 'Read what lands and say whether it holds.',
        target: { kind: 'role', role: 'reviewer' },
      },
    ],
  })
})

test('@seat and @role are different targets even when they spell the same word', () => {
  // The reason there are two spellings rather than one. This run has a SEAT called
  // `implementer` and a ROLE called `implementer`, so `@implementer` would need a precedence
  // rule — and a precedence rule is a silent answer to a question the advisor thought it had
  // asked explicitly. `@seat implementer` is one seat; `@role implementer` is two.
  const targetOf = (reply: string) => {
    const d = parse(reply).decisions?.[0]
    return d?.kind === 'instruct' ? d.target : undefined
  }
  assert.deepEqual(targetOf('@seat implementer: Do it.'), { kind: 'seat', seat: 'implementer' })
  assert.deepEqual(targetOf('@role implementer: Do it.'), { kind: 'role', role: 'implementer' })
})

test('an unknown seat or role fails the WHOLE reply, valid decisions included', () => {
  // Atomic. The first directive here is perfectly good and names a seat that exists; a parser
  // that returned it and dropped the second would dispatch half a plan and report success.
  for (const [reply, detail] of [
    ['@seat implementer: Do this.\n@seat implementer-9: And this.', 'no seat named implementer-9'],
    ['@seat implementer: Do this.\n@role auditor: And this.', 'no seat fills the role auditor'],
  ] as const) {
    const r = parse(reply)
    assert.equal(r.ok, false, 'a reply naming a seat the run does not have must not be admitted')
    assert.equal(r.why, 'unknown_target')
    assert.equal(r.detail, detail)
    assert.equal(r.decisions, undefined, 'nothing at all comes back, not the part that parsed')
  }
})

test('a role nothing fills is unknown even though the word is a real role elsewhere', () => {
  // Validated against the run's CONFIGURED seats, which is the whole rule: `reviewer` is a
  // role this file uses, and in a run with no reviewer seat it names nobody.
  const r = parse('@role reviewer: Read it.', [seat('implementer')])
  assert.equal(r.ok, false)
  assert.equal(r.why, 'unknown_target')
})

test('prose outside a directive fails the reply rather than being attached to one', () => {
  // The advisor that wrote a preamble and the advisor that wrote an instruction it forgot to
  // address are indistinguishable here, and one of them is asking for work on a seat it never
  // named. Attaching it to the neighbouring directive would put that work somewhere.
  const r = parse('Here is the plan.\n@seat implementer: Do the first part.')
  assert.equal(r.ok, false)
  assert.equal(r.why, 'stray_prose')
  assert.match(r.detail!, /Here is the plan\./)
})

test('a directive with nothing after it fails the reply', () => {
  // A seat addressed and given nothing is a turn spent on a routing header. The valid
  // directive alongside it goes too.
  const r = parse('@seat implementer: Do this.\n@seat implementer-2:')
  assert.equal(r.ok, false)
  assert.equal(r.why, 'empty_instruction')
  assert.match(r.detail!, /implementer-2 was addressed and given no instruction/)
})

test('DONE or ESCALATE inside an addressed reply fails it rather than being sent as prose', () => {
  // Ending the run and assigning work are different decisions. Without this the keyword lands
  // in a seat's instruction — the advisor believes it ended the run, and a seat is told "DONE".
  for (const [reply, why] of [
    ['@seat implementer: Do this.\nDONE', 'mixed_keyword'],
    ['@seat implementer: Do this.\n@seat implementer-2: ESCALATE: is this in scope?', 'mixed_keyword'],
  ] as const) {
    const r = parse(reply)
    assert.equal(r.ok, false, reply)
    assert.equal(r.why, why)
  }
})

test('the fallback target is validated too, so a run whose role nothing fills fails closed', () => {
  // The unaddressed path's own version of the same rule, and the one that survives from before
  // the syntax existed: a fallback naming a role no seat fills is not a run with a default, it
  // is a run with nowhere to put the work.
  const r = parse('Do the thing.', [seat('reviewer', 'reviewer')])
  assert.equal(r.ok, false)
  assert.equal(r.why, 'unknown_target')
  assert.equal(r.detail, 'no seat fills the role implementer')
})

test('a directive must be at the start of a line, so an @ inside prose is prose', () => {
  // An advisor writing about the syntax is talking about code, not addressing anybody.
  //
  // The sentences below are chosen to MATCH the directive pattern everywhere except at the
  // start of the line — `@seat`, whitespace, a name, a colon. That is the whole test: an
  // earlier version used a sentence that matched nowhere, so it passed with the anchor
  // removed and proved nothing. Unanchored, the first of these is admitted as an instruction
  // reading "goes to that seat." — the advisor's sentence silently truncated to the fragment
  // after the colon, and dispatched.
  for (const reply of [
    'Document the syntax: an instruction addressed with @seat implementer: goes to that seat.',
    'Explain why @role implementer: is different from @seat implementer:.',
  ]) {
    assert.deepEqual(
      parse(reply),
      { ok: true, decisions: [{ kind: 'instruct', instruction: reply, target: ROLE }] },
      'a sentence that mentions the syntax must be relayed whole, to the fallback target',
    )
  }

  // And a real directive is still recognised when the same sentence follows it on later
  // lines, so the anchor does not cost the advisor the ability to explain itself.
  const r = parse('@seat implementer-2: Document it.\nSay that @seat implementer: addresses one seat.')
  assert.equal(r.ok, true)
  assert.deepEqual(r.decisions, [
    {
      kind: 'instruct',
      instruction: 'Document it.\nSay that @seat implementer: addresses one seat.',
      target: { kind: 'seat', seat: 'implementer-2' },
    },
  ])
})

test('two directives may name the same seat, and both are admitted', () => {
  // Not a defect: it is two pieces of work for one seat, which the queue serialises. Refusing
  // it would make the advisor discover a scheduling rule by having its reply rejected.
  const r = parse('@seat implementer: First this.\n@seat implementer: Then this.')
  assert.equal(r.ok, true)
  assert.deepEqual(r.decisions?.map((d) => d.kind === 'instruct' && d.instruction), ['First this.', 'Then this.'])
})

/**
 * The keyword forms and the addressed form cannot be combined, whichever comes first.
 *
 * `DONE` on the first line used to win outright: the whole-reply keyword tests ran BEFORE the
 * reply was examined for directives, so `DONE\n@seat a: ...` was a clean end-of-run and every
 * assignment under it was discarded without a word. The advisor believed it had done both, got
 * one, and nothing in the log said the rest had gone. `ESCALATE` had the same shape.
 *
 * The fix is to decide the FORM first, so this is asserted from both directions: keyword above
 * the directives, keyword below them, and keyword inside a body -- and, in every case, that the
 * decisions which would have been admitted are not.
 */
test('a keyword above, below or inside an addressed reply fails the whole reply', () => {
  const cases: [string, string][] = [
    ['DONE\n@seat implementer: Add the tests.', 'the keyword first, which used to win outright'],
    ['DONE — the work is finished.\n@seat implementer: Add the tests.', 'with a trailing clause, as an advisor writes it'],
    ['ESCALATE: is this in scope?\n@role implementer: Add the tests.', 'ESCALATE has the same shape'],
    ['@seat implementer: Add the tests.\nDONE', 'the keyword last'],
    ['@seat implementer: DONE', 'the keyword as the whole instruction'],
    ['@seat implementer: Add the tests.\n@seat implementer-2: ESCALATE: is this in scope?', 'the keyword as a later body'],
  ]
  for (const [reply, why] of cases) {
    const r = parse(reply)
    assert.equal(r.ok, false, `${why}: ${JSON.stringify(reply)}`)
    assert.equal(r.why, 'mixed_keyword', why)
    assert.equal(r.decisions, undefined, 'nothing may be admitted from a reply that mixes the two')
  }
})

test('the legacy keyword forms are untouched by that rule', () => {
  // The N=1 path. No directive anywhere, so the reply is what it has always been -- including
  // a multi-line DONE, which is the shape the mixed-keyword rule has to be careful not to eat.
  assert.deepEqual(parse('DONE'), { ok: true, decisions: [{ kind: 'done', instruction: 'DONE' }] })
  assert.deepEqual(parse('DONE\nThe tests pass and the docs are updated.'), {
    ok: true,
    decisions: [{ kind: 'done', instruction: 'DONE\nThe tests pass and the docs are updated.' }],
  })
  const esc = parse('ESCALATE: which endpoint?\nBoth are defensible and the goal does not say.')
  assert.equal(esc.ok, true)
  assert.equal(esc.decisions?.[0]?.kind, 'escalate')
  // And an ordinary instruction that merely CONTAINS the word on a later line is an
  // instruction, because nothing in it addresses a seat.
  const plain = parse('Add the tests.\nReport DONE when they pass.')
  assert.equal(plain.ok, true)
  assert.equal(plain.decisions?.[0]?.kind, 'instruct')
})
