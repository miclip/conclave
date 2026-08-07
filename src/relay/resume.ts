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
export function resumeBriefing(messages: RelayMessage[], budget = BUDGET): string {
  const rendered = messages
    .filter((m) => m.visibility !== 'internal')
    .map((m) => {
      const to = m.to.length > 0 ? m.to.join(', ') : '(recorded only)'
      return `[${m.seq}] ${m.from} -> ${to}\n${m.text.trim()}`
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
