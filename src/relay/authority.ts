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
 *
 * WHEN AN ORIGIN STOPS COUNTING (#171). The asymmetry is a state, not an event. An operator
 * who answers a pause by broadcasting the withheld message's own text to the seat it was
 * withheld from has ended it, and from that moment the pause's own sentence -- "a message it
 * never saw" -- is false. Until `reconcileDelivery` existed the record could not say so, and
 * one aside went on citing an exclusion that had ended: three pauses, one origin, the last of
 * them matching on a single filename the project's own commit policy touches every time.
 *
 * Reconciliation is deliberately narrow. It needs the origin's COMPLETE text, whitespace
 * aside, inside a later human message that reached the excluded seat. Partial quotes and
 * paraphrases do not qualify, because a false reconciliation is a silent false negative --
 * and only `/continue` is offered otherwise, which answers one pause and changes no record.
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
  /**
   * Participants the message was withheld from and has since been GIVEN, in full (#171).
   *
   * A withheld message is not withheld forever. The operator who resolves a conflict by
   * broadcasting the aside's own text to the seat that never saw it has repaired the
   * asymmetry the pause exists to report -- and until this field existed the detector could
   * not tell, so the same origin went on citing an exclusion that had already ended. Three
   * pauses in one live run, all naming the same message, the third matching on a single
   * common filename (#171).
   *
   * A LEDGER rather than a boolean, and it does not replace `informed`/`excluded`: those
   * two say who holds the message NOW, which is the question the detector asks, and this
   * says which later message put them there, which is the question a human reading the
   * record afterwards asks. Present and empty rather than absent, for the reason the report
   * gives about `flags`: a field that disappears when it has nothing to say makes a reader
   * distinguish "nothing was reconciled" from "this build does not reconcile".
   */
  reconciled: { participant: string; seq: number }[]
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
function clean(raw: string): string {
  return raw.trim().replace(/^[`'"]|[`'".,;:]$/g, '')
}

/** Long enough to identify something, and not a word every message contains. */
function admissible(token: string): boolean {
  return token.length >= 3 && !NOISE.has(token.toLowerCase())
}

/**
 * Is this slash-bearing span a path, or is it English with a slash in it? (#157)
 *
 * `booleans/counts` and `and/or` are prose. The old rule could not tell them from
 * `v1/ops/status`, so a finding whose remedy read "return booleans/counts instead" put
 * `booleans/counts` -- and, via the basename pass, the bare word `counts` -- into the token
 * set, and every later instruction mentioning counts matched an aside about access scopes.
 *
 * A single unmarked slash between two plain words is the ambiguous case and the only one
 * refused. Four shapes still read as a path:
 *
 *   marked        `env/config` in backticks or quotes never reaches here; an author marking
 *                 something is naming it, which is signal the prose case lacks.
 *   rooted        a leading `/`, `./` or `../` is a filesystem, not a sentence.
 *   multi-segment two or more slashes. `and/or` has one; `v1/ops/status` has two.
 *   filename      the last segment carries an extension -- `src/compat.ts`.
 *
 * The cost is real and is accepted: an unmarked `src/relay` in prose is no longer a token,
 * which is under-detection, the direction this module says it must not fail in. Two things
 * bound it. Findings and instructions that mean a path usually mark it, and attribution
 * supplies the paths a restricted message actually caused through `artifacts`, which
 * `detectConflict` matches independently of anything extracted from prose.
 */
function looksLikePath(span: string): boolean {
  if (/^\.{0,2}\//.test(span)) return true
  if ((span.match(/\//g) ?? []).length >= 2) return true
  return /\.[A-Za-z]{1,6}$/.test(span)
}

export function extractTokens(text: string): string[] {
  const out = new Set<string>()
  const add = (raw: string) => {
    const t = clean(raw)
    if (admissible(t)) out.add(t)
  }
  // Backticked and quoted spans: an author marking something is naming it.
  for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) add(m[1]!)
  for (const m of text.matchAll(/"([^"\n]{2,80})"/g)) add(m[1]!)
  // Paths and filenames. The leading `/` is part of the span now, because whether a path is
  // rooted is one of the things `looksLikePath` has to be able to see.
  for (const m of text.matchAll(/(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+/g)) {
    const t = clean(m[0]!)
    if (looksLikePath(t)) add(t)
  }
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
  // Through the same filters every other token passes. Adding `base(p)` directly let
  // `base('and/or')` -> `or` into the set below the three-character floor the rest of this
  // module enforces, and would let a noise word in the same way.
  for (const p of paths) {
    const b = base(p)
    if (admissible(b)) keep.add(b)
  }
  return [...keep]
}

/** Verbs that undo rather than change. `restore` is included: it reverses a removal. */
const REVERSAL =
  /\b(remove|removing|delete|deleting|revert|reverting|undo|undoing|roll ?back|drop|dropping|strip|stripping|discard|discarding|back out|take out|get rid of|restore|restoring|unwind|revert to)\b/i

/** Removal-shaped: the text asks for something to stop existing. */
const REMOVAL =
  /\b(remove|removing|delete|deleting|drop|dropping|strip|stripping|discard|discarding|omit|omitting|back out|take out|get rid of)\b/i

/** Restoration-shaped: the text asks for something removed to come back. */
const RESTORATION = /\b(restore|restoring|reinstate|reinstating|re-?add|re-?adding|bring back|put back)\b/i

/**
 * A prohibition is removal-shaped without using a removal verb.
 *
 * "do not emit raw scope strings" asks for an output to stop existing as squarely as
 * "delete the scope strings" does, and code-review findings are written the first way far
 * more often than the second. Without this, the finding that produced #157 classified as
 * having no direction at all, and no instruction could ever align with it.
 */
const PROHIBITION =
  /\b(?:do not|don't|do n't|never|no longer|stop|cease|avoid)\s+(?:\w+\s+){0,2}(?:emit|emitting|return|returning|expose|exposing|include|including|output|outputting|send|sending|surface|surfacing|leak|leaking|print|printing|log|logging|store|storing|write|writing|pass|passing)\b/i

/**
 * Additive or preservative: the text asks for something to exist, or to go on existing.
 *
 * Read only to DISQUALIFY a removal reading, never to establish one, so it is allowed to be
 * broad. It deliberately does not include `return` or `emit`: "return booleans/counts
 * instead" is how a removal-shaped remedy names its replacement, and treating that as
 * additive would make every such finding ambiguous and put #157 back.
 */
const ADDITIVE =
  /\b(?:add|adds|adding|re-?add|keep|keeps|keeping|retain|retains|retaining|preserve|preserves|preserving|create|creates|creating|introduce|introduces|introducing|reinstate|reinstates|restore|restores|restoring|ensure|ensures|ensuring|make sure|leave in place|leave unchanged|must (?:still )?(?:have|include|contain|expose))\b/i

type ActionDirection = 'removal' | 'restoration' | 'mixed' | 'none'

/**
 * Which way a text pushes: toward something existing, or toward it not existing.
 *
 * Narrower than `REVERSAL` on purpose, and deliberately not a partition of it. `revert`,
 * `undo` and `roll back` are direction-AMBIGUOUS -- reverting a deletion restores, reverting
 * an addition removes -- so they land in `none` and can never establish alignment. That is
 * the conservative failure: an unclassifiable direction pauses.
 *
 * Restoration is tested first because a restoring instruction routinely explains itself with
 * a removal verb ("Restore src/compat.ts -- removing it broke the build").
 *
 * `mixed` is the false-negative guard. A restricted message can say two things at once --
 * "keep these three fields, and do not emit `raw_token`" -- and reading only the prohibition
 * classifies the whole message as removal-shaped. An advisor then deleting the KEPT fields
 * quotes the message heavily and uses a removal verb, so it would suppress as propagation
 * while actually reversing the additive half. A message that pushes both ways is not
 * unambiguously removal-shaped, and alignment is refused rather than guessed at.
 */
function actionDirection(text: string): ActionDirection {
  if (RESTORATION.test(text)) return 'restoration'
  const removal = REMOVAL.test(text) || PROHIBITION.test(text)
  if (removal) return ADDITIVE.test(text) ? 'mixed' : 'removal'
  return 'none'
}

/** At least this many of the origin's tokens, and at least this share of them. */
const PROPAGATION_MIN_TOKENS = 3
const PROPAGATION_MIN_SHARE = 0.5

/**
 * Is the advisor carrying the restricted instruction onward rather than opposing it? (#157)
 *
 * A finding of the form "stop emitting X" has an unavoidable signature under the plain
 * detector: an instruction that CARRIES IT OUT quotes it (high overlap) and removes
 * something (a reversal verb), which is exactly the shape of an instruction that UNDOES it.
 * Three false pauses in one live session came from that, all on the same finding.
 *
 * Suppression requires both halves, because either alone is a real conflict:
 *
 *   containment  substantial and multi-token. A relay reproduces the message; a coincidence
 *                shares an identifier. One shared token is never a quotation no matter what
 *                fraction of a one-token origin it is, so a count floor sits beside the
 *                share floor rather than being implied by it.
 *   alignment    the RESTRICTED message must itself be UNAMBIGUOUSLY removal-shaped, and
 *                the instruction must push the same way. Read from the human's text, not the
 *                advisor's -- the question is whether the human asked for this, and only the
 *                human's own words answer it. A message carrying an additive directive
 *                alongside a prohibition classifies `mixed` and never aligns, because the
 *                advisor may be relaying one half while reversing the other.
 *
 * A matched ARTIFACT vetoes suppression outright. An artifact is a file the restricted work
 * is shown to have put in the tree, so an instruction removing it is undoing something that
 * happened, whatever the surrounding prose quotes.
 *
 * What this deliberately is not: a latch on the operator's first answer. Suppressing later
 * pauses for an origin once one was approved treats the symptom -- and would silence a
 * genuine reversal arriving later with the same overlap, which is the one case the guard
 * exists for.
 */
function isPropagation(
  origin: RestrictedOrigin,
  instruction: string,
  matched: string[],
): boolean {
  if (matched.some((m) => origin.artifacts.includes(m))) return false
  if (origin.tokens.length === 0) return false
  const tokenMatches = matched.filter((m) => origin.tokens.includes(m))
  if (tokenMatches.length < PROPAGATION_MIN_TOKENS) return false
  if (tokenMatches.length / origin.tokens.length < PROPAGATION_MIN_SHARE) return false
  return actionDirection(origin.text) === 'removal' && actionDirection(instruction) === 'removal'
}

/**
 * Whitespace-insensitive, and nothing else (#171).
 *
 * The operator who repairs an asymmetry pastes the message back, and a paste is reflowed:
 * wrapped at a different width, indented into a quote, joined onto a sentence. Comparing
 * raw text would refuse every one of those for a reason that has nothing to do with whether
 * the seat now holds the message.
 *
 * It stops there. Markdown quote markers are NOT stripped, punctuation is NOT folded, case
 * is NOT folded. Every relaxation here is a way to mistake a paraphrase for the message, and
 * a false reconciliation silently disarms the detector -- the direction this module says it
 * must not fail in. Refusing to notice a delivery only leaves the pause firing, which is the
 * status quo and is visible.
 */
function normaliseDelivery(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Does this later text contain the origin's message WHOLE? (#171)
 *
 * Containment, not equality, because a delivery is rarely bare: "for the record, here is
 * what I sent the implementer at #5: <the whole thing>. You both have it now" is the shape an
 * operator actually types, and demanding an exact match would refuse it.
 *
 * Containment of the COMPLETE text, because anything less is not the message. A partial
 * quote hands over the half the operator happened to re-read; a paraphrase hands over the
 * operator's summary of it. Neither puts the excluded seat where an informed one stands, and
 * the whole point of reconciliation is that the seat can now be held to what the human
 * actually said.
 */
export function deliversInFull(origin: RestrictedOrigin, text: string): boolean {
  const message = normaliseDelivery(origin.text)
  // An empty origin is contained in everything. Nothing was withheld, so nothing is delivered.
  if (message.length === 0) return false
  return normaliseDelivery(text).includes(message)
}

/**
 * Move the seats this delivery reached out of `excluded` and into `informed` (#171).
 *
 * The origin RECORD is what the detector reads, so the record is what has to change. The
 * routing log is deliberately left alone: it says what happened at that seq, and seq 5 was
 * withheld from the advisor whatever seq 20 did about it. `audit()` and `asymmetryAt()` are
 * defined over the log and go on answering the historical question.
 *
 * Returns the participants whose membership actually moved, so a caller can say who -- an
 * empty return means this message delivered nothing and nothing was touched.
 */
export function reconcileDelivery(
  origin: RestrictedOrigin,
  delivery: { seq: number; text: string; to: readonly string[] },
): string[] {
  // A message cannot deliver something sent after it, and an origin cannot deliver itself.
  if (delivery.seq <= origin.seq) return []
  if (!deliversInFull(origin, delivery.text)) return []
  const moved: string[] = []
  for (const id of delivery.to) {
    const at = origin.excluded.indexOf(id)
    if (at === -1) continue
    origin.excluded.splice(at, 1)
    if (!origin.informed.includes(id)) origin.informed.push(id)
    origin.reconciled.push({ participant: id, seq: delivery.seq })
    moved.push(id)
  }
  return moved
}

/**
 * Can this origin still support the claim the pause makes? (#171)
 *
 * The pause's own sentence is "an advisor instruction would reverse work that came from a
 * message it never saw". Once the advisor has been handed that message in full, the sentence
 * is false, and a pause that asserts it is asking the human to adjudicate a premise the human
 * personally repaired. That is what #171 reports: three pauses, one origin, the second and
 * third raised after the operator had broadcast the message to both seats.
 *
 * Read off the ADVISOR specifically rather than off `excluded` being empty. At N>1 an origin
 * can be reconciled for one implementer seat and still withheld from the advisor, and the
 * detector's question is only ever about the advisor -- it is the advisor's instruction.
 *
 * With no advisor named the rule falls back to "somebody is still excluded", which is what
 * every origin built by `originOf` from a restricted message satisfies. Callers that cannot
 * name the advisor therefore behave exactly as they did before this existed.
 */
function stillWithheld(origin: RestrictedOrigin, advisor: string | undefined): boolean {
  return advisor === undefined ? origin.excluded.length > 0 : origin.excluded.includes(advisor)
}

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
  /**
   * The seat whose instruction this is, when the caller knows it. See `stillWithheld`.
   *
   * Optional because the record-level callers -- and every test that builds an origin by hand
   * -- have no participant table to read it from, and because a detector that silently stops
   * firing when a caller forgets an argument is worse than one that keeps its old behaviour.
   */
  advisor?: string,
): AuthorityConflict | undefined {
  const verbMatch = REVERSAL.exec(instruction)
  if (!verbMatch) return undefined
  const haystack = instruction.toLowerCase()

  for (const origin of origins) {
    // Delivered in full since, so the asymmetry this origin stands for has ended. `continue`
    // rather than `return`, for the same reason propagation uses one: a DIFFERENT origin,
    // still withheld, may be genuinely opposed by this same instruction.
    if (!stillWithheld(origin, advisor)) continue
    const candidates = [...origin.tokens, ...origin.artifacts]
    const matched = candidates.filter((c) => {
      const b = base(c).toLowerCase()
      return b.length >= 3 && haystack.includes(b)
    })
    if (matched.length === 0) continue
    const unique = [...new Set(matched)]
    // Relaying the human's own removal is not reversing it. `continue`, not `return`: a
    // later origin may still be genuinely opposed by this same instruction.
    if (isPropagation(origin, instruction, unique)) continue
    return { origin, instruction, verb: verbMatch[0]!, matched: unique }
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
    reconciled: [],
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
  if (c.origin.reconciled.length > 0) {
    // Only reachable at N>1: the pause cannot fire once the ADVISOR has been given the
    // message, so anything listed here is another seat. It is printed because the human is
    // being asked to adjudicate an asymmetry and has already closed part of it -- a line
    // saying which part is the difference between "you were never told" and "you were told,
    // and one of the three seats now knows".
    lines.push(
      `  since delivered in full to: ${c.origin.reconciled
        .map((r) => `${r.participant} (#${r.seq})`)
        .join(', ')}`,
    )
  }
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
    ``,
    // The third option, and the only one that changes the record rather than answering one
    // question about it. Named because #171 is a report of an operator taking it and the
    // tool not noticing: they broadcast the message at the first pause and were asked twice
    // more. It states the mechanism and its condition; it does not say which to choose.
    `Sending #${c.origin.seq}'s text in full to ${c.origin.excluded.join(', ') || 'nobody'} ends the`,
    `asymmetry itself: a seat that has been given the message is no longer reversing something`,
    `it never saw, and #${c.origin.seq} stops raising this. The COMPLETE text, in one message —`,
    `a partial quote or a summary reconciles nothing.`,
  )
  return lines.join('\n')
}
