/**
 * Continuing a run that ended with work in flight.
 *
 * `relay` ends at every pause point, deliberately — "a call that returns an outcome has
 * nowhere to suspend to". The consequence is that the NORMAL way a long run stops is with
 * work unfinished: an escalation with nobody attending, a `--rounds` budget exhausted
 * mid-task, an operator kill, or a crash. Recovery was to write a new goal that carried the
 * established state back in by hand, transcribed from a 130-line routing log.
 *
 * That works and it has a failure mode nobody can see: **anything the operator does not
 * transcribe is silently re-derived or silently lost**, and neither the participants nor the
 * log can tell it happened.
 *
 * The routing log already holds every message. Replaying it removes the transcription step
 * without inventing a new format to get wrong.
 *
 * ## Two decisions worth stating
 *
 * **Recording is continuous, not at the end.** A record written on exit is exactly the
 * record a crash destroys, and the crash is one of the endings this exists for.
 *
 * **A resumed run is told it is resuming.** The alternative — replaying the log as though
 * the participants had said those things themselves — would have them believe they hold
 * context they do not. A fresh session that thinks it remembers is worse than one that knows
 * it does not, because it stops asking.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RelayMessage } from './message.ts'

/**
 * Appends each routing-log entry as one JSON line, as it happens.
 *
 * Failures are swallowed after the first report. A run must not die because its own audit
 * trail could not be written — losing the ability to resume is bad, and losing the work is
 * worse.
 */
export class RunLogWriter {
  readonly path: string
  #failed = false

  constructor(path: string) {
    this.path = path
    mkdirSync(dirname(path), { recursive: true })
  }

  write(message: RelayMessage): void {
    if (this.#failed) return
    try {
      appendFileSync(this.path, `${JSON.stringify(message)}\n`)
    } catch (err) {
      this.#failed = true
      console.error(
        `conclave: could not record the run log at ${this.path} ` +
          `(${err instanceof Error ? err.message : String(err)}); this run cannot be resumed`,
      )
    }
  }
}

/**
 * Read a recorded log back.
 *
 * A truncated final line is expected rather than exceptional: the process may have been
 * killed mid-write, which is precisely the case a resume is for. It is dropped silently, and
 * every complete line before it is kept.
 */
export function readRunLog(path: string): RelayMessage[] {
  const out: RelayMessage[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as RelayMessage)
    } catch {
      // Only ever the last line, and only when the writer died mid-append.
    }
  }
  return out
}

export function runLogExists(path: string): boolean {
  return existsSync(path)
}

/** Characters of prior log to replay before truncating. */
const BUDGET = 24_000

/**
 * What a resumed participant is told about the run it is continuing.
 *
 * Rendered from the log rather than summarised by a model. A summary would be a new claim
 * about what happened, authored by something that was not there, and the operator's whole
 * complaint is that reconstruction loses things quietly.
 *
 * Truncation is loud. When the log does not fit, the OLDEST messages are dropped — the tail
 * is where the unfinished work is — and the notice says how many went, so a participant that
 * needs the beginning knows to ask rather than assuming it saw everything.
 */
/**
 * One message as the resumed participants read it, with `unsettled` honoured (#94).
 *
 * The marker was already ON the message -- `RelayMessage.unsettled` exists precisely so that
 * "anything consuming the routing log rather than watching the console" is not told an
 * unverified body is an ordinary one. This function was that consumer, and it dropped the
 * field: an empty unsettled report rendered as a header with nothing under it, which is
 * indistinguishable from a participant that genuinely said nothing, and reads as established
 * fact under a briefing whose own first line is "treat it as established".
 *
 * Observed on oath-lang. The halt that followed the lost report predicted this in as many
 * words -- "a resume from this log starts with that turn saying nothing" -- and it did.
 *
 * A qualification rather than a redaction: an unsettled body that HAS text is still replayed
 * in full, because it is real narration and the only thing wrong with it is that it is not
 * the closing statement. What changes is that the reader is told which one they have.
 */
function bodyOf(m: RelayMessage): string {
  const text = m.text.trim()
  if (!m.unsettled) return text
  if (text === '') {
    return (
      '(this turn produced no readable account of itself: the transcript never settled and ' +
      'nothing was streamed. The turn DID complete and its work may be on disk -- treat the ' +
      'absence as missing information, not as a turn that did nothing.)'
    )
  }
  return `(unverified: read from a transcript that had not settled, so this may be incomplete)\n${text}`
}

export function resumeBriefing(messages: RelayMessage[], budget = BUDGET): string {
  const rendered = messages
    .filter((m) => m.visibility !== 'internal')
    .map((m) => {
      const to = m.to.length > 0 ? m.to.join(', ') : '(recorded only)'
      return `[${m.seq}] ${m.from} -> ${to}\n${bodyOf(m)}`
    })

  const kept: string[] = []
  let size = 0
  for (let i = rendered.length - 1; i >= 0; i--) {
    const entry = rendered[i]!
    if (size + entry.length > budget) break
    kept.unshift(entry)
    size += entry.length
  }
  const dropped = rendered.length - kept.length

  return [
    'THIS RUN IS A CONTINUATION. A previous run on this repository ended before the work was',
    'finished. You do not remember it: what follows is its routing log, replayed verbatim.',
    '',
    'Treat it as established. Do not re-derive findings it already records, and do not repeat',
    'work it shows as done. If something in it is ambiguous, ask rather than assuming — a',
    'wrong assumption here silently discards work that was already paid for.',
    ...(dropped > 0
      ? [
          '',
          `NOTE: the ${dropped} OLDEST message(s) were dropped to fit. What follows begins`,
          'mid-run. If you need what came before, say so.',
        ]
      : []),
    '',
    '--- previous run ---',
    kept.join('\n\n'),
    '--- end of previous run ---',
  ].join('\n')
}
