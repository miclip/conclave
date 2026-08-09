/**
 * A pinned input area at the bottom of the terminal.
 *
 * Three attempts to do this with readline failed the same way: readline owns the line the
 * cursor is on and redraws it whenever it likes, so anything else writing there is either
 * overwritten or left stranded. The premise was wrong — two subsystems cannot both own the
 * cursor — and no amount of erase-ordering fixes it.
 *
 * So the console takes the screen instead, with a DEC scrolling region:
 *
 *   ESC[1;{rows-h}r   confine scrolling to the top rows
 *   transcript        printed there, scrolls normally, never touches the bottom
 *   ESC[{row};1H      absolute addressing for the reserved rows
 *
 * The reserved rows are redrawn from scratch on every keystroke, which is cheap and means
 * there is no incremental state to get out of step. Input is handled here rather than by
 * readline, because readline cannot be told to draw somewhere else.
 *
 * Everything is restored on close: region, cursor, raw mode. A console that leaves a
 * terminal with a scrolling region set is a console that breaks the next command the
 * operator runs.
 */

import type { Suggestion } from './complete.ts'
import { emitKeypressEvents } from 'node:readline'

export interface Key {
  name?: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  sequence?: string
}

export interface ScreenOptions {
  input: NodeJS.ReadStream
  output: NodeJS.WriteStream
  /** Rows reserved at the bottom: rule, input, rule, footer. */
  height?: number
  onLine: (line: string) => void
  onInterrupt: () => void
  /**
   * Inlaid into the rule ABOVE the input: what is happening right now.
   *
   * On the rule rather than on a row of its own, because a permanent row for a line that is
   * usually one short phrase is a row spent on nothing.
   */
  status: () => string
  /**
   * The row BELOW the input, which is contextual: slash commands while a command is being
   * typed, completion candidates while completing, nothing otherwise.
   *
   * That row is the only place a suggestion can appear without pushing the transcript
   * around, so it is worth more as an answer to what is being typed than as a status line.
   */
  hint: () => string
  prompt: () => string
  /**
   * Candidates for what is being typed, recomputed on every edit.
   *
   * The screen owns selection and application: a menu that the caller applied would mean
   * two things editing one buffer, which is the mistake that made the status line take
   * three attempts.
   */
  suggest?: (line: string, cursor: number) => Suggestion | undefined
  /**
   * Messages typed but not yet delivered, shown ABOVE the input box.
   *
   * They belong in the pinned region rather than the transcript because their status
   * changes: a line already scrolled past cannot stop being provisional. Pinning them is
   * what lets them be dim while they wait and then be written into the transcript in
   * normal type once a participant has actually taken them.
   *
   * Nothing pending means no rows spent, so the box is its usual four lines when there is
   * nothing to say about it.
   */
  pending?: () => string[]
}

/** Pinned rows spent on the queue before it starts crowding the transcript. */
const MAX_PENDING_ROWS = 3

/** Rows the candidate list may wrap onto before it admits it is showing a prefix. */
const MAX_MENU_ROWS = 3

const ESC = '\x1b['
const dimmed = (s: string) => `\x1b[2m${s}\x1b[0m`

export class Screen {
  #o: ScreenOptions
  #out: NodeJS.WriteStream
  #height: number
  #line = ''
  #cursor = 0
  #history: string[] = []
  #historyAt = 0
  /**
   * `index` is -1 when nothing is selected, which is how the menu OPENS. Pre-selecting the
   * first item would mean the menu had already made a choice on the operator's behalf, and
   * for participants that choice is wrong: no prefix at all reaches both, so a menu that
   * arrives with `>advisor` highlighted teaches that narrowing is mandatory. Nothing is
   * selected until an arrow says so, and enter with nothing selected submits the line.
   */
  #menu: (Suggestion & { index: number }) | undefined
  #open = false
  #base: number
  #onResize = () => this.#reserve()

  constructor(opts: ScreenOptions) {
    this.#o = opts
    this.#out = opts.output
    this.#height = opts.height ?? 4
    this.#base = this.#height
  }

  /** What is currently typed. The hint row answers it, so it has to be able to see it. */
  get line(): string {
    return this.#line
  }

  get rows(): number {
    return this.#out.rows ?? 24
  }
  get columns(): number {
    return this.#out.columns ?? 80
  }

  /**
   * Restore the terminal on ANY exit, not only the tidy one.
   *
   * A scrolling region outlives the process that set it: leave one behind and every command
   * the operator runs afterwards scrolls inside our four rows. `close()` handles the normal
   * path, but a throw, a `process.exit`, or a signal would skip it — so the reset is also
   * registered as an exit hook, which must be synchronous and must not assume `close()` ran.
   */
  #restore = (): void => {
    if (!this.#open) return
    this.#open = false
    try {
      this.#out.write(`${ESC}r${ESC}${this.rows};1H`)
      if (this.#o.input.isTTY) this.#o.input.setRawMode(false)
    } catch {
      /* the stream may already be gone; nothing useful to do */
    }
  }

  open(): void {
    if (this.#open) return
    this.#open = true
    process.once('exit', this.#restore)
    this.#reserve()
    if (this.#o.input.isTTY) {
      emitKeypressEvents(this.#o.input)
      this.#o.input.setRawMode(true)
      this.#o.input.resume()
    }
    this.#o.input.on('keypress', this.#key)
    this.#out.on('resize', this.#onResize)
    this.draw()
  }

  /**
   * Reserve the bottom rows.
   *
   * The region is set first, then the cursor is parked on the last scrolling row, so the
   * first line of output lands above the box rather than inside it.
   */
  #reserve(): void {
    const last = Math.max(1, this.rows - this.#height)
    this.#out.write(`${ESC}1;${last}r${ESC}${last};1H`)
    this.draw()
  }

  close(): void {
    if (!this.#open) return
    process.off('exit', this.#restore)
    this.#open = false
    this.#o.input.off('keypress', this.#key)
    this.#out.off('resize', this.#onResize)
    if (this.#o.input.isTTY) this.#o.input.setRawMode(false)
    // Clear the reserved rows, drop the region, and leave the cursor at the bottom. Without
    // resetting the region the operator's next command scrolls inside our box.
    for (let r = this.rows - this.#height + 1; r <= this.rows; r++) {
      this.#out.write(`${ESC}${r};1H${ESC}2K`)
    }
    this.#out.write(`${ESC}r${ESC}${this.rows};1H`)
  }

  /** Print into the scrolling region, leaving the input box untouched. */
  write(text: string): void {
    if (!this.#open) {
      this.#out.write(`${text}\n`)
      return
    }
    const last = Math.max(1, this.rows - this.#height)
    // Save, move into the scrolling area, print, restore. `ESC[s`/`ESC[u` are honoured by
    // every terminal that honours the region, and are cheaper than tracking a row.
    this.#out.write(`${ESC}s${ESC}${last};1H\n${text}${ESC}u`)
    this.draw()
  }

  /** The pending rows, capped, with an overflow line rather than an unbounded box. */
  #pendingRows(): string[] {
    const all = this.#o.pending?.() ?? []
    if (all.length <= MAX_PENDING_ROWS) return all
    const shown = all.slice(0, MAX_PENDING_ROWS - 1)
    return [...shown, `${all.length - shown.length} more queued — /queue`]
  }

  /**
   * The candidate rows, wrapped to the width, or the hint row when no menu is open.
   *
   * Wrapping rather than truncating, because a fixed cap of eight items hid `/exit` — the
   * tenth command, and the one an operator most needs to be able to find — and hid it
   * silently. A menu that looks complete is read as complete, so the failure was not that
   * two items were missing but that nothing said so.
   *
   * Bounded at three rows all the same: `@` over a large directory has no natural limit,
   * and a picker that can swallow half the screen is worse than one that admits it is
   * showing a prefix.
   */
  #menuRows(): string[] {
    const menu = this.#menu
    if (!menu) return [this.#o.hint()]
    const w = this.columns
    // Width is tracked alongside the text rather than measured from it: the rendered string
    // carries escapes that occupy no columns, so its `.length` is not what fits on a row.
    const rows: { text: string; width: number }[] = [{ text: ' ', width: 1 }]
    let hiddenFrom = menu.items.length
    for (const [i, item] of menu.items.entries()) {
      const cost = item.length + 2
      let row = rows[rows.length - 1]!
      if (row.width + cost > w && row.width > 1) {
        if (rows.length === MAX_MENU_ROWS) {
          hiddenFrom = i
          break
        }
        row = { text: ' ', width: 1 }
        rows.push(row)
      }
      row.text += i === menu.index ? `\x1b[7m ${item} \x1b[0m` : ` ${dimmed(item)} `
      row.width += cost
    }
    const last = rows[rows.length - 1]!
    const hidden = menu.items.length - hiddenFrom
    if (hidden > 0) last.text += dimmed(` +${hidden} more`)
    else if (menu.note && last.width + menu.note.length + 4 <= w) {
      last.text += `  ${dimmed(menu.note)}`
    }
    return rows.map((r) => r.text)
  }

  /**
   * Grow or shrink the reserved region as the queue changes.
   *
   * Growing has to push the transcript up FIRST. The region is shrinking from the bottom,
   * so the rows it takes are rows that already hold text; writing newlines at the old
   * bottom scrolls that text up into scrollback the way ordinary output does, instead of
   * painting the box over the last thing a participant said.
   */
  #resize(height: number): void {
    if (height === this.#height) return
    if (height > this.#height) {
      const last = Math.max(1, this.rows - this.#height)
      this.#out.write(`${ESC}s${ESC}${last};1H${'\n'.repeat(height - this.#height)}${ESC}u`)
    } else {
      // Shrinking frees rows that still hold the old box; clear them so they do not linger
      // above the transcript as text nothing will overwrite.
      for (let r = this.rows - this.#height + 1; r <= this.rows; r++) {
        this.#out.write(`${ESC}${r};1H${ESC}2K`)
      }
    }
    this.#height = height
    const last = Math.max(1, this.rows - this.#height)
    this.#out.write(`${ESC}1;${last}r`)
  }

  /** Redraw the reserved rows from scratch. */
  draw(): void {
    if (!this.#open) return
    const queued = this.#pendingRows()
    const menuRows = this.#menuRows()
    this.#resize(this.#base + queued.length + menuRows.length - 1)
    const w = this.columns
    const top = this.rows - this.#height + 1
    const rule = '─'.repeat(Math.max(4, w))
    const prompt = this.#o.prompt()
    const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length

    // The status is inlaid into the top rule: `──── ⋯ implementer 5s · Grep ─────`.
    const status = this.#o.status()
    const head = status
      ? `${'─'.repeat(2)} ${status} ${'─'.repeat(Math.max(0, w - visible(status) - 4))}`
      : rule
    // Dim AND italic: two signals, because a terminal that drops one usually keeps the
    // other, and this is the difference between "said" and "not yet said".
    const waiting = queued.map((t) => {
      const text = `  ${t}`
      const clipped = text.length > w ? `${text.slice(0, Math.max(1, w - 1))}…` : text
      return `\x1b[2;3m${clipped}\x1b[0m`
    })
    const rows = [...waiting, head, `${prompt}${this.#line}`, rule, ...menuRows]
    let out = `${ESC}s`
    rows.forEach((text, i) => {
      out += `${ESC}${top + i};1H${ESC}2K${text}`
    })
    // Cursor into the input row, after the prompt and the typed text.
    out += `${ESC}${top + waiting.length + 1};${visible(prompt) + this.#cursor + 1}H`
    this.#out.write(out)
  }

  #key = (str: string | undefined, key: Key = {}): void => {
    if (!this.#open) return
    // Match the raw byte as well as the parsed key. In raw mode the interrupt arrives as
    // ETX, and depending on how the sequence is decoded `key.name` is not always `c` — an
    // interrupt that does not interrupt leaves the operator with no way out but another
    // terminal.
    const etx = str === '\x03' || key.sequence === '\x03'
    if (etx || (key.ctrl && key.name === 'c')) return void this.#o.onInterrupt()
    const eot = str === '\x04' || key.sequence === '\x04'
    if ((eot || (key.ctrl && key.name === 'd')) && this.#line === '') return void this.#o.onInterrupt()

    // A menu takes the keys that would otherwise move through history or submit. That is
    // what makes it a picker rather than a list you have to type past.
    if (this.#menu) {
      if (key.name === 'escape') {
        this.#menu = undefined
        this.draw()
        return
      }
      // Left and right first, because the candidates are laid out left to right and the
      // arrow that matches the layout is the one an operator reaches for. Up and down work
      // too rather than being an error: a menu is not the place to be strict about which
      // arrow you meant.
      //
      // This does cost cursor movement while a menu is open. Escape gets it back, and the
      // menu is open precisely when the cursor sits at the end of the token being typed,
      // where there is nothing to the right to move to.
      const forward = key.name === 'right' || key.name === 'down'
      const back = key.name === 'left' || key.name === 'up'
      if (forward || back) {
        const n = this.#menu.items.length
        // From "nothing selected", forward lands on the first and back on the last.
        this.#menu.index =
          this.#menu.index < 0 ? (forward ? 0 : n - 1) : (this.#menu.index + (forward ? 1 : n - 1)) % n
        this.draw()
        return
      }
      // Tab completes the obvious one even with nothing selected — that is what tab has
      // always meant. Enter does not: with nothing selected it submits the line as typed,
      // so the default stays reachable without dismissing the menu first.
      if (key.name === 'tab') return void this.#accept(Math.max(0, this.#menu.index))
      if ((key.name === 'return' || key.name === 'enter') && this.#menu.index >= 0) {
        return void this.#accept(this.#menu.index)
      }
    } else if (key.name === 'tab') {
      // No menu and nothing to suggest: tab does nothing rather than inserting a tab into
      // a message bound for a participant.
      this.draw()
      return
    }

    switch (key.name) {
      case 'return':
      case 'enter': {
        const line = this.#line
        this.#line = ''
        this.#cursor = 0
        if (line.trim()) {
          this.#history.push(line)
          this.#historyAt = this.#history.length
        }
        this.draw()
        this.#o.onLine(line)
        return
      }
      case 'backspace':
        if (this.#cursor > 0) {
          this.#line = this.#line.slice(0, this.#cursor - 1) + this.#line.slice(this.#cursor)
          this.#cursor--
        }
        break
      case 'delete':
        this.#line = this.#line.slice(0, this.#cursor) + this.#line.slice(this.#cursor + 1)
        break
      case 'left':
        this.#cursor = Math.max(0, this.#cursor - 1)
        break
      case 'right':
        this.#cursor = Math.min(this.#line.length, this.#cursor + 1)
        break
      case 'home':
        this.#cursor = 0
        break
      case 'end':
        this.#cursor = this.#line.length
        break
      case 'up':
      case 'down': {
        if (this.#history.length === 0) break
        this.#historyAt += key.name === 'up' ? -1 : 1
        this.#historyAt = Math.max(0, Math.min(this.#history.length, this.#historyAt))
        this.#line = this.#history[this.#historyAt] ?? ''
        this.#cursor = this.#line.length
        break
      }
      default:
        // Printable only. Control sequences arrive with a name and no useful `str`, and
        // inserting them would put escape bytes into a message bound for a participant.
        if (str && !key.ctrl && !key.meta && str >= ' ' && str !== '\x7f') {
          this.#line = this.#line.slice(0, this.#cursor) + str + this.#line.slice(this.#cursor)
          this.#cursor += str.length
        }
    }
    this.#refreshMenu()
    this.draw()
  }

  /** Replace the suggested span with the highlighted item. */
  #accept(index: number): void {
    const m = this.#menu
    if (!m) return
    const item = m.items[index] ?? ''
    // A directory gets no suffix, so the next keystroke descends into it rather than
    // starting a new word.
    const insert = item.endsWith('/') ? item : `${item}${m.suffix}`
    this.#line = this.#line.slice(0, m.start) + insert + this.#line.slice(m.end)
    this.#cursor = m.start + insert.length
    this.#menu = undefined
    this.#refreshMenu()
    this.draw()
  }

  #refreshMenu(): void {
    const next = this.#o.suggest?.(this.#line, this.#cursor)
    if (!next || next.items.length === 0) {
      this.#menu = undefined
      return
    }
    // Keep the selection on the same item while it is still offered, so narrowing a search
    // does not silently move the choice under the cursor.
    // Keep the selection on the item it was on, and drop back to "nothing selected" if that
    // item stopped being offered — moving it to a neighbour would change the choice under
    // the operator without a keystroke saying so.
    const previous = this.#menu && this.#menu.index >= 0 ? this.#menu.items[this.#menu.index] : undefined
    this.#menu = { ...next, index: previous ? next.items.indexOf(previous) : -1 }
  }
}
