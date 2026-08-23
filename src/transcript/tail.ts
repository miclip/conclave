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
 *
 * The verification and the suffix must come from the SAME bytes, or the mechanism certifies one
 * state of the file and consumes another (#167). Compaction rewrites these transcripts, and it
 * does not wait for a poll to finish: a poll that opened the file once per operation could pass
 * its prefix check against content that had already ceased to exist, take its suffix from the
 * file that replaced it, and report the result as an APPEND -- leaving everything derived from
 * the vanished prefix live, and the projection half one file and half another.
 *
 * So a poll takes ONE handle, asks THAT HANDLE how big the file is, reads the whole of it once,
 * and answers every question from that single buffer. A replacement by rename leaves the handle
 * on the old inode, so the poll yields a coherent OLD projection and the next poll -- which
 * opens the path afresh -- sees the rewrite and voids it.
 *
 * Be exact about what that buys, because it is easy to claim too much. It removes the
 * INTER-OPERATION race, and only that: there is no longer a window between "the prefix is
 * intact" and "here is the suffix" for the file to change in, because both answers are cut from
 * one buffer. It is NOT a filesystem snapshot. A rewrite is a truncate and a write, not one
 * atomic act, and a write overlapping the read syscall itself can still tear across it; nothing
 * at this layer can prevent that. The claim is that a poll can no longer CERTIFY one state of
 * the file and CONSUME another -- not that the bytes it holds are a state the file ever wholly
 * had.
 *
 * One rule spans both answers a poll can give, and it took #168 to state it as one: a record the
 * writer has not finished is not a record. The append path always trimmed to the last complete
 * line; the rewrite path did not, and consumed the half-written tail while correctly declining
 * to parse it. Dropping a fragment from the OUTPUT is right. Dropping it from the OUTPUT while
 * taking it from the INPUT is what turns a record that is merely EARLY into a record that is
 * GONE -- the writer completes it, the bytes already banked are still a valid prefix, so no
 * rewrite is seen and only the unparseable remainder is read. So `#offset` and `#prefixDigest`
 * cover complete lines and nothing else, on both paths, and a partial record is always simply
 * waited for.
 */

import { createHash } from 'node:crypto'
import { open, type FileHandle } from 'node:fs/promises'

/** `\n`. The record separator, as a byte, because that is how the buffer is searched. */
const NEWLINE = 0x0a

export interface TailPoll<T> {
  /** Records appended since the last poll. Empty after a rewrite -- see `rebuilt`. */
  appended: T[]
  /**
   * Set when the file no longer starts with what we already consumed. Everything
   * previously derived is void; `all` carries the full re-read.
   */
  rewritten: boolean
  /**
   * Present only when `rewritten`. The rewritten file re-read from the start -- as far as its
   * last COMPLETE line, which is as far as it can honestly be read (#168). A record the writer
   * was still in the middle of is not here, and has not been consumed either; the poll that
   * finds it finished delivers it as an ordinary append. Empty when the rewritten file has no
   * complete line at all, which is a real answer and not a missing one: the file contains no
   * whole record, so neither does this.
   */
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

  /**
   * The file as one buffer, through one handle: open it, ask THAT HANDLE how big it is, and read
   * the whole of it once. Everything a poll concludes is derived from what this returns.
   *
   * `undefined` is "could not be opened, or could not be measured" -- the condition the old
   * `stat` on the PATH reported, and it produces the same non-answer for the caller. A read that
   * fails still throws, as it always did, and a read that comes back SHORT is one of those.
   */
  async #readWhole(): Promise<Buffer | undefined> {
    let fh: FileHandle
    try {
      fh = await open(this.path, 'r')
    } catch {
      return undefined
    }
    try {
      let size: number
      try {
        size = (await fh.stat()).size
      } catch {
        return undefined
      }
      const buf = Buffer.alloc(size)
      if (size === 0) return buf
      const { bytesRead } = await fh.read(buf, 0, size, 0)
      // Deliberately NOT a fill loop. A second read is a second window for exactly the rewrite
      // this method exists to shut out, and it would open it in the worst possible shape: old
      // bytes at the front, new bytes behind them, in one buffer that then looks self-consistent
      // to everything downstream.
      //
      // Nor is a short read a shorter FILE. Whatever produced it -- a signal, a filesystem that
      // declines to fill the request, a rewrite shrinking the file between the fstat and the
      // read -- what came back is a FRAGMENT, and a fragment is a state of the file that never
      // existed.
      //
      // What believing one COSTS changed with #168, and the honest version is the smaller
      // claim. It used to be record loss: a fragment whose prefix no longer matches is routed
      // to the rewrite branch, that branch did not trim to the last complete line, and it would
      // set `#offset` past half a record and bank a digest over it -- after which no poll ever
      // delivered that record. Now that both branches trim, the fragment's complete lines are
      // consumed and its partial tail is left for the next poll, so the records survive.
      //
      // The guard stays, because what is left is not nothing. A fragment that fails the prefix
      // check is reported as a REWRITE, and a rewrite is not a cheap false alarm: it tells
      // every consumer downstream that history changed and that everything derived from it is
      // void. Manufacturing that out of a file nobody touched is a lie about the transcript,
      // paid for by a full rebuild. It is also the wrong thing to rest on -- "believing a
      // fragment is survivable" holds only as long as every branch that handles one gets the
      // trimming right, which is precisely the assumption #168 found broken.
      //
      // So a read that did not deliver what it was asked for is a failed read. Fail it, commit
      // nothing, and let the next poll ask again from an offset that never moved.
      if (bytesRead !== size) {
        throw new Error(
          `short read on ${this.path}: got ${bytesRead} of ${size} bytes`,
        )
      }
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
   *
   * Reads no file of its own. It is handed the very buffer the suffix will be cut from, which is
   * what makes its verdict binding on that suffix instead of on a state the file has since left.
   */
  #prefixIntact(whole: Buffer): boolean {
    if (this.#offset === 0) return true
    if (whole.length < this.#offset) return false
    const head = createHash('sha256').update(whole.subarray(0, this.#offset)).digest('hex')
    return head === this.#prefixDigest
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
   *
   * The awaits did not go away when the poll went down to one read; they moved INSIDE
   * `#readWhole`, which opens, fstats, reads and closes. What did move is the FIRST abandonment
   * check, which used to sit between the old `stat` and the reads that followed it and now sits
   * after all four, including the close. So a read whose lease expires early no longer skips the
   * reading -- it does the whole of it and then declines to commit. It still commits nothing,
   * which is the property that matters and the one the tests pin; it is simply no longer the
   * cheap way to find out. Checking the lease between the fstat and the read would restore that
   * without reopening the race, and is deliberately not done here: it would put the lease inside
   * `#readWhole`, and the saving is one read of a file already open.
   *
   * The remaining checks are kept and are NOT redundant. `abandoned` is a live reading and a
   * DEADLINE one: `boundedReconcile` answers it with `released || Date.now() >= deadlineAt`,
   * which can turn over between two consecutive synchronous reads of it. A commit point needs a
   * current answer, not the one that happened to be true when the read came back.
   */
  async poll(lease?: ReadLease): Promise<TailPoll<T>> {
    // The poll's only filesystem work. Not its only await: `#readWhole` opens, fstats, reads
    // and closes, and each of those is one. Everything below reasons about the bytes it returns.
    const whole = await this.#readWhole()
    if (whole === undefined) return { appended: [], rewritten: false, first: !this.#started }
    if (lease?.abandoned) return this.#nonAnswer()

    const size = whole.length
    const first = !this.#started
    // Not a commit, and the one piece of state an abandoned read is allowed to leave behind:
    // it records that this TAIL has successfully stat'd its file at least once, which is true
    // however the read that established it ended, and it feeds nothing but `first`.
    this.#started = true

    if (!this.#prefixIntact(whole)) {
      if (lease?.abandoned) return this.#nonAnswer()
      // The same rule as the append path below, for the same reason, on the path that is MORE
      // likely to meet it: a rewrite is a writer writing, which is exactly when a poll catches a
      // record half done. Trimming here is not a refinement of the old behaviour, it is the
      // difference between a delay and a loss -- see this file's header (#168).
      //
      // A byte index, taken from the buffer rather than from a decode of it. The append path
      // reaches the same answer through `lastIndexOf` on a string and `Buffer.byteLength` back
      // again; here there is nothing to gain by the round trip, and one fewer place for a
      // multi-byte character to make a string index and a byte offset disagree.
      const lastNewline = whole.lastIndexOf(NEWLINE)
      // -1 means the rewritten file has no complete line at all, and 0 is then the honest
      // offset: there is no coherent prefix to bank, so bank none. The rewrite is still
      // REPORTED -- what the consumer held is void either way, and staying silent about that to
      // avoid an awkward `all: []` would leave it holding records the file no longer contains.
      // The record now being written is not skipped; with the offset at zero the next poll
      // reads it as a plain append, whole.
      const consumed = lastNewline + 1
      this.#offset = consumed
      this.#prefixDigest = createHash('sha256')
        .update(whole.subarray(0, consumed))
        .digest('hex')
      return {
        appended: [],
        rewritten: true,
        all: this.#parseAll(whole.subarray(0, consumed).toString('utf8')),
        first,
      }
    }

    if (size === this.#offset) return { appended: [], rewritten: false, first }

    // Only consume through the last complete line; a partially-written record must not
    // be parsed, and must not poison the prefix digest.
    const text = whole.subarray(this.#offset, size).toString('utf8')
    const lastNewline = text.lastIndexOf('\n')
    if (lastNewline === -1) return { appended: [], rewritten: false, first }

    const complete = text.slice(0, lastNewline + 1)
    const consumed = Buffer.byteLength(complete, 'utf8')
    if (lease?.abandoned) return this.#nonAnswer()
    this.#offset += consumed
    // The same bytes the old code went back to the file for. Taking them from `whole` is not
    // merely cheaper: that re-read was a third chance to digest a file that had changed since
    // the prefix was checked, and to bank the result as though it were ours.
    this.#prefixDigest = createHash('sha256')
      .update(whole.subarray(0, this.#offset))
      .digest('hex')

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
