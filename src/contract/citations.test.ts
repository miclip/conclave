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
 * an expected token declared in `CITED` below. The token is the tripwire, not the claim: it is
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
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'

const REPO = join(import.meta.dirname, '..', '..')

/** Scanned for citations. */
const SOURCE_ROOTS = ['src', 'bin']

/**
 * This file, which declares citations as data and would otherwise satisfy the found-and-declared
 * pin with itself -- every key found in its own table, proving nothing about the tree.
 */
const SELF = 'src/contract/citations.test.ts'

/**
 * What each cited line must still say.
 *
 * Keyed by the citation exactly as it is written in the sources, so one entry covers every place
 * that cites it. Repairing a citation means changing the line number here and in the prose
 * together, which is the point: the two cannot drift apart without this test saying so.
 */
const CITED: Record<string, string> = {
  // The two per-command flag helpers are gone (#81), and with them the four citations that
  // pinned their bodies and the one that pinned `value.startsWith('--')` -- the line recording
  // why the console could not be passed `--model x` through `--implementer-args`. Deleted
  // rather than repaired, and that is the exception rather than the rule here: each was
  // evidence FOR a divergence that no longer exists, so there is nothing left for them to point
  // at. What replaced them is cited by symbol -- `flagReader` and `PASS_THROUGH_FLAGS` in
  // src/config/cliFlags.ts -- which needs no line to survive.
  //
  // The three below moved twice over, once for #81 and once for #80's integration work in the
  // same file, and are pinned against the merged tree rather than against either side of it.
  'bin/conclave.ts:1208': 'cwd: process.cwd(),',
  'bin/conclave.ts:1296': 'runReport(relay, { goal, outcome, startedAt: runStartedAt, build })',
  // One flag for every implementer seat, which is the RUN-WIDE half of the launch args. The
  // per-seat half is no longer missing (#77): it rides inside each `--implementers` entry and
  // is appended after this, so a seat's own spelling wins. This citation still pins what it
  // always pinned -- the flag that applies to all of them.
  'bin/conclave.ts:1058-1061': "...extraArgs(flag('implementer-args', ''))",
  'src/config/project.ts:160-163': 'export function launchArgsFor',
  'src/registry/roles.ts:15': 'export type RoleId = string',
  // The relay.ts citations below moved together when `launch` was added to RelayParticipant
  // and `#join` (#71). Repaired rather than deleted: each still points at the thing it was
  // written about, and the one whose LINE no longer says what it said -- `#join` now passes a
  // named context object rather than an inline literal -- is pinned on the new spelling.
  'src/relay/relay.ts:1531-1533': 'get cwd(): string',
  'src/relay/relay.ts:1681-1687': 'createParticipant(spec, ctx)',
  'src/relay/relay.ts:2228': 'worktreePaths(this.#opts.cwd)',
  'src/relay/relay.ts:2255': 'NOT ARMED (no checks configured)',
  'src/relay/relay.ts:2325': 'worktreePaths(this.#opts.cwd)',
  'src/relay/relay.ts:2748': 'resolutionFor(p.subject, { rotationArmed: armed })',
  'src/relay/relay.ts:2926-2932': 'No rotation checks are configured',
  'src/relay/relay.ts:312': "onDegradation ?? 'candidate'",
  'src/relay/relay.ts:3778': 'worktreePaths(this.#opts.cwd)',
  'src/relay/relay.ts:4245': "subject: { reason: 'turn_incomplete', participant: lead.id }",
  // The five below are what the console's `/continue` liveness guard cites for reading a
  // pause's SCOPE rather than `verdictOf` or a rank scan (`seatsToSampleAtPause` in
  // src/repl/session.ts). Two of them pin the ONLY sites that populate `verdictOf` -- the
  // claim the guard's comment rests on is "exactly two, both turn_incomplete", and a third
  // one appearing elsewhere would leave that sentence quietly false. The other three pin the
  // conclave-scoped halt the change gives up sampling on, its own liveness evidence, and the
  // send that a resumed `advisor_escalated` pause actually makes -- to the ADVISOR, which is
  // why measuring implementer children there was answering the wrong question.
  'src/relay/relay.ts:4248': 'verdictOf: { participant: lead.id, endSeq: next.end.seq },',
  'src/relay/relay.ts:4347': 'The human has seen your escalation and asked you to continue.',
  // The workstream a conflicted instruction belongs to, named after the seat when exactly one
  // seat could take it -- the N=1 coincidence a scope reader must not mistake for a seat.
  'src/relay/relay.ts:4411': "reason: 'authority_conflict', workstream:",
  'src/relay/relay.ts:4495': "subject: { reason: 'implementer_unanswered', participant: seat.id }",
  'src/relay/relay.ts:4544': "subject: { reason: 'advisor_escalated' },",
  'src/relay/relay.ts:4557': '#livenessEvidence(seat, report.emittedSinceSend)',
  'src/relay/relay.ts:4628': "subject: { reason: 'turn_incomplete', participant: seat.id }",
  'src/relay/relay.ts:4634': 'verdictOf: { participant: seat.id, endSeq: current.seq },',
  'src/relay/resolution.ts:190': 'export function resolutionFor',
  'src/relay/run.ts:51': "| 'implementer_unanswered'",
  'src/relay/run.ts:169-183': 'reason: PauseReason',
  'src/relay/run.ts:193': 'resolution: ResolutionRequest',
  'src/relay/subagents.ts:68': 'export function worktreePaths',
  'src/repl/session.ts:209-221': 'turnWatchdogMs?: number | undefined',
  // The three below moved by the same edit that added `seatsToSampleAtPause` above
  // `runSession`: it inserts a documented function into the middle of the file, so every
  // citation past it shifts. Repaired against this tree rather than deleted -- each still
  // points at the line it was written about.
  'src/repl/session.ts:601': 'escalates to you rather than being replaced',
  'src/repl/session.ts:764': 'logPath: runLogPath,',
  // Moved by #83's edit to the `/continue` refusal, nine lines above it in the same block.
  // Repaired rather than deleted: the call it pins is the one the console still makes.
  'src/repl/session.ts:943': "recording.set('paused', { pause: run.pause })",
}

/**
 * Text that looks like a citation and is not one.
 *
 * Keyed by the file it appears in as well as the citation, so an exemption covers the one place
 * it was granted for and not every future use of the same string. Both entries are checked to be
 * still present, so an exemption cannot outlive the fixture it was written for.
 */
const NOT_CITATIONS: Record<string, string> = {
  'src/repl/demo.ts|src/relay/relay.ts:214':
    'Sample report prose in the demo fixture. The numbers are what a participant wrote in an ' +
    'imaginary report, not a claim about this tree, and changing them would change what the ' +
    'demo shows rather than repair anything.',
  'src/repl/render.test.ts|parse.ts:76':
    'An inline code span the markdown renderer must pass through unchanged. `src/repl/parse.ts` ' +
    'does not exist; the string is there to be rendered, not resolved.',
}

interface Found {
  /** The citation as written, path always repo-root-relative in the enforceable form. */
  readonly cite: string
  readonly path: string
  readonly start: number
  readonly end: number
  /** Where it was written, for the failure message. */
  readonly at: string
}

const PATHY = /([A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:ts|tsx|js|cjs|mjs|json|md|py|sh)):(\d+)(?:-(\d+))?/g
/**
 * The continuation form: `relay.ts:1653, :1700 and :2885`, which inherits the nearest path to
 * its left. Written this way in two places already, and a scanner blind to it would leave a
 * whole shape of citation unenforced -- the same hole the two-way pin exists to close.
 */
const CONTINUED = /(?<=[\s`(,[])(:)(\d+)(?:-(\d+))?(?![\d.\-\w])/g

/** Every citation in one line of text, both forms. */
function citationsInLine(line: string): { path: string; start: number; end: number; text: string }[] {
  const full = [...line.matchAll(PATHY)]
  const out = full.map((m) => ({
    path: m[1]!,
    start: Number(m[2]),
    end: Number(m[3] ?? m[2]),
    text: m[0],
    index: m.index,
  }))
  for (const m of line.matchAll(CONTINUED)) {
    // Inside a full match already -- the `-34` of `foo.ts:12-34` cannot reach here, but belt
    // and braces: an overlap would double-count rather than fail, which is the harder bug.
    if (full.some((f) => m.index >= f.index && m.index < f.index + f[0].length)) continue
    const owner = [...out].reverse().find((c) => c.index < m.index)
    if (!owner) continue
    out.push({
      path: owner.path,
      start: Number(m[2]),
      end: Number(m[3] ?? m[2]),
      text: `${owner.path}${m[0]}`,
      index: m.index,
    })
  }
  return out.map(({ path, start, end, text }) => ({ path, start, end, text }))
}

function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) out.push(p)
    }
  }
  for (const root of SOURCE_ROOTS) walk(join(REPO, root))
  return out.map((p) => relative(REPO, p)).filter((p) => p !== SELF)
}

function allCitations(): Found[] {
  const out: Found[] = []
  for (const file of sourceFiles()) {
    readFileSync(join(REPO, file), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const c of citationsInLine(line)) {
          out.push({ cite: c.text, path: c.path, start: c.start, end: c.end, at: `${file}:${i + 1}` })
        }
      })
  }
  return out
}

const exemptKey = (c: Found): string => `${c.at.slice(0, c.at.lastIndexOf(':'))}|${c.cite}`

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

/**
 * Why one citation is not checkable, or `undefined` when it is.
 *
 * Separated from the test that walks `CITED` so the two ways a citation rots -- the cited line
 * is GONE, and the cited line is still there but no longer SAYS it -- can be proven against
 * fixtures rather than argued for in a comment. A guard whose failure path never runs is a
 * guard nobody has seen work.
 */
function citationFault(cite: string, expected: string, root: string = REPO): string | undefined {
  const colon = cite.lastIndexOf(':')
  const path = cite.slice(0, colon)
  const [start, end] = cite
    .slice(colon + 1)
    .split('-')
    .map(Number) as [number, number?]
  let lines: string[]
  try {
    lines = readFileSync(join(root, path), 'utf8').split('\n')
  } catch {
    return `${cite}: no such file (citations must be repo-root-relative)`
  }
  const last = end ?? start
  if (!(start >= 1 && last >= start)) return `${cite}: not a line or range`
  if (last > lines.length) return `${cite}: the file ends at line ${lines.length}`
  const cited = lines.slice(start - 1, last).join('\n')
  if (cited.includes(expected)) return undefined
  return `${cite}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(cited.trim().slice(0, 120))}`
}

test('every declared citation still points at what it says it does', () => {
  assert.deepEqual(
    Object.entries(CITED)
      .map(([cite, expected]) => citationFault(cite, expected))
      .filter((f) => f !== undefined),
    [],
    'These citations have rotted. Find where the cited thing moved to, repair the line number ' +
      'in the prose AND in CITED, and keep the citation -- a stale citation is evidence that ' +
      'went missing, and deleting it loses the claim as well as the pointer.',
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
  const invented = citationsInLine('// a claim about src/relay/relay.ts:99999')
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
    assert.equal(
      citationFault('moved.ts:1', 'export const second = 2', root),
      'moved.ts:1: expected "export const second = 2", found "export const first = 1"',
    )
    // Range form: the token has to be inside the cited range, not merely in the file.
    assert.equal(
      citationFault('moved.ts:1-2', 'export const third = 3', root),
      'moved.ts:1-2: expected "export const third = 3", found "export const first = 1\\nexport const second = 2"',
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

test('an undeclared citation is reported, and an exemption covers only where it was granted', () => {
  // The bypass half, on synthetic input. `allCitations()` is what the real test feeds this
  // filter; the filter itself is what decides whether a new citation can slip through.
  const found: Found[] = [
    { cite: 'src/relay/run.ts:51', path: 'src/relay/run.ts', start: 51, end: 51, at: 'src/relay/x.ts:7' },
    { cite: 'src/relay/relay.ts:214', path: 'src/relay/relay.ts', start: 214, end: 214, at: 'src/repl/demo.ts:48' },
    { cite: 'src/relay/relay.ts:214', path: 'src/relay/relay.ts', start: 214, end: 214, at: 'src/relay/y.ts:9' },
    { cite: 'src/relay/relay.ts:31337', path: 'src/relay/relay.ts', start: 31337, end: 31337, at: 'src/relay/z.ts:3' },
  ]
  assert.deepEqual(
    found.filter((c) => !(c.cite in CITED) && !(exemptKey(c) in NOT_CITATIONS)).map((c) => `${c.at} cites ${c.cite}`),
    [
      // The demo's copy is waived and this one is not, though the text is identical: an
      // exemption is granted to a place, so fixture data cannot license a claim elsewhere.
      'src/relay/y.ts:9 cites src/relay/relay.ts:214',
      'src/relay/z.ts:3 cites src/relay/relay.ts:31337',
    ],
  )
})
