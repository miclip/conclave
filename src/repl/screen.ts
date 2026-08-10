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
import { rowsUsed } from './width.ts'
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
  /**
   * One row per implementer seat that is working, shown ABOVE the pending queue.
   *
   * Rows rather than more text on the status rule, which is where this used to have to go.
   * The rule inlays ONE line — `── ⠋ implementer 5s · Grep ────` — and it is the right shape
   * for one worker and the wrong one for several: four seats put four names, four clocks and
   * four tool names on a row that has to fit the terminal, so it wraps, and a wrapped rule
   * occupies a row the box did not reserve and paints over the transcript.
   *
   * Empty at N=1, where the rule holds the one worker exactly as it always has.
   */
  seats?: () => string[]
}

/** Pinned rows spent on the queue before it starts crowding the transcript. */
const MAX_PENDING_ROWS = 3

/**
 * Pinned rows spent on working seats before the box starts crowding the transcript.
 *
 * The same cap as the queue and for the same reason: a run may have more seats than the
 * terminal has rows to spare, and a box that grew with the seat count would eat the
 * transcript it exists to annotate. Deliberately NOT a per-seat column budget — sharing one
 * row between four seats gives each a fifth of the width and truncates the only part that
 * differs between them, which is worse than saying plainly that some are not shown.
 */
const MAX_SEAT_ROWS = 3

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
  /**
   * The last screen row occupied by transcript output.
   *
   * The box's position is DERIVED from this rather than fixed at the bottom of the terminal,
   * which is the difference between a console that starts where you launched it and one that
   * does not. A box permanently at the floor has to be met: either output is separated from
   * the startup rule by a band of blank rows, or — the version that shipped — the whole
   * screen is scrolled down to close the gap, dragging the operator's own shell prompt with
   * it. Both were reported as bugs, because both are the console moving text the operator
   * was reading.
   *
   * So it grows instead. Output prints directly under the last line, the box follows it down
   * a row at a time, and when it reaches the floor it stays there and the region scrolls
   * underneath it exactly as before. The anchored end state is the old behaviour; what
   * changes is that the console arrives at it rather than starting there.
   */
  #contentRow = 0
  /**
   * The row the box was last painted at, so it can be erased before it is painted elsewhere.
   *
   * `draw()` erases from the box's BOTTOM downward, which is right while it descends — the
   * only stale rows are the copy it just left below itself. It is wrong whenever the box
   * moves UP, and a resize is the first thing that ever did that: the abandoned frame sits
   * above the new one, nothing clears it, and it stays until the transcript scrolls over it.
   */
  #drawnTop: number | undefined
  #onResize = () => {
    // A resize is the one event after which conclave does not know where its own output is.
    //
    // The terminal REFLOWS the scrollback it already has: every line longer than the new
    // width rewraps, so the row the transcript ends on moves by an amount that depends on
    // the text above, not on the size change. `#contentRow` is not told, and querying the
    // cursor does not help — the cursor is sitting in the input box, not at the end of the
    // transcript, so the answer describes where the box was rather than where the text is.
    //
    // So it anchors, which is the same answer given to a terminal that never replies to the
    // cursor query: when the position of the content is unknown, the floor is the one place
    // the box is certainly not on top of anything. The descending box is given up for the
    // rest of the session, which is a real cost and the right one — the alternative on show
    // in #54 was several box frames on screen at once, each drawn against a row that no
    // longer meant anything.
    if (this.#drawnTop !== undefined) {
      // Erase the old frame first. It was drawn for the previous dimensions, so its rules are
      // padded to a width that no longer matches and its rows are not where they were.
      this.#out.write(`${ESC}${Math.min(this.#drawnTop, this.rows)};1H${ESC}0J`)
    }
    this.#contentRow = this.#floor
    this.#reserve()
    this.draw()
  }

  /**
   * The lowest row transcript output may occupy: everything below belongs to the box.
   *
   * Depends on `#height`, which changes as the queue and the menu grow, so it is computed
   * rather than stored — a stored floor and a grown box disagree, and the box wins by
   * painting over a line somebody was reading.
   */
  get #floor(): number {
    return Math.max(1, this.rows - this.#height)
  }

  /** The row the box starts on: just under the content, or the floor once it gets there. */
  get #boxTop(): number {
    return Math.min(this.#contentRow + 1, this.#floor + 1)
  }

  /**
   * How many screen rows a write will occupy.
   *
   * Counts wrapping, because a line longer than the terminal takes more than one row and a
   * box placed as though it did not would land on top of it. Measured in columns rather
   * than characters — see `width.ts`; a transcript full of CJK is half as many rows as its
   * `String.length` suggests, and accented Latin is fewer still.
   *
   * Only ever consulted while the box is still descending. Once anchored the terminal's own
   * scrolling keeps the count, and any drift here stops mattering.
   */
  #rowsUsed(text: string): number {
    return rowsUsed(text, this.columns)
  }

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
      this.#out.write(`${ESC}r${ESC}${this.#boxTop};1H`)
      if (this.#o.input.isTTY) this.#o.input.setRawMode(false)
    } catch {
      /* the stream may already be gone; nothing useful to do */
    }
  }

  async open(): Promise<void> {
    if (this.#open) return
    this.#open = true
    process.once('exit', this.#restore)
    // Raw mode must be on before the cursor query, otherwise the terminal reply cannot be read.
    if (this.#o.input.isTTY) {
      this.#o.input.setRawMode(true)
      this.#o.input.resume()
    }

    // The console prints the banner, the rule, and setup messages before the screen is
    // created, so the box has to be placed relative to them rather than to the terminal. Ask
    // the terminal where the cursor is and start the box on the next row: output continues
    // where the startup messages left off, and nothing already on screen moves.
    //
    // A terminal that never answers falls back to `rows`, which clamps to the floor — the
    // fully-anchored box this used to start with. Degrading to the old behaviour is the
    // point of that default; it is the one arrangement known to be safe on a terminal we
    // have learned nothing about.
    const { pos, leftover } = await this.#queryCursorPosition()
    this.#contentRow = Math.min(pos?.row ?? this.rows, this.#floor)

    this.#reserve()

    if (this.#o.input.isTTY) {
      emitKeypressEvents(this.#o.input)
    }
    this.#o.input.on('keypress', this.#key)
    this.#o.output.on('resize', this.#onResize)
    this.draw()

    // Re-emit any input that arrived while we were waiting for the cursor-position reply, so
    // keystrokes typed before the box was drawn are not lost.
    if (leftover) {
      this.#o.input.emit('data', Buffer.from(leftover))
    }
  }

  /**
   * Set the scrolling region to everything above the floor.
   *
   * The region is the FINAL one from the very first call, even while the box is still
   * descending through it. That is deliberate: the region only does anything once output
   * reaches its last row, and until then the box is repainted below the content on every
   * draw anyway. Resizing the region as the box moved would mean a DECSTBM for every line
   * of output, and each one homes the cursor.
   *
   * Nothing is scrolled here. The previous version shifted the whole screen down with
   * `ESC[{n}T` to bring already-printed rows to a box waiting at the floor, which moved the
   * operator's shell prompt along with it.
   */
  #reserve(): void {
    this.#out.write(`${ESC}1;${this.#floor}r${ESC}${this.#contentRow};1H`)
  }

  async #queryCursorPosition(): Promise<{ pos?: { row: number; col: number }; leftover?: string }> {
    const input = this.#o.input
    if (!input.isTTY) return {}
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      const cprRe = /\x1b\[(\d+);(\d+)R/
      let timer: NodeJS.Timeout | undefined
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        input.off('data', onData)
      }
      const onData = (chunk: Buffer) => {
        chunks.push(chunk)
        const s = Buffer.concat(chunks).toString()
        const m = cprRe.exec(s)
        if (m) {
          cleanup()
          const marker = `\x1b[${m[1]};${m[2]}R`
          const idx = s.indexOf(marker)
          resolve({
            pos: { row: parseInt(m[1]!, 10), col: parseInt(m[2]!, 10) },
            leftover: s.slice(0, idx) + s.slice(idx + marker.length),
          })
        }
      }
      input.on('data', onData)
      timer = setTimeout(() => {
        cleanup()
        resolve({ leftover: Buffer.concat(chunks).toString() })
      }, 500)
      this.#out.write(`${ESC}6n`)
    })
  }

  close(): void {
    if (!this.#open) return
    process.off('exit', this.#restore)
    this.#open = false
    this.#o.input.off('keypress', this.#key)
    this.#out.off('resize', this.#onResize)
    if (this.#o.input.isTTY) this.#o.input.setRawMode(false)
    // Clear the box and everything under it, drop the region, and leave the cursor where the
    // transcript ended rather than at the bottom of the terminal. Without resetting the
    // region the operator's next command scrolls inside our box; without placing the cursor
    // their next shell prompt appears at the floor, separated from the session's last line by
    // the blank rows the box used to cover — the exit-time version of the jump this whole
    // arrangement exists to avoid.
    this.#out.write(`${ESC}${this.#boxTop};1H${ESC}0J${ESC}r${ESC}${this.#boxTop};1H`)
  }

  /** Print into the scrolling region, leaving the input box untouched. */
  write(text: string): void {
    if (!this.#open) {
      this.#out.write(`${text}\n`)
      return
    }
    if (this.#contentRow < this.#floor) {
      // Still descending: print directly under the last line. `ESC[0J` wipes from there to
      // the bottom of the screen first, which erases the box at its current position —
      // everything below the cursor at this point IS the box, and the redraw below puts it
      // back one row lower. Without it a short line leaves the tail of the old box beside it.
      this.#out.write(`${ESC}${this.#contentRow};1H\n${ESC}0J${text}`)
      this.#contentRow = Math.min(this.#floor, this.#contentRow + this.#rowsUsed(text))
    } else {
      // Anchored: the region scrolls under a box that no longer moves. Save, move to the
      // region's last row, print, restore. Do not remove the save/restore — a version
      // without it shipped as 0.2.11 and made prose wander back and forth across the screen.
      this.#out.write(`${ESC}s${ESC}${this.#floor};1H\n${text}${ESC}u`)
    }
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
   * The working-seat rows, capped the same way, and naming where the rest can be read.
   *
   * `/state` rather than a count alone, and rather than a command invented for the message:
   * an overflow line that says only how many are hidden tells the operator they are missing
   * something and not how to stop missing it. `/state` prints every seat with its task and
   * its branch, which is the whole state this row is a summary of.
   */
  #seatRows(): string[] {
    const all = this.#o.seats?.() ?? []
    if (all.length <= MAX_SEAT_ROWS) return all
    const shown = all.slice(0, MAX_SEAT_ROWS - 1)
    return [...shown, `${all.length - shown.length} more working — /state`]
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
    const wasFloor = this.#floor
    this.#height = height
    // A taller box lowers the floor. Content already below the new one has to go somewhere,
    // and only here — while the box is anchored, or has just been overtaken by it — is
    // pushing the transcript up the right answer: those rows are about to be painted over.
    // While the box is still descending there is nothing to push, because it takes its extra
    // rows from the blank screen underneath rather than from the transcript.
    const overflow = this.#contentRow - this.#floor
    if (overflow > 0) {
      this.#out.write(`${ESC}s${ESC}${wasFloor};1H${'\n'.repeat(overflow)}${ESC}u`)
      this.#contentRow = this.#floor
    }
    this.#out.write(`${ESC}1;${this.#floor}r`)
  }

  /** Redraw the reserved rows from scratch. */
  draw(): void {
    if (!this.#open) return
    const queued = this.#pendingRows()
    const working = this.#seatRows()
    const menuRows = this.#menuRows()
    // Every variable-height band is counted here, and this is the only place any of them is:
    // the box's height and the rows it paints are computed from the same three arrays in the
    // same draw, so a band can never be drawn into a row the region was not shrunk to free.
    this.#resize(this.#base + queued.length + working.length + menuRows.length - 1)
    const w = this.columns
    const top = this.#boxTop
    this.#drawnTop = top
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
    // Clipped to the width one row at a time, and NOT dimmed here: a seat row carries its own
    // colour for the seat id, which is what tells two of them apart at a glance, and wrapping
    // the whole row in an attribute would flatten that. Clipping matters more than for the
    // queue — the box reserved exactly one row for each of these, so a row that wrapped would
    // be drawn into the row below it, which is another seat's.
    const seatRows = working.map((t) => {
      const text = `  ${t}`
      const visibleWidth = visible(text)
      if (visibleWidth <= w) return text
      // Escapes cost no columns, so the slice is taken against the visible length: cutting
      // the raw string at `w` would cut a colour sequence in half and leave the rest of the
      // box wearing it.
      const budget = Math.max(1, w - 1 - (text.length - visibleWidth))
      return `${text.slice(0, budget)}…\x1b[0m`
    })
    const rows = [...seatRows, ...waiting, head, `${prompt}${this.#line}`, rule, ...menuRows]
    let out = `${ESC}s`
    rows.forEach((text, i) => {
      out += `${ESC}${top + i};1H${ESC}2K${text}`
    })
    // While the box is descending it does not reach the bottom of the terminal, and the rows
    // under it hold whatever it painted there a moment ago. Erase to the end of the screen so
    // the box does not leave a copy of itself behind each time it moves down a row.
    const bottom = top + this.#height - 1
    if (bottom < this.rows) out += `${ESC}${bottom + 1};1H${ESC}0J`
    // Cursor into the input row, after the prompt and the typed text.
    // Counted past BOTH bands above the rule. The input row is the rule's row plus one, and
    // the rule's row moves down by every seat row as well as by every queued one.
    out += `${ESC}${top + seatRows.length + waiting.length + 1};${visible(prompt) + this.#cursor + 1}H`
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
