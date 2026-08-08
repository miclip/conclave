/**
 * Rendering a recorded session, for a human and for a machine.
 *
 * Split from `sessionRecord.ts` for the reason `report.ts` gives about its own fields:
 * writing the record and reading it back are different jobs with different failure modes,
 * and a module that did both would let a rendering choice quietly change the format.
 *
 * The prose and the JSON describe the same thing and the JSON is the whole record — not a
 * hand-picked subset. A caller that had to fall back to parsing the prose for one missing
 * field is a caller that will parse the prose for all of them.
 */

import type { ReadSession } from './sessionRecord.ts'

export function elapsed(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/**
 * One line per session, for a listing.
 *
 * `abandoned` is shown in place of the claimed state rather than beside it, because that is
 * the reading a listing has to make unmissable: a row saying `running` for a process that no
 * longer exists is the exact ambiguity that nearly produced a filed bug — a retry that could
 * not be told from a double start.
 */
export function formatSessionLine(s: ReadSession, now: number): string {
  const st = s.status
  const state = s.abandoned ? `abandoned (last said ${st.state})` : st.state
  const age = elapsed(now - st.updatedAt)
  const goal = st.goal ? st.goal.replace(/\s+/g, ' ').slice(0, 48) : '(no goal yet)'
  return `${st.id}  ${state.padEnd(28)}  updated ${age} ago  ${goal}`
}

/** The full record as prose. Every field the JSON has, in the order an operator reads them. */
export function formatSession(s: ReadSession, now: number): string {
  const st = s.status
  const lines: string[] = []
  lines.push(`session ${st.id}`)
  lines.push(`  goal:      ${st.goal || '(none yet)'}`)
  lines.push(`  cwd:       ${st.cwd}`)
  lines.push(`  front:     ${st.front}   operator: ${st.operator}`)
  lines.push(
    `  state:     ${st.state}${s.abandoned ? '  — but pid ' + st.pid + ' is gone; this run did not finish' : ''}`,
  )
  lines.push(`  pid:       ${st.pid}${s.alive ? ' (alive)' : ' (not running)'}`)
  lines.push(`  started:   ${elapsed(now - st.startedAt)} ago`)
  // The single most useful number for "is it stuck". A status that has not been touched in
  // twenty minutes says something no amount of state does.
  lines.push(`  updated:   ${elapsed(now - st.updatedAt)} ago`)
  lines.push(`  messages:  ${st.messages}`)
  for (const p of st.participants) {
    const bits: string[] = []
    if (p.awaitingPermission) bits.push(`AWAITING PERMISSION for ${p.awaitingPermission.tool}`)
    if (p.activity) {
      bits.push(
        `${p.activity.kind}${p.activity.tool ? ` ${p.activity.tool}` : ''} ` +
          `(${elapsed(now - p.activity.since)} ago)`,
      )
    }
    lines.push(`  ${p.id.padEnd(12)} ${p.agent.padEnd(9)} ${p.rank.padEnd(12)} ${bits.join('  ') || 'idle'}`)
  }
  if (st.pause) {
    lines.push(`  PAUSED: ${st.pause.reason} — ${st.pause.detail}`)
    for (const e of st.pause.evidence) lines.push(`    ${e}`)
    lines.push(`    options: ${st.pause.options.join(', ')}`)
  }
  if (st.outcome) {
    lines.push(`  outcome:   ${st.outcome.reason}${st.outcome.detail ? ` — ${st.outcome.detail}` : ''}`)
  }
  lines.push(`  events:    ${st.eventsPath}`)
  if (st.logPath) lines.push(`  run log:   ${st.logPath}`)
  return lines.join('\n')
}

/**
 * The record as JSON.
 *
 * `alive` and `abandoned` are included, and they are the only two fields not read from the
 * file: they are what the reader learned by checking the pid. A consumer must not have to
 * repeat that check, and one that did would repeat it differently.
 */
export function formatSessionJson(s: ReadSession): string {
  return JSON.stringify({ ...s.status, alive: s.alive, abandoned: s.abandoned }, null, 2)
}
