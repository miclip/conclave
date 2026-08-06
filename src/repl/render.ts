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

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * A one-line status that updates in place while a turn runs, and is erased when it ends.
 *
 * The interval is unref'd so it can never hold the process open — the console already
 * learned that lesson from a child process that outlived its test by 26 minutes.
 */
export class Status {
  #out: NodeJS.WritableStream
  #timer: NodeJS.Timeout | undefined
  #frame = 0
  #started = 0
  #label = ''
  #detail = ''
  #drawn = false
  #enabled: boolean

  /**
   * `suppressed` yields true while the operator has typed something.
   *
   * The spinner and readline's prompt occupy the same line, so an unconditional spinner
   * overwrites a half-typed message every 90ms. Deferring to the human is the only sane
   * precedence: readline redraws on keypress and owns the line, and the spinner resumes
   * once the buffer is empty again.
   */
  #suppressed: () => boolean

  constructor(out: NodeJS.WritableStream, enabled: boolean, suppressed: () => boolean = () => false) {
    this.#out = out
    this.#enabled = enabled
    this.#suppressed = suppressed
  }

  start(label: string): void {
    this.#label = label
    this.#detail = ''
    this.#started = Date.now()
    // A blank line between the prose above and the status below. Without it the spinner
    // butts straight up against the last line of a report and the two read as one block.
    if (this.#enabled) this.#out.write('\n')
    if (!this.#enabled || this.#timer) return
    this.#timer = setInterval(() => this.#draw(), 90)
    this.#timer.unref()
  }

  detail(d: string): void {
    this.#detail = d
    if (this.#enabled) this.#draw()
  }

  get elapsed(): string {
    const s = Math.round((Date.now() - this.#started) / 1000)
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  }

  #draw(): void {
    if (this.#suppressed()) return
    const frame = FRAMES[this.#frame++ % FRAMES.length]!
    const parts = [cyan(frame), this.#label, dim(this.elapsed)]
    if (this.#detail) parts.push(dim('·'), dim(this.#detail))
    this.#out.write(`\r\x1b[2K  ${parts.join(' ')}`)
    this.#drawn = true
  }

  /** Erase, so the transcript above stays clean rather than accumulating spinner corpses. */
  clear(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
    if (this.#drawn) this.#out.write('\r\x1b[2K')
    this.#drawn = false
  }
}
