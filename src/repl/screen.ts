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
   * Tab completion. Returns the replacement line and cursor, or undefined to do nothing.
   *
   * The screen owns the buffer, so completion has to come back through it rather than
   * being applied by the caller — otherwise two things would be editing the same string.
   */
  complete?: (line: string, cursor: number) => { line: string; cursor: number } | undefined
  /** Any edit that is not a completion. Lets the caller drop a now-stale suggestion. */
  onEdit?: () => void
}

const ESC = '\x1b['

export class Screen {
  #o: ScreenOptions
  #out: NodeJS.WriteStream
  #height: number
  #line = ''
  #cursor = 0
  #history: string[] = []
  #historyAt = 0
  #open = false
  #onResize = () => this.#reserve()

  constructor(opts: ScreenOptions) {
    this.#o = opts
    this.#out = opts.output
    this.#height = opts.height ?? 4
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

  /** Redraw the reserved rows from scratch. */
  draw(): void {
    if (!this.#open) return
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
    const rows = [head, `${prompt}${this.#line}`, rule, this.#o.hint()]
    let out = `${ESC}s`
    rows.forEach((text, i) => {
      out += `${ESC}${top + i};1H${ESC}2K${text}`
    })
    // Cursor into the input row, after the prompt and the typed text.
    out += `${ESC}${top + 1};${visible(prompt) + this.#cursor + 1}H`
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

    if (key.name !== 'tab') this.#o.onEdit?.()

    if (key.name === 'tab') {
      const done = this.#o.complete?.(this.#line, this.#cursor)
      if (done) {
        this.#line = done.line
        this.#cursor = done.cursor
      }
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
    this.draw()
  }
}
