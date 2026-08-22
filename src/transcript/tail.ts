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
  /**
   * The read was abandoned before it committed anything, and this is a NON-ANSWER rather than
   * a poll result: the offset did not move, the digest was not replaced, and `appended` and
   * `all` are empty because nothing was consumed rather than because nothing was there.
   *
   * A caller must not read it as "the file is unchanged". See `ReadLease`.
   */
  abandoned?: boolean
}

/**
 * Handed to a poll so it can be told, mid-read, that nobody is listening any more.
 *
 * Structurally identical to `adapters/boundedReconcile.ts`'s `Abandonment`, and deliberately a
 * separate type: that one bounds how long an ADAPTER waits for a re-check, this one bounds how
 * long one read may hold up every other read on the same tail. They expire on different clocks
 * for different reasons, and a shared type would invite passing one where the other belongs --
 * quite apart from the transcript layer having no business importing from the adapter layer.
 *
 * A live reading, not a stored flag, for the reason spelled out on `Abandonment`: the parsing
 * that follows a read is synchronous, so a blocked loop resumes into the job's own microtask
 * continuations BEFORE any overdue timer callback, and a flag a timer writes still reads
 * `false` at the exact moment the guard consults it.
 */
export interface ReadLease {
  readonly abandoned: boolean
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

  /** A read that gave up: nothing consumed, nothing advanced, nothing claimed. */
  #nonAnswer(): TailPoll<T> {
    return { appended: [], rewritten: false, first: !this.#started, abandoned: true }
  }

  /**
   * Read what is new, and say what kind of change it was.
   *
   * `lease`, when given, is checked after every await that precedes a mutation of `#offset` or
   * `#prefixDigest`. An abandoned read must commit NOTHING -- not a partial advance, not a
   * fresh digest -- because its replacement is going to read from the same offset, and a half
   * committed abandoned read would either hand the records it consumed to nobody at all or
   * hand the same range to two readers. Committing nothing makes it a pure waste of I/O, which
   * is the only safe thing for it to be.
   *
   * The caller is responsible for the other half of it: at most one NON-abandoned poll may be
   * in flight at a time, and the lease must be monotone, so a read abandoned once can never come
   * back and commit.
   *
   * `TranscriptSessionView` passes no lease at all, and is entitled to: it never authorises a
   * second read while the first is unresolved -- see its `#inflight` -- so "two readers
   * committing" is not a race it has to win but a state it cannot reach, and a read of its that
   * overruns is a slow read holding records nobody else has. The parameter is here for a caller
   * that CAN have a rival, which is the only situation where discarding a completed read is
   * better than keeping it.
   */
  async poll(lease?: ReadLease): Promise<TailPoll<T>> {
    let size: number
    try {
      size = (await stat(this.path)).size
    } catch {
      return { appended: [], rewritten: false, first: !this.#started }
    }
    if (lease?.abandoned) return this.#nonAnswer()

    const first = !this.#started
    // Not a commit, and the one piece of state an abandoned read is allowed to leave behind:
    // it records that this TAIL has successfully stat'd its file at least once, which is true
    // however the read that established it ended, and it feeds nothing but `first`.
    this.#started = true

    if (!(await this.#prefixIntact(size))) {
      const whole = await this.#readRange(0, size)
      if (lease?.abandoned) return this.#nonAnswer()
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
    if (lease?.abandoned) return this.#nonAnswer()
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
