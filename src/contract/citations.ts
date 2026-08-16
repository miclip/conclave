/**
 * The citation registry and its scanner, shared by the guard and the repair tool.
 *
 * `citations.test.ts` is the guard: it proves a citation points at what it claims. This module
 * is what both it and `scripts/fix-citations.ts` read, and it exists as a module for one reason
 * -- a second copy of the scanner is the failure `439cf05` is about, where a duplicated terminal
 * parser was fixed on one side and left broken on the other for months.
 *
 * ## Why a repair tool exists at all
 *
 * A citation is `path:line` plus a declared token, and the TOKEN is what carries the meaning:
 * it is the thing that would have to change for the citation to be pointing somewhere else. The
 * line number carries nothing the token does not. It is a lookup key, and it rots on every edit
 * ABOVE it -- so inserting fifteen lines into `relay.ts`, which has eighteen citations into it,
 * invalidates a block of them mechanically and all at once.
 *
 * That was being repaired by hand, once per edit, with a throwaway script each time. Four times
 * in one session on this branch. Every one of those scripts had to re-derive the same two things
 * the guard already knows -- where a token lives now, and which spellings of a citation appear in
 * the prose -- and one of them silently repaired ten of fifteen because it matched single-quoted
 * declarations and not double-quoted ones. A repair that quietly does less than it claims is the
 * same failure as a citation nobody checks, one level up.
 *
 * So relocation is computed from the token, by the code that already owns the token, and
 * verified before it is written.
 *
 * ## What is NOT automated, deliberately
 *
 * A token that no longer appears in its file, or appears more than once, is not relocated. Those
 * are the two cases where the guard is doing its actual job: the cited thing is GONE, or the pin
 * was never specific enough to be a pin. Both need a human to decide whether the claim survives,
 * and a tool that guessed would launder real rot into a green build.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

export const REPO = join(import.meta.dirname, '..', '..')

/** Scanned for citations. */
export const SOURCE_ROOTS = ['src', 'bin']

/**
 * The two files that carry citations as DATA rather than as claims.
 *
 * This module holds the table, and the test holds the fixtures the scanner is proven against.
 * Either one scanned as a source would satisfy the found-and-declared pin with itself -- every
 * key found in its own table, proving nothing about the tree.
 */
export const SELF = new Set(['src/contract/citations.ts', 'src/contract/citations.test.ts'])

/**
 * What each cited line must still say.
 *
 * Keyed by the citation exactly as it is written in the sources, so one entry covers every place
 * that cites it. Repairing a citation means changing the line number here and in the prose
 * together, which is the point: the two cannot drift apart without the guard saying so.
 * `npm run citations:fix` does both halves at once, for the mechanical case.
 */
export const CITED: Record<string, string> = {
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
  'bin/conclave.ts:1262': 'cwd: process.cwd(),',
  'bin/conclave.ts:1342': 'runReport(relay, { goal, outcome, startedAt: runStartedAt, build })',
  // One flag for every implementer seat, which is the RUN-WIDE half of the launch args. The
  // per-seat half is no longer missing (#77): it rides inside each `--implementers` entry and
  // is appended after this, so a seat's own spelling wins. This citation still pins what it
  // always pinned -- the flag that applies to all of them.
  'bin/conclave.ts:1102-1105': "...extraArgs(flag('implementer-args', ''))",
  'src/config/project.ts:160-163': 'export function launchArgsFor',
  'src/registry/roles.ts:15': 'export type RoleId = string',
  // The relay.ts citations below moved together when `launch` was added to RelayParticipant
  // and `#join` (#71). Repaired rather than deleted: each still points at the thing it was
  // written about, and the one whose LINE no longer says what it said -- `#join` now passes a
  // named context object rather than an inline literal -- is pinned on the new spelling.
  'src/relay/relay.ts:1616-1618': 'get cwd(): string',
  'src/relay/relay.ts:1786-1792': 'createParticipant(spec, ctx)',
  'src/relay/relay.ts:2340': 'worktreePaths(this.#opts.cwd)',
  'src/relay/relay.ts:2367': 'NOT ARMED (no checks configured)',
  'src/relay/relay.ts:2568': 'worktreePaths(this.#opts.cwd)',
  'src/relay/relay.ts:3015': 'resolutionFor(p.subject, { rotationArmed: armed })',
  'src/relay/relay.ts:3449-3451': 'No rotation checks are configured',
  'src/relay/relay.ts:324': "onDegradation ?? 'candidate'",
  // The console's status line, cited by `activeTurn` for the claim its own doc rests on: the
  // footer's notion of "working" is `turn_start` until `turn_end`, and `tool_use` only relabels
  // a turn that is already running. If that ever stops being true, the predicate the relay and
  // `/continue` both send on is no longer the thing the operator is watching.
  'src/repl/session.ts:869-882': 'progress.start(e.participant)',
  'src/relay/relay.ts:4478': 'worktreePaths(this.#opts.cwd)',
  'src/relay/relay.ts:4966': "subject: { reason: 'turn_incomplete', participant: lead.id }",
  // The five below are what the console's `/continue` liveness guard cites for reading a
  // pause's SCOPE rather than `verdictOf` or a rank scan (`seatsToSampleAtPause` in
  // src/repl/session.ts). Two of them pin the ONLY sites that populate `verdictOf` -- the
  // claim the guard's comment rests on is "exactly two, both turn_incomplete", and a third
  // one appearing elsewhere would leave that sentence quietly false. The other three pin the
  // conclave-scoped halt the change gives up sampling on, its own liveness evidence, and the
  // send that a resumed `advisor_escalated` pause actually makes -- to the ADVISOR, which is
  // why measuring implementer children there was answering the wrong question.
  'src/relay/relay.ts:4970': 'verdictOf: { participant: lead.id, endSeq: next.end.seq },',
  'src/relay/relay.ts:5069': 'The human has seen your escalation and asked you to continue.',
  // The workstream a conflicted instruction belongs to, named after the seat when exactly one
  // seat could take it -- the N=1 coincidence a scope reader must not mistake for a seat.
  'src/relay/relay.ts:5133': "reason: 'authority_conflict', workstream:",
  'src/relay/relay.ts:5217': "subject: { reason: 'implementer_unanswered', participant: seat.id }",
  'src/relay/relay.ts:5266': "subject: { reason: 'advisor_escalated' },",
  // Repaired rather than deleted, and it now pins a DESCRIPTOR rather than a call: #101 moved
  // the measurement inside `#halt`, so the halt site says which seat to measure and no longer
  // builds the sentence itself. The claim the citation supports is unchanged -- this halt does
  // carry liveness evidence -- so the pointer moved with the thing it points at.
  //
  // Weaker than the pins around it, and worth saying: the same descriptor appears at the
  // `turn_incomplete` halt below, so only a shift of exactly the distance between the two would
  // slip past. There is nothing unique on the line to pin instead. It is also why this entry
  // is never auto-relocated -- two matches is not a pin, and `planRepairs` refuses it by rule.
  'src/relay/relay.ts:5280': 'liveness: { participant: seat, emittedBefore: report.emittedBefore },',
  'src/relay/relay.ts:5350': "subject: { reason: 'turn_incomplete', participant: seat.id }",
  'src/relay/relay.ts:5354': 'verdictOf: { participant: seat.id, endSeq: current.seq },',
  'src/relay/resolution.ts:190': 'export function resolutionFor',
  'src/relay/run.ts:51': "| 'implementer_unanswered'",
  'src/relay/run.ts:215-229': 'reason: PauseReason',
  'src/relay/run.ts:243': 'resolution: ResolutionRequest',
  // The pause is amended IN PLACE while it is held. #101's report read a repeated status as a
  // second pause replaying the first one's samples; this is the line that says it cannot be
  // one, because there is only ever the one object.
  'src/relay/run.ts:523': 'this.#pause.superseded = info',
  'src/relay/subagents.ts:68': 'export function worktreePaths',
  'src/repl/session.ts:210-222': 'turnWatchdogMs?: number | undefined',
  // The console's liveness seam, cited by the relay's own copy of it (#101). Two front-ends
  // needing the same injection is not duplication to be noticed later -- it is the shape the
  // relay deliberately copied, and the citation is what keeps the two spellings together.
  'src/repl/session.ts:285': 'liveness?: (pid: number) => Promise<ChildLiveness>',
  // The three below moved by the same edit that added `seatsToSampleAtPause` above
  // `runSession`: it inserts a documented function into the middle of the file, so every
  // citation past it shifts. Repaired against this tree rather than deleted -- each still
  // points at the line it was written about.
  'src/repl/session.ts:663': 'escalates to you rather than being replaced',
  'src/repl/session.ts:826': 'logPath: runLogPath,',
  // Moved by #83's edit to the `/continue` refusal, nine lines above it in the same block.
  // Repaired rather than deleted: the call it pins is the one the console still makes.
  'src/repl/session.ts:1031': "recording.set('paused', { pause: run.pause })",
  // Why an in-place amendment to a pause needs an event behind it. Cited by both halves of
  // #101's refresh -- the module that explains the mechanism and the loop that uses it --
  // because the argument was already written here, for `/wait`, and restating it in two more
  // places is how three copies of a reason drift apart.
  'src/repl/session.ts:1713': 'so an in-place change like `superseded` reaches the file on the next one',
  // The falsifier `/continue <message>` is argued against: two commands that already give
  // their trailing text a meaning, so the new rule is narrow by intent rather than by
  // accident. Pinned to the dispatch lines, which is what makes "these are unchanged"
  // checkable rather than a claim about code nobody re-reads.
  "src/repl/session.ts:1735": "if (word === '/rotate') {",
  "src/repl/session.ts:1765": "if (word === '/abort') {",
}

/**
 * Text that looks like a citation and is not one.
 *
 * Keyed by the file it appears in as well as the citation, so an exemption covers the one place
 * it was granted for and not every future use of the same string. Both entries are checked to be
 * still present, so an exemption cannot outlive the fixture it was written for.
 */
export const NOT_CITATIONS: Record<string, string> = {
  'src/repl/demo.ts|src/relay/relay.ts:214':
    'Sample report prose in the demo fixture. The numbers are what a participant wrote in an ' +
    'imaginary report, not a claim about this tree, and changing them would change what the ' +
    'demo shows rather than repair anything.',
  'src/repl/render.test.ts|parse.ts:76':
    'An inline code span the markdown renderer must pass through unchanged. `src/repl/parse.ts` ' +
    'does not exist; the string is there to be rendered, not resolved.',
}

export interface Found {
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

/**
 * A citation and WHERE IN THE LINE it is written.
 *
 * `raw` is the literal text on the line, which is not the same as `text` for a continuation:
 * `:1700` on the line, `src/relay/relay.ts:1700` as a citation. A repair has to put back the
 * form it found, or the second entry of `relay.ts:1653, :1700` would grow a path the author
 * deliberately left off.
 */
export interface CitationSpan {
  path: string
  start: number
  end: number
  text: string
  index: number
  raw: string
}

/** Every citation in one line of text, both forms, with their positions. */
export function citationSpansInLine(line: string): CitationSpan[] {
  const full = [...line.matchAll(PATHY)]
  const out: CitationSpan[] = full.map((m) => ({
    path: m[1]!,
    start: Number(m[2]),
    end: Number(m[3] ?? m[2]),
    text: m[0],
    index: m.index,
    raw: m[0],
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
      raw: m[0],
    })
  }
  return out
}

/** Every citation in one line of text, both forms. */
export function citationsInLine(line: string): { path: string; start: number; end: number; text: string }[] {
  return citationSpansInLine(line).map(({ path, start, end, text }) => ({ path, start, end, text }))
}

export function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) out.push(p)
    }
  }
  for (const root of SOURCE_ROOTS) walk(join(REPO, root))
  return out.map((p) => relative(REPO, p)).filter((p) => !SELF.has(p))
}

export function allCitations(): Found[] {
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

export const exemptKey = (c: Found): string => `${c.at.slice(0, c.at.lastIndexOf(':'))}|${c.cite}`

/** `path`, `start` and `end` of a citation string, without reading anything. */
export function parseCite(cite: string): { path: string; start: number; end: number | undefined } {
  const colon = cite.lastIndexOf(':')
  const path = cite.slice(0, colon)
  const [start, end] = cite
    .slice(colon + 1)
    .split('-')
    .map(Number) as [number, number?]
  return { path, start, end }
}

/** The citation string for a path and a range, in the spelling the sources use. */
export function formatCite(path: string, start: number, end: number | undefined): string {
  return end === undefined || end === start ? `${path}:${start}` : `${path}:${start}-${end}`
}

/**
 * Why one citation is not checkable, or `undefined` when it is.
 *
 * Separated from the test that walks `CITED` so the two ways a citation rots -- the cited line
 * is GONE, and the cited line is still there but no longer SAYS it -- can be proven against
 * fixtures rather than argued for in a comment. A guard whose failure path never runs is a
 * guard nobody has seen work.
 */
export function citationFault(cite: string, expected: string, root: string = REPO): string | undefined {
  const { path, start, end } = parseCite(cite)
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
  const moved = relocate(cite, expected, root)
  return (
    `${cite}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(cited.trim().slice(0, 120))}` +
    // The answer, where there is an unambiguous one. Without it every repair starts by
    // re-deriving what this function already computed, which is how four throwaway scripts
    // got written in one session.
    (moved.to ? ` — it is now at ${moved.to}; \`npm run citations:fix\` repairs this` : ` — ${moved.why}`)
  )
}

/**
 * Where a citation's token lives now, or why that cannot be said.
 *
 * One match is a relocation. Zero means the cited thing is gone, and more than one means the
 * token was never specific enough to be a pin -- both are exactly what the guard exists to put
 * in front of a human, so neither is repaired.
 */
export function relocate(
  cite: string,
  expected: string,
  root: string = REPO,
): { to: string | undefined; why: string; lines: number[] } {
  const { path, start, end } = parseCite(cite)
  let lines: string[]
  try {
    lines = readFileSync(join(root, path), 'utf8').split('\n')
  } catch {
    return { to: undefined, why: 'no such file', lines: [] }
  }
  const hits = lines.flatMap((l, i) => (l.includes(expected) ? [i + 1] : []))
  if (hits.length === 0) {
    return {
      to: undefined,
      why: 'the token appears nowhere in the file, so the cited thing is gone rather than moved — decide whether the claim survives',
      lines: [],
    }
  }
  if (hits.length > 1) {
    return {
      to: undefined,
      why: `the token appears on ${hits.length} lines (${hits.join(', ')}), so it is not a pin — narrow it before relocating`,
      lines: hits,
    }
  }
  const at = hits[0]!
  // A range keeps its WIDTH and moves as a block. Its token sat somewhere inside it, and the
  // only shift that is safe to infer is the one that puts the token back inside a window of the
  // same size -- anchored so the token keeps the offset it has in the current file. Verified by
  // the caller before anything is written, so a wrong guess is dropped rather than committed.
  if (end !== undefined && end !== start) {
    const width = end - start + 1
    for (let offset = 0; offset < width; offset++) {
      const s = at - offset
      if (s < 1 || s + width - 1 > lines.length) continue
      if (lines.slice(s - 1, s + width - 1).join('\n').includes(expected)) {
        return { to: formatCite(path, s, s + width - 1), why: 'relocated', lines: hits }
      }
    }
    return { to: undefined, why: 'the token moved but no window of the cited width contains it', lines: hits }
  }
  return { to: formatCite(path, at, undefined), why: 'relocated', lines: hits }
}

export interface Repair {
  from: string
  to: string
  expected: string
}

export interface RepairPlan {
  repairs: Repair[]
  /** Faulted citations that must not be relocated automatically, with why. */
  refused: { cite: string; why: string }[]
}

/**
 * What can be repaired mechanically, and what a human has to look at.
 *
 * Every proposed move is VERIFIED against the file before it is offered: the new citation must
 * satisfy `citationFault`. A relocation that does not verify is refused rather than written,
 * which is what makes the heuristic above safe to have at all.
 */
export function planRepairs(cited: Record<string, string> = CITED, root: string = REPO): RepairPlan {
  const repairs: Repair[] = []
  const refused: { cite: string; why: string }[] = []
  for (const [cite, expected] of Object.entries(cited)) {
    if (citationFault(cite, expected, root) === undefined) continue
    const { to, why } = relocate(cite, expected, root)
    if (!to) {
      refused.push({ cite, why })
      continue
    }
    const stillWrong = citationFault(to, expected, root)
    if (stillWrong) {
      refused.push({ cite, why: `proposed ${to} does not verify: ${stillWrong}` })
      continue
    }
    repairs.push({ from: cite, to, expected })
  }
  return { repairs, refused }
}

/**
 * One line of text with every repaired citation rewritten in the form it was written in.
 *
 * Spliced by POSITION, from the right, using the scanner -- not by string substitution. A
 * substitution pass is what a hand-rolled repair reaches for, and it rewrites any `:4331` on the
 * line whether or not it belongs to the citation being repaired.
 */
export function repairLine(line: string, by: Map<string, string>): string {
  const spans = citationSpansInLine(line)
    .filter((s) => by.has(s.text))
    .sort((a, b) => b.index - a.index)
  let out = line
  for (const s of spans) {
    const to = by.get(s.text)!
    // Put back the form it was found in: a continuation stays a continuation.
    const replacement = s.raw.startsWith(':') ? `:${to.slice(to.lastIndexOf(':') + 1)}` : to
    out = out.slice(0, s.index) + replacement + out.slice(s.index + s.raw.length)
  }
  return out
}

/** The whole of a file's text with every repaired citation rewritten. */
export function repairText(text: string, by: Map<string, string>): string {
  return text
    .split('\n')
    .map((l) => repairLine(l, by))
    .join('\n')
}
