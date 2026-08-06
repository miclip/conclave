/**
 * Terminal rendering: markdown to ANSI, and a status line that updates in place.
 *
 * The console's job is to make a session readable, and participants write markdown —
 * headings, tables, fenced code, bold — which currently prints as raw asterisks and pipes.
 * The best terminal agent UIs are mostly RESTRAINT: sparse, low-chrome, colour used to
 * distinguish speakers rather than to decorate, and detail on demand.
 *
 * No dependencies. Colour is suppressed when NO_COLOR is set or the stream is not a TTY,
 * so piped output stays clean — the first live run of the console leaked escape codes into
 * a log because that check was missing.
 */

export interface Style {
  (s: string): string
}

function make(open: string): Style {
  return (s: string) => (ENABLED ? `\x1b[${open}m${s}\x1b[0m` : s)
}

let ENABLED = true
export function setColor(on: boolean): void {
  ENABLED = on
}
export function colorFor(stream: { isTTY?: boolean }): boolean {
  if (process.env.NO_COLOR) return false
  if (process.env.FORCE_COLOR) return true
  return stream.isTTY === true
}

export const dim = make('2')
export const bold = make('1')
export const italic = make('3')
export const red = make('31')
export const green = make('32')
export const yellow = make('33')
export const blue = make('34')
export const magenta = make('35')
export const cyan = make('36')
export const grey = make('90')

/** One colour per speaker, stable across a session so the eye can track them. */
export function speakerColor(id: string, rank: string): Style {
  if (rank === 'human') return magenta
  if (rank === 'advisor') return cyan
  if (rank === 'implementer') return green
  return grey
}

const RESET = /\x1b\[[0-9;]*m/g
const visible = (s: string) => s.replace(RESET, '').length

/** Wrap to width, preserving indent and ignoring ANSI in the measurement. */
function wrap(text: string, width: number, indent: string): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w
    if (visible(candidate) + indent.length > width && line) {
      lines.push(indent + line)
      line = w
    } else {
      line = candidate
    }
  }
  if (line) lines.push(indent + line)
  return lines
}

/** Inline spans: `code`, **bold**, *italic*, and bare URLs. */
function inline(s: string): string {
  return s
    .replace(/`([^`\n]+)`/g, (_, c) => yellow(c))
    .replace(/\*\*([^*\n]+)\*\*/g, (_, c) => bold(c))
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, (_, c) => italic(c))
    .replace(/(?<![_\w])_([^_\n]+)_(?!\w)/g, (_, c) => italic(c))
}

function renderTable(rows: string[][], indent: string, width: number): string[] {
  const cols = Math.max(...rows.map((r) => r.length))
  const w: number[] = []
  for (let c = 0; c < cols; c++) {
    w[c] = Math.max(...rows.map((r) => visible(inline(r[c] ?? ''))))
  }
  // Shrink proportionally if the table would overflow; a wrapped table is unreadable, a
  // truncated cell is merely lossy and says so with an ellipsis.
  const total = w.reduce((a, b) => a + b + 3, 0) + indent.length
  if (total > width) {
    const scale = (width - indent.length - cols * 3) / w.reduce((a, b) => a + b, 0)
    for (let c = 0; c < cols; c++) w[c] = Math.max(6, Math.floor(w[c]! * scale))
  }
  const cell = (s: string, c: number) => {
    const r = inline(s)
    const len = visible(r)
    if (len > w[c]!) return `${r.slice(0, Math.max(0, w[c]! - 1))}…`
    return r + ' '.repeat(w[c]! - len)
  }
  const out: string[] = []
  rows.forEach((r, i) => {
    const line = Array.from({ length: cols }, (_, c) => cell(r[c] ?? '', c)).join(dim(' │ '))
    out.push(indent + (i === 0 ? bold(line) : line))
    if (i === 0) out.push(indent + dim(w.map((n) => '─'.repeat(n)).join('─┼─')))
  })
  return out
}

export interface MarkdownOptions {
  width?: number
  indent?: string
}

/** Markdown → ANSI. Covers what participants actually write, and nothing else. */
export function markdown(text: string, opts: MarkdownOptions = {}): string {
  const width = opts.width ?? 100
  const indent = opts.indent ?? '  '
  const out: string[] = []
  const lines = text.replace(/\r/g, '').split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!

    // Fenced code: printed verbatim, dim-bordered, never wrapped.
    const fence = /^\s*```(\w*)\s*$/.exec(line)
    if (fence) {
      i++
      const body: string[] = []
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i]!), i++
      i++
      if (fence[1]) out.push(`${indent}${dim(fence[1])}`)
      for (const b of body) out.push(`${indent}${dim('│')} ${b}`)
      out.push('')
      continue
    }

    // Tables: a header row followed by a separator of dashes and pipes.
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1]!)) {
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i]!)) {
          rows.push(lines[i]!.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
        }
        i++
      }
      out.push(...renderTable(rows, indent, width), '')
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      out.push('', `${indent}${bold(inline(heading[2]!))}`)
      i++
      continue
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      const pad = indent + ' '.repeat(bullet[1]!.length)
      const wrapped = wrap(inline(bullet[2]!), width, `${pad}  `)
      out.push(`${pad}${dim('•')} ${wrapped[0]?.trimStart() ?? ''}`, ...wrapped.slice(1))
      i++
      continue
    }

    const numbered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line)
    if (numbered) {
      const pad = indent + ' '.repeat(numbered[1]!.length)
      const wrapped = wrap(inline(numbered[3]!), width, `${pad}   `)
      out.push(`${pad}${dim(`${numbered[2]}.`)} ${wrapped[0]?.trimStart() ?? ''}`, ...wrapped.slice(1))
      i++
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      out.push(`${indent}${dim('▏')} ${italic(inline(quote[1]!))}`)
      i++
      continue
    }

    if (!line.trim()) {
      if (out.at(-1) !== '') out.push('')
      i++
      continue
    }

    out.push(...wrap(inline(line.trim()), width, indent))
    i++
  }

  while (out.at(-1) === '') out.pop()
  return out.join('\n')
}

/**
 * The opening banner.
 *
 * The three dots are the speaker legend: the colours used throughout for you, the advisor
 * and the implementer. Teaching the code once here means every later line reads without a
 * key, which is the only reason to spend four lines on a banner at all.
 */
export function banner(opts: {
  version: string
  advisor: string
  implementer: string
  cwd: string
  checks: string[]
}): string {
  const legend = `${magenta('●')} ${cyan('●')} ${green('●')}`
  const rotation = opts.checks.length > 0 ? opts.checks.join(', ') : dim('off — no checks configured')
  return [
    '',
    `  ${legend}  ${bold('conclave')} ${dim(opts.version)}`,
    `        ${dim('you')} · ${cyan(`advisor ${opts.advisor}`)} · ${green(`implementer ${opts.implementer}`)}`,
    `        ${dim(opts.cwd)}`,
    `        ${dim('rotation:')} ${rotation}`,
    '',
  ].join('\n')
}

/** A full-width rule, for separating the transcript from the input area. */
export function rule(width: number): string {
  return dim('─'.repeat(Math.max(8, width)))
}

/**
 * Progress while a turn runs: append-only, throttled, never redrawn.
 *
 * This replaced an in-place spinner, and the reason is worth keeping. The spinner and
 * readline both wrote to the last line of the terminal, and readline redraws on its own
 * schedule — on every keypress, on every `prompt()`. So whichever wrote last won, and the
 * loser was left stranded in the transcript. Three rounds of fixes to the erase logic each
 * looked right offline and each still duplicated live, because the premise was wrong: two
 * subsystems cannot both own the cursor.
 *
 * Append-only output has no such contention. It cannot strand a line because it never goes
 * back, and it cannot duplicate because it only ever moves forward. The cost is that there
 * is no animation, which is a real loss and a smaller one than a console that lies about
 * what is happening.
 *
 * A pinned status line is still the nicer answer, and it needs the console to own the
 * screen — a scroll region or an alternate buffer, with readline replaced by its own input
 * handling. That is a different piece of work, not a tweak to this one.
 */
export class Progress {
  #out: NodeJS.WritableStream
  #enabled: boolean
  #everyMs: number
  #started = new Map<string, number>()
  #lastPrinted = new Map<string, number>()
  #detail = new Map<string, string>()

  /**
   * `enabled` gates nothing about the cursor, because this writes no escape codes — it is
   * here only so a caller can silence progress entirely. It must NOT be tied to whether the
   * stream is a terminal: gating it that way made a piped run print no progress at all,
   * which is precisely the run used to inspect it.
   */
  constructor(out: NodeJS.WritableStream, enabled = true, everyMs = 10_000) {
    this.#out = out
    this.#enabled = enabled
    this.#everyMs = everyMs
  }

  start(participant: string): void {
    this.#started.set(participant, Date.now())
    this.#lastPrinted.delete(participant)
  }

  /**
   * The single live line for a pinned footer: who is working, for how long, doing what.
   *
   * Preferred over `activity()` wherever there is somewhere to pin it. Appending progress
   * to the transcript produced lines that differ only in their elapsed time — `implementer
   * 8s · Bash` then `implementer 20s · Bash` — which read as duplicates however correct
   * they are. One line that updates says the same thing and repeats nothing.
   */
  line(colour: (s: string) => string = (x) => x): string {
    const active = [...this.#started.entries()]
    if (active.length === 0) return ''
    const [participant, startedAt] = active[active.length - 1]!
    const detail = this.#detail.get(participant)
    return `${dim('⋯')} ${colour(participant)} ${dim(elapsedSince(startedAt))}${detail ? ` ${dim('·')} ${dim(detail)}` : ''}`
  }

  /** Remember what a participant is doing, without printing anything. */
  note(participant: string, detail: string): void {
    this.#detail.set(participant, detail)
  }

  /**
   * Report activity, at most once per interval per participant.
   *
   * Throttled rather than per-event because a busy turn emits a tool call every few hundred
   * milliseconds, and a line each would bury the prose the console exists to show. Used
   * only where there is no pinned footer to hold a live line instead.
   */
  activity(participant: string, colour: Style, detail?: string): void {
    if (!this.#enabled) return
    const startedAt = this.#started.get(participant)
    if (startedAt === undefined) return
    const last = this.#lastPrinted.get(participant) ?? 0
    const now = Date.now()
    if (now - last < this.#everyMs) return
    this.#lastPrinted.set(participant, now)
    const parts = [dim('⋯'), colour(participant), dim(elapsedSince(startedAt))]
    if (detail) parts.push(dim('·'), dim(detail))
    this.#out.write(`  ${parts.join(' ')}\n`)
  }

  /** The turn ended; the report follows, so nothing is printed here. */
  done(participant: string): void {
    this.#started.delete(participant)
    this.#lastPrinted.delete(participant)
    this.#detail.delete(participant)
  }
}

export function elapsedSince(startedAt: number): string {
  const s = Math.round((Date.now() - startedAt) / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}
