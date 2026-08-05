/**
 * PTY process lifecycle.
 *
 * Byte-level behaviour is ported from spikes/common/ptydriver.py, which drove real
 * Claude Code and Codex sessions successfully. The parts that look arbitrary are not:
 * each was established by a spike and is cited below. The public surface is new; the
 * spike's architecture deliberately does not come with it.
 *
 * This module moves BYTES and owns process lifetime. It does not know what any of those
 * bytes mean -- screen content is used only to prove a child is alive and interactive,
 * never for semantics or turn boundaries.
 */

import { EventEmitter } from 'node:events'
import type { Env } from './childenv.ts'

// Neither CLI uses the alternate screen buffer: Claude Code 2.1.222 and Codex 0.146.0
// both render inline with cursor-addressed redraws. Bracketed paste is the reliable
// "this is a real interactive raw-mode UI" signal -- a piped or headless run has no
// reason to enable it. Testing for ?1049h reports a false negative on both.
export const TUI_MARKERS: Record<string, string> = {
  altScreen: '[?1049h',
  bracketedPaste: '[?2004h',
  focusEvents: '[?1004h',
  hideCursor: '[?25l',
  kittyKeyboard: '[>7u',
}

export const DECISIVE_TUI_MARKERS = ['bracketedPaste', 'focusEvents', 'kittyKeyboard'] as const

const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\[[0-9;?>=]*[ -/]*[@-~]|[\]P^_].*?(?:|\\)|[@-Z\\-_]/gs

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

/** TUIs wrap and redraw, so a literal match against raw output gives false negatives. */
export function squash(s: string): string {
  return stripAnsi(s).replace(/\s+/g, '')
}

export interface PtyOptions {
  file: string
  args: string[]
  cwd: string
  /** Required and fully constructed. See process/childenv.ts -- never process.env. */
  env: Env
  rows?: number
  cols?: number
}

export type ExitReason = 'graceful' | 'sigterm' | 'sigkill' | 'spontaneous'

export interface ExitInfo {
  exitCode: number
  signal?: number
  reason: ExitReason
}

/** How the process ended, from the adapter's point of view. */
export interface PtyProcessEvents {
  data: [string]
  exit: [ExitInfo]
}

export class PtyProcess extends EventEmitter<PtyProcessEvents> {
  #pty: any
  #buffer = ''
  #alive = true
  #exit?: ExitInfo
  #requestedReason?: ExitReason
  #markers = new Set<string>()

  private constructor(pty: any) {
    super()
    this.#pty = pty
    pty.onData((chunk: string) => {
      this.#buffer += chunk
      for (const [name, seq] of Object.entries(TUI_MARKERS)) {
        if (!this.#markers.has(name) && chunk.includes(seq)) this.#markers.add(name)
      }
      this.emit('data', chunk)
    })
    pty.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      this.#alive = false
      this.#exit = {
        exitCode,
        signal,
        // An exit we did not ask for is spontaneous, and that distinction matters:
        // close() must not manufacture an outcome for a child that died on its own.
        reason: this.#requestedReason ?? 'spontaneous',
      }
      this.emit('exit', this.#exit)
    })
  }

  static async spawn(opts: PtyOptions): Promise<PtyProcess> {
    const { default: pty } = await import('node-pty')
    const child = pty.spawn(opts.file, opts.args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 40,
      cwd: opts.cwd,
      env: opts.env,
    })
    return new PtyProcess(child)
  }

  get pid(): number {
    return this.#pty.pid
  }

  get alive(): boolean {
    return this.#alive
  }

  get exitInfo(): ExitInfo | undefined {
    return this.#exit
  }

  get output(): string {
    return this.#buffer
  }

  get markers(): string[] {
    return [...this.#markers]
  }

  /** True once the child has negotiated a raw-mode interactive UI. */
  get isInteractive(): boolean {
    return DECISIVE_TUI_MARKERS.some((m) => this.#markers.has(m))
  }

  write(data: string): void {
    if (!this.#alive) throw new Error('write to a dead pty')
    this.#pty.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this.#alive) this.#pty.resize(cols, rows)
  }

  /** Resolves when `predicate` sees the accumulated output, or on timeout/exit. */
  waitForOutput(predicate: (all: string) => boolean, timeoutMs: number): Promise<boolean> {
    if (predicate(this.#buffer)) return Promise.resolve(true)
    return new Promise((resolve) => {
      const done = (v: boolean) => {
        clearTimeout(timer)
        this.off('data', onData)
        this.off('exit', onExit)
        resolve(v)
      }
      const onData = () => {
        if (predicate(this.#buffer)) done(true)
      }
      const onExit = () => done(predicate(this.#buffer))
      const timer = setTimeout(() => done(false), timeoutMs)
      this.on('data', onData)
      this.on('exit', onExit)
    })
  }

  /** Resolves once the child has emitted nothing for `quietMs`. Spike-grade only. */
  async waitQuiet(quietMs: number, maxWaitMs: number): Promise<boolean> {
    const deadline = Date.now() + maxWaitMs
    let lastLength = -1
    while (Date.now() < deadline) {
      lastLength = this.#buffer.length
      await new Promise((r) => setTimeout(r, quietMs))
      if (!this.#alive) return false
      if (this.#buffer.length === lastLength) return true
    }
    return false
  }

  /**
   * Always SIGTERM and wait before escalating. SIGKILL leaves no transcript at all,
   * while SIGTERM leaves a truncated but real one -- verified in spike 3. Escalating
   * early discards the only durable record of the session.
   */
  async terminate(opts: { graceMs?: number; killAfterMs?: number } = {}): Promise<ExitInfo> {
    const { graceMs = 5000, killAfterMs = 5000 } = opts
    if (!this.#alive) return this.#exit!

    const exited = new Promise<ExitInfo>((resolve) => this.once('exit', resolve))

    this.#requestedReason = 'sigterm'
    try {
      this.#pty.kill('SIGTERM')
    } catch {
      /* already gone */
    }

    const timedOut = Symbol('timeout')
    const first = await Promise.race([
      exited,
      new Promise<typeof timedOut>((r) => setTimeout(() => r(timedOut), graceMs)),
    ])
    if (first !== timedOut) return first as ExitInfo

    this.#requestedReason = 'sigkill'
    try {
      this.#pty.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    const second = await Promise.race([
      exited,
      new Promise<typeof timedOut>((r) => setTimeout(() => r(timedOut), killAfterMs)),
    ])
    if (second === timedOut) {
      throw new Error(`pty ${this.pid} survived SIGKILL`)
    }
    return second as ExitInfo
  }
}
