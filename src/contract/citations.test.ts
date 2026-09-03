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
 * `docs/**` is deliberately out of scope for frozen design records, which carry ~150 more
 * citations, most of them bare filenames (`relay.ts:1818`) that no root resolves. Sections
 * marked `## LIVE:` are now scanned because they assert current fact and their citations must
 * not rot silently; the frozen records around them stay as they are.
 *
 * The registry and the scanner live in `citations.ts`, because `scripts/fix-citations.ts` needs
 * both and a second copy of a parser is the failure `439cf05` is about. What stays here is the
 * proving: the guard, and the fixtures the guard is proven against.
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'
import {
  CITED,
  DOCS_ROOTS,
  NOT_CITATIONS,
  REGISTRY_FILE,
  REPO,
  allCitations,
  applyRepairs,
  citationFault,
  citationSites,
  citationsInLine,
  docsLiveClaimCitations,
  exemptKey,
  faultsAfterRepair,
  planPairedRepairs,
  planRepairs,
  repairDocsText,
  staleSpellings,
  relocate,
  weakPins,
  repairLine,
  SOURCE_ROOTS,
  sourceFiles,
  type Found,
} from './citations.ts'
import { runFixer, type FixerOutput } from '../../scripts/fix-citations.ts'

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

test('the scanner only enforces citations inside docs `## LIVE:` sections', (t) => {
  // Frozen design records in docs/** are intentionally out of scope. The guard must still catch
  // live claims, which are marked by a `## LIVE:` heading and end at the next sibling `## `.
  const root = tempDir(t, 'conclave-citations-docs')
  const docs = join(root, 'docs')
  mkdirSync(docs)
  const liveFile = join(docs, 'live.md')
  writeFileSync(
    liveFile,
    [
      '# Frozen document',
      '',
      '## Frozen: a section that is not live',
      'This is a frozen claim `src/relay/relay.ts:1`.',
      '',
      '## LIVE: a section that asserts current fact',
      'This is a live claim `src/relay/relay.ts:2`.',
      '',
      '### A subsection does not exit the live section',
      'Still live, so `src/relay/relay.ts:3` is enforced too.',
      '',
      '## Another frozen section',
      'Not live again `src/relay/relay.ts:4`.',
      '',
    ].join('\n'),
  )

  const found = docsLiveClaimCitations(root)
    .filter((c) => c.at.startsWith('docs/live.md'))
    .sort((a, b) => a.start - b.start)
  assert.deepEqual(
    found.map((c) => ({ cite: c.cite, at: c.at })),
    [
      { cite: 'src/relay/relay.ts:2', at: 'docs/live.md:7' },
      { cite: 'src/relay/relay.ts:3', at: 'docs/live.md:10' },
    ],
    'only the live section and its subsection are returned',
  )
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

test('both ways a citation rots are caught, against a tree written for the purpose', (t) => {
  // A fixture tree rather than an edit to a real source. The alternative -- break a file, run,
  // put it back -- proves the same thing once, in a session nobody else can see, and leaves the
  // repository one interrupted run away from carrying the damage. This runs on every `npm test`.
  const root = tempDir(t, 'conclave-citations')
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
  //
  // And a range does NOT get told where it went, which is the honest answer. The token sat
  // somewhere inside the range and the current file cannot say where, so several windows of
  // the cited width contain it and each implies a different shift. Anchoring the token to the
  // range's first line was the obvious guess; it re-frames the range around the token and
  // reports a shift one or two lines off the one the file actually took. `planRepairs` settles
  // these from the shift its unambiguous neighbours measured, which is evidence rather than a
  // preference between equally good guesses.
  assert.equal(
    citationFault('moved.ts:1-2', 'export const third = 3', root),
    'moved.ts:1-2: expected "export const third = 3", found "export const first = 1\\nexport const second = 2"' +
      ' — the token is inside 2 windows of the cited width, so its offset in the range is not' +
      ' recoverable from the file alone',
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
})

test('a token that is gone, or no longer unique, is refused rather than relocated', (t) => {
  // The whole safety argument for having a repair tool. Relocation is only ever inferred from a
  // token that appears EXACTLY once: zero means the cited thing is gone, and more than one means
  // the pin was never a pin. Both are the cases the guard exists to raise, and a tool that
  // guessed at either would launder real rot into a green build.
  const root = tempDir(t, 'conclave-citations-refuse')
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
})

test('a token that spans lines is found, and counted, like any other', (t) => {
  // The blind spot that shipped. `relocate` and `weakPins` both searched line by line, and no
  // single line contains a multi-line token — so both silently treated one as ZERO occurrences.
  //
  // It failed in both directions at once, which is why nothing caught it. `relocate` announced
  // "the token appears nowhere in the file, so the cited thing is gone" about a token plainly
  // sitting there. `weakPins` read zero, zero is not `> 1`, and it therefore certified as a
  // perfect pin exactly the entries it could not see.
  //
  // And the entries it could not see were the ones created BY strengthening the weakest pins:
  // when a token has an identical twin, widening the citation to a range whose distinguishing
  // text spans two lines is the fix. Two of this repo's own citations are that shape.
  const root = tempDir(t, 'conclave-citations-span')
  const span = 'const start = {\n  key: 1,'
  writeFileSync(
    join(root, 'span.ts'),
    ['// header', 'const start = {', '  key: 1,', '}', ''].join('\n'),
  )

  // Found, at the line it STARTS on, and reported as the single occurrence it is.
  const moved = relocate('span.ts:1-2', span, root)
  assert.equal(moved.to, 'span.ts:2-3', 'the range moves as a block onto the token')
  assert.deepEqual(moved.lines, [2], 'reported at the line the token starts on')
  assert.equal(citationFault('span.ts:2-3', span, root), undefined)
  assert.deepEqual(weakPins({ 'span.ts:2-3': span }, root), [], 'one occurrence is not weak')

  // A citation NARROWER than its own token has no answer, and saying so is right rather than a
  // gap: one line cannot contain two, so there is nothing to relocate onto. The old code
  // reached the same refusal by a different route — it could not see the token anywhere — and
  // the distinction matters, because that route also refused the satisfiable case above.
  const tooNarrow = relocate('span.ts:1', span, root)
  assert.equal(tooNarrow.to, undefined)
  assert.match(tooNarrow.why, /no window of the cited width contains it/)
  assert.deepEqual(tooNarrow.lines, [2], 'the token was still FOUND; only the width is wrong')

  // Twice over, and it is a weak pin like any other rather than an invisible one.
  writeFileSync(
    join(root, 'twice.ts'),
    ['const start = {', '  key: 1,', '}', 'const start = {', '  key: 1,', '}', ''].join('\n'),
  )
  assert.deepEqual(weakPins({ 'twice.ts:1-2': span }, root), [{ cite: 'twice.ts:1-2', hits: 2 }])
  const ambiguous = relocate('twice.ts:5-6', span, root)
  assert.equal(ambiguous.to, undefined, 'two occurrences cannot be told apart')
  assert.deepEqual(ambiguous.lines, [1, 4])
})

test('a weak pin is relocated by the shift its neighbours measured, or not at all', (t) => {
  // The pass that made this tool worth having. Eight of the repo's thirty-eight tokens are not
  // unique in their file, and on the first run against a real edit the tool repaired eleven
  // citations and refused three of them -- which would have left me finishing the job by hand,
  // which is the entire thing it exists to stop.
  //
  // A weak pin cannot say where it went. But it did not move on its own: an insertion shifts
  // everything below it by the SAME amount, and the citations that DO pin uniquely have already
  // measured that shift. So the file lends its consensus to the ones that cannot speak, and the
  // answer is only taken if it lands on a line that actually holds the token.
  const root = tempDir(t, 'conclave-citations-shift')
  const cited = { 'shift.ts:3': 'const b = 3', 'shift.ts:5': 'dup()' }
  const body = ['const a = 1', 'dup()', 'const b = 3', 'filler', 'dup()', '']

  // Correct to begin with, so what follows is caused by the edit and not by the fixture.
  writeFileSync(join(root, 'shift.ts'), body.join('\n'))
  assert.deepEqual(planRepairs(cited, root), { repairs: [], refused: [] })

  // One line inserted at the top: everything below shifts by exactly one.
  writeFileSync(join(root, 'shift.ts'), ['// inserted', ...body].join('\n'))
  const plan = planRepairs(cited, root)
  assert.deepEqual(plan.refused, [])
  assert.deepEqual(plan.repairs, [
    // Pass one. Unique token, so it needs nothing but itself -- and it is what measures +1.
    { from: 'shift.ts:3', to: 'shift.ts:4', expected: 'const b = 3' },
    // Pass two. `dup()` is on lines 3 and 6 and cannot choose; +1 picks 6, which is one of
    // them, so it is taken. Note the order: repairs come out in the order they were settled,
    // not in the order they were declared.
    { from: 'shift.ts:5', to: 'shift.ts:6', expected: 'dup()' },
  ])

  // And alone, with nothing to measure the shift from, the same citation is refused rather
  // than guessed at. This is the assertion that keeps pass two evidence rather than a
  // preference: strip the neighbour and the answer disappears with it.
  const lonely = planRepairs({ 'shift.ts:5': 'dup()' }, root)
  assert.deepEqual(lonely.repairs, [])
  assert.equal(lonely.refused.length, 1)
  assert.match(lonely.refused[0]!.why, /no citation in its file relocated on its own evidence/)
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

test('every declared token is a pin on its own, so nothing needs a neighbour to be found', () => {
  // Not `planRepairs().refused`, which was the first thing written here and proves nothing: on a
  // tree with no faults there is nothing to relocate, so it asserts an empty list against an
  // empty list forever. This asks the question that has an answer whether or not anything has
  // rotted -- is each declared token unique in the file it points into?
  //
  // Eight of thirty-eight are not, and only one of them said so. A duplicate token is still a
  // guard: the cited line either says the thing or it does not. It is weaker in one specific
  // way, and the way is worth naming rather than discovering -- a shift of exactly the distance
  // between two occurrences moves the citation onto the other one and passes. `planRepairs`
  // covers the repair side by taking the shift its unambiguous neighbours measured; nothing
  // covers this side, so the list is pinned and a NINTH has to be argued for.
  // Eight of the thirty-eight were not, when this was first asked. All eight are now, and the
  // list is empty rather than an allowlist -- which is a much stronger thing to assert and was
  // only affordable because asking the question at all showed how few there were.
  //
  // Three needed nothing but a better token: the LINES differed and the declared token was the
  // substring they had in common. The other five had a genuine twin -- `cwd: process.cwd(),`
  // appears five times in `conclave.ts` and nothing on that line can tell them apart -- so the
  // citation was widened to a range that includes something distinguishing. Widening is a
  // judgement about what the claim rests on, which is why the repair tool does not do it.
  assert.deepEqual(
    weakPins().map((w) => w.cite),
    [],
    'A declared token that matches more than one line is a weaker pin than it looks: only a ' +
      'shift of exactly the distance between two occurrences slips past it, and it cannot be ' +
      'relocated on its own evidence. Narrow the token, or widen the citation to a range that ' +
      'contains something unique.',
  )
})

test('an undeclared citation is reported, and an exemption covers only where it was granted', () => {
  // The bypass half, on synthetic input. `allCitations()` is what the real test feeds this
  // filter; the filter itself is what decides whether a new citation can slip through.
  const found: Found[] = [
    // A DECLARED citation, so the filter drops it. It has to be one that is really in `CITED`,
    // which means it moves when that entry moves -- this file is in `SELF` and so is not
    // rewritten by `npm run citations:fix`, and a fixture pointing at a line the table no
    // longer declares would make this test fail for a reason that has nothing to do with the
    // filter it is about.
    { cite: 'src/relay/run.ts:52', path: 'src/relay/run.ts', start: 52, end: 52, at: 'src/relay/x.ts:7' },
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

/**
 * A tree written for the purpose, with the four kinds of place a citation lives: the table that
 * declares it, the prose that cites it, a `## LIVE:` docs section that claims it, and a frozen
 * docs section that merely records it. Everything below is proven against one of these rather
 * than against the repository, because the repository is green and the failures being proven are
 * what happens when it is not.
 */
const withTree = (t: TestContext, files: Record<string, string>, fn: (root: string) => void): void => {
  const root = tempDir(t, 'conclave-citations-pair')
  // Every configured root, whether or not this fixture puts a file in it. The scanner refuses
  // to read a missing one as an empty one -- see `walkRoot` -- so a fixture without `bin/` is
  // not a smaller tree, it is a tree the scanner would not run on, and creating them here is
  // what keeps these fixtures the same shape as the repository they stand in for.
  for (const dir of [...SOURCE_ROOTS, ...DOCS_ROOTS]) mkdirSync(join(root, dir), { recursive: true })
  for (const [file, text] of Object.entries(files)) {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  fn(root)
}

/** The cited file, with its token three lines below where the table still says it is. */
const SHIFTED_THING = [
  '// A helper whose declaration used to be on line 2.',
  '//',
  '//',
  '//',
  'export function thing(): void {}',
  '',
].join('\n')

test('a repair moves the declaration, the prose and the live docs claim together', (t) => {
  // #170. Before this, `citations:fix` repaired CITED and the sources and never looked at
  // `docs/**` at all, so a pair whose docs half was brought into scope by #164 came out half
  // done -- and the tree went from a failure the tool could finish to one only a human could,
  // while the tool printed success.
  const registry = [
    'export const CITED: Record<string, string> = {',
    "  'src/thing.ts:2': 'export function thing(',",
    '}',
    '',
  ].join('\n')
  const notes = [
    '# Notes',
    '',
    '## Frozen: what was true when this was recorded',
    'The helper was at `src/thing.ts:2` when this was written, and that is the point of it.',
    '',
    '## LIVE: what is true now',
    '`thing` is declared at `src/thing.ts:2`, and once more as `:2` in the continued form.',
    '',
  ].join('\n')
  withTree(
    t,
    {
      [REGISTRY_FILE]: registry,
      'src/thing.ts': SHIFTED_THING,
      'src/other.ts': '// The claim rests on `src/thing.ts:2` and on nothing else.\n',
      'docs/NOTES.md': notes,
    },
    (root) => {
      const cited = { 'src/thing.ts:2': 'export function thing(' }
      const plan = planPairedRepairs(cited, root)
      assert.deepEqual(
        plan.repairs.map((r) => `${r.from} -> ${r.to}`),
        ['src/thing.ts:2 -> src/thing.ts:5'],
      )
      assert.deepEqual(plan.refused, [])

      // Planning writes nothing. `--check` is this call and no more, which is what makes the
      // flag safe to trust rather than a second code path that has to be kept honest.
      assert.equal(readFileSync(join(root, 'docs/NOTES.md'), 'utf8'), notes)
      assert.equal(readFileSync(join(root, REGISTRY_FILE), 'utf8'), registry)

      assert.deepEqual(applyRepairs(plan.writes, root), [
        'docs/NOTES.md',
        REGISTRY_FILE,
        'src/other.ts',
      ])
      const read = (f: string): string => readFileSync(join(root, f), 'utf8')
      assert.ok(read(REGISTRY_FILE).includes("'src/thing.ts:5'"), 'the declaration moved')
      assert.ok(read('src/other.ts').includes('src/thing.ts:5'), 'the prose moved')

      const docs = read('docs/NOTES.md').split('\n')
      assert.equal(
        docs[6],
        '`thing` is declared at `src/thing.ts:5`, and once more as `:5` in the continued form.',
        'the live claim moved, and the continued form stayed continued',
      )
      // The frozen half, byte for byte. It is a record of what was true when it was written, the
      // guard does not check it, and renumbering it would be editing the evidence rather than
      // the claim.
      assert.equal(
        docs[3],
        'The helper was at `src/thing.ts:2` when this was written, and that is the point of it.',
        'the frozen section is untouched',
      )

      const by = new Map(plan.repairs.map((r) => [r.from, r.to]))
      assert.deepEqual(staleSpellings(by, root), [], 'no half of the pair is left behind')
      assert.deepEqual(
        Object.entries({ 'src/thing.ts:5': 'export function thing(' })
          .map(([c, e]) => citationFault(c, e, root))
          .filter((f) => f !== undefined),
        [],
        'and the repaired citation verifies against the tree it was written into',
      )
    },
  )
})

/**
 * A registry that writes one citation twice: once as the declaration, once inside an exemption
 * granted for text that merely looks like it. Both are real shapes -- `NOT_CITATIONS` keys carry
 * a citation spelling today -- and a rewriter cannot tell which is the claim.
 */
const AMBIGUOUS_REGISTRY = [
  'export const CITED: Record<string, string> = {',
  "  'src/thing.ts:2': 'export function thing(',",
  "  'src/other.ts:2': 'export function other(',",
  "  'src/thing.ts:1': 'a token that was deleted',",
  '}',
  '',
  'export const NOT_CITATIONS: Record<string, string> = {',
  "  'src/demo.ts|src/thing.ts:2': 'sample prose in a fixture, not a claim about this tree',",
  '}',
  '',
].join('\n')

const PAIR_TREE = {
  [REGISTRY_FILE]: AMBIGUOUS_REGISTRY,
  'src/thing.ts': SHIFTED_THING,
  'src/other.ts': SHIFTED_THING.replace('thing', 'other').replace('thing', 'other'),
  'docs/THING.md': ['# Thing', '', '## LIVE: now', 'It is at `src/thing.ts:2`.', ''].join('\n'),
  'docs/OTHER.md': ['# Other', '', '## LIVE: now', 'It is at `src/other.ts:2`.', ''].join('\n'),
}

const PAIR_TABLE = {
  'src/thing.ts:2': 'export function thing(',
  'src/other.ts:2': 'export function other(',
  'src/thing.ts:1': 'a token that was deleted',
}

test('a pair that cannot be rewritten whole is declined by name, and neither side of it moves', (t) => {
  withTree(t, PAIR_TREE, (root) => {
    const plan = planPairedRepairs(PAIR_TABLE, root)

    assert.deepEqual(
      plan.repairs.map((r) => `${r.from} -> ${r.to}`),
      ['src/other.ts:2 -> src/other.ts:5'],
      'the clean pair is still repaired -- one undecidable citation does not stop the rest',
    )

    const declined = plan.refused.find((r) => r.cite === 'src/thing.ts:2')
    assert.ok(declined, 'the pair it declined is named')
    assert.match(
      declined.why,
      /writes it on 2 lines \(2, 8\)/,
      'and the reason says which side it could not rewrite, and where',
    )
    // The refusals `planRepairs` already made -- a token that is GONE -- come through unchanged.
    // This narrows what is repaired; it does not widen it, and range behaviour is untouched.
    assert.ok(
      plan.refused.some((r) => r.cite === 'src/thing.ts:1' && r.why.includes('appears nowhere')),
      'the pre-existing refusals still arrive',
    )

    // `src/other.ts` is absent because nothing in it cites anything: a pair is the declaration
    // and whatever prose and live claims exist, which here is one docs section and no comment.
    assert.deepEqual([...plan.writes.keys()].sort(), ['docs/OTHER.md', REGISTRY_FILE])
    applyRepairs(plan.writes, root)

    assert.equal(
      readFileSync(join(root, 'docs/THING.md'), 'utf8'),
      PAIR_TREE['docs/THING.md'],
      'the declined pair leaves its live docs claim byte for byte unchanged',
    )
    const registry = readFileSync(join(root, REGISTRY_FILE), 'utf8').split('\n')
    assert.equal(registry[1], "  'src/thing.ts:2': 'export function thing(',", 'and its declaration')
    assert.equal(registry[7], "  'src/demo.ts|src/thing.ts:2': 'sample prose in a fixture, not a claim about this tree',")
    assert.equal(registry[2], "  'src/other.ts:5': 'export function other(',", 'while the clean pair moved')

    // And what the run REPORTS afterwards. A refused citation is still faulted once the run is
    // over -- that is what refusing it means -- so counting it as a repair that failed to verify
    // says "the tree has been changed, review it" over repairs that were all correct, and buries
    // the line naming the pair a human has to look at.
    const by = new Map(plan.repairs.map((r) => [r.from, r.to]))
    const after = faultsAfterRepair(by, plan.faulted, PAIR_TABLE, root)
    assert.deepEqual(after.broken, [], 'nothing the repair wrote is broken')
    assert.deepEqual(after.halfRepaired, [], 'and no half of a pair was left behind')
    assert.deepEqual(
      after.untouched.map((f) => f.slice(0, f.indexOf(':', f.indexOf(':') + 1))).sort(),
      ['src/thing.ts:1', 'src/thing.ts:2'],
      'what remains is exactly what was declined, reported as needing a human',
    )
  })
})

test('a live docs claim is never repaired while its declaration stays stale', (t) => {
  // The reverse of #170, asked structurally rather than hoped for. The docs half of the declined
  // pair is perfectly rewritable ON ITS OWN -- proven here by rewriting it -- and the fixer still
  // does not write it, because the plan is per PAIR and its registry half was refused. There is
  // no path from a rewritable docs claim to a written one that does not carry the declaration
  // with it: every file's new text comes from the same surviving map, computed once, after the
  // declaration check has already removed what it removed.
  withTree(t, PAIR_TREE, (root) => {
    const alone = repairDocsText(
      PAIR_TREE['docs/THING.md'],
      new Map([['src/thing.ts:2', 'src/thing.ts:5']]),
    )
    assert.notEqual(alone, PAIR_TREE['docs/THING.md'], 'the docs half could have been rewritten')

    const plan = planPairedRepairs(PAIR_TABLE, root)
    assert.ok(!plan.writes.has('docs/THING.md'), 'and the fixer declines to write it anyway')

    // Nothing accepted is written to docs without its declaration being written too.
    const sites = citationSites(root)
    for (const r of plan.repairs) {
      const where = sites.get(r.from) ?? []
      assert.equal(
        where.filter((s) => s.scope === 'registry').length,
        1,
        `${r.from} is accepted, so exactly one declaration carries it`,
      )
      for (const s of where) {
        assert.ok(plan.writes.has(s.file), `${r.from} is repaired at every side it is written, ${s.file} included`)
      }
    }
  })
})

test('the fixer reaches docs `## LIVE:` claims, and every declaration is written once', () => {
  // Two tripwires on the real tree, both of which the fixture tests above would keep passing if
  // they broke. `docs/**` was brought into the guard by #164 and into the fixer by #170; if the
  // live sections stop being reached, every test above still passes against its own fixture and
  // the repository quietly returns to half repairs.
  const sites = citationSites()
  const paired = Object.keys(CITED).filter((c) =>
    (sites.get(c) ?? []).some((s) => s.scope === 'docs-live'),
  )
  assert.ok(paired.length > 0, 'declared citations are claimed in docs `## LIVE:` sections')

  // And the condition every one of those pairs is repairable UNDER: a declaration the rewriter
  // can find exactly once. A second mention of the same spelling in the registry is legal and
  // will simply be declined by name -- this says nothing has drifted into that state unnoticed.
  assert.deepEqual(
    Object.keys(CITED).filter(
      (c) => (sites.get(c) ?? []).filter((s) => s.scope === 'registry').length !== 1,
    ),
    [],
    `${REGISTRY_FILE} writes some declaration in no place or in more than one. The fixer cannot ` +
      'tell a declaration from data about one, so it will decline those pairs rather than ' +
      'half repair them -- which is safe, and still means they need a human.',
  )
})

/** A run's two streams, collected instead of printed. */
const collect = (): { log: string[]; error: string[]; out: FixerOutput } => {
  const log: string[] = []
  const error: string[] = []
  return { log, error, out: { log: (l) => log.push(l), error: (l) => error.push(l) } }
}

/** Every file of a fixture, still exactly as it was written. */
const assertUnchanged = (root: string, files: Record<string, string>, why: string): void => {
  for (const [file, text] of Object.entries(files)) {
    assert.equal(readFileSync(join(root, file), 'utf8'), text, `${file} ${why}`)
  }
}

/**
 * A tree where the only faulted pair is one the fixer must decline.
 *
 * Separate from the mixed fixture on purpose. There, the registry is rewritten on behalf of the
 * OTHER pair, so "nothing was written" can only be asserted line by line -- true, and weaker than
 * it sounds. Here there is nothing else to repair, so the claim is the whole tree, byte for byte,
 * which is what "or it repairs neither" is supposed to mean.
 */
const DECLINE_ONLY_TREE = {
  [REGISTRY_FILE]: [
    'export const CITED: Record<string, string> = {',
    "  'src/thing.ts:2': 'export function thing(',",
    '}',
    '',
    'export const NOT_CITATIONS: Record<string, string> = {',
    "  'src/demo.ts|src/thing.ts:2': 'sample prose in a fixture, not a claim about this tree',",
    '}',
    '',
  ].join('\n'),
  'src/thing.ts': SHIFTED_THING,
  'src/prose.ts': '// The claim rests on `src/thing.ts:2` and on nothing else.\n',
  'docs/THING.md': ['# Thing', '', '## LIVE: now', 'It is at `src/thing.ts:2`.', ''].join('\n'),
}

const DECLINE_ONLY_TABLE = { 'src/thing.ts:2': 'export function thing(' }

test('a declined pair leaves the whole tree byte for byte, and says which pair it declined', (t) => {
  withTree(t, DECLINE_ONLY_TREE, (root) => {
    // Planning first, then the command, because they are different claims: the plan proposes no
    // writes, and the command -- which is what an operator actually runs -- makes none.
    const plan = planPairedRepairs(DECLINE_ONLY_TABLE, root)
    assert.deepEqual(plan.repairs, [], 'nothing is accepted')
    assert.deepEqual([...plan.writes.keys()], [], 'so there is nothing to write')
    assert.deepEqual(
      plan.refused.map((r) => r.cite),
      ['src/thing.ts:2'],
      'and the pair it declined is named',
    )

    const run = collect()
    assert.equal(runFixer([], run.out, DECLINE_ONLY_TABLE, root), 1, 'the run needs a human')
    assertUnchanged(root, DECLINE_ONLY_TREE, 'was written by a run that repaired nothing')

    assert.ok(
      run.log.some((l) => l.startsWith('  REFUSED src/thing.ts:2:') && l.includes('2 lines (2, 6)')),
      `the refusal names the pair and where it could not rewrite it: ${JSON.stringify(run.log)}`,
    )
    assert.ok(
      run.error.some((l) => l.includes('1 refused above and still need a human')),
      'and the run ends saying so, rather than claiming a repair failed to verify',
    )
    assert.ok(
      !run.log.some((l) => l.startsWith('citations: repaired')),
      'nothing is reported as repaired',
    )
  })
})

test('--check writes nothing and exits on what it WOULD have done', (t) => {
  // The flag's whole contract, asserted through the command rather than around it. Testing the
  // planner and calling that `--check` proves that nothing wrote because nothing was asked to,
  // which is the reasoning rather than the behaviour.
  const clean = {
    [REGISTRY_FILE]: [
      'export const CITED: Record<string, string> = {',
      "  'src/thing.ts:2': 'export function thing(',",
      '}',
      '',
    ].join('\n'),
    'src/thing.ts': SHIFTED_THING,
    'docs/THING.md': ['# Thing', '', '## LIVE: now', 'It is at `src/thing.ts:2`.', ''].join('\n'),
  }
  withTree(t, clean, (root) => {
    const run = collect()
    assert.equal(runFixer(['--check'], run.out, DECLINE_ONLY_TABLE, root), 0, 'nothing refused, so 0')
    assertUnchanged(root, clean, 'was written by --check')
    assert.deepEqual(
      run.log.filter((l) => l.startsWith('  would write')).sort(),
      ['  would write docs/THING.md', `  would write ${REGISTRY_FILE}`],
      'and it says which files it would have written, docs included',
    )
    assert.ok(run.log.some((l) => l.includes('1 would be repaired across 2 files, 0 refused (nothing written)')))

    // The same tree, actually repaired, so the exit code above is a statement about a run that
    // would have done something rather than about an empty plan.
    assert.equal(runFixer([], collect().out, DECLINE_ONLY_TABLE, root), 0)
    assert.ok(readFileSync(join(root, 'docs/THING.md'), 'utf8').includes('src/thing.ts:5'))
  })

  withTree(t, DECLINE_ONLY_TREE, (root) => {
    const run = collect()
    assert.equal(runFixer(['--check'], run.out, DECLINE_ONLY_TABLE, root), 1, 'a refusal exits 1')
    assertUnchanged(root, DECLINE_ONLY_TREE, 'was written by --check over a refusal')
    assert.ok(run.log.some((l) => l.includes('0 would be repaired across 0 files, 1 refused (nothing written)')))
  })
})

test('the command line runs the same function this file tests', () => {
  // The two lines `runFixer` does not cover: argv reaching it, and its return value becoming the
  // process's exit code. Run against this repository, which is green, so it asserts the quiet
  // path -- the one every other invocation of `npm run citations:fix` takes.
  const ran = spawnSync(process.execPath, ['scripts/fix-citations.ts', '--check'], {
    cwd: REPO,
    encoding: 'utf8',
  })
  assert.equal(ran.status, 0, `citations:fix --check failed: ${ran.stdout}${ran.stderr}`)
  assert.match(ran.stdout, /^citations: /m, 'and it reported through the same lines')
})

test('a configured scan root that is not there is raised, not read as an empty one', (t) => {
  // The failure this shape invites, and the reason it is worth a test of its own: an unreadable
  // root makes every guard over it pass. `docs/**` came into scope with #164 and is the newest
  // and least load-bearing-looking of them, so a `docs` that had been renamed or not checked out
  // would report zero live claims, take the two-way pin over them with it, and look like a clean
  // run. Nothing downstream can tell that apart from a tree with no live claims in it.
  const root = tempDir(t, 'conclave-citations-roots')
  for (const dir of [...SOURCE_ROOTS, ...DOCS_ROOTS]) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(
    join(root, 'docs/LIVE.md'),
    ['# Doc', '', '## LIVE: now', 'It is at `src/thing.ts:2`.', ''].join('\n'),
  )
  assert.equal(docsLiveClaimCitations(root).length, 1, 'the tree it is about does have a live claim')

  for (const dir of DOCS_ROOTS) rmSync(join(root, dir), { recursive: true, force: true })
  assert.throws(
    () => docsLiveClaimCitations(root),
    /'docs' is a configured scan root and could not be read/,
    'a missing docs root is raised rather than reported as no live claims',
  )
  // And through the fixer, because that is what would act on the emptiness.
  assert.throws(() => planPairedRepairs({}, root), /configured scan root/)

  // The same for the source roots, whose absence takes the found-must-be-declared half with it.
  mkdirSync(join(root, 'docs'))
  rmSync(join(root, SOURCE_ROOTS[1]!), { recursive: true, force: true })
  assert.throws(
    () => allCitations(root),
    new RegExp(`'${SOURCE_ROOTS[1]}' is a configured scan root`),
    'and a missing source root is not zero citations either',
  )
})
