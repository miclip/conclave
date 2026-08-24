/**
 * A withheld message stops being withheld once the human hands it over (#171).
 *
 * One operator note, sent to the implementer alone at seq 5, produced three
 * `authority_conflict` pauses across a two-hour run. All three cited the same origin, and
 * the match set narrowed as the session moved on -- four tokens, then two, then one:
 *
 *   pause 1  seq 14  TR-8S, tr-8s-nodecap, DESIGN.md, lib/core/search.ts   verb: remove
 *   pause 2  seq 21  TR-8S, DESIGN.md                                      verb: restore
 *   pause 3  seq 46  DESIGN.md                                             verb: removing
 *
 * The third is the shape of the defect on its own. `DESIGN.md` is a file that project's own
 * commit policy requires touching whenever an invariant changes, so it appears in nearly
 * every instruction -- and a token that matches forever pauses forever.
 *
 * The defect underneath is not the matching. At pause 1 the operator resolved it by
 * broadcasting the full text of message #5 to BOTH seats before continuing, precisely so the
 * advisor would stop reasoning without it. From that moment the pause's own opening sentence
 * -- "an advisor instruction would reverse work that came from a message it never saw" --
 * was false. Pauses 2 and 3 asserted it anyway, because nothing in the record could say the
 * advisor had since been told.
 *
 * These are RECORD-level: a sequence of messages against a `RestrictedOrigin`, with no relay
 * and no children, because the claim is about what the record remembers and what
 * `detectConflict` reads off it. The wiring that gets a real broadcast into the record is
 * pinned separately in `relay.test.ts`.
 *
 * What must NOT change is asserted alongside, in both directions: `/continue` still clears
 * only the pause in front of the operator, a partial or paraphrased hand-over reconciles
 * nothing, and a NEW restricted message is armed exactly as the first one was.
 *
 *   node --test src/relay/authorityReconciliation.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { deliversInFull, detectConflict, originOf, reconcileDelivery } from './authority.ts'
import type { RelayMessage } from './message.ts'

/**
 * The operator note from #171, reconstructed around the tokens the issue reports as matched.
 *
 * `TR-8S`, `tr-8s-nodecap`, `DESIGN.md` and `lib/core/search.ts` are the four the first pause
 * cited, so the token set this produces is the one the live run actually held. It is quoted
 * in this file exactly once and every delivery below is built from the same constant -- a
 * second copy would let the "full text" tests pass against text the origin never carried.
 */
const NOTE = [
  'Operator note, no action needed beyond referencing it: the node-cap finding is now GitHub',
  'issue #78, so the cap in `lib/core/search.ts` and the `DESIGN.md` invariant it touches are',
  'tracked there rather than here. Your stashed TR-8S is also preserved as branch',
  '`wip/tr-8s-nodecap` in case the stash is lost.',
].join('\n')

function aside(text: string, seq = 5): RelayMessage {
  return {
    seq,
    at: 0,
    from: 'human',
    fromRank: 'human',
    to: ['implementer'],
    kind: 'aside',
    text,
    visibility: 'restricted',
    excluded: ['advisor'],
  }
}

/** Pause 1: the temporary removal, verbatim in shape from the issue's table. */
const PAUSE_1 =
  'Temporarily remove the recovered TR-8S files from the working tree, run the suite, then ' +
  'restore the TR-8S files byte-identically from `wip/tr-8s-nodecap^3`.'

/**
 * A reversal that is genuine rather than the issue's second false positive.
 *
 * The point being made below is that `/continue` disarms nothing, and only a real conflict
 * can make it -- reusing pause 2 would prove that a false positive re-fires, which is a
 * different and much weaker claim.
 */
const GENUINE_REVERSAL =
  'Delete the recovered TR-8S files and drop the wip/tr-8s-nodecap branch — none of that ' +
  'belongs in this repository.'

/** Pause 3: one common filename, and nothing else. The end state of the defect. */
const PAUSE_3 =
  'Before the next commit, stop removing DESIGN.md from the staged set — it belongs in every ' +
  'commit that touches an invariant.'

/**
 * What the operator actually typed at pause 1: the whole message, inside prose.
 *
 * Reflowed onto one line, because a paste is. If containment demanded the original line
 * breaks it would refuse nearly every real hand-over, and the operator would have repaired
 * the asymmetry with the tool still insisting they had not.
 */
const BROADCAST =
  'For the record, both of you — here is message #5 in full, which until now only the ' +
  `implementer had seen: ${NOTE.replace(/\n/g, ' ')} That is all of it. Nothing else changes.`

test('the original conflict fires: the aside is armed and the first instruction opposes it', () => {
  const origin = originOf(aside(NOTE))
  assert.deepEqual(origin.excluded, ['advisor'], 'the advisor is the seat that cannot see it')
  assert.deepEqual(origin.reconciled, [], 'and nothing has been handed over yet')

  const conflict = detectConflict(PAUSE_1, [origin], 'advisor')
  assert.ok(conflict, 'pause 1 from the issue')
  assert.equal(conflict.verb.toLowerCase(), 'remove')
  assert.deepEqual(
    [...conflict.matched].sort(),
    ['TR-8S', 'tr-8s-nodecap', 'wip/tr-8s-nodecap'],
    'matched on what the note preserved',
  )
})

test('`/continue` clears the pause and not the origin: a later genuine reversal still fires', () => {
  // `/continue` is an answer to ONE adjudication. The relay records it by instruction so the
  // same instruction is not re-raised; it deliberately does not latch the origin, because
  // latching would silence a real reversal arriving later with the same overlap -- the one
  // case the mechanism exists for. That decision is #157's and is not being revisited: what
  // is asserted here is that it leaves the RECORD untouched, which is why the origin has to
  // be reconcilable by something else.
  const origin = originOf(aside(NOTE))
  assert.ok(detectConflict(PAUSE_1, [origin], 'advisor'), 'pause 1 fired')

  // Continuing changes nothing about who holds the message, because continuing is not
  // telling anyone anything.
  assert.deepEqual(origin.excluded, ['advisor'])
  assert.deepEqual(origin.informed, ['implementer'])
  assert.deepEqual(origin.reconciled, [])

  const later = detectConflict(GENUINE_REVERSAL, [origin], 'advisor')
  assert.ok(later, 'a genuine reversal after a continue must still pause')
  assert.equal(later.verb.toLowerCase(), 'delete')
})

test('the full text, broadcast to the excluded seat, reconciles the origin (#171)', () => {
  const origin = originOf(aside(NOTE))
  assert.ok(detectConflict(PAUSE_1, [origin], 'advisor'), 'armed before the broadcast')

  const moved = reconcileDelivery(origin, { seq: 15, text: BROADCAST, to: ['advisor', 'implementer'] })
  assert.deepEqual(moved, ['advisor'], 'only the seat that was actually excluded moves')

  // The record now says what is true: both seats hold it, and one of them was given it late.
  assert.deepEqual(origin.excluded, [])
  assert.deepEqual(origin.informed, ['implementer', 'advisor'])
  assert.deepEqual(origin.reconciled, [{ participant: 'advisor', seq: 15 }])

  // Surrounding prose did not stop the whole message being recognised.
  assert.ok(BROADCAST.length > NOTE.length + 40, 'the delivery really was wrapped in prose')
  assert.ok(deliversInFull(origin, BROADCAST))
})

test('and once reconciled, every later matching instruction goes through silently (#171)', () => {
  // Pauses 2 and 3 from the issue, and the genuine reversal too. This is the whole complaint:
  // the operator repaired the asymmetry at pause 1 and was asked about it twice more.
  const origin = originOf(aside(NOTE))
  reconcileDelivery(origin, { seq: 15, text: BROADCAST, to: ['advisor', 'implementer'] })

  assert.equal(detectConflict(PAUSE_3, [origin], 'advisor'), undefined, 'pause 3 must not fire')
  assert.equal(
    detectConflict('Restore the TR-8S files and DESIGN.md from the branch.', [origin], 'advisor'),
    undefined,
    'pause 2 must not fire',
  )
  assert.equal(
    detectConflict(GENUINE_REVERSAL, [origin], 'advisor'),
    undefined,
    'a seat that has been given the message is not reversing something it never saw',
  )

  // Not because the tokens stopped matching. The origin is unchanged as evidence; it is the
  // premise about who was kept in the dark that has expired.
  assert.ok(origin.tokens.includes('DESIGN.md'), 'the token set is untouched')
  const stillHidden = originOf(aside(NOTE, 99))
  assert.ok(detectConflict(PAUSE_3, [stillHidden], 'advisor'), 'and an unreconciled twin still fires')
})

test('a partial quote is not a delivery: the seat holds half the message (#171)', () => {
  // The operator re-reads the sentence that came up, not the message. Handing over the half
  // that happens to be under discussion does not put the advisor where an informed seat
  // stands, and treating it as though it did would disarm the detector on the strength of an
  // excerpt -- a silent false negative, which is the direction this must not fail in.
  const origin = originOf(aside(NOTE))
  const partial =
    'To be clear for both of you, what I told the implementer earlier was: Your stashed TR-8S ' +
    'is also preserved as branch `wip/tr-8s-nodecap` in case the stash is lost.'
  assert.ok(NOTE.includes('preserved as branch'), 'the excerpt really is from the message')

  assert.deepEqual(reconcileDelivery(origin, { seq: 15, text: partial, to: ['advisor'] }), [])
  assert.deepEqual(origin.excluded, ['advisor'], 'still withheld')
  assert.deepEqual(origin.reconciled, [])
  assert.ok(detectConflict(PAUSE_3, [origin], 'advisor'), 'so the pause is still correct to fire')
})

test('a paraphrase is not a delivery either, however faithful (#171)', () => {
  const origin = originOf(aside(NOTE))
  const paraphrase =
    'For context, both of you: earlier I told the implementer that the node-cap finding is ' +
    'tracked as issue #78 and that the TR-8S work is safe on a wip branch. Nothing is lost.'

  assert.deepEqual(reconcileDelivery(origin, { seq: 15, text: paraphrase, to: ['advisor'] }), [])
  assert.deepEqual(origin.excluded, ['advisor'])
  assert.ok(detectConflict(PAUSE_1, [origin], 'advisor'), 'the asymmetry is intact, so the guard is')

  // Overlapping heavily is not the same as containing. The paraphrase names three of the
  // origin's own tokens and still delivers nothing.
  assert.ok(paraphrase.includes('TR-8S') && paraphrase.includes('node-cap') && paraphrase.includes('#78'))
})

test('reconciliation is per seat: a hand-over to one seat leaves the other withheld (#171)', () => {
  // The reason the check reads the ADVISOR's id rather than asking whether `excluded` is
  // empty. At N>1 the operator can repair one seat's asymmetry and not another's, and an
  // origin still withheld from the advisor is still armed against the advisor's instruction.
  const origin = originOf({ ...aside(NOTE), excluded: ['advisor', 'impl-b'] })
  assert.deepEqual(reconcileDelivery(origin, { seq: 15, text: BROADCAST, to: ['impl-b'] }), ['impl-b'])
  assert.deepEqual(origin.excluded, ['advisor'], 'the advisor was not in the delivery')

  const conflict = detectConflict(PAUSE_3, [origin], 'advisor')
  assert.ok(conflict, 'the advisor still never saw it')
  // And the human adjudicating is told which part of the asymmetry has already closed.
  assert.deepEqual(conflict.origin.reconciled, [{ participant: 'impl-b', seq: 15 }])
})

test('a NEW restricted message after a reconciliation is armed exactly as the first was (#171)', () => {
  // The failure a fix for this could easily buy quiet with: reconciling one origin must not
  // teach the detector that this session no longer has asymmetries. The operator withholds
  // something else an hour later, and that one is as live as seq 5 ever was.
  const first = originOf(aside(NOTE))
  reconcileDelivery(first, { seq: 15, text: BROADCAST, to: ['advisor', 'implementer'] })
  assert.deepEqual(first.excluded, [], 'the first origin is settled')

  const second = originOf(
    aside('Keep `lib/core/nodecap.ts` exactly as it is — I wrote that limit deliberately.', 50),
  )
  const origins = [first, second]

  const conflict = detectConflict('Remove lib/core/nodecap.ts, the limit is arbitrary.', origins, 'advisor')
  assert.ok(conflict, 'the new asymmetry pauses')
  assert.equal(conflict.origin.seq, 50, 'and it is attributed to the message that is actually withheld')
  assert.deepEqual(conflict.matched, ['lib/core/nodecap.ts', 'nodecap.ts'], 'path and basename both')

  // The settled origin is skipped rather than terminating the scan: an instruction can match
  // a reconciled origin and a live one at once, and the live one is the answer.
  const both = detectConflict(
    'Remove the TR-8S files and lib/core/nodecap.ts as well.',
    origins,
    'advisor',
  )
  assert.ok(both, 'a reconciled origin earlier in the list must not swallow a live one')
  assert.equal(both.origin.seq, 50)
})

test('a delivery cannot precede the message it delivers', () => {
  // Sequence is the only ordering the record has. A message earlier in the log cannot have
  // handed over text that did not exist yet, and an origin cannot deliver itself -- which is
  // what an unguarded containment test would conclude, since every text contains itself.
  const origin = originOf(aside(NOTE))
  assert.deepEqual(reconcileDelivery(origin, { seq: 4, text: BROADCAST, to: ['advisor'] }), [])
  assert.deepEqual(reconcileDelivery(origin, { seq: 5, text: NOTE, to: ['advisor'] }), [])
  assert.deepEqual(origin.excluded, ['advisor'])
})

test('an empty message delivers nothing, though every text contains it', () => {
  // Degenerate and worth pinning: containment of the empty string is universal, so an origin
  // with no text would be reconciled by the next thing anyone said.
  const origin = originOf(aside('   \n  '))
  assert.equal(deliversInFull(origin, 'anything at all'), false)
  assert.deepEqual(reconcileDelivery(origin, { seq: 9, text: 'anything at all', to: ['advisor'] }), [])
})

test('with no advisor named, detection behaves exactly as it did before reconciliation existed', () => {
  // Every caller that builds origins by hand -- and every test in the two files beside this
  // one -- passes two arguments. A detector that quietly stopped firing for them would be a
  // false negative introduced by an argument nobody knew to pass.
  const origin = originOf(aside(NOTE))
  assert.ok(detectConflict(PAUSE_1, [origin]), 'two-argument form still fires')

  reconcileDelivery(origin, { seq: 15, text: BROADCAST, to: ['advisor'] })
  assert.equal(
    detectConflict(PAUSE_1, [origin]),
    undefined,
    'and an origin nobody is excluded from can support no claim, named advisor or not',
  )
})
