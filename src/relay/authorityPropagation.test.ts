/**
 * Relaying a finding is not reversing it (#157).
 *
 * A restricted message carried a code-review finding whose remedy was, verbatim, "do not
 * emit raw scope strings; return booleans/counts instead". The advisor then relayed that
 * finding to the implementer — a near-verbatim restatement — and the run paused three times
 * with `authority_conflict`, every time falsely. Nothing was being reversed; the instruction
 * was the finding being *carried out*.
 *
 * There are two independent defects underneath that, and they are tested separately here
 * because fixing either one alone leaves the run pausing:
 *
 *   extraction  `booleans/counts` is prose, not a path. `extractTokens` treats any
 *               `word/word` span as a path, keeps it, and additionally contributes its
 *               "basename" `counts` as a token in its own right. Two of the matches the
 *               issue reports are artifacts of that rule and identify nothing.
 *
 *   decision    remove that artifact entirely and the pause still fires. An instruction
 *               that IMPLEMENTS a removal-shaped finding quotes the finding (high token
 *               overlap) and removes something (a reversal verb) — exactly the detector's
 *               signature for opposing it. `detectConflict` has no signal that separates
 *               propagating a restricted instruction from undoing one.
 *
 * The last test pins the case the mechanism exists for, so that a fix for the two above is
 * not allowed to buy quiet by disarming the guard.
 *
 *   node --test src/relay/authorityPropagation.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { detectConflict, extractTokens, originOf } from './authority.ts'
import type { RelayMessage } from './message.ts'

/**
 * The restricted message, reconstructed from the issue.
 *
 * The remedy sentence is verbatim from #157. The surrounding finding is rebuilt from the
 * artifacts the issue reports as matched — `src/thread/access/ops.py`, `render_status`, the
 * three endpoint paths, the four scope names, `AHA_DOMAIN`, and the hyphenated descriptors —
 * so that the token set this produces is the one the live run actually held.
 *
 * The three endpoint paths are marked as code, the way a reviewer writes them and the way the
 * live finding had them. That matters to what this file proves: single-slash paths are only
 * extractable when marked, so leaving them bare would delete them from the token set for a
 * reason that has nothing to do with the defect, and the arithmetic below would no longer be
 * about `booleans/counts`.
 */
const FINDING = [
  'Code-review finding (restricted): in `src/thread/access/ops.py`, `render_status` emits the raw',
  'allow-listed scope strings — confluence_spaces, jira_projects, figma_files, atlassian_site, and the',
  'operator-pasted AHA_DOMAIN — straight out of the `aha_domain/products`, `v1/ops/status` and `env/config`',
  'handlers. Anything token-shaped or basic-auth reaches the dt-access response body verbatim.',
  'Remedy: do not emit raw scope strings; return booleans/counts instead.',
].join('\n')

/** The advisor relaying that finding onward. A restatement, not a reversal. */
const RELAYED =
  'Apply the restricted finding in src/thread/access/ops.py: render_status must stop emitting the raw ' +
  'allow-listed, operator-pasted scope strings. Delete confluence_spaces, jira_projects, figma_files, ' +
  'atlassian_site and AHA_DOMAIN from the aha_domain/products, v1/ops/status and env/config responses so ' +
  'nothing token-shaped or basic-auth reaches dt-access, and return booleans/counts instead.'

function restricted(text: string, seq = 4): RelayMessage {
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

/**
 * The `matched:` list from #157, verbatim and in the issue's order.
 *
 * The bound this file has to hit. Nineteen of these are genuine — real paths, real
 * identifiers, real basenames — and a fix that quiets the pause by dropping them has
 * traded a false positive for a false negative. Exactly two are extraction artifacts.
 */
const REPORTED_MATCHED = [
  'src/thread/access/ops.py',
  'aha_domain/products',
  'v1/ops/status',
  'env/config',
  'booleans/counts',
  'ops.py',
  'confluence_spaces',
  'jira_projects',
  'figma_files',
  'atlassian_site',
  'AHA_DOMAIN',
  'operator-pasted',
  'basic-auth',
  'allow-listed',
  'token-shaped',
  'render_status',
  'dt-access',
  'products',
  'status',
  'config',
  'counts',
]

/** The two of them that identify nothing: prose with a slash, and the word it donated. */
const ARTIFACTS = ['booleans/counts', 'counts']

test('exactly the two artifacts leave the reported match list; the other 19 stay (#157)', () => {
  const origin = originOf(restricted(FINDING))
  const genuine = REPORTED_MATCHED.filter((m) => !ARTIFACTS.includes(m))
  assert.equal(genuine.length, 19, 'the issue reported 21 matches, two of which are artifacts')

  // Extractable: every genuine entry is still a token of the restricted message.
  assert.deepEqual(
    genuine.filter((m) => !origin.tokens.includes(m)),
    [],
    'a genuine entry stopped being extracted',
  )
  assert.deepEqual(
    ARTIFACTS.filter((m) => origin.tokens.includes(m)),
    [],
    'an extraction artifact survived',
  )

  // Matchable: and every genuine entry still comes back through `detectConflict` itself,
  // not merely out of the token set. Driven with an OPPOSED instruction naming all 21
  // terms, because the aligned relay is suppressed and would report no matches at all --
  // which would prove nothing about whether the terms can still be matched.
  const opposed =
    'Restore src/thread/access/ops.py: re-add confluence_spaces, jira_projects, figma_files, ' +
    'atlassian_site and AHA_DOMAIN to render_status, put back the operator-pasted allow-listed ' +
    'token-shaped basic-auth values on aha_domain/products, v1/ops/status, env/config and ' +
    'dt-access, and stop returning booleans/counts.'
  const conflict = detectConflict(opposed, [origin])
  assert.ok(conflict, 'an opposed instruction naming all of it must still pause')
  assert.deepEqual([...conflict.matched].sort(), [...genuine].sort())
})

test('a slashed prose pair is not a path, and contributes no token (#157)', () => {
  const t = extractTokens(FINDING)

  // The finding names real identifiers, and those are correct to keep. Asserted first so a
  // fix that simply stops extracting is not mistaken for a fix.
  assert.ok(t.includes('src/thread/access/ops.py'), 'a real path is still a token')
  assert.ok(t.includes('render_status'), 'a real identifier is still a token')

  // `booleans/counts` is English with a slash in it. The path rule cannot tell it from
  // `v1/ops/status`, so it becomes a token and then donates its basename as a second one.
  assert.ok(!t.includes('booleans/counts'), 'prose with a slash is not a path')
  assert.ok(
    !t.includes('counts'),
    'and must not contribute a bare word — `counts` identifies nothing in this repository',
  )
})

test('`and/or` is the same defect, and its basename evades the length floor (#157)', () => {
  // A second instance, minimal, because the first could be read as being about this one
  // finding. Any prose pair joined by a slash does this.
  const t = extractTokens('Report the flag as present and/or absent, not as a raw string.')
  assert.ok(!t.includes('and/or'), 'prose with a slash is not a path')

  // `and` is on the noise list and `or` is below the three-character floor -- but the
  // basename pass adds `base(p)` directly to the kept set, bypassing both filters that
  // `add()` applies to every other token.
  assert.ok(!t.includes('or'), 'a two-character basename must not bypass the length floor')
})

test('relaying a removal-shaped finding does not pause, extraction artifact or not (#157)', () => {
  // The decision rule, isolated from the extraction rule. The token set here is the live
  // one with `booleans/counts` and `counts` removed, so every remaining token is a genuine,
  // correctly-extracted identifier and the quiet cannot be credited to the fix above.
  const origin = originOf(restricted(FINDING))
  const artifacts = new Set(['booleans/counts', 'counts'])
  origin.tokens = origin.tokens.filter((tok) => !artifacts.has(tok))
  // Kept as a belt-and-braces filter: the test above makes it a no-op, and it keeps this
  // test's subject independent of that one if the extraction rule ever regresses.
  assert.ok(origin.tokens.includes('ops.py'), 'the genuine tokens are still present')
  assert.ok(origin.tokens.includes('status'))
  assert.ok(origin.tokens.includes('render_status'))
  assert.ok(origin.tokens.includes('confluence_spaces'))
  assert.ok(origin.tokens.length >= 10, 'and the overlap is substantial, not incidental')

  // The advisor is carrying the human's own instruction to the implementer. The overlap is
  // high *because* it is a faithful relay, and the verb is a removal *because* the remedy
  // is one. Both halves of the detector fire on the evidence that it is propagation.
  const conflict = detectConflict(RELAYED, [origin])
  assert.equal(
    conflict,
    undefined,
    `relaying a restricted finding is not reversing it; matched: ${conflict?.matched.join(', ')} (verb: ${conflict?.verb})`,
  )
})

// --- neither half of the propagation test may suppress on its own ---------------------

test('a marked path still has its basename filtered by the length floor (#157)', () => {
  // The basename pass is what donated `counts`, and marking is the one route into it that
  // the slash gate cannot close: a backticked span is a token whatever it looks like, so its
  // basename reaches the floor on its own. `io` is two characters, under the same floor
  // `detectConflict` and `attributable` both apply, and must not become a token.
  const t = extractTokens('The `src/relay/io` shim is wrong.')
  assert.ok(t.includes('src/relay/io'), 'the marked path itself is kept')
  assert.ok(!t.includes('io'), 'its two-character basename is not')

  // Three characters is enough, and is the boundary -- the same one stated in authority.test.ts.
  assert.ok(extractTokens('The `src/relay/api` shim is wrong.').includes('api'))
})

test('sparse overlap stays a conflict even when the directions agree (#157)', () => {
  // The share is 1.0 -- every token the origin has is matched -- and both texts are removal
  // shaped. It still pauses, because one shared identifier is a coincidence rather than a
  // quotation, and a share floor alone cannot say that about a one-token origin.
  const origin = originOf(restricted('Do not emit render_status any more.'))
  assert.deepEqual(origin.tokens, ['render_status'], 'a single-token origin is the sharp case')

  const conflict = detectConflict('Delete render_status.', [origin])
  assert.ok(conflict, 'agreement in direction cannot substitute for containment')
  assert.deepEqual(conflict.matched, ['render_status'])
})

test('three aligned matches below the share floor still pause (#157)', () => {
  // The count floor and the share floor are independent, and this is the case only the share
  // floor catches: the count is exactly at its minimum, both texts are unambiguously
  // removal-shaped, and the instruction still touches well under half the message. Quoting
  // three names out of eight is not relaying the message, it is mentioning part of it.
  const origin = originOf(
    restricted(
      'Do not emit `alpha_one`, `beta_two`, `gamma_three`, `delta_four`, `epsilon_five`, ' +
        '`zeta_six`, `eta_seven` or `theta_eight` from the payload.',
    ),
  )
  assert.equal(origin.tokens.length, 8, 'eight tokens, so three of them is 0.375')

  const conflict = detectConflict('Delete alpha_one, beta_two and gamma_three.', [origin])
  assert.ok(conflict, 'three matches is enough to count and not enough to contain')
  assert.equal(conflict.matched.length, 3, 'the count floor was satisfied')
  assert.ok(conflict.matched.length / origin.tokens.length < 0.5, 'and the share floor was not')
})

test('an attributed artifact in the overlap vetoes suppression (#157)', () => {
  // Suppression is about prose quoting prose. An ARTIFACT is different in kind: a path the
  // restricted work is shown to have put in the tree. An instruction removing one is undoing
  // something that actually happened, however faithfully the rest of it relays the finding --
  // so this is the #157 case, otherwise suppressed, with one attributed file added.
  const origin = originOf(restricted(FINDING))
  assert.equal(detectConflict(RELAYED, [origin]), undefined, 'suppressed on prose alone')

  origin.artifacts.push('src/thread/access/scopes_view.py')
  const conflict = detectConflict(
    `${RELAYED} Also delete src/thread/access/scopes_view.py, which was added for this.`,
    [origin],
  )
  assert.ok(conflict, 'a matched artifact must veto suppression')
  assert.ok(
    conflict.matched.includes('src/thread/access/scopes_view.py'),
    'and the artifact is named in the match list the human reads',
  )
  // The prose half is unchanged: containment is still high and the directions still align.
  assert.ok(conflict.matched.length > 15, 'the overlap really was substantial')
})

test('a mixed restricted message never aligns: deleting what it asked to keep pauses (#157)', () => {
  // The false-negative the propagation rule opens if direction is read from the prohibition
  // alone. This message says two things: keep three named fields, and separately stop
  // emitting a fourth. An advisor deleting the KEPT fields quotes the message heavily and
  // uses a removal verb -- the exact signature propagation suppresses -- while reversing the
  // half of the message that was additive.
  const origin = originOf(
    restricted(
      'Keep `render_status` returning confluence_spaces, jira_projects and figma_files — the dashboard ' +
        'needs all three, and add atlassian_site alongside them. But do not emit `raw_token` anywhere in ' +
        'that payload.',
    ),
  )
  const conflict = detectConflict(
    'Delete confluence_spaces, jira_projects, figma_files and atlassian_site from render_status.',
    [origin],
  )
  assert.ok(conflict, 'an additive directive in the origin must prevent suppression')
  assert.equal(conflict.verb.toLowerCase(), 'delete')
  // Both halves of the propagation test are otherwise satisfied, which is what makes this
  // the sharp case: high containment, and removal language present on both sides.
  assert.ok(conflict.matched.length >= 4, 'containment was high')
  assert.ok(/do not emit/i.test(origin.text), 'and the origin does carry removal language')
})

test('high overlap stays a conflict when the directions oppose (#157)', () => {
  // The advisor reproduces almost the whole restricted message -- and asks for the opposite
  // of it. Containment alone would read that as a relay; it is the clearest possible
  // reversal, and it is exactly what the guard exists to catch.
  const origin = originOf(
    restricted(
      'Delete the legacy shim at `src/compat.ts`, and drop confluence_spaces, jira_projects and ' +
        'figma_files from `render_status`.',
    ),
  )
  const conflict = detectConflict(
    'Restore src/compat.ts and re-add confluence_spaces, jira_projects and figma_files to ' +
      'render_status — removing them broke the build.',
    [origin],
  )
  assert.ok(conflict, 'containment cannot substitute for agreement in direction')
  assert.equal(conflict.verb.toLowerCase(), 'restore')
  assert.ok(conflict.matched.length >= 4, 'and the overlap really was high')
})

test('the real reversal is still caught, and a fix may not buy quiet by disarming it', () => {
  // The case the whole mechanism exists for, from the live pause run. It must survive any
  // change made for #157 -- a false negative here leaves the implementer deciding alone.
  const origin = originOf(
    restricted('Without reading any file, tell me the word you chose earlier, then write it into two.txt.'),
  )
  const conflict = detectConflict('Remove two.txt, leave one.txt unchanged, and wait.', [origin])
  assert.ok(conflict, 'a genuine reversal must still pause')
  assert.equal(conflict.verb.toLowerCase(), 'remove')
  assert.deepEqual(conflict.matched, ['two.txt'])
})
