/**
 * What a run says about itself, for the glasses' session list (#278).
 *
 * The bridge in `client.ts` knows the wire shape and nothing about conclave; this is the part
 * that knows where a run's record is and reads it. Sourced from the REAL record every time it
 * is asked, so a run that did something after its session opened re-sorts on the next poll.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'

import { readSession, type ReadSession } from '../../workspace/sessionRecord.ts'
import type { SessionMetadata, SessionState } from './client.ts'

/** How much of `events.ndjson` is read per step, walking backward from the end. */
export const TAIL_CHUNK = 64 * 1024

/**
 * When the run last did something, as a millisecond timestamp.
 *
 * The newest VALID event's `at` in `events.ndjson`, else `startedAt`. Never `updatedAt`, and
 * deliberately: that field is a heartbeat -- rewritten every `SESSION_HEARTBEAT_MS` whether
 * anything changed or not (`sessionRecord.ts`) -- so every live run would carry a near-identical
 * value, the ordering on the glasses would collapse, and a run stuck for two hours would read as
 * though it had just moved. The vendor's field is the mtime of a transcript that only grows when
 * something is appended, and this matches what it MEANS rather than just its name.
 *
 * `startedAt` for a run with no events yet is true, sorts correctly, and claims no activity
 * that did not happen.
 */
export function lastActivityAt(status: ReadSession['status']): number {
  return lastEventAt(status.eventsPath) ?? status.startedAt
}

/**
 * The `at` of the newest event whose line parses, or undefined when none does.
 *
 * Read BACKWARD in bounded chunks until a valid event is found or the file begins, rather than
 * one fixed slice of the tail: a slice can be entirely garbage -- a torn line longer than it,
 * or a long run of them -- and then "no valid event" would be said of a stream that has
 * thousands. Bounded per step so the app polling every few seconds does not read a megabyte
 * stream whole; the walk only goes as far back as the newest event that parses.
 *
 * Lines are split on the byte, and only a COMPLETE line is decoded and parsed. The newest
 * partial fragment at the top of a chunk is carried into the next step, which is what lets an
 * event line that straddles a chunk boundary be read whole. Anything that does not parse is
 * skipped -- a trailing partial line is expected, because the writer appends whole lines but a
 * reader can arrive between the write and its newline (`bin/conclave.ts`'s follower makes the
 * same allowance).
 */
export function lastEventAt(eventsPath: string): number | undefined {
  if (!existsSync(eventsPath)) return undefined
  let fd: number
  let end: number
  try {
    end = statSync(eventsPath).size
    fd = openSync(eventsPath, 'r')
  } catch {
    return undefined
  }
  try {
    // The bytes after `end` that have not yet formed a complete line: the head of the newest
    // line seen so far, waiting for the chunk before it.
    let carry = Buffer.alloc(0)
    while (end > 0) {
      const from = Math.max(0, end - TAIL_CHUNK)
      const chunk = Buffer.alloc(end - from)
      readSync(fd, chunk, 0, chunk.length, from)
      const bytes = Buffer.concat([chunk, carry])
      // Every complete line in this window, newest first. The segment before the first newline
      // is complete only if this window starts at the beginning of the file.
      const lines: Buffer[] = []
      let cut = bytes.length
      for (let i = bytes.length - 1; i >= 0; i--) {
        if (bytes[i] !== 0x0a) continue
        lines.push(bytes.subarray(i + 1, cut))
        cut = i
      }
      carry = bytes.subarray(0, cut)
      if (from === 0) lines.push(carry)
      for (const line of lines) {
        const at = eventAt(line)
        if (at !== undefined) return at
      }
      end = from
    }
    return undefined
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

/** One line's `at`, if the line is an event. */
function eventAt(line: Buffer): number | undefined {
  if (line.length === 0) return undefined
  try {
    const at = (JSON.parse(line.toString('utf8')) as { at?: unknown }).at
    return typeof at === 'number' && Number.isFinite(at) ? at : undefined
  } catch {
    return undefined // Not an event. The line before it may be.
  }
}

/**
 * What is genuinely known about a run's state, in the vendor's words, else `null`.
 *
 * Read from the run's recorded `progress`, which is the field that measures this, and NOT from
 * the process merely existing: a live run idling between turns is not busy, and calling every
 * live run `busy` would tell the operator nothing. In the vendor's words (`dist/claude/
 * session.js`: `awaiting` with an unanswered question, else `busy` or `idle`):
 *
 *   in_turn, live      busy      a seat is inside a turn
 *   paused, live       awaiting  waiting for a person, which is what the word means on the HUD
 *   idle               idle      nothing in flight, live or cleanly ended
 *   anything else      null      no progress recorded; an ending with a turn cut off
 *                                (`abandoned`); a record that says running with the process
 *                                gone -- what such a run is doing is exactly the thing nobody
 *                                knows, and `null` is the value the vendor lists before it knows
 *
 * A question outstanding on the bridge overrides all of this to `awaiting`, in `client.ts`.
 */
export function runState(s: ReadSession): SessionState | null {
  const ended = s.status.state === 'ended'
  if (!ended && !s.alive) return null
  const progress = s.status.progress?.state
  if (progress === 'idle') return 'idle'
  if (ended) return null
  if (progress === 'in_turn') return 'busy'
  if (progress === 'paused') return 'awaiting'
  return null
}

/** The run's record as list-item metadata, or undefined when it cannot be read right now. */
export function describeRun(repoRoot: string, runId: string): SessionMetadata | undefined {
  const found = readSession(repoRoot, runId)
  if (!found) return undefined
  return {
    title: found.status.goal,
    timestamp: new Date(lastActivityAt(found.status)).toISOString(),
    cwd: found.status.cwd,
    status: runState(found),
  }
}
