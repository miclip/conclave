/**
 * What to tell an operator when a send is never acknowledged by a hook -- and what the attempts
 * journal says about WHICH failure it was (#352).
 *
 * The diagnostic used to hand the operator a rule: if the journal EXISTS the handler ran and
 * could not deliver, if it is ABSENT the handler never executed. The rule was right about the
 * two states it named and wrong about the file, because the journal is per-agent rather than
 * per-delivery. A run on #352 ended at its first turn with a journal that existed and held
 * exactly one entry -- `SessionEnd`, the child leaving -- and the rule sent its operator to
 * trust and to the broker when the file was saying the child was gone. The evidence was right
 * there; nothing was reading it.
 *
 * So this reads it. Both adapters share the reading and the explanation; each keeps its own
 * opening line, because they know different things about the prompt when the timeout fires
 * (Claude's has checked the transcript and can say a turn is there; Codex's has not and says
 * only that the text was typed). The child-ended reading is worded from that difference, so
 * neither opening is contradicted by what follows it. A journal that could not be read gets
 * no rule at all -- least of all the EXISTS half of the old one, which is the inference #352
 * was about -- only what is known, and what to look at by hand.
 */

import { readFileSync } from 'node:fs'

/** The hook a send waits for. Both CLIs dispatch it by this name (`hookEventNames.test.ts`). */
export const SEND_HOOK_EVENT = 'UserPromptSubmit'
/** The hook the child fires on its way out. */
export const SESSION_END_EVENT = 'SessionEnd'

/**
 * What the adapter established about the prompt on its own, before the journal was read.
 *
 *   `typed`       the text went into the pty and nothing more is known (Codex).
 *   `transcript`  the child's transcript shows a turn whose prompt is this text (Claude, whose
 *                 `#submit` checks before it waits).
 *
 * The child-ended reading is worded from this. With only `typed`, the child leaving with no
 * prompt hook means the prompt never became a turn. With `transcript`, it did -- and the hook
 * for it never ran before the child left, which is a different sentence about the same journal.
 */
export type PromptEvidence = 'typed' | 'transcript'

/** One attempt as the hook client journals it; only the fields the reading needs. */
interface Attempt {
  event: string
  firedAt: number
  reason: string | undefined
}

/**
 * The event name the hook client writes when the payload carried none. A real firing, and one
 * that cannot be classified -- so it is evidence that the handler ran and evidence of nothing
 * else, which is the uncertainty column rather than the `other` reading.
 */
const UNKNOWN_EVENT = 'unknown'
/**
 * The one phase the hook client writes to this file (`runHookClient`, before it POSTs). A line
 * with any other phase, or none, was not written by the code whose meaning this reader assumes.
 */
const FIRED_PHASE = 'fired'

/**
 * The journal's answer, narrowed to the attempts fired since the send in question.
 *
 * Every reading but the last two carries `uncertain`: the lines that were not usable as
 * evidence -- torn or foreign JSON, a record of any phase but `fired`, an object with an empty
 * or missing event or the client's own `unknown`, an entry with no `firedAt` to place it by. Any of those could have been this send's
 * `UserPromptSubmit`, so a reading that rests on its absence (`absent`, `session_ended`,
 * `other`) says so when the count is non-zero. `expected` rests on its presence, which an
 * unreadable line cannot take away.
 *
 *   `expected`       an attempt for `UserPromptSubmit` was journalled after the send: the
 *                    handler ran and could not deliver. This outranks a later `SessionEnd`,
 *                    because the prompt WAS accepted and the hook for it is what went missing;
 *                    `endedSince` carries the child's exit as a note rather than the headline.
 *   `session_ended`  the newest attempt is `SessionEnd` and no prompt attempt preceded it: the
 *                    child left before the prompt became a turn.
 *   `other`          attempts since the send, none of them the expected one, and the newest is
 *                    not `SessionEnd`: the handler runs, and the CLI did not dispatch the hook
 *                    for this prompt.
 *   `absent`         no file, or no attempt since the send (`older` counts the entries earlier
 *                    turns left): for THIS send the handler never executed.
 *   `undecodable`    the file exists and none of its lines is an attempt. Something wrote it,
 *                    so the handler most likely ran, but which event it was for is not
 *                    recoverable -- and that is all that can be said.
 *   `unreadable`     the file could not be opened for a reason other than absence. Nothing is
 *                    known, not even whether it exists.
 */
export type JournalReading =
  | { kind: 'expected'; count: number; endedSince: { reason: string | undefined } | undefined; uncertain: number }
  | { kind: 'session_ended'; reason: string | undefined; count: number; uncertain: number }
  | { kind: 'other'; events: string[]; uncertain: number }
  | { kind: 'absent'; older: number; uncertain: number }
  | { kind: 'undecodable'; lines: number }
  | { kind: 'unreadable'; detail: string }

/**
 * Read the attempts journal and say which state it shows for a send typed at `sentAt` (seconds
 * since the epoch, the unit the hook client writes `firedAt` in). Entries fired before then
 * belong to earlier turns and do not count: at turn three the journal always holds two
 * `UserPromptSubmit` attempts, and a reading that counted them would report "delivery problem"
 * for every mid-run timeout regardless of what happened to this one -- the per-agent confusion
 * of #352, one level up. An entry with no `firedAt` cannot be placed; the client has written
 * one since its first commit, so such a line is damage rather than an older format, and it is
 * counted as uncertainty rather than as this send's.
 *
 * Never throws. This runs inside a timeout callback that is about to reject a send; a second
 * failure in there would replace the diagnostic with a stack trace.
 */
export function readAttemptJournal(path: string, sentAt?: number): JournalReading {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return { kind: 'absent', older: 0, uncertain: 0 }
    return { kind: 'unreadable', detail: e.message }
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  const attempts: Attempt[] = []
  let uncertain = 0
  for (const line of lines) {
    const attempt = decodeAttempt(line)
    if (attempt) attempts.push(attempt)
    else uncertain++
  }
  if (attempts.length === 0) return { kind: 'undecodable', lines: lines.length }

  const since = sentAt === undefined ? attempts : attempts.filter((a) => a.firedAt >= sentAt)
  if (since.length === 0) return { kind: 'absent', older: attempts.length, uncertain }

  const newest = since[since.length - 1]!
  const ended = newest.event === SESSION_END_EVENT ? { reason: newest.reason } : undefined
  // The prompt attempt wins over the exit. Both were fired for this send, but the prompt's is
  // the one the adapter was waiting for and did not get: that is the delivery fault, and the
  // child leaving afterwards qualifies it rather than replacing it.
  if (since.some((a) => a.event === SEND_HOOK_EVENT)) return { kind: 'expected', count: since.length, endedSince: ended, uncertain }
  if (ended) return { kind: 'session_ended', reason: ended.reason, count: since.length, uncertain }
  return { kind: 'other', events: [...new Set(since.map((a) => a.event))], uncertain }
}

/**
 * One line as evidence, or nothing. A genuine attempt is an object the client wrote at fire time
 * -- `phase: 'fired'` -- with a usable event and a time it fired at. `{}` is valid JSON and is
 * not one; neither is an empty event, the client's `unknown`, or a record of some other phase
 * that happens to name the right event.
 */
function decodeAttempt(line: string): Attempt | undefined {
  let d: any
  try {
    d = JSON.parse(line)
  } catch {
    return undefined // torn after a crash, or not ours
  }
  if (!d || typeof d !== 'object') return undefined
  if (d.phase !== FIRED_PHASE) return undefined
  if (typeof d.event !== 'string' || d.event === '' || d.event === UNKNOWN_EVENT) return undefined
  if (typeof d.firedAt !== 'number' || !Number.isFinite(d.firedAt)) return undefined
  let reason: string | undefined
  if (typeof d.body === 'string') {
    // The payload is journalled as the CLI produced it; `reason` is what SessionEnd carries.
    try {
      const r = JSON.parse(d.body)?.reason
      if (typeof r === 'string') reason = r
    } catch {
      /* a payload the CLI produced malformed is still an attempt for a named event */
    }
  }
  return { event: d.event, firedAt: d.firedAt, reason }
}

/**
 * The qualification a reading that rests on an ABSENCE carries when lines were not usable. Any
 * one of them could have been the attempt whose absence the reading is built on.
 */
function unlessUncertain(reading: { uncertain: number }, claim: string): string {
  if (reading.uncertain === 0) return ''
  const n = reading.uncertain
  return ` But ${n} ${plural(n, 'line was', 'lines were')} not usable as evidence -- torn, not an attempt, or
without an event or a time -- and any of them could have been this send's ${SEND_HOOK_EVENT}. So
${claim} is the reading of what could be read, not a certainty; the raw lines decide it.`
}

/** The reading, as a sentence an operator can act on. */
export function describeReading(reading: JournalReading, evidence: PromptEvidence): string {
  switch (reading.kind) {
    case 'absent':
      return (
        (reading.older === 0
          ? `it is ABSENT, so the handler never executed`
          : `it holds nothing fired since this send (${reading.older} older ${plural(reading.older, 'entry', 'entries')} from earlier turns), so for this send the handler never executed`) +
        `. Under load that is the hook's own timeout killing a cold 'node' start -- and the same
command succeeds on a quiet machine, which is why this presents as flakiness rather than as a
resource problem. If 'conclave config check' reports a registration or trust problem, that is
the cause instead.` +
        unlessUncertain(reading, '"the handler never executed"')
      )
    case 'expected': {
      const ended =
        reading.endedSince === undefined
          ? ''
          : ` Its newest entry is ${SESSION_END_EVENT}${reading.endedSince.reason === undefined ? '' : ` (reason: ${reading.endedSince.reason})`}: the
child has since left, so there is no seat to retry into until it is restarted -- but the exit
came after the prompt was accepted, and the missing hook is the fault to chase.`
      return `it holds a ${SEND_HOOK_EVENT} attempt fired after this send (${reading.count} ${plural(reading.count, 'entry', 'entries')} since), so the
handler ran and could not deliver. That is a delivery problem -- the receiver, not the hooks
and not --settle. The entry's 'body' is the payload the CLI produced.${ended}`
    }
    case 'session_ended': {
      const why = reading.reason === undefined ? '' : ` (reason: ${reading.reason})`
      const [ended, claim] =
        evidence === 'transcript'
          ? [
              `although the prompt is in the child's transcript, its hook never ran: the child's session ENDED
with the prompt's ${SEND_HOOK_EVENT} unfired.`,
              `"the prompt's ${SEND_HOOK_EVENT} never ran"`,
            ]
          : [`the child's session ENDED before the prompt became a turn.`, '"before the prompt became a turn"']
      return (
        `its newest entry is ${SESSION_END_EVENT}${why}, fired after this send, and no ${SEND_HOOK_EVENT} was ever
fired for the prompt: ${ended} That points at
the child rather than at conclave's plumbing -- nothing about registration, trust or the
receiver is in question. Observed once (#352, at a first turn, with the child CLI healthy on its
own) it was transient: a retry with '--settle 20' and nothing else changed got past it. Retry
before looking anywhere else; if it recurs, the child is what to look at.` +
        unlessUncertain(reading, claim)
      )
    }
    case 'other':
      return (
        `it holds ${reading.events.length === 1 ? 'an attempt' : 'attempts'} fired after this send (${reading.events.join(', ')}) but none for
${SEND_HOOK_EVENT}, and its newest is not ${SESSION_END_EVENT}. The handler runs, so this is neither the
timeout nor a registration problem: the CLI did not dispatch ${SEND_HOOK_EVENT} for this prompt.
Read the entries; their 'body' is what the CLI sent.` +
        unlessUncertain(reading, `"the CLI did not dispatch ${SEND_HOOK_EVENT}"`)
      )
    case 'undecodable':
      return `it EXISTS but none of its ${reading.lines} ${plural(reading.lines, 'line', 'lines')} is a decodable attempt. Something wrote it, so the handler
most likely ran -- but which event it ran for is not recoverable from it, and that is the whole
question: a ${SEND_HOOK_EVENT} that could not POST is a delivery fault, a ${SESSION_END_EVENT} is the child leaving.
Read the raw lines by hand; if nothing in them says, treat this as undiagnosed rather than as
either.`
    case 'unreadable':
      return `it could not be opened this time (${reading.detail}), so nothing is known -- not even whether it exists.
Check by hand: if it is ABSENT the handler never executed, which under load is the timeout; if
it is present, its newest entry's 'event' is the answer, per the states above.`
  }
}

/**
 * The whole diagnostic. `opening` is the adapter's own first sentence and `evidence` is what it
 * rests on; what follows is shared. `sentAt` is when the send was typed, in seconds; omitted,
 * every entry in the journal counts.
 */
export function sendHookTimeoutDiagnostic(opening: string, evidence: PromptEvidence, journal: string, sentAt?: number): string {
  return `${opening} Most often the previous turn had not finished -- neither CLI accepts input mid-turn -- so try a longer --settle. If it recurs at the first turn, read the attempts journal below before naming a cause: it says whether the hooks fired at all, and for what.

Four states are known to produce this, and two of them are transient; evidence that fits none
of them is reported as such below rather than forced into one:

  - the hooks are not registered, or registered but untrusted. 'conclave config check'
    distinguishes those two and says so plainly
  - the handler was killed before it could run. Under load a cold 'node' start can exceed the
    hook's own timeout and the CLI kills it. 'config check' reports registration and trust; it
    cannot see this, and will report that everything is fine. Transient: the same command
    succeeds on a quiet machine
  - the handler ran and could not deliver, which is a delivery problem
  - the child's session ended with no UserPromptSubmit ever fired for the prompt (#352).
    Transient where it has been seen, and a fact about the child rather than about conclave's
    plumbing

${journal} tells them apart, and it was read for this send: ${describeReading(readAttemptJournal(journal, sentAt), evidence)}`
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}
