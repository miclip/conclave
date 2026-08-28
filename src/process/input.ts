/**
 * Serialized, attributed input.
 *
 * Two jobs, and the second is the one that matters for the lifecycle model:
 *
 * 1. Serialization. send(), cancel() and decidePermission() all write keystrokes to the
 *    same PTY. Interleaving them corrupts both -- half a prompt with an ESC in the
 *    middle is not a cancellation, it is garbage. Every action goes through one queue.
 *
 * 2. Attribution. The queue records SEMANTIC ACTIONS -- submit, cancel,
 *    permission_decision -- not just the bytes they turned into. Bytes are transport
 *    evidence; actions are what lets the classifier say `cancelled` at all, since
 *    nothing in Claude Code records a cancellation anywhere. This log IS the evidence
 *    behind an `assumed` confidence grade, so it has to mean something.
 *
 * When input ownership is `external`, actions can enter the child without passing
 * through here. That is exactly why that mode drops cancellation attribution.
 */

import type { PtyProcess } from './pty.ts'

export type ActionKind = 'submit' | 'cancel' | 'permission_decision' | 'raw'

export interface InputAction {
  kind: ActionKind
  at: number
  /** Who asked for it. `external` means it did not come through the orchestrator. */
  origin: 'orchestrator' | 'external'
  detail?: string | undefined
  /** Bytes actually written. Transport evidence, kept for debugging only. */
  bytes?: string | undefined
}

/**
 * Established in spike 1: writing text and CR as one burst is unreliable, because both
 * CLIs coalesce fast input as a paste and the submit gets swallowed. Type the body,
 * pause, then send Enter alone. Codex additionally needs
 * `-c disable_paste_burst=true`.
 */
const SUBMIT_SETTLE_MS = 400

/**
 * The tty input queue ceiling, MEASURED (#174) on darwin-arm64 25.5.0 through a real pty into
 * a child that records what it is handed:
 *
 *   1024 B sent -> 1024 B received.  1025 B sent -> 1024 B received.  64 KB sent -> 1024 B.
 *
 * A hard cliff, not a proportional loss, and the overflow is discarded in the driver: the
 * write succeeds, the child never sees the bytes, nobody is told. `src/process/pty.ts`
 * forwards to node-pty, whose write returns no drain signal, so there is no backpressure to
 * read either. Recorded as a named constant because SUBMIT_CHUNK_BYTES is derived from it.
 *
 * ONE PLATFORM ON ONE DAY, and CI measured that the hard way. Across four attempts of a single
 * commit (run 33100038199): `ubuntu-latest` gave the child all 1025 B of an unchunked write
 * every time and 4096 B whole in one attempt out of four; `macos-15-intel` cut 1025 to 1024 in
 * three attempts and passed all 1025 in the fourth; and darwin-arm64 -- the machine this number
 * is named after -- delivered an unchunked 1025 B write WHOLE in attempt 4 after cutting it to
 * 1024 in the three before.
 *
 * So the cliff is not a constant anywhere. It is a race with the child's next read, and it
 * moves with load in both directions on every platform. This stays as the tightest ceiling in
 * evidence, which makes it the right number to derive a chunk size from and the wrong number to
 * promise anything with.
 */
const TTY_INPUT_QUEUE_BYTES = 1024

/**
 * A QUARTER of the measured ceiling, and the quarter was arrived at the hard way.
 *
 * A chunk the size of the ceiling only works if the queue happens to be empty when it lands,
 * which is the assumption that made the unchunked write fail in the first place: writing 64 KB
 * in chunks, the whole payload arrived 3 times in 4 at 1024 B and never at 1536 B. Half the
 * ceiling looked fine on a small sample and is not. Over 15 attempts at each size, 512 B chunks
 * dropped a SHORT run -- six bytes, from the middle -- in 1 of 15 at 4 KB and 1 of 15 at 16 KB,
 * and a longer yield did not help (3 of 15 at 16 KB with a 1 ms yield). That failure mode is
 * worse than the one this fixes: a six-byte hole in the middle of a message still parses.
 *
 * At 256 B there were no failures in 60 attempts across 4 KB and 16 KB, and none in 8 at 64 KB.
 * The cost is one write per 256 bytes: ~18 ms for 4 KB, ~74 ms for 16 KB, ~293 ms for 64 KB.
 * Messages are sent once per turn, so that is not a budget worth defending.
 *
 * WHAT THOSE NUMBERS ARE. They are a failure RATE falling to zero on one machine's sample, and
 * a rate of zero over 60 attempts is not a guarantee -- it is the absence of a counterexample
 * in 60 tries. CI has now produced nine of them. A 4096 B `submit()`, chunked exactly like
 * this, arrived short on a `macos-latest` runner; run 33100038199 paced a 2048 B `submit()`
 * down to 1018 B on darwin-arm64; and run 33104083028 lost bytes in 7 of 90 paced measurements
 * on darwin-x64, including 65536 -> 47610 and 1024 -> 1018.
 *
 * WHY 256 STAYS ANYWAY. The same two runs measured 8192 B paced against 8192 B unpaced on the
 * same runner seconds apart, 21 times: paced was never worse, and on darwin it was 8x better
 * every single time. Chunking is a large, repeatedly measured reduction in the FREQUENCY of
 * loss, with no bound on the residual and no delivery signal to check it against.
 * `process/inputTruncation.test.ts` carries the full tally under WHAT THE PACING EVIDENCE
 * SUPPORTS, including what it does not license anyone to claim. Nothing here has changed as a result, because
 * 256 B is still the best-measured value and a smaller one would only move the rate, not the
 * kind of claim. What changed is what is claimed for it: chunking is RISK REDUCTION on a
 * transport that offers no delivery signal at all. The guarantee a caller gets lives one layer
 * up, in the adapters -- the child echoes back what it took, a mismatch is cancelled and re-sent
 * once, and a message that still does not arrive intact is REFUSED rather than delivered short
 * (`adapters/promptFidelity.ts`). That is the only place a promise about arrival can be kept,
 * because it is the only place anything downstream of the write is observed.
 */
const SUBMIT_CHUNK_BYTES = TTY_INPUT_QUEUE_BYTES / 4

/**
 * Paste framing. Written only when the child has ADVERTISED bracketed paste -- see
 * `PtyProcess.bracketedPaste`, which is deliberately narrower than `isInteractive`.
 *
 * Without it a newline in the payload is an Enter: the child submits there and the rest of the
 * message becomes a separate one, which is how #174's messages arrived with their fronts
 * missing. Every message conclave sends goes through `envelope()`, which puts a blank line
 * after the header, so this fired on every send with a multi-line body.
 *
 * Known gap, not addressed here: a payload containing a literal ESC[201~ ends the paste early.
 * Real terminals have the same hole.
 *
 * Two corrections to what this note used to say, both measured in `inputTruncation.test.ts`:
 *
 * "Ends the paste early" understates it. Against a composer that clears on Escape -- which is
 * what a real one does -- the payload's marker closes the paste, the rest of the payload
 * becomes keystrokes, and then the REAL closing marker arrives outside any paste and CLEARS.
 * The whole message is destroyed and replaced by `[201~`, rather than being cut short.
 *
 * "Prose does not carry raw escape bytes" is the assumption to be careful with, and #174 is
 * where it was questioned: seats quote ANSI-coloured terminal output at each other, and that
 * output carries ESC literally. An ordinary interior ESC is harmless here BECAUSE of the
 * framing -- inside a paste it is content -- which is the same reasoning that makes ESC[201~
 * the one sequence the framing cannot protect.
 *
 * Left unaddressed deliberately: `adapters/promptFidelity.ts` compares what the child took
 * against what was sent and refuses on any difference, so this is loud rather than silent, and
 * a send path that started rewriting payloads to escape a marker would be altering a message
 * to make it transmissible -- which is the failure this whole area exists to prevent.
 */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * Split `text` into chunks of at most `maxBytes` UTF-8 bytes, never mid-character.
 *
 * The budget is in BYTES because the tty queue counts bytes, but the split has to happen on
 * CODE POINT boundaries: cutting a surrogate pair leaves a lone surrogate, which node-pty
 * encodes as U+FFFD, and the payload arrives corrupted instead of truncated -- a worse failure
 * than the one being fixed, because it still parses. Iterating the string with for..of yields
 * whole code points, so a 4-byte emoji is never divided.
 */
export function chunkForPty(text: string, maxBytes: number = SUBMIT_CHUNK_BYTES): string[] {
  const chunks: string[] = []
  let chunk = ''
  let bytes = 0
  for (const ch of text) {
    const width = Buffer.byteLength(ch, 'utf8')
    if (bytes + width > maxBytes && chunk !== '') {
      chunks.push(chunk)
      chunk = ''
      bytes = 0
    }
    chunk += ch
    bytes += width
  }
  if (chunk !== '') chunks.push(chunk)
  return chunks
}

/**
 * Hand the event loop back, so the child has a CHANCE to drain the queue between chunks.
 *
 * A timer, not `setImmediate`, and that was measured rather than assumed: with setImmediate
 * between chunks an 8 KB payload arrived as 7168 B and a 64 KB payload as 58880 B. A
 * check-phase yield stays inside this process, and this process is not what empties the tty
 * queue -- the child's next read is. Only parking the loop on a timer gives that a chance to
 * happen. setImmediate does sometimes get away with it, which is worse than never working:
 * a timer is the version that does not depend on how busy the child was.
 *
 * What this yield does NOT do is acknowledge anything, and the mechanism is worth stating
 * because the name invites the opposite reading. `PtyProcess.write` forwards to node-pty's
 * `write`, which does not write: it pushes the buffer onto node-pty's own `_writeQueue` and
 * returns (`node_modules/node-pty/lib/unixTerminal.js`, `CustomWriteStream`). The queue is
 * drained by `fs.write` callbacks that RECURSE straight into the next write with no yield of
 * their own -- deliberately, so that large pastes stay fast -- and only an EAGAIN from a full
 * kernel buffer parks the drain on a `setImmediate`. So when this timer fires, the previous
 * chunk may not have reached the fd, and if it has, nothing says the child has read it out of
 * the tty buffer. Several 256 B chunks can be handed to the driver back to back with no gap at
 * all, which is what an unchunked write looks like from the line discipline's side.
 *
 * The yield therefore buys a better distribution, not a delivery. See SUBMIT_CHUNK_BYTES for
 * what that is worth and where the actual guarantee is kept.
 */
function yieldToChild(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

/**
 * Permission-dialog key encodings, per agent.
 *
 * These differ, and one half is verified while the other is not, so a single blanket
 * caveat would be wrong in both directions.
 */
export interface PermissionEncoding {
  allow: string
  deny: string
  /** Whether the allow encoding has been exercised against a real dialog. */
  allowVerified: boolean
  describeAllow: string
}

/**
 * Claude Code. ESC on the dialog is "No, and tell Claude what to do differently",
 * observed in spike 3. Allow is presumed to be Enter taking the highlighted first
 * option, but no fixture has exercised it.
 */
export const CLAUDE_PERMISSION_ENCODING: PermissionEncoding = {
  allow: '\r',
  deny: '\x1b',
  allowVerified: false,
  describeAllow: 'allow (unverified encoding)',
}

/**
 * Codex 0.146.0. Both halves observed live, dialog captured verbatim:
 *
 *   1. Yes, proceed (y)
 *   2. Yes, and don't ask again for these files (a)
 *   3. No, and tell Codex what to do differently (esc)
 *
 * `y` was confirmed by the file being created and Stop firing; ESC by the file not
 * being created and turn_aborted being recorded.
 */
export const CODEX_PERMISSION_ENCODING: PermissionEncoding = {
  allow: 'y',
  deny: '\x1b',
  allowVerified: true,
  describeAllow: 'allow',
}

export class InputQueue {
  readonly #pty: PtyProcess
  readonly #log: InputAction[] = []
  readonly #keys: PermissionEncoding
  /** Tail of the serialization chain. Every action appends to it. */
  #chain: Promise<unknown> = Promise.resolve()

  constructor(pty: PtyProcess, keys: PermissionEncoding = CLAUDE_PERMISSION_ENCODING) {
    this.#pty = pty
    this.#keys = keys
  }

  get actions(): readonly InputAction[] {
    return this.#log
  }

  /** Most recent action of a kind, for the classifier's orchestrator evidence. */
  last(kind: ActionKind): InputAction | undefined {
    for (let i = this.#log.length - 1; i >= 0; i--) {
      if (this.#log[i]!.kind === kind) return this.#log[i]
    }
    return undefined
  }

  hasSent(kind: ActionKind, since = 0): boolean {
    return this.#log.some((a) => a.kind === kind && a.at >= since)
  }

  /** Serialize `fn` behind everything already queued. Failures do not break the chain. */
  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn)
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  #record(action: InputAction): void {
    this.#log.push(action)
  }

  /**
   * Type a message and submit it (#174).
   *
   * Three things happen in order, and the order is the fix:
   *
   *   1. If the child advertised bracketed paste, the payload is FRAMED as a paste. That is
   *      what stops a newline in the body from being read as Enter.
   *   2. The payload goes out in chunks under the tty queue ceiling, with the loop parked
   *      between them so the child can drain. That is what stops the tail being discarded.
   *   3. The existing settle, and only then the Enter -- unchanged from spike 1, and still
   *      necessary: the paste framing tells the child where the text ends, not that it is
   *      finished.
   *
   * The paste markers are written on their own so no chunk boundary can fall inside one.
   *
   * What this does NOT do: notice that the child got less than was sent. Chunking cannot
   * rescue a child that has stopped reading -- measured, a child that stalls 1.5 s still
   * receives 1024 B of a 64 KB write and no pacing changes that -- and there is no drain
   * signal to detect it from. Verifying the landed length is deferred, deliberately.
   */
  async submit(text: string, detail?: string): Promise<InputAction> {
    return this.#enqueue(async () => {
      const framed = this.#pty.bracketedPaste && text !== ''
      if (framed) this.#pty.write(PASTE_START)
      for (const chunk of chunkForPty(text)) {
        this.#pty.write(chunk)
        await yieldToChild()
      }
      if (framed) this.#pty.write(PASTE_END)

      await new Promise((r) => setTimeout(r, SUBMIT_SETTLE_MS))
      this.#pty.write('\r')
      const action: InputAction = {
        kind: 'submit',
        at: Date.now(),
        origin: 'orchestrator',
        detail: detail ?? text.slice(0, 120),
        bytes: framed ? `${PASTE_START}${text}${PASTE_END}\\r` : `${text}\\r`,
      }
      this.#record(action)
      return action
    })
  }

  async cancel(detail?: string): Promise<InputAction> {
    return this.#enqueue(async () => {
      this.#pty.write('\x1b')
      const action: InputAction = {
        kind: 'cancel',
        at: Date.now(),
        origin: 'orchestrator',
        detail,
        bytes: '\\x1b',
      }
      this.#record(action)
      return action
    })
  }

  /**
   * Answer a pending permission dialog using this adapter's encoding.
   *
   * The recorded detail distinguishes a verified encoding from an assumed one, so later
   * code cannot treat a presumed allow as equivalent evidence to an observed deny.
   */
  async decidePermission(decision: 'allow' | 'deny'): Promise<InputAction> {
    return this.#enqueue(async () => {
      const bytes = decision === 'deny' ? this.#keys.deny : this.#keys.allow
      this.#pty.write(bytes)
      const action: InputAction = {
        kind: 'permission_decision',
        at: Date.now(),
        origin: 'orchestrator',
        detail: decision === 'deny' ? 'deny' : this.#keys.describeAllow,
        bytes: JSON.stringify(bytes),
      }
      this.#record(action)
      return action
    })
  }

  /** Escape hatch for the keystroke proxy. Origin is recorded honestly. */
  async raw(bytes: string, origin: 'orchestrator' | 'external', detail?: string): Promise<InputAction> {
    return this.#enqueue(async () => {
      this.#pty.write(bytes)
      const action: InputAction = { kind: 'raw', at: Date.now(), origin, detail, bytes }
      this.#record(action)
      return action
    })
  }

  /** Resolves when everything queued so far has been written. */
  async drain(): Promise<void> {
    await this.#chain
  }
}
