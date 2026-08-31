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
 *
 * ## Why a repair is planned as a PAIR
 *
 * A citation is not one thing in one place. It is the DECLARATION in `CITED`, the mentions in the
 * prose, and -- since #164 -- the claims in `docs/**` sections marked `## LIVE:`, which the guard
 * checks in both directions. Repairing some of those and not the rest is worse than repairing
 * none: it turns a failure this tool can finish into one only a human can, while reporting
 * success. That is #170, and it was not hypothetical -- `sourceFiles()` has never included
 * `docs/**`, so every pair with a live docs half came out half done.
 *
 * So `planPairedRepairs` simulates the whole set against every file that writes it before any of
 * it is written, and declines BY NAME any repair that would leave a side stale -- taking its
 * writes with it, so neither of its files is touched on its account. Frozen docs sections are
 * never rewritten at all: the guard does not check them, and they record what was true when they
 * were written. `liveSectionMask` is the one place that line is drawn, for the same reason the
 * scanner is not copied -- see `439cf05`.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

export const REPO = join(import.meta.dirname, '..', '..')

/** Scanned for citations. */
export const SOURCE_ROOTS = ['src', 'bin']

/** Scanned for live-claim sections. */
export const DOCS_ROOTS = ['docs']

/**
 * The two files that carry citations as DATA rather than as claims.
 *
 * This module holds the table, and the test holds the fixtures the scanner is proven against.
 * Either one scanned as a source would satisfy the found-and-declared pin with itself -- every
 * key found in its own table, proving nothing about the tree.
 */
export const REGISTRY_FILE = 'src/contract/citations.ts'

export const SELF = new Set([REGISTRY_FILE, 'src/contract/citations.test.ts'])

/**
 * What each cited line must still say.
 *
 * Keyed by the citation exactly as it is written in the sources, so one entry covers every place
 * that cites it. Repairing a citation means changing the line number here and in the prose
 * together, which is the point: the two cannot drift apart without the guard saying so.
 * `npm run citations:fix` does both halves at once, for the mechanical case.
 */
export const CITED: Record<string, string> = {
  // The two spellings of a compaction revision, pinned because a doc comment on
  // `withdrawReason` rests on the difference between them: only one withdraws anything. Cited by
  // line because the claim is about these exact two emissions, not about `Tracker` in general.
  'src/transcript/reconcile.ts:593': "reason: fresh > 0 ? 'compaction' : 'rewrite',",
  'src/transcript/reconcile.ts:594': 'replaces: replaced,',
  'src/transcript/reconcile.ts:679': 'replaces: [],',
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
  'bin/conclave.ts:1835-1837': "    const relay = await Relay.start({\n      registry,\n      cwd: process.cwd(),",
  'bin/conclave.ts:1927': 'runReport(relay, { goal, outcome, startedAt: runStartedAt, build })',
  // One flag for every implementer seat, which is the RUN-WIDE half of the launch args. The
  // per-seat half is no longer missing (#77): it rides inside each `--implementers` entry and
  // is appended after this, so a seat's own spelling wins. This citation still pins what it
  // always pinned -- the flag that applies to all of them.
  'bin/conclave.ts:1621-1624': "...extraArgs(flag('implementer-args', ''))",
  'src/config/project.ts:160-163': 'export function launchArgsFor',
  'src/registry/roles.ts:15': 'export type RoleId = string',
  // The relay.ts citations below moved together when `launch` was added to RelayParticipant
  // and `#join` (#71). Repaired rather than deleted: each still points at the thing it was
  // written about, and the one whose LINE no longer says what it said -- `#join` now passes a
  // named context object rather than an inline literal -- is pinned on the new spelling.
  'src/relay/relay.ts:1981-1983': 'get cwd(): string',
  'src/relay/relay.ts:2262-2268': 'const ctx = { cwd, watchdogMs: this.#opts.turnWatchdogMs, idleMs: this.#opts.silenceWatchdogMs }',
  'src/relay/relay.ts:3072-3073': "this.#worktreesSeen.add(w)\n    return {",
  'src/relay/relay.ts:3173': 'NOT ARMED (no checks configured)',
  'src/relay/relay.ts:3670': 'if (this.#worktreesAtStart) for (const w of worktreePaths',
  'src/relay/relay.ts:4154': 'resolutionFor(p.subject, { rotationArmed: armed })',
  'src/relay/relay.ts:4759': 'No rotation checks are configured',
  'src/relay/relay.ts:342': "onDegradation ?? 'candidate'",
  // The console's status line, cited by `activeTurn` for the claim its own doc rests on: the
  // footer's notion of "working" is `turn_start` until `turn_end`, and `tool_use` only relabels
  // a turn that is already running. If that ever stops being true, the predicate the relay and
  // `/continue` both send on is no longer the thing the operator is watching.
  'src/repl/session.ts:1278': 'progress.note(e.participant, label)',
  'src/relay/relay.ts:6048': 'this.#worktreesAtStart = worktreePaths(this.#opts.cwd)',
  'src/relay/relay.ts:6828': "subject: { reason: 'turn_incomplete', participant: lead.id }",
  // The five below are what the console's `/continue` liveness guard cites for reading a
  // pause's SCOPE rather than `verdictOf` or a rank scan (`seatsToSampleAtPause` in
  // src/repl/session.ts). Two of them pin the ONLY sites that populate `verdictOf` -- the
  // claim the guard's comment rests on is "exactly two, both turn_incomplete", and a third
  // one appearing elsewhere would leave that sentence quietly false. The other three pin the
  // conclave-scoped halt the change gives up sampling on, its own liveness evidence, and the
  // send that a resumed `advisor_escalated` pause actually makes -- to the ADVISOR, which is
  // why measuring implementer children there was answering the wrong question.
  // `current.seq` and no longer `next.end.seq`: the advisor path now resolves a withdrawn
  // verdict through supersession before it decides anything, the way the implementer path
  // below always has, so both sites quote the SAME resolved end. The claim this pin supports is
  // untouched -- these are still the only two that populate `verdictOf`, both `turn_incomplete`
  // -- and the token moved with the thing it points at rather than the pin being dropped.
  'src/relay/relay.ts:6832': 'verdictOf: { participant: lead.id, endSeq: current.seq },',
  'src/relay/relay.ts:6949': 'The human has seen your escalation and asked you to continue.',
  // The workstream a conflicted instruction belongs to, named after the seat when exactly one
  // seat could take it -- the N=1 coincidence a scope reader must not mistake for a seat.
  'src/relay/relay.ts:7116': "reason: 'authority_conflict', workstream:",
  'src/relay/relay.ts:7215': "subject: { reason: 'implementer_unanswered', participant: seat.id }",
  'src/relay/relay.ts:7266': "its report could not be read, so there is",
  // Repaired rather than deleted, and it now pins a DESCRIPTOR rather than a call: #101 moved
  // the measurement inside `#halt`, so the halt site says which seat to measure and no longer
  // builds the sentence itself. The claim the citation supports is unchanged -- this halt does
  // carry liveness evidence -- so the pointer moved with the thing it points at.
  //
  // Weaker than the pins around it, and worth saying: the same descriptor appears at the
  // `turn_incomplete` halt below, so only a shift of exactly the distance between the two would
  // slip past. There is nothing unique on the line to pin instead. It is also why this entry
  // is never auto-relocated -- two matches is not a pin, and `planRepairs` refuses it by rule.
  'src/relay/relay.ts:7277': "knowing whether the child is still writing changes what the operator does.",
  'src/relay/relay.ts:7348': "subject: { reason: 'turn_incomplete', participant: seat.id }",
  'src/relay/relay.ts:7352': 'verdictOf: { participant: seat.id, endSeq: current.seq },',
  // The one sentence #66's bypass rests on: a verdict withdrawn with no replacement can come
  // from nowhere but `resetTranscript`, so the open turn the console stops refusing on is a
  // deleted record rather than an observed one. If that ever stops being true, the guard's
  // argument stops being true with it, and this is what says so out loud.
  'src/outcomes/tracker.ts:23-27': 'only possible via `resetTranscript`',
  'src/relay/resolution.ts:190': 'export function resolutionFor',
  'src/relay/run.ts:52': "| 'implementer_unanswered'",
  'src/relay/run.ts:315': 'reason: PauseReason',
  'src/relay/run.ts:329': 'resolution: ResolutionRequest',
  // The pause is amended IN PLACE while it is held. #101's report read a repeated status as a
  // second pause replaying the first one's samples; this is the line that says it cannot be
  // one, because there is only ever the one object.
  'src/relay/run.ts:872': 'this.#pause.superseded = info',
  'src/relay/subagents.ts:68': 'export function worktreePaths',
  'src/repl/session.ts:265-277': 'turnWatchdogMs?: number | undefined',
  // The console's liveness seam, cited by the relay's own copy of it (#101). Two front-ends
  // needing the same injection is not duplication to be noticed later -- it is the shape the
  // relay deliberately copied, and the citation is what keeps the two spellings together.
  'src/repl/session.ts:361': 'liveness?: (pid: number) => Promise<ChildLiveness>',
  // The three below moved by the same edit that added `seatsToSampleAtPause` above
  // `runSession`: it inserts a documented function into the middle of the file, so every
  // citation past it shifts. Repaired against this tree rather than deleted -- each still
  // points at the line it was written about.
  'src/repl/session.ts:1052': 'escalates to you rather than being replaced',
  'src/repl/session.ts:1212': 'logPath: runLogPath,',
  // Moved by #83's edit to the `/continue` refusal, nine lines above it in the same block.
  // Repaired rather than deleted: the call it pins is the one the console still makes.
  'src/repl/session.ts:1530': 'run.pause.refusal = { at: Date.now(), reason, ...(colour ? { liveness: colour } : {}) }',
  // Why an in-place amendment to a pause needs an event behind it. Cited by both halves of
  // #101's refresh -- the module that explains the mechanism and the loop that uses it --
  // because the argument was already written here, for `/wait`, and restating it in two more
  // places is how three copies of a reason drift apart.
  'src/repl/session.ts:2380': 'so an in-place change like `superseded` reaches the file on the next one',
  // The falsifier `/continue <message>` is argued against: two commands that already give
  // their trailing text a meaning, so the new rule is narrow by intent rather than by
  // accident. Pinned to the dispatch lines, which is what makes "these are unchanged"
  // checkable rather than a claim about code nobody re-reads.
  "src/repl/session.ts:2402": "if (word === '/rotate') {",
  "src/repl/session.ts:2435": "if (word === '/abort') {",

  // Live-claim section in docs/NOTES.md: #156's premise and the unverified-generation guards.
  // These citations assert current fact in a section marked `## LIVE:`, so they are checked even
  // though the rest of docs/** is frozen design record.
  'src/adapters/claude.ts:1884-1897': 'containedFallback: true,',
  'src/adapters/codex.ts:1449-1462': 'containedFallback: true,',
  'src/rotation/rotate.ts:484':
    'const generation = snap.containedFallback ? UNKNOWN_GENERATION : snap.compactionGeneration',
  'src/relay/relay.ts:4578': 'async #considerRotation(',
  'src/relay/relay.ts:4801-4805':
    "      // RETIRED session's, and acknowledging it against the replacement would hand a session at\n" +
    "      // generation 0 a baseline of 1.\n" +
    "      return replaced\n" +
    "        ? this.#answeredByReplacement(impl, snap.compactionGeneration)\n" +
    "        : this.#acknowledge(impl, snap.compactionGeneration)",
  'src/relay/relay.ts:4846-4850':
    "      // As above (#128): `snap` describes the session that was in the seat when the question was\n" +
    "      // put, and the operator may have answered it by replacing that session.\n" +
    "      return replaced\n" +
    "        ? this.#answeredByReplacement(impl, snap.compactionGeneration)\n" +
    "        : this.#acknowledge(impl, snap.compactionGeneration)",
  'src/relay/relay.ts:4872': 'return this.#acknowledge(impl, snap.compactionGeneration)',
  'src/relay/relay.ts:4903-4913':
    "        detail:\n" +
    "          `rotation could not be accepted and ROTATION IS NOT THE REMEDY: ${result.detail} ` +\n" +
    "          `${impl.id} is back in service and no further rotation will be attempted this run.`,\n" +
    "        evidence: [\n" +
    "          ...verdict.evidence,\n" +
    "          ...(result.evidence ?? []),\n" +
    "          'the original implementer is back in service',\n" +
    "          'a replacement cannot demonstrate itself while the transport it would demonstrate over is not working',\n" +
    "        ],\n" +
    "      })\n" +
    "      return halted ?? this.#acknowledge(impl, (await impl.session.snapshot()).compactionGeneration)",
  'src/relay/relay.ts:4917-4920':
    "      detail: `rotation failed (${result.reason}): ${result.detail}`,\n" +
    "      evidence: [...verdict.evidence, 'the original implementer is back in service'],\n" +
    "    })\n" +
    "    return halted ?? this.#acknowledge(impl, (await impl.session.snapshot()).compactionGeneration)",
  'src/relay/relay.ts:7372':
    'const rotated = await this.#considerRotation(seat, report.prose, handle)',
  'src/adapters/codex.ts:620-626': 'this.#view = new TranscriptSessionView({',
  'src/adapters/claude.ts:1114-1118': 'this.#view = new TranscriptSessionView({',
  'src/relay/relay.ts:2269':
    'const p: RelayParticipant = { id: spec.id, agent: spec.agent, rank, role: spec.role, launch, session, events: [], baselineGeneration: 0, degradationCursor: 0 }',
  'src/relay/report.ts:286-296': 'const snap = await p.session.snapshot()',
  // The two console lines the #171 sequence test says it is not going around: the operator's
  // reply at a pause, and `>advisor <text>`. The claim they support is that the test drives the
  // same call the front end makes, so a pin on the call itself is the whole point.
  'src/repl/session.ts:1560': "inject(text, 'all')",
  'src/repl/session.ts:2498': 'inject(rest, { only: who })',
  'src/adapters/kimi.ts:752': 'compactionGeneration: 0,',
  'src/adapters/opencode.ts:790': 'compactionGeneration: 0,',
  'src/rotation/rotate.ts:412': 'export async function rotate(',
  'src/adapters/claude.ts:1547': "#state: SessionState = 'running'",
  'src/adapters/codex.ts:1118': "#state: SessionState = 'running'",
  'src/rotation/handoff.ts:74': 'compactionGeneration: CompactionGeneration',
  'src/workspace/sessionRecord.ts:1408': 'snap.turns.map(',
  'src/relay/relay.ts:3743':
    "const unsettled = snap.turns.at(-1)?.state === 'in_progress'",
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

function walkFiles(dir: string, ext: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walkFiles(p, ext, out)
    else if (e.name.endsWith(ext)) out.push(p)
  }
}

/**
 * Walk a CONFIGURED root, and fail loudly when it cannot be read.
 *
 * The tempting shape here is to treat an unreadable root as an empty one, because it makes
 * fixtures easier to write. It also makes every guard over that root pass by finding nothing:
 * `docs/**` came into scope with #164, and a `docs` that has been renamed, moved, or simply not
 * checked out would report zero live claims and take the two-way pin over them quietly with it.
 * A root named in `SOURCE_ROOTS` or `DOCS_ROOTS` is a root this repository HAS, so not finding
 * one is a fact about the scanner rather than about the tree, and it is raised as one. A fixture
 * that wants to be scanned creates the roots, which is the honest version of the same
 * convenience.
 */
function walkRoot(root: string, dir: string, ext: string, out: string[]): void {
  try {
    walkFiles(join(root, dir), ext, out)
  } catch (cause) {
    throw new Error(
      `citations: '${dir}' is a configured scan root and could not be read (${(cause as Error).message}). ` +
        'Nothing under it was scanned, so every guard over it would have passed by finding nothing.',
      { cause },
    )
  }
}

export function sourceFiles(root: string = REPO): string[] {
  const out: string[] = []
  for (const dir of SOURCE_ROOTS) walkRoot(root, dir, '.ts', out)
  return out.map((p) => relative(root, p)).filter((p) => !SELF.has(p))
}

/** Every `.md` under `DOCS_ROOTS`, repo-root-relative. Live and frozen alike; see `liveSectionMask`. */
export function docsFiles(root: string = REPO): string[] {
  const out: string[] = []
  for (const dir of DOCS_ROOTS) walkRoot(root, dir, '.md', out)
  return out.map((p) => relative(root, p))
}

/**
 * Which lines of a document are inside a `## LIVE:` section.
 *
 * The ONE place that decides live from frozen. The scanner reads it to know what to enforce and
 * the repair writer reads it to know what it may rewrite, and that is deliberate: two copies of
 * this rule drifting apart would let the fixer renumber a frozen design record -- text the guard
 * never looks at, written to be true of the tree it was written against -- which is the single
 * thing `docs/**` is protected from. A section runs from its `## LIVE:` heading to the next
 * sibling `## `, and the heading itself counts as inside it.
 */
export function liveSectionMask(text: string): boolean[] {
  let inLive = false
  return text.split('\n').map((line) => {
    if (/^##\s+/.test(line)) inLive = /^##\s+LIVE:\s+/.test(line)
    return inLive
  })
}

/** Walk `docs/**` for `.md` files and return citations inside `## LIVE:` sections. */
export function docsLiveClaimCitations(root: string = REPO): Found[] {
  const out: Found[] = []
  for (const file of docsFiles(root)) {
    const text = readFileSync(join(root, file), 'utf8')
    const live = liveSectionMask(text)
    text.split('\n').forEach((line, i) => {
      if (!live[i]) return
      for (const c of citationsInLine(line)) {
        out.push({ cite: c.text, path: c.path, start: c.start, end: c.end, at: `${file}:${i + 1}` })
      }
    })
  }
  return out
}

export function allCitations(root: string = REPO): Found[] {
  const out: Found[] = []
  for (const file of sourceFiles(root)) {
    readFileSync(join(root, file), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const c of citationsInLine(line)) {
          out.push({ cite: c.text, path: c.path, start: c.start, end: c.end, at: `${file}:${i + 1}` })
        }
      })
  }
  out.push(...docsLiveClaimCitations(root))
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
 * Every line a token STARTS on, counting a token that spans lines as one occurrence.
 *
 * The obvious spelling -- `lines.filter(l => l.includes(expected))` -- cannot see a multi-line
 * token at all, because no single line contains one. That is not hypothetical: widening a citation
 * to a range whose distinguishing text spans two lines is exactly what you do when a token has an
 * identical twin, so the tokens this got wrong were precisely the ones created BY fixing the
 * weakest pins.
 *
 * It failed in both directions at once, which is why it went unnoticed. `relocate` reported "the
 * token appears nowhere in the file, so the cited thing is gone" about a token plainly sitting
 * there -- alarming, but at least loud. `weakPins` counted ZERO occurrences and concluded the pin
 * was unique, so a measurement that could not see two of its entries reported them as its
 * strongest. An instrument blind to a case reads as evidence of that case's absence.
 */
function tokenLines(lines: string[], expected: string): number[] {
  const text = lines.join('\n')
  const out: number[] = []
  for (let i = text.indexOf(expected); i !== -1; i = text.indexOf(expected, i + 1)) {
    // +1 twice: `split` counts the lines before the match, and lines are 1-based.
    out.push(text.slice(0, i).split('\n').length)
  }
  return out
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
): { to: string | undefined; candidates: string[]; why: string; lines: number[] } {
  const { path, start, end } = parseCite(cite)
  let lines: string[]
  try {
    lines = readFileSync(join(root, path), 'utf8').split('\n')
  } catch {
    return { to: undefined, candidates: [], why: 'no such file', lines: [] }
  }
  const hits = tokenLines(lines, expected)
  if (hits.length === 0) {
    return {
      to: undefined,
      candidates: [],
      why: 'the token appears nowhere in the file, so the cited thing is gone rather than moved — decide whether the claim survives',
      lines: [],
    }
  }

  // A range keeps its WIDTH and moves as a block, and its token sat SOMEWHERE inside it -- which
  // the current file cannot tell you. Anchoring the token to the range's first line was the
  // obvious guess and it is wrong: it silently re-frames the range around the token and reports
  // a shift one or two lines off the one the file actually took. So every window of the cited
  // width that contains the token is a candidate, and something better-evidenced than a guess
  // picks between them.
  const width = end === undefined ? 1 : end - start + 1
  const candidates: string[] = []
  for (const at of hits) {
    for (let offset = 0; offset < width; offset++) {
      const s = at - offset
      if (s < 1 || s + width - 1 > lines.length) continue
      if (!lines.slice(s - 1, s + width - 1).join('\n').includes(expected)) continue
      const cand = formatCite(path, s, end === undefined ? undefined : s + width - 1)
      if (!candidates.includes(cand)) candidates.push(cand)
    }
  }
  if (candidates.length === 1) return { to: candidates[0], candidates, why: 'relocated', lines: hits }
  if (candidates.length === 0) {
    return { to: undefined, candidates, why: 'the token moved but no window of the cited width contains it', lines: hits }
  }
  return {
    to: undefined,
    candidates,
    why:
      hits.length > 1
        ? `the token appears on ${hits.length} lines (${hits.join(', ')}), so it is not a pin on its own`
        : `the token is inside ${candidates.length} windows of the cited width, so its offset in the range is not recoverable from the file alone`,
    lines: hits,
  }
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
  const faulted = Object.entries(cited).filter(([c, e]) => citationFault(c, e, root) !== undefined)

  const accept = (cite: string, to: string, expected: string): boolean => {
    const stillWrong = citationFault(to, expected, root)
    if (stillWrong) {
      refused.push({ cite, why: `proposed ${to} does not verify: ${stillWrong}` })
      return false
    }
    repairs.push({ from: cite, to, expected })
    return true
  }

  // Pass one: the citations that have exactly one possible answer. Those need nothing but
  // themselves, and they are what measures the file's shift for pass two.
  const ambiguous: { cite: string; expected: string; why: string; candidates: string[] }[] = []
  for (const [cite, expected] of faulted) {
    const { to, candidates, why } = relocate(cite, expected, root)
    if (to) {
      accept(cite, to, expected)
      continue
    }
    if (candidates.length > 1) ambiguous.push({ cite, expected, why, candidates })
    else refused.push({ cite, why })
  }

  // Pass two, and the one that makes this worth having on a real tree.
  //
  // A weak pin -- `worktreePaths(this.#opts.cwd)` is cited three times over -- cannot say where
  // it went on its own. But it did not move on its own: an insertion shifts everything below it
  // by the SAME amount, and the citations in the file that DO pin uniquely have already
  // measured that shift. So a file with one consistent delta lends it to its ambiguous
  // citations, and the candidate is only taken if it lands exactly on a line that has the token.
  //
  // Consensus is required, not a majority. Two different deltas in one file means more than a
  // simple insertion happened, and the arithmetic that makes this safe no longer holds.
  const deltas = new Map<string, Set<number>>()
  for (const r of repairs) {
    const from = parseCite(r.from)
    const to = parseCite(r.to)
    const set = deltas.get(from.path) ?? new Set<number>()
    set.add(to.start - from.start)
    deltas.set(from.path, set)
  }
  for (const a of ambiguous) {
    const { path, start, end } = parseCite(a.cite)
    const seen = deltas.get(path)
    if (!seen || seen.size !== 1) {
      refused.push({
        cite: a.cite,
        why: seen
          ? `${a.why}, and its file shifted by no single amount (${[...seen].join(', ')}) to infer from`
          : `${a.why}, and no citation in its file relocated on its own evidence, so there is no shift to measure`,
      })
      continue
    }
    const delta = [...seen][0]!
    const shifted = formatCite(path, start + delta, end === undefined ? undefined : end + delta)
    // The shift has to land on one of the answers the file itself allows. Taking `start + delta`
    // on faith would let a consensus measured elsewhere in the file invent a line that does not
    // hold the token at all -- which `accept` would catch, but as a confusing failure rather
    // than as the refusal it is.
    if (!a.candidates.includes(shifted)) {
      refused.push({
        cite: a.cite,
        why: `${a.why}, and the file's shift of ${delta} picks none of them (${a.candidates.join(', ')})`,
      })
      continue
    }
    accept(a.cite, shifted, a.expected)
  }
  return { repairs, refused }
}

/**
 * Declared citations whose token is not unique in the file it points into.
 *
 * A weak pin still guards -- the cited line either says the thing or it does not -- but it is
 * weaker in two specific ways worth knowing about rather than discovering: only a shift of
 * exactly the distance between two occurrences slips past it, and it cannot be relocated on its
 * own evidence. `planRepairs` covers the second with the file's measured shift; nothing covers
 * the first, which is why this is reported rather than hidden.
 */
export function weakPins(
  cited: Record<string, string> = CITED,
  root: string = REPO,
): { cite: string; hits: number }[] {
  const out: { cite: string; hits: number }[] = []
  for (const [cite, expected] of Object.entries(cited)) {
    const { path } = parseCite(cite)
    let text: string
    try {
      text = readFileSync(join(root, path), 'utf8')
    } catch {
      continue
    }
    // `tokenLines`, not a per-line filter: a multi-line token occurs zero times by that measure,
    // and zero is not `> 1`, so the entries this function was least able to judge were the ones it
    // reported as strongest. See `tokenLines`.
    const hits = tokenLines(text.split('\n'), expected).length
    if (hits > 1) out.push({ cite, hits })
  }
  return out.sort((a, b) => a.cite.localeCompare(b.cite))
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

/**
 * A document's text with repaired citations rewritten INSIDE `## LIVE:` sections only.
 *
 * Frozen sections pass through byte for byte. They are a record of what was true when they were
 * written, the guard does not check them, and a repair tool that quietly renumbered them would be
 * editing the evidence rather than the claim. The live sections are the opposite case -- they
 * assert current fact and are checked -- so leaving THEM stale is the half-repair #170 is about.
 */
export function repairDocsText(text: string, by: Map<string, string>): string {
  const live = liveSectionMask(text)
  return text
    .split('\n')
    .map((l, i) => (live[i] ? repairLine(l, by) : l))
    .join('\n')
}

/** Where a citation is written: the table that declares it, the prose, or a live docs claim. */
export type SiteScope = 'registry' | 'source' | 'docs-live'

export interface CitationSite {
  readonly file: string
  /** 1-based. */
  readonly line: number
  readonly scope: SiteScope
}

interface ScannedFile {
  readonly file: string
  readonly scope: SiteScope
  readonly text: string
  /** Present for docs only: which lines may be read and rewritten. See `liveSectionMask`. */
  readonly mask: boolean[] | undefined
}

/**
 * Every file a repair may have to touch, with its text and -- for docs -- its live mask.
 *
 * Read once and passed around, because the plan has to look at the same bytes twice: to find the
 * sites, and to check what a rewrite of them would leave behind. Re-reading between those two
 * would compare a proposal against a file that had moved under it.
 */
function scanScopes(root: string): ScannedFile[] {
  const out: ScannedFile[] = []
  const push = (file: string, scope: SiteScope): void => {
    let text: string
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      return
    }
    out.push({ file, scope, text, mask: scope === 'docs-live' ? liveSectionMask(text) : undefined })
  }
  // The registry is not in `sourceFiles()` -- it is excluded from scanning precisely because it
  // carries citations as data -- so it is named here. A pass over the sources alone repairs the
  // prose and leaves every declaration pointing at the old line, which is half of #170.
  push(REGISTRY_FILE, 'registry')
  for (const f of sourceFiles(root)) push(f, 'source')
  for (const f of docsFiles(root)) push(f, 'docs-live')
  return out
}

/** Every citation written in `s`, skipping the lines a mask excludes. */
function sitesIn(s: ScannedFile, text: string): { cite: string; line: number }[] {
  const out: { cite: string; line: number }[] = []
  text.split('\n').forEach((line, i) => {
    if (s.mask && !s.mask[i]) return
    for (const span of citationSpansInLine(line)) out.push({ cite: span.text, line: i + 1 })
  })
  return out
}

/**
 * Every place each citation is written, across the three scopes a repair must keep in step.
 *
 * Frozen docs sections are absent by construction: they are neither checked by the guard nor
 * rewritten by the fixer, so a citation living only there has no site here and cannot make a
 * repair look half-done.
 */
export function citationSites(root: string = REPO): Map<string, CitationSite[]> {
  const out = new Map<string, CitationSite[]>()
  for (const s of scanScopes(root)) {
    for (const { cite, line } of sitesIn(s, s.text)) {
      const list = out.get(cite) ?? []
      list.push({ file: s.file, line, scope: s.scope })
      out.set(cite, list)
    }
  }
  return out
}

/**
 * The old spellings a set of repairs was meant to remove, minus any that a repair also PRODUCES.
 *
 * Two citations can trade line numbers -- `A:10 -> A:12` alongside `A:12 -> A:10` -- and then the
 * old spelling of one is the correct new spelling of the other. Reporting it as left-behind would
 * turn a completed repair into a false alarm.
 */
function spellingsToRetire(by: Map<string, string>): Set<string> {
  const produced = new Set(by.values())
  return new Set([...by.keys()].filter((from) => by.get(from) !== from && !produced.has(from)))
}

function staleIn(scopes: ScannedFile[], texts: Map<string, string>, retire: Set<string>): Map<string, CitationSite[]> {
  const out = new Map<string, CitationSite[]>()
  for (const s of scopes) {
    for (const { cite, line } of sitesIn(s, texts.get(s.file) ?? s.text)) {
      if (!retire.has(cite)) continue
      const list = out.get(cite) ?? []
      list.push({ file: s.file, line, scope: s.scope })
      out.set(cite, list)
    }
  }
  return out
}

/**
 * Citations still written in their pre-repair spelling anywhere the guard looks.
 *
 * Read from disk, so this is what the fixer asks AFTER writing: a plan proves what it intends,
 * and this proves what landed. A non-empty answer is the #170 failure itself -- one half of a
 * pair moved and the other did not.
 */
export function staleSpellings(by: Map<string, string>, root: string = REPO): string[] {
  const scopes = scanScopes(root)
  const stale = staleIn(scopes, new Map(), spellingsToRetire(by))
  return [...stale.entries()].flatMap(([cite, at]) => at.map((s) => `${s.file}:${s.line} still cites ${cite}`))
}

export interface PairedRepairPlan extends RepairPlan {
  /** Repo-relative file -> its whole new text, for every file the accepted repairs change. */
  writes: Map<string, string>
  /** Every citation that was faulted when this was planned, repaired or not. */
  faulted: string[]
}

/**
 * `planRepairs`, narrowed to the repairs whose every side can be rewritten in one go.
 *
 * A citation is not one thing in one place. It is a DECLARATION in the registry, zero or more
 * mentions in the prose, and -- since #164 -- zero or more claims in a `## LIVE:` docs section
 * that the guard now checks both ways. Repairing some of those and not the rest is worse than
 * repairing none: it converts a failure the tool can finish into one only a human can, while
 * printing success. That is #170, and the fixer's own comment already named the shape without
 * covering the docs half, because `sourceFiles()` has never included `docs/**`.
 *
 * So every accepted repair is simulated against every file that writes it, in memory, before
 * anything is written, and a repair that would leave any side stale is declined BY NAME and
 * removed -- taking its writes with it, so neither of its files is touched on its account. The
 * refusal is the same currency `planRepairs` already deals in for ranges and gone tokens, and it
 * is deliberately per-pair: one undeclinable citation does not stop the twenty that are clean.
 */
export function planPairedRepairs(
  cited: Record<string, string> = CITED,
  root: string = REPO,
): PairedRepairPlan {
  const planned = planRepairs(cited, root)
  const faulted = Object.entries(cited)
    .filter(([c, e]) => citationFault(c, e, root) !== undefined)
    .map(([c]) => c)
  const refused = [...planned.refused]
  const scopes = scanScopes(root)
  const sites = new Map<string, CitationSite[]>()
  for (const s of scopes) {
    for (const { cite, line } of sitesIn(s, s.text)) {
      const list = sites.get(cite) ?? []
      list.push({ file: s.file, line, scope: s.scope })
      sites.set(cite, list)
    }
  }

  // The declaration first, because it is the half that cannot be inferred back. A citation the
  // registry writes in no form the rewriter can see would have its prose moved onto a line the
  // table still denies; one the registry writes TWICE is worse, because the second is data about
  // the citation -- an exemption key, a quoted token -- and rewriting both would edit evidence to
  // match the thing it was evidence about.
  let candidates = planned.repairs.filter((r) => {
    const declared = (sites.get(r.from) ?? []).filter((s) => s.scope === 'registry')
    if (declared.length === 1) return true
    refused.push({
      cite: r.from,
      why:
        declared.length === 0
          ? `it moved to ${r.to}, but ${REGISTRY_FILE} does not write it in a form this can rewrite, so the declaration would stay stale while the prose moved`
          : `it moved to ${r.to}, but ${REGISTRY_FILE} writes it on ${declared.length} lines (${declared
              .map((s) => s.line)
              .join(', ')}) and a repair cannot tell the declaration from data about it`,
    })
    return false
  })

  // Then the whole plan, simulated. Declining one repair changes only the lines that repair
  // would have touched, so a second pass cannot un-stale a third citation -- but it is cheap and
  // the alternative is arguing that in a comment, so it loops until it stops changing its mind.
  let texts = new Map<string, string>()
  for (let pass = 0; ; pass++) {
    const by = new Map(candidates.map((r) => [r.from, r.to]))
    texts = new Map(
      scopes.map((s) => [s.file, s.mask ? repairDocsText(s.text, by) : repairText(s.text, by)]),
    )
    const stale = staleIn(scopes, texts, spellingsToRetire(by))
    if (stale.size === 0 || pass >= 4) {
      for (const [cite, at] of stale) {
        refused.push({
          cite,
          why: `it would move to ${by.get(cite)}, but ${at
            .map((s) => `${s.file}:${s.line}`)
            .join(', ')} still writes the old spelling after the rewrite, so the pair would be half repaired`,
        })
      }
      if (stale.size > 0) candidates = candidates.filter((r) => !stale.has(r.from))
      break
    }
    candidates = candidates.filter((r) => {
      const at = stale.get(r.from)
      if (!at) return true
      refused.push({
        cite: r.from,
        why: `it would move to ${r.to}, but ${at
          .map((s) => `${s.file}:${s.line}`)
          .join(', ')} still writes the old spelling after the rewrite, so the pair would be half repaired`,
      })
      return false
    })
  }

  // Recomputed against the surviving set, so a declined repair leaves no trace in what is
  // written. This is what "or it repairs neither" means concretely: the bytes of its files are
  // whatever the OTHER repairs made of them, and unchanged where there were none.
  const finalBy = new Map(candidates.map((r) => [r.from, r.to]))
  const writes = new Map<string, string>()
  for (const s of scopes) {
    const after = s.mask ? repairDocsText(s.text, finalBy) : repairText(s.text, finalBy)
    if (after === s.text) continue
    // `repairLine` splices within a line and never adds or removes one, so every citation's line
    // number survives its own file being rewritten. If that ever stops holding, every relocation
    // in the plan was measured against a file that no longer exists, and stopping is the only
    // safe answer.
    if (after.split('\n').length !== s.text.split('\n').length) {
      throw new Error(`citations: rewriting ${s.file} changed its line count; nothing was written`)
    }
    writes.set(s.file, after)
  }

  return { repairs: candidates, refused, writes, faulted }
}

export interface PostRepairFaults {
  /** Faulted now and not before, or faulted now having been repaired: the writes broke it. */
  broken: string[]
  /** An old spelling still written where the guard looks: a pair that moved by halves. */
  halfRepaired: string[]
  /** Faulted before, not repaired, faulted still: the refusals, doing what refusals do. */
  untouched: string[]
}

/**
 * What is wrong with the tree after a repair landed, split by whose fault it is.
 *
 * Worth separating, and it was not: walking `CITED` after writing reports every REFUSED citation
 * as a repair that failed to verify, because a refusal is by definition a citation still faulted
 * afterwards. So declining a pair -- the thing #170 asks for -- came out as "repairs did not
 * verify, the tree has been changed, review it" over a set of repairs that were all correct, and
 * buried the one line that says which pair needs a human.
 */
export function faultsAfterRepair(
  by: Map<string, string>,
  faultedBefore: Iterable<string>,
  cited: Record<string, string> = CITED,
  root: string = REPO,
): PostRepairFaults {
  const before = new Set(faultedBefore)
  const broken: string[] = []
  const untouched: string[] = []
  for (const [cite, expected] of Object.entries(cited)) {
    const fault = citationFault(by.get(cite) ?? cite, expected, root)
    if (fault === undefined) continue
    if (by.has(cite) || !before.has(cite)) broken.push(fault)
    else untouched.push(fault)
  }
  return { broken, halfRepaired: staleSpellings(by, root), untouched }
}

/**
 * Write a plan out, in sorted order, one file at a time.
 *
 * The guarantee is about the PLAN, not the filesystem: nothing is written until the whole set has
 * been simulated and every pair that would come out half done has been declined, so no write here
 * is one this could have known better than to make. It is NOT atomic -- these are ordinary
 * sequential `writeFileSync` calls, and a failure partway leaves the files before it written and
 * the files after it not. Closing that would take a write-and-rename pass; what closes the failure
 * #170 is about is the simulation upstream, which is where the half-repairs came from.
 */
export function applyRepairs(writes: Map<string, string>, root: string = REPO): string[] {
  const files = [...writes.keys()].sort()
  for (const file of files) writeFileSync(join(root, file), writes.get(file)!)
  return files
}
