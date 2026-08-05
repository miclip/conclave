/**
 * A tail that expects its file to be rewritten under it.
 *
 * Both CLIs compact: Codex writes `compacted` lines and `context_compacted` events,
 * Claude Code writes `compact_file_reference` attachments. Compaction rewrites history,
 * so a plain byte-offset tailer with append-only derived state will eventually contradict
 * its own source -- it will hold turns that the transcript no longer contains.
 *
 * Format markers are a fast path, not the mechanism. The mechanism is prefix
 * verification: remember a digest of the bytes already consumed, and re-check it. If the
 * prefix changed, history was rewritten and everything derived from it is void,
 * regardless of whether we recognised the marker that caused it.
 */

import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'

export interface TailPoll<T> {
  /** Records appended since the last poll. Empty after a rewrite -- see `rebuilt`. */
  appended: T[]
  /**
   * Set when the file no longer starts with what we already consumed. Everything
   * previously derived is void; `all` carries the full re-read.
   */
  rewritten: boolean
  /** Present only when `rewritten`. The entire file, freshly parsed. */
  all?: T[]
  /** True on the first successful poll, when there is nothing to rewrite yet. */
  first: boolean
}

export class RewriteAwareTail<T> {
  readonly path: string
  #offset = 0
  #prefixDigest = createHash('sha256').update('').digest('hex')
  #started = false
  readonly #parse: (line: string) => T | undefined

  constructor(path: string, parse: (line: string) => T | undefined) {
    this.path = path
    this.#parse = parse
  }

  get consumedBytes(): number {
    return this.#offset
  }

  async #readRange(from: number, to: number): Promise<Buffer> {
    const fh = await open(this.path, 'r')
    try {
      const len = Math.max(0, to - from)
      const buf = Buffer.alloc(len)
      if (len > 0) await fh.read(buf, 0, len, from)
      return buf
    } finally {
      await fh.close()
    }
  }

  #parseAll(text: string): T[] {
    const out: T[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      const v = this.#parse(line)
      if (v !== undefined) out.push(v)
    }
    return out
  }

  /**
   * A rewrite is anything that makes our consumed prefix no longer the file's prefix:
   * truncation, or the same length with different content.
   */
  async #prefixIntact(size: number): Promise<boolean> {
    if (this.#offset === 0) return true
    if (size < this.#offset) return false
    const head = await this.#readRange(0, this.#offset)
    return createHash('sha256').update(head).digest('hex') === this.#prefixDigest
  }

  async poll(): Promise<TailPoll<T>> {
    let size: number
    try {
      size = (await stat(this.path)).size
    } catch {
      return { appended: [], rewritten: false, first: !this.#started }
    }

    const first = !this.#started
    this.#started = true

    if (!(await this.#prefixIntact(size))) {
      const whole = await this.#readRange(0, size)
      this.#offset = size
      this.#prefixDigest = createHash('sha256').update(whole).digest('hex')
      return { appended: [], rewritten: true, all: this.#parseAll(whole.toString('utf8')), first }
    }

    if (size === this.#offset) return { appended: [], rewritten: false, first }

    const chunk = await this.#readRange(this.#offset, size)
    // Only consume through the last complete line; a partially-written record must not
    // be parsed, and must not poison the prefix digest.
    const text = chunk.toString('utf8')
    const lastNewline = text.lastIndexOf('\n')
    if (lastNewline === -1) return { appended: [], rewritten: false, first }

    const complete = text.slice(0, lastNewline + 1)
    const consumed = Buffer.byteLength(complete, 'utf8')
    const head = await this.#readRange(0, this.#offset + consumed)
    this.#offset += consumed
    this.#prefixDigest = createHash('sha256').update(head).digest('hex')

    return { appended: this.#parseAll(complete), rewritten: false, first }
  }
}

export function parseJsonLine(line: string): Record<string, any> | undefined {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}
