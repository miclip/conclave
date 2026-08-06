/**
 * The handoff document.
 *
 * Two halves with different authors, and the split is the point.
 *
 *   narrative   the advisor's. Goal, state, decisions, disagreement, next action.
 *   record      the orchestrator's. HEAD, file digests, verification exit codes.
 *
 * §7a argues the advisor is the natural author *because* it is on a thin context diet: it
 * has followed the whole narrative and holds none of the working set, which is the shape a
 * handoff should be. But it also cannot see the implementer's tools, so everything it says
 * about files and tests is second-hand. Asking it to author the checkable parts too would
 * hand the arbiter's job to a participant.
 *
 * Human constraints are NOT in here. They are replayed separately so they reach the
 * replacement at human rank rather than as advisor prose — see §7a and the rank rules in
 * §6. Folding them in would quietly demote every constraint the session was given.
 */

import type { RelayMessage } from '../relay/message.ts'
import type { RepoRecord } from './record.ts'

export interface HandoffNarrative {
  /**
   * What the advisor chose to tell the replacement, which is NOT the session's goal.
   *
   * It was `## GOAL`, asking the advisor to restate what the human wanted in their terms.
   * That made rotation the one place a goal reached an implementer verbatim -- the whole
   * narrative is embedded in `acceptancePrompt` -- so a session that rotated silently
   * abandoned the rule that the advisor decides what an implementer knows. Reframed rather
   * than stripped: the replacement still needs something to work from, and the advisor is
   * the one who should decide how much of the goal that is.
   */
  brief: string
  currentState: string
  decisions: string[]
  /** What the advisor believes about tests and evidence. A claim; `record` is the check. */
  evidence: string
  /** Files the advisor believes matter. Unioned with the tree, never trusted alone. */
  files: string[]
  /** Unresolved disagreement. Carried forward so a rotation cannot launder it away. */
  openDisagreement: string[]
  nextAction: string
  /** Verbatim, because parsing is lossy and the prose is what actually gets handed over. */
  raw: string
}

export interface Handoff {
  narrative: HandoffNarrative
  record: RepoRecord
  /** Human-rank messages, replayed at human rank rather than quoted as advisor prose. */
  constraints: RelayMessage[]
  authoredBy: string
  from: { sessionId: string; agent: string }
  /** Compaction generation of the session being replaced: the mechanical degradation signal. */
  compactionGeneration: number
  at: number
}

const SECTIONS = ['BRIEF', 'STATE', 'DECISIONS', 'EVIDENCE', 'FILES', 'DISAGREEMENT', 'NEXT'] as const
type Section = (typeof SECTIONS)[number]

/**
 * What the advisor is asked for.
 *
 * Fixed headings rather than free prose, because an unparseable handoff has to be
 * detectable *before* the old session is terminated. Sections are also the only way to
 * ask for open disagreement explicitly — left implicit, a summary drops it, and the
 * replacement then re-derives a settled question as if it were open.
 */
export function handoffPrompt(reason: string): string {
  return `The implementer session is being replaced. ${reason}

Write the handoff that lets a fresh implementer continue this work. It has none of your
history: it has not seen the instructions or anything either of us said. Like the
implementer it replaces, it does not hold this session's goal — what it knows is what you
write here.

Use exactly these headings, in this order, and put nothing outside them:

## BRIEF
What the replacement needs in order to continue, in the human's terms rather than yours.
You hold the goal; decide how much of it belongs here exactly as you decide what to put in
an instruction. Enough to do the work — not necessarily where the work is heading.

## STATE
Where the work actually is right now. Be specific about what is finished and what is not.

## DECISIONS
One per line, prefixed with "- ". Choices already made that should not be reopened, each
with the reason. Write "- none" if there are none.

## EVIDENCE
What has been verified and how, including test status. Say which of this you checked
yourself and which you are repeating from the implementer's prose.

## FILES
One repo-relative path per line, prefixed with "- ". The files this work touches.

## DISAGREEMENT
One per line, prefixed with "- ". Anything still unresolved between us, stated fairly
including the position you do not hold. Write "- none" if there is none. Do not resolve an
open question here just to make the handoff tidy.

## NEXT
The single concrete action the replacement should take first.`
}

/**
 * Split on headings by hand rather than by regex.
 *
 * A lazy `[\s\S]*?` bounded by `$` under the `m` flag stops at the first newline, which
 * silently truncates every section to one line. Line-walking is duller and correct.
 */
function sections(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  let current: string | undefined
  let buf: string[] = []
  const flush = () => {
    if (current) out[current] = (out[current] ? `${out[current]}\n` : '') + buf.join('\n').trim()
    buf = []
  }
  for (const line of text.split('\n')) {
    const heading = /^\s*#{1,4}\s*([A-Z]+)\b/.exec(line)
    if (heading) {
      flush()
      current = heading[1]
    } else if (current) {
      buf.push(line)
    }
  }
  flush()
  return out
}

function bullets(block: string): string[] {
  const items = block
    .split('\n')
    .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean)
  return items.length === 1 && /^none\.?$/i.test(items[0]!) ? [] : items
}

export interface ParseResult {
  narrative?: HandoffNarrative
  /** Missing or empty sections. Non-empty means the handoff cannot be relied on. */
  missing: Section[]
}

/** Sections without which a replacement cannot start. The rest may legitimately be empty. */
const REQUIRED: Section[] = ['BRIEF', 'STATE', 'NEXT']

export function parseHandoff(text: string): ParseResult {
  const found = sections(text)
  const got = Object.fromEntries(SECTIONS.map((s) => [s, (found[s] ?? '').trim()])) as Record<Section, string>
  const missing = REQUIRED.filter((s) => got[s].length === 0)
  if (missing.length > 0) return { missing }
  return {
    missing: [],
    narrative: {
      brief: got.BRIEF,
      currentState: got.STATE,
      decisions: bullets(got.DECISIONS),
      evidence: got.EVIDENCE,
      files: bullets(got.FILES).map((f) => f.replace(/^`|`$/g, '')),
      openDisagreement: bullets(got.DISAGREEMENT),
      nextAction: got.NEXT,
      raw: text,
    },
  }
}

/**
 * What the replacement is given, and what it is asked to do with it.
 *
 * Not "acknowledge this". §7a: transfer acceptance is demonstrated. So the replacement is
 * asked to inspect the named state, run the recorded commands, and report exit codes in a
 * form that can be compared — a reply that cannot be compared is itself a failed transfer.
 */
export function acceptancePrompt(h: Handoff): string {
  // The example is generated from the actual checks, not written as a fixed pair.
  //
  // It used to show `CHECK 1` and `CHECK 2` whatever the real count. Given one command,
  // two live replacements did two different things with that: one flagged it -- "there is
  // no CHECK 2 to report. I'm flagging that rather than inventing a line to fill the
  // template" -- and the other filled it in, reporting a CHECK 1 exit code that the
  // arbiter had not observed alongside a CHECK 2 that did not exist.
  //
  // The second is a claim mismatch manufactured by the prompt. Had the repository not
  // diverged first, the transaction would have refused the transfer and blamed the
  // replacement for a template defect of ours.
  const checks = h.record.checks.map((c, i) => `${i + 1}. \`${c.command}\``).join('\n')
  const files = h.narrative.files.length > 0 ? h.narrative.files.map((f) => `- ${f}`).join('\n') : '- (none named)'
  return `You are replacing an implementer session that is being retired. It is still alive and
frozen; if you cannot reproduce the state below, say so and it will be resumed instead of
you. Do not paper over a mismatch.

The advisor wrote the following handoff. It cannot see tool calls or code, so treat its
account of files and tests as a claim to check, not as fact.

${h.narrative.raw}

Before doing any of the work, demonstrate that you can continue it:

1. Read the files named above.
${files}
2. Run each of these commands and report its exit code:
${checks}
3. Report using exactly this format, before anything else — ${h.record.checks.length} line(s),
   one per command above, and no others:

${h.record.checks.map((_, i) => `CHECK ${i + 1}: exit <code>`).join('\n')}

Then, in prose: what you found, and anything in the handoff that the repository
contradicts. If something does not match, say that plainly — a mismatch reported is a
working transfer; a mismatch smoothed over is not.

Do not start on the next action yet.`
}

export interface ClaimedCheck {
  index: number
  exitCode: number
}

/**
 * Read the replacement's claimed exit codes out of its prose.
 *
 * These are compared against the orchestrator's own re-run, so a replacement that claims
 * a passing check the arbiter observes failing is caught. The parse is deliberately
 * strict: a report that cannot be read is treated as no report at all rather than
 * generously interpreted, because generosity here means accepting a transfer nobody
 * demonstrated.
 */
export function parseClaimedChecks(prose: string): ClaimedCheck[] {
  const out: ClaimedCheck[] = []
  // NOT anchored to a line start, and that is the whole point of this comment.
  //
  // It was. The first live rotation rolled back with "no reported exit code", and the
  // replacement's prose read:
  //
  //     I'll verify the state before doing any work.CHECK 1: exit 0
  //
  // It had done exactly what it was asked. A newline it does not control -- and which the
  // transcript may not preserve anyway -- decided that a correct answer was no answer.
  //
  // Strictness about the FORMAT is what keeps a vague "looks fine" from passing, and that
  // is unchanged: the exact demanded token sequence is still required. Strictness about
  // surrounding whitespace bought nothing and cost a spurious rollback.
  const re = /CHECK\s+(\d+)\s*:\s*exit\s+(-?\d+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(prose))) {
    out.push({ index: Number(m[1]), exitCode: Number(m[2]) })
  }
  return out
}
