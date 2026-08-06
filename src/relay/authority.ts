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
 */

import { execFileSync } from 'node:child_process'
import type { RelayMessage } from './message.ts'

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
  /** Repository paths that appeared after it was delivered, attributed to it. */
  artifacts: string[]
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
  return [...out]
}

/** Verbs that undo rather than change. `restore` is included: it reverses a removal. */
const REVERSAL =
  /\b(remove|removing|delete|deleting|revert|reverting|undo|undoing|roll ?back|drop|dropping|strip|stripping|discard|discarding|back out|take out|get rid of|restore|restoring|unwind|revert to)\b/i

/** Just the basename, so `/abs/path/two.txt` matches an instruction saying `two.txt`. */
function base(token: string): string {
  const parts = token.split('/')
  return parts[parts.length - 1] || token
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
    return execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => l.slice(3))
      .filter((p) => !p.startsWith('.conclave/'))
  } catch {
    return []
  }
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
    lines.push(`  changes attributed to it: ${c.origin.artifacts.join(', ')}`)
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
