/**
 * `path:line` citations are checked, or they are not citations.
 *
 *   node --test src/contract/citations.test.ts
 *
 * Every goal on this branch has required citations for claims about current behaviour, and the
 * discipline works -- it has caught real errors. But a citation is prose in a moving tree: the
 * run that raised #73 invalidated its own citations during the session that wrote them, and
 * roughly six were already stale. The failure is silent, and it degrades exactly the evidence a
 * later reader would use to check something. That is the shape of every other guard on this
 * branch, so it gets the same treatment: rot becomes a test failure.
 *
 * A citation is ENFORCEABLE when it names a repo-root-relative path, a line or line range, and
 * an expected token declared in `CITED`. The token is the tripwire, not the claim: it is
 * whatever short piece of the cited line would have to change for the citation to be pointing
 * somewhere else. A citation that cannot be pinned to a token that specific -- a range covering
 * a whole helper, a nested block of an interface -- belongs in the other form the issue offers,
 * a SYMBOL citation (`#join`, `seats()`, `resolutionFor`), which needs no line to survive.
 *
 * The pin runs both ways, which is the part that keeps it honest:
 *
 *   - Every citation found in the sources must be declared. A new `path:line` written into a
 *     comment fails this test until its author declares what the line says. Without this half,
 *     the guard would check the citations that happened to exist when it was written and let
 *     every later one through -- the silent decay of #73, one level up.
 *   - Every declaration must still be found. A citation repaired into a symbol citation, or
 *     deleted, takes its declaration with it, so `CITED` cannot fill up with entries that pin
 *     nothing.
 *
 * Scanning is over the whole text of each source, not over comment syntax. The densest
 * citations in this repository are in string prose -- the `DECLARED` table in
 * `defaultUnchanged.test.ts` carries five -- and a comment-only scan would leave exactly the
 * most-cited documentation in the tree unenforced. The cost is that fixture data mentioning a
 * `path:line` is caught too; there are two, and they are named in `NOT_CITATIONS` with why.
 *
 * `docs/**` is deliberately out of scope. Those files carry ~150 more citations, most of them
 * bare filenames (`relay.ts:1818`) that no root resolves, and the design records among them are
 * snapshots of a decision rather than claims about today. Enforcing them is a separate piece of
 * work with a separate answer to "what should a frozen document cite".
 *
 * The registry and the scanner live in `citations.ts`, because `scripts/fix-citations.ts` needs
 * both and a second copy of a parser is the failure `439cf05` is about. What stays here is the
 * proving: the guard, and the fixtures the guard is proven against.
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  CITED,
  NOT_CITATIONS,
  REPO,
  allCitations,
  citationFault,
  citationsInLine,
  exemptKey,
  planRepairs,
  relocate,
  repairLine,
  sourceFiles,
  type Found,
} from './citations.ts'

test('every path:line citation in the sources is declared with an expected token', () => {
  const undeclared = allCitations().filter((c) => !(c.cite in CITED) && !(exemptKey(c) in NOT_CITATIONS))
  assert.deepEqual(
    undeclared.map((c) => `${c.at} cites ${c.cite}`),
    [],
    'Each of these is a citation nothing checks. Declare it in CITED with a token the cited ' +
      'line must contain, or -- if no line can be pinned that precisely -- cite the symbol ' +
      'instead and drop the line number. A citation nobody checks is the failure #73 is about.',
  )
})

test('every declared citation still points at what it says it does', () => {
  assert.deepEqual(
    Object.entries(CITED)
      .map(([cite, expected]) => citationFault(cite, expected))
      .filter((f) => f !== undefined),
    [],
    'These citations have rotted. Each message says where the token went, and ' +
      '`npm run citations:fix` repairs the ones that moved cleanly -- in CITED and in the prose ' +
      'together. What it refuses is what actually needs deciding: a token that is GONE, or one ' +
      'that now matches in several places and was therefore never a pin. Keep the citation ' +
      'either way -- a stale citation is evidence that went missing, and deleting it loses the ' +
      'claim as well as the pointer.',
  )
})

test('no declaration or exemption outlives the citation it was written for', () => {
  const found = allCitations()
  const cited = new Set(found.map((c) => c.cite))
  const exempt = new Set(found.map(exemptKey))
  assert.deepEqual(
    Object.keys(CITED).filter((k) => !cited.has(k)),
    [],
    'CITED declares citations that no source makes any more. Remove them: a declaration that ' +
      'pins nothing makes the table look like coverage it is not.',
  )
  assert.deepEqual(
    Object.keys(NOT_CITATIONS).filter((k) => !exempt.has(k)),
    [],
    'NOT_CITATIONS exempts text that is no longer there. Remove the entry, so the next thing ' +
      'to appear at that spelling is checked rather than inheriting a waiver.',
  )
})

test('the registry and its fixtures are not scanned as sources', () => {
  // Both files carry citations as DATA. Either one scanned would satisfy the found-and-declared
  // pin with itself -- every key found in its own table -- and the guard would pass over a tree
  // it had never looked at. Asserted rather than left to `SELF`, because the exclusion moved
  // when the registry did and a silent regression here disables everything above.
  const files = sourceFiles()
  assert.ok(!files.includes('src/contract/citations.ts'), 'the registry is not a source')
  assert.ok(!files.includes('src/contract/citations.test.ts'), 'nor are its fixtures')
  assert.ok(files.includes('src/relay/relay.ts'), 'and the tree it guards still is')
})

test('the scanner sees both citation forms, so neither can be added unnoticed', () => {
  // The guard's own tripwire. Everything above rests on the scanner finding what a future
  // author writes, and the two-way pin passes vacuously if it finds nothing -- so the shapes
  // are asserted against text rather than trusted.
  assert.deepEqual(citationsInLine('// see src/relay/run.ts:51 for the reason'), [
    { path: 'src/relay/run.ts', start: 51, end: 51, text: 'src/relay/run.ts:51' },
  ])
  assert.deepEqual(citationsInLine(' * a range (`bin/conclave.ts:1029-1032`) is one citation'), [
    { path: 'bin/conclave.ts', start: 1029, end: 1032, text: 'bin/conclave.ts:1029-1032' },
  ])
  // The continuation form, and the reason it is worth the regex: two of the three citations on
  // this shape of line carry no path of their own.
  assert.deepEqual(citationsInLine('// src/relay/relay.ts:1653, :1700 and :2885 read it.'), [
    { path: 'src/relay/relay.ts', start: 1653, end: 1653, text: 'src/relay/relay.ts:1653' },
    { path: 'src/relay/relay.ts', start: 1700, end: 1700, text: 'src/relay/relay.ts:1700' },
    { path: 'src/relay/relay.ts', start: 2885, end: 2885, text: 'src/relay/relay.ts:2885' },
  ])
  // A symbol citation is the escape hatch, and it must not be caught: pushing an author towards
  // it is the whole point of the other half of this file.
  assert.deepEqual(citationsInLine(' * `resolutionFor` in `src/relay/resolution.ts` classifies it'), [])
  // An undeclared citation is what the found-must-be-declared test consumes. Proven here on a
  // literal, because a scanner that quietly matched nothing would make that test pass forever.
  const invented = citationsInLine('// a claim about src/relay/relay.ts:100006')
  assert.equal(invented.length, 1)
  assert.ok(!(invented[0]!.text in CITED), 'an invented citation must not already be declared')
})

test('both ways a citation rots are caught, against a tree written for the purpose', () => {
  // A fixture tree rather than an edit to a real source. The alternative -- break a file, run,
  // put it back -- proves the same thing once, in a session nobody else can see, and leaves the
  // repository one interrupted run away from carrying the damage. This runs on every `npm test`.
  const root = mkdtempSync(join(tmpdir(), 'conclave-citations-'))
  try {
    writeFileSync(
      join(root, 'moved.ts'),
      ['export const first = 1', 'export const second = 2', 'export const third = 3', ''].join('\n'),
    )

    // Mode one: the cited line is GONE. The file used to be longer, the citation still names a
    // line past its end, and nothing about reading the prose would tell you.
    assert.equal(
      citationFault('moved.ts:9', 'export const ninth = 9', root),
      'moved.ts:9: the file ends at line 4',
    )
    // The same for a range whose tail has fallen off the end, which is the commoner shape --
    // a block shrinks and the citation keeps the width it was written with.
    assert.equal(
      citationFault('moved.ts:2-9', 'export const second = 2', root),
      'moved.ts:2-9: the file ends at line 4',
    )

    // Mode two, and the one line numbers alone can never catch: the line EXISTS and says
    // something else. Code moved down, the citation kept its number, and it now points at a
    // real line that supports a different claim -- exactly how a reader is misled.
    //
    // The message names where the token went. That sentence is the difference between a repair
    // that is one command and a repair that starts by re-deriving what this function already
    // knows -- which is how four throwaway scripts got written in one session on this branch.
    assert.equal(
      citationFault('moved.ts:1', 'export const second = 2', root),
      'moved.ts:1: expected "export const second = 2", found "export const first = 1"' +
        ' — it is now at moved.ts:2; `npm run citations:fix` repairs this',
    )
    // Range form: the token has to be inside the cited range, not merely in the file.
    assert.equal(
      citationFault('moved.ts:1-2', 'export const third = 3', root),
      'moved.ts:1-2: expected "export const third = 3", found "export const first = 1\\nexport const second = 2"' +
        ' — it is now at moved.ts:3-4; `npm run citations:fix` repairs this',
    )

    // And the true cases, so the two above are not passing because everything fails.
    assert.equal(citationFault('moved.ts:2', 'export const second = 2', root), undefined)
    assert.equal(citationFault('moved.ts:1-3', 'export const third = 3', root), undefined)

    // A path that resolves nowhere is its own fault, and it is what a bare filename citation
    // (`relay.ts:1818`) becomes once someone declares it: the check demands a real root.
    assert.equal(
      citationFault('nested/gone.ts:1', 'anything', root),
      'nested/gone.ts:1: no such file (citations must be repo-root-relative)',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a token that is gone, or no longer unique, is refused rather than relocated', () => {
  // The whole safety argument for having a repair tool. Relocation is only ever inferred from a
  // token that appears EXACTLY once: zero means the cited thing is gone, and more than one means
  // the pin was never a pin. Both are the cases the guard exists to raise, and a tool that
  // guessed at either would launder real rot into a green build.
  const root = mkdtempSync(join(tmpdir(), 'conclave-citations-refuse-'))
  try {
    writeFileSync(
      join(root, 'twice.ts'),
      ['const a = 1', 'const dup = 2', 'const b = 3', 'const dup = 4', ''].join('\n'),
    )

    const gone = relocate('twice.ts:1', 'const vanished = 9', root)
    assert.equal(gone.to, undefined)
    assert.match(gone.why, /appears nowhere/)

    const ambiguous = relocate('twice.ts:1', 'const dup =', root)
    assert.equal(ambiguous.to, undefined)
    assert.match(ambiguous.why, /appears on 2 lines \(2, 4\)/)
    assert.deepEqual(ambiguous.lines, [2, 4])

    // And the plan refuses both, naming each, rather than dropping them silently.
    const plan = planRepairs({ 'twice.ts:1': 'const vanished = 9', 'twice.ts:3': 'const dup =' }, root)
    assert.deepEqual(plan.repairs, [])
    assert.deepEqual(
      plan.refused.map((r) => r.cite),
      ['twice.ts:1', 'twice.ts:3'],
    )

    // The single-match case in the same tree, so the refusals above are not passing because
    // nothing ever relocates.
    const moved = planRepairs({ 'twice.ts:1': 'const b = 3' }, root)
    assert.deepEqual(moved.refused, [])
    assert.deepEqual(moved.repairs, [{ from: 'twice.ts:1', to: 'twice.ts:3', expected: 'const b = 3' }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a repair rewrites the citation it was asked to, in the form it was written in', () => {
  // Spliced by position rather than substituted, and this is the test that says why. A
  // hand-rolled repair reaches for string replacement, and string replacement cannot tell the
  // citation from the identical number next to it -- nor put a continuation back as a
  // continuation, which would grow a path the author deliberately left off.
  const by = new Map([
    ['src/relay/relay.ts:100', 'src/relay/relay.ts:150'],
    ['src/relay/relay.ts:200', 'src/relay/relay.ts:250'],
  ])

  assert.equal(
    repairLine('// see src/relay/relay.ts:100 for the reason', by),
    '// see src/relay/relay.ts:150 for the reason',
  )
  // The continuation keeps its form: `:200`, not the full path.
  assert.equal(
    repairLine('// src/relay/relay.ts:100, :200 and :300 read it.', by),
    '// src/relay/relay.ts:150, :250 and :300 read it.',
  )
  // `:300` above is untouched because it is not in the map -- a citation nobody asked to move
  // must not move.
  //
  // And the number that is not a citation stays put. Substitution would have rewritten `100`
  // here as readily as the citation above it.
  assert.equal(
    repairLine('// a budget of 100 turns, unlike src/relay/relay.ts:100', by),
    '// a budget of 100 turns, unlike src/relay/relay.ts:150',
  )
  // A citation into a DIFFERENT file that happens to share the line number is not the one being
  // repaired, and a path-blind pass would take it.
  assert.equal(repairLine('// src/relay/run.ts:100 is unrelated', by), '// src/relay/run.ts:100 is unrelated')
})

test('the repo has no citation the fixer would refuse', () => {
  // The plan, run against the real tree on every `npm test`. Zero refusals is not the same
  // claim as zero faults: it says that IF something rots, it rots in the shape the tool can
  // repair -- every declared token is still unique in its file. A pin that quietly stopped
  // being unique would otherwise only be discovered by the one person trying to repair it, at
  // the moment they were least equipped to notice.
  const plan = planRepairs()
  assert.deepEqual(
    plan.refused.map((r) => `${r.cite}: ${r.why}`),
    [],
    'These declared tokens are no longer a pin. Narrow the token, or move the claim to a symbol ' +
      'citation -- the repair tool cannot and must not guess at them.',
  )
})

test('an undeclared citation is reported, and an exemption covers only where it was granted', () => {
  // The bypass half, on synthetic input. `allCitations()` is what the real test feeds this
  // filter; the filter itself is what decides whether a new citation can slip through.
  const found: Found[] = [
    { cite: 'src/relay/run.ts:51', path: 'src/relay/run.ts', start: 51, end: 51, at: 'src/relay/x.ts:7' },
    { cite: 'src/relay/relay.ts:214', path: 'src/relay/relay.ts', start: 214, end: 214, at: 'src/repl/demo.ts:48' },
    { cite: 'src/relay/relay.ts:214', path: 'src/relay/relay.ts', start: 214, end: 214, at: 'src/relay/y.ts:9' },
    { cite: 'src/relay/relay.ts:31344', path: 'src/relay/relay.ts', start: 31337, end: 31337, at: 'src/relay/z.ts:3' },
  ]
  assert.deepEqual(
    found.filter((c) => !(c.cite in CITED) && !(exemptKey(c) in NOT_CITATIONS)).map((c) => `${c.at} cites ${c.cite}`),
    [
      // The demo's copy is waived and this one is not, though the text is identical: an
      // exemption is granted to a place, so fixture data cannot license a claim elsewhere.
      'src/relay/y.ts:9 cites src/relay/relay.ts:214',
      'src/relay/z.ts:3 cites src/relay/relay.ts:31344',
    ],
  )
})

test('the fixer is wired into package.json under the name the guard tells you to run', () => {
  // The failure message names `npm run citations:fix`. A message that names a command which
  // does not exist is worse than one that names none -- it spends the reader's trust once and
  // then teaches them to ignore the rest of the sentence.
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  assert.ok(pkg.scripts?.['citations:fix'], 'the guard points at this script by name')
  assert.match(pkg.scripts['citations:fix']!, /fix-citations/)
})
