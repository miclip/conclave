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

import { ceilingSummary } from '../relay/guardrails.ts'
import { SESSION_HEARTBEAT_MS, sessionStaleness, type ReadSession } from './sessionRecord.ts'

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
  // ...and since #126 it does not have to be inferred from that number. Immediately after the
  // line it qualifies, and before everything below it, because everything below it is what the
  // record CLAIMED and this is the warning that the claim may predate what the run is doing now.
  const stale = sessionStaleness(s, now)
  if (stale) {
    lines.push(
      `  STALE:     nothing has written this record in ${elapsed(stale.ageMs)}, and a live run ` +
        `rewrites it every ${elapsed(SESSION_HEARTBEAT_MS)}.`,
    )
    lines.push(
      `             pid ${st.pid} is still there, so everything below is what the run last ` +
        `managed to say — not necessarily what it is doing.`,
    )
  }
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
    // The same three states the JSON distinguishes, said in words rather than left to be
    // inferred from an empty array. A prose reader deciding how to answer a pause needs
    // "rotation is possible here" as plainly as a parser does, and the seat this run reports
    // it for is the seat `rotate` would act on.
    if (p.rotation) {
      const r = p.rotation
      const how = r.onDegradation ? `, on degradation: ${r.onDegradation}` : ''
      if (r.armed) {
        const checks = r.checks
          .map((c) => (c.relevance === 'required' ? c.command : `${c.command} [${c.relevance}]`))
          .join(', ')
        lines.push(`    rotation:  ARMED${how} — ${checks}`)
      } else if (r.configured) {
        // Not the same sentence as the line below it, and the difference is the whole point:
        // this seat was named and given no checks, which is a policy saying it cannot be
        // rotated -- not a run that forgot to configure one.
        lines.push(`    rotation:  not armed for this seat — its policy sets no checks${how}`)
      } else {
        lines.push('    rotation:  not armed — no checks configured for this run')
      }
    }
  }
  if (st.pause) {
    lines.push(`  PAUSED: ${st.pause.reason} — ${st.pause.detail}`)
    for (const e of st.pause.evidence) lines.push(`    ${e}`)
    lines.push(`    options: ${st.pause.options.join(', ')}`)
  }
  // The same line the launch banners print, from the same renderer. A prose reader asking why
  // a run stopped early needs the bound as plainly as a parser does -- and needs it to be the
  // bound the run actually had, not one recomposed here from a different set of fields.
  if (st.ceilings) lines.push(`  ceilings:  ${ceilingSummary(st.ceilings)}`)
  // Only when something rotated. The JSON carries the empty array because a probe cannot tell an
  // absent key from a false one (#103); a prose reader can tell an absent LINE from a present one
  // perfectly well, and printing `rotations: none` on every run of a feature most runs never
  // reach is the noise this renderer keeps out.
  //
  // The intent is on the line rather than only in the JSON because it is what makes the entry
  // readable at all: "implementer replaced" beside a compaction generation reads as the proxy
  // having fired, whether or not it did, and that misreading is the whole of #75.
  for (const r of st.rotations ?? []) {
    lines.push(`  rotated:   ${r.seat} (${r.intent}) — ${r.reason}`)
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
 *
 * `stale` is the third, and it is the one that APPEARS AND DISAPPEARS. See `sessionStaleness`
 * for what it means. Present only when there is something to warn about, and appended, so a
 * fresh document has the same keys in the same order with the same types it had before #126 --
 * D1, and the shape guard in `defaultUnchanged.test.ts` pins exactly that. NOT byte-identical,
 * and the difference matters to a reader: `updatedAt` now advances on a heartbeat and means
 * when the file was last WRITTEN rather than when the state last changed, so its value moves on
 * a run where nothing has happened. A consumer diffing two polls of an idle run sees that field
 * change; one reading keys, order or types sees nothing new.
 *
 * Appearing-and-disappearing is the opposite of how `rotation` and `ceilings` argue, where an
 * absent key was mistaken for a false one (#103), and the difference is that those describe the
 * RUN, permanently, while this describes THIS READ: a consumer's `if (doc.stale)` cannot misread
 * an absent key here, because absent is the fact.
 */
export function formatSessionJson(s: ReadSession, now: number = Date.now()): string {
  const stale = sessionStaleness(s, now)
  return JSON.stringify(
    { ...s.status, alive: s.alive, abandoned: s.abandoned, ...(stale ? { stale } : {}) },
    null,
    2,
  )
}
