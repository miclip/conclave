/**
 * Detecting when an advisor instruction would reverse work the human asked for privately.
 *
 * §5c promises that a restricted message's asymmetry stays *attributable*, not that its
 * effects survive. Three live runs made the difference concrete: the same asymmetry — an
 * advisor meeting work it never asked for, because it never saw the aside that caused it —
 * resolved three different ways. Twice the implementer refused and the advisor escalated.
 * Once it complied, reasoning that the deletion was cheap to undo:
 *
 *   > I complied because the deletion is trivially reversible [...] If this had been
 *   > non-trivial or unrecoverable work, I'd have stopped and asked the human.
 *
 * Better reasoning than the design specified, and still the wrong place for the decision.
 * **Reversibility informs urgency and risk; it does not resolve who has authority.** A
 * seven-byte file and a schema migration differ operationally and can equally represent a
 * human's deliberate intent.
 *
 * So the orchestrator does not adjudicate and does not prohibit. Forbidding the implementer
 * to undo human-originated work would turn every aside into an invisible veto over
 * legitimate correction — an advisor must be able to say the human made a mistake. What the
 * orchestrator does is *notice*, and hand the case to the only party who holds both sides
 * of it.
 *
 * The detection is a heuristic and is deliberately biased. A false positive costs a pause
 * the human resolves in one word; a false negative leaves exactly the status quo, where the
 * implementer decides alone. Under-detecting is the failure it is tuned away from.
 *
 * WHAT ITS EVIDENCE NOW IS. Token matching is scoped to what the aside actually said.
 * Artifact attribution used to be scoped to nothing: it diffed `git status --porcelain`,
 * which is global to the repository, so anything that became dirty in the interval was
 * attributed to the aside — including edits by whoever else was working in the tree. Its
 * authority exceeded its evidence in exactly the case where a second editor was present.
 *
 * It is now an intersection. `git status` still supplies the candidates, because it is the
 * only thing that knows a file changed at all, but a candidate is attributed only when the
 * informed participant's own tool inputs name it. See `attributable`.
 *
 * The remaining gaps are named rather than closed, because each fails toward over-detection
 * or is bounded:
 *
 *   - reading a file counts as touching it. `cat foo.ts` corroborates `foo.ts`.
 *   - a path a participant never names — a build artifact, `npm install` — is not
 *     attributed, even if that participant did cause it.
 *   - compaction rewrites the transcript the evidence is read from. Attribution is
 *     cumulative and runs immediately after each turn, so the exposure is one turn wide.
 */

import { execFileSync } from 'node:child_process'
import type { RelayMessage } from './message.ts'

/** How well an attributed path is evidenced. See `RestrictedOrigin.artifactSupport`. */
export type AttributionSupport = 'named_path' | 'text_match'

/**
 * How well the ACTOR is evidenced — a different question from `AttributionSupport`.
 *
 * Support asks how strongly a path is tied to the message; this asks how strongly it is tied
 * to the participant. The two are independent and both are needed: a `named_path` in a shared
 * checkout still cannot rule out a second writer, and a path found in a seat's own linked
 * worktree names its author whatever the tool inputs looked like.
 *
 * The vocabulary is the conformance report's, deliberately (`src/conformance/capabilities.ts`).
 * This codebase already has one word for "seen to happen" and one for "argued from evidence
 * that does not exclude the alternative", and a second pair would just be the same distinction
 * spelled differently.
 */
export type AttributionConfidence =
  /**
   * A linked worktree only one seat writes in. The tree itself names the actor: nothing else
   * has that directory, so a path that appeared in it appeared because that seat wrote it.
   */
  | 'observed'
  /**
   * A shared root. `git status` says the path changed and the participant's own tool inputs
   * name it, which is real evidence and does not exclude a second writer in the same
   * directory — the operator, or another participant. This is what N=1 has always produced.
   */
  | 'reasoned_but_unverified'

/**
 * One attributed path, with both evidence dimensions and the seat it was read from.
 *
 * A LIST rather than a map keyed by path, and that is the point at N>1: two seats working in
 * two worktrees can each create `notes.md`, and those are two different files by two different
 * actors. Keyed by path they collapse into one entry whose seat is whichever was written last,
 * which is worse than not recording the seat at all.
 */
export interface AttributedArtifact {
  /** As `git status` reported it, relative to the root it was found in. */
  path: string
  support: AttributionSupport
  /**
   * The seat whose isolated worktree this was read from, or `null` for a shared root.
   *
   * `null` rather than absent. A key that vanishes when it has nothing to say forces a reader
   * to tell "no seat" from "this build does not report seats", which is the ambiguity the
   * report's own rules are written against.
   */
  seat: string | null
  confidence: AttributionConfidence
}

/**
 * Whether a path was NAMED by a tool input or merely found inside one.
 *
 * A complete JSON string value equal to the path, or to a path ending in it, is the tool
 * telling us which file it operated on. Anything else is a substring hit.
 *
 * Deliberately structural rather than a list of known-good tool names: an allowlist would
 * need extending for every new adapter and would silently downgrade the ones it had not
 * heard of, which is the failure mode this codebase keeps recording.
 */
export function supportFor(path: string, evidence: string[]): AttributionSupport {
  const b = base(path)
  for (const raw of evidence) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    for (const value of stringValues(parsed)) {
      if (value === path || value.endsWith(`/${path}`) || base(value) === b) return 'named_path'
    }
  }
  return 'text_match'
}

/** Every string leaf of a parsed tool input, however nested. */
function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringValues)
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringValues)
  return []
}

/** A restricted human message, and what can be traced to it. */
export interface RestrictedOrigin {
  seq: number
  at: number
  text: string
  /** Participants that received it. */
  informed: string[]
  /** Participants deliberately kept from it — the ones that may later contradict it. */
  excluded: string[]
  /** Identifiers and paths named in it, which later instructions may refer to. */
  tokens: string[]
  /**
   * Repository paths that appeared after it was delivered, attributed to it.
   *
   * Deduplicated by path, and therefore lossy the moment two seats have their own trees. It
   * stays because it is what every existing reader — the pause text, the status document, the
   * report — was written against, and because at N=1 it is exactly `attributions` with one
   * field. `attributions` is the record; this is the view.
   */
  artifacts: string[]
  /**
   * Every attribution, with the seat and both evidence dimensions. The full-fidelity record.
   *
   * Present and empty rather than absent when nothing was attributed, for the reason the
   * report gives about `flags`: a field that disappears when it has nothing to say makes a
   * reader distinguish "nothing attributed" from "this build does not attribute".
   */
  attributions: AttributedArtifact[]
  /**
   * How strongly each attributed path is supported.
   *
   *   named_path  a tool input contained the path as a COMPLETE value -- the participant's
   *               own tooling named the file, so this is an exact match.
   *   text_match  the path appeared only as a substring, typically inside a shell command
   *               (`python3 - <<'PY' ... open('notes.md','w') ... PY`). Real evidence, and
   *               weaker: `cat foo.ts` reads a file and matches identically.
   *
   * Recorded because attribution previously arrived as a bare list of paths, with an exact
   * match from a structured tool input indistinguishable from a substring hit in a heredoc.
   * The same grading discipline the outcomes use, applied to the other place this codebase
   * makes claims from evidence.
   *
   * The mix is not a constant. It was measured at roughly two-thirds shell commands over
   * Claude Code and Codex sessions; OpenCode and Kimi both emit absolute paths as structured
   * tool inputs on every edit, so which agent holds the seat changes how well attribution is
   * supported. That was invisible before this field existed.
   */
  artifactSupport: Record<string, AttributionSupport>
}

export interface AuthorityConflict {
  origin: RestrictedOrigin
  /** The advisor instruction that would reverse it. */
  instruction: string
  /** The reversal verb that fired. */
  verb: string
  /** Which of the origin's tokens or artifacts the instruction referenced. */
  matched: string[]
}

/**
 * Words too common to identify anything. Kept short: an over-eager stoplist produces
 * silent false negatives, which is the direction this must not fail in.
 */
const NOISE = new Set([
  'the', 'this', 'that', 'then', 'with', 'from', 'into', 'your', 'you', 'and', 'for', 'not',
  'file', 'files', 'write', 'writing', 'read', 'reading', 'tell', 'said', 'say', 'earlier',
  'without', 'chose', 'choose', 'about', 'what', 'when', 'where', 'which', 'their', 'there',
  'instruction', 'instructions', 'anything', 'something', 'please', 'would', 'should',
])

/** Just the basename, so `/abs/path/two.txt` matches an instruction saying `two.txt`. */
function base(token: string): string {
  const parts = token.split('/')
  return parts[parts.length - 1] || token
}

/**
 * Identifiers a later instruction could plausibly refer to.
 *
 * Filenames, backticked spans, quoted spans, and dotted or underscored identifiers. Plain
 * prose words are included only when distinctive enough to be worth matching — the aside
 * that motivated this named `two.txt`, and the earlier one named a `ZQX_` prefix.
 */
export function extractTokens(text: string): string[] {
  const out = new Set<string>()
  const add = (raw: string) => {
    const t = raw.trim().replace(/^[`'"]|[`'".,;:]$/g, '')
    if (t.length < 3) return
    if (NOISE.has(t.toLowerCase())) return
    out.add(t)
  }
  // Backticked and quoted spans: an author marking something is naming it.
  for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) add(m[1]!)
  for (const m of text.matchAll(/"([^"\n]{2,80})"/g)) add(m[1]!)
  // Paths and filenames.
  for (const m of text.matchAll(/\b[\w.-]*\/[\w./-]+\b/g)) add(m[1] ?? m[0]!)
  for (const m of text.matchAll(/\b[\w-]+\.[A-Za-z]{1,6}\b/g)) add(m[0]!)
  // Identifiers: snake_case, camelCase, SCREAMING, or a distinctive prefix like `ZQX_`.
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+\b/g)) add(m[0]!)
  for (const m of text.matchAll(/\b[a-z]+[A-Z][A-Za-z0-9]*\b/g)) add(m[0]!)

  // Drop path SEGMENTS. `/Users/me/coding-repl/.conclave/two.txt` legitimately yields the
  // full path and `two.txt`, but the identifier rules also pick out `coding-repl` and
  // `scratch-authority` — and matching on a repository name would fire on any two absolute
  // paths in the same checkout. Over-detection is the safe direction, but not this kind:
  // a detector that cries conflict on every path erodes the trust that makes the pause
  // worth reading.
  const paths = [...out].filter((t) => t.includes('/'))
  const keep = new Set<string>()
  for (const t of out) {
    const isSegment = paths.some((p) => p !== t && p.includes(t) && base(p) !== t)
    if (!isSegment) keep.add(t)
  }
  for (const p of paths) keep.add(base(p))
  return [...keep]
}

/** Verbs that undo rather than change. `restore` is included: it reverses a removal. */
const REVERSAL =
  /\b(remove|removing|delete|deleting|revert|reverting|undo|undoing|roll ?back|drop|dropping|strip|stripping|discard|discarding|back out|take out|get rid of|restore|restoring|unwind|revert to)\b/i

/**
 * Would this advisor instruction reverse something a restricted message caused?
 *
 * Requires BOTH a reversal verb and a reference to something traceable to the aside.
 * Either alone is ordinary traffic: advisors delete things all the time, and they mention
 * files all the time.
 */
export function detectConflict(
  instruction: string,
  origins: RestrictedOrigin[],
): AuthorityConflict | undefined {
  const verbMatch = REVERSAL.exec(instruction)
  if (!verbMatch) return undefined
  const haystack = instruction.toLowerCase()

  for (const origin of origins) {
    const candidates = [...origin.tokens, ...origin.artifacts]
    const matched = candidates.filter((c) => {
      const b = base(c).toLowerCase()
      return b.length >= 3 && haystack.includes(b)
    })
    if (matched.length > 0) {
      return { origin, instruction, verb: verbMatch[0]!, matched: [...new Set(matched)] }
    }
  }
  return undefined
}

/** `git status --porcelain` paths, minus Conclave's own bookkeeping. */
export function dirtyPaths(repoRoot: string): string[] {
  try {
    // stderr discarded, for the reason `sessionLock.porcelain` gives: the `catch` handles
    // "not a repository", so letting git announce it as well only frightens the operator.
    return execFileSync('git', ['status', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => l.slice(3))
      .filter((p) => !p.startsWith('.conclave/'))
  } catch {
    return []
  }
}

/**
 * Of the paths that became dirty, the ones the participant can be shown to have touched.
 *
 * `git status` answers "what changed in this repository", which is not the question. It
 * cannot distinguish the implementer's work from a colleague's, so on its own it attributed
 * every dirty path to the aside — the overreach this module's header used to concede.
 *
 * The narrowing keeps `git status` as the candidate set and requires corroboration from the
 * participant's OWN tool inputs before attributing anything. A path another editor dirtied
 * is dropped, because nothing the participant did names it.
 *
 * Substring matching over raw argument text, deliberately, rather than reading structured
 * path fields. Measured over this repository's own sessions, ~65% of file mutations happen
 * through shell commands — `python3 - <<'PY'` heredocs and redirects — not through `Write`
 * or `Edit`. A structured-field rule would score well on the tools that announce a
 * `file_path` and miss the majority that do not, which is under-detection, the direction
 * this must not fail in.
 *
 * It over-attributes instead: `cat foo.ts` reads a file and counts as evidence of touching
 * it. That is accepted. Over-attribution costs a pause the human resolves in one word, and
 * this is still strictly narrower than attributing the entire working tree.
 */
export function attributable(candidates: string[], evidence: string[]): string[] {
  if (evidence.length === 0) return []
  const haystack = evidence.join('\n')
  return candidates.filter((path) => {
    // Both forms, because the two sides disagree on shape: `git status` reports paths
    // relative to the repository root, while a tool input usually names an absolute one.
    // Without the basename test, `src/a.ts` and `/repo/src/a.ts` never match.
    //
    // The same length floor on both, and on the whole path rather than only the basename.
    // Guarding just the fallback left a two-character path matching on the full-path
    // branch, where a substring that short appears in almost any command by coincidence.
    // `detectConflict` applies the identical floor for the identical reason.
    if (path.length >= 3 && haystack.includes(path)) return true
    const b = base(path)
    return b.length >= 3 && haystack.includes(b)
  })
}

/**
 * The evidence that can speak for one ROOT: informed participants working in it, and no others.
 *
 * An excluded participant could not have acted on the message — that rule predates roots. This
 * adds the second half: an informed participant working in a DIFFERENT tree cannot have caused
 * a path in this one, so its tool inputs are not corroboration for a candidate found here.
 *
 * A function rather than an inline filter because it is currently UNREACHABLE through the
 * relay: `Audience` addresses exactly one participant, so a restricted message has one informed
 * id and one root, and the filter never removes anything. It is the correct rule and it becomes
 * load-bearing the moment a message can be addressed to two participants — so it lives here,
 * where it can be exercised directly, rather than as a line nothing can test.
 */
export function evidenceForRoot(
  informed: readonly string[],
  rootOf: (id: string) => string,
  root: string,
  since: (id: string) => string[],
): string[] {
  return informed.filter((id) => rootOf(id) === root).flatMap((id) => since(id))
}

/** Build an origin record from a restricted message as it is sent. */
export function originOf(m: RelayMessage): RestrictedOrigin {
  return {
    seq: m.seq,
    at: m.at,
    text: m.text,
    informed: [...m.to],
    excluded: [...m.excluded],
    tokens: extractTokens(m.text),
    artifacts: [],
    attributions: [],
    artifactSupport: {},
  }
}

/**
 * Record one attribution, and keep the derived views in step.
 *
 * One function so the relationship between the record and the two legacy fields lives in a
 * single place. Identity is (seat, path), not path: the same relative path in two isolated
 * worktrees is two files, and merging them would report one seat's work under another's name.
 *
 * `support` is upgraded in place when a later turn produces better evidence for the same
 * entry — `named_path` beats `text_match`, never the other way round, so a substring hit
 * cannot demote a tool that named the file.
 */
export function recordAttribution(
  origin: RestrictedOrigin,
  entry: { path: string; support: AttributionSupport; seat: string | null },
): void {
  const confidence: AttributionConfidence = entry.seat === null ? 'reasoned_but_unverified' : 'observed'
  const existing = origin.attributions.find((a) => a.path === entry.path && a.seat === entry.seat)
  if (existing) {
    if (entry.support === 'named_path') existing.support = 'named_path'
  } else {
    origin.attributions.push({ path: entry.path, support: entry.support, seat: entry.seat, confidence })
  }
  if (!origin.artifacts.includes(entry.path)) origin.artifacts.push(entry.path)
  // The derived map keeps its old meaning — the best support seen for this path anywhere —
  // which is what it already meant when there was only one root for it to mean it in.
  if (origin.artifactSupport[entry.path] !== 'named_path') {
    origin.artifactSupport[entry.path] = entry.support
  }
}

/**
 * What the human is shown. Assembled rather than narrated, per §9 — every line is a fact
 * the orchestrator holds, not a summary of it.
 */
export function describeConflict(c: AuthorityConflict): string {
  const lines = [
    `An advisor instruction would reverse work that came from a message it never saw.`,
    ``,
    `  your restricted instruction (#${c.origin.seq}, to ${c.origin.informed.join(', ') || 'nobody'}):`,
    `    ${c.origin.text.trim().split('\n')[0]}`,
    `  withheld from: ${c.origin.excluded.join(', ') || 'nobody'}`,
  ]
  if (c.origin.artifacts.length > 0) {
    // The support level travels with the path. A reader deciding whether to trust an
    // attribution needs to know whether a tool named the file or a substring matched.
    // Per attribution rather than per path, and the seat is named when one is known: at N>1
    // "notes.md was changed" is not actionable when two seats each have a notes.md, and the
    // operator adjudicating this needs to know whose tree it is in.
    lines.push(
      `  changes attributed to it: ${c.origin.attributions
        .map((a) => `${a.seat ? `${a.seat}:` : ''}${a.path} [${a.support}, ${a.confidence}]`)
        .join(', ')}`,
    )
  }
  lines.push(
    ``,
    `  the advisor now says:`,
    `    ${c.instruction.trim().split('\n')[0]}`,
    ``,
    `  matched on: ${c.matched.join(', ')} (verb: ${c.verb})`,
    ``,
    `Continue to let the instruction through, or send a constraint first. The advisor may`,
    `be correcting a genuine mistake; it may also be undoing something it cannot see.`,
  )
  return lines.join('\n')
}
