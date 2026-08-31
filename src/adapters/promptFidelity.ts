/**
 * Did the child receive the prompt that was sent? (#174)
 *
 * `InputQueue.submit()` resolving means this process wrote bytes to a pty. `#120` established
 * that this is not the same as the child accepting them, and the adapters gained a landed
 * check for it. `#174` is the next thing along: the child can accept text that is not the text
 * that was sent, and every witness downstream then agrees on the wrong message. The transcript
 * records the corrupted prompt, the hook carries the corrupted prompt, the turn runs on the
 * corrupted prompt, and nothing anywhere disagrees.
 *
 * That is the whole reason this exists. A dropped message announces itself -- the seat says it
 * got nothing. A message that lost its front does not: in the four observed incidents the
 * fragment was a grammatical sentence, and one of them ("...urement wrong.") read like an
 * instruction. The seats caught them by being suspicious of a mid-word opening, which is not a
 * control.
 *
 * `UserPromptSubmit` echoes back the prompt the child actually took. Comparing it to what was
 * sent is a free, exact, end-to-end check of the whole transport, and it is the only one
 * available that does not depend on the pty, the tty queue or the composer behaving.
 */

/** What the received text turned out to be, relative to what was sent. */
/**
 * `unrelated` is not a corruption at all, and that is the point of having it.
 *
 * Two strings that share no prefix AND no suffix are not a damaged copy of one another -- they
 * are different messages. Folding that case into `interior` produced a sentence that reads as
 * arithmetic and means nothing: "the first 0 bytes and the last 0 bytes match, and between them
 * 472 bytes were sent and 394 arrived." It then told the operator this was neither a hook
 * failure nor a slow child and that `--settle` would not help, which is confidently wrong for a
 * message that simply is not the one we sent.
 *
 * Reported from a live run where the received text was a complete, well-formed
 * `<task-notification>` block -- the harness delivering a background-task completion, which
 * arrived while an advisor send was in flight and was correlated against the open turn.
 */
/**
 * Tags the HARNESS injects into the child, as distinct from anything a caller sent it.
 *
 * Claude Code delivers these itself: `<task-notification>` when a background task it started
 * completes, `<system-reminder>` for context it wants in front of the model. Each is a real
 * prompt -- it raises a real `UserPromptSubmit` and the child really works on it -- but it is
 * not the echo of anything we typed.
 */
const HARNESS_TAGS = ['<task-notification>', '<system-reminder>']

/**
 * Is this text the harness talking to the child, rather than the echo of a send?
 *
 * #185: when a background task completed while an advisor send was in flight, the block's
 * `UserPromptSubmit` arrived first, was correlated against the pending send, and compared
 * against the advisor's envelope. They share nothing, so the send was refused as corrupt, the
 * adapter typed ESC to cancel the turn it thought it had spoiled, and waited for a `Stop` that
 * a harness turn was never going to produce. Two unattended runs died there.
 *
 * Anchored at the START, and on the tag alone. A message that merely CONTAINS one of these --
 * an operator quoting a notification, a seat pasting one back to ask about it -- is still that
 * message and must still be checked against what was sent. Only a block that IS one is exempt.
 *
 * Deliberately not a fifth `MismatchShape`. This is not a verdict about a comparison; it is the
 * reason not to make the comparison at all.
 */
export function isHarnessBlock(text: string): boolean {
  const head = text.trimStart()
  return HARNESS_TAGS.some((tag) => head.startsWith(tag))
}

export type MismatchShape = 'prefix' | 'suffix' | 'interior' | 'unrelated'

export interface PromptMismatch {
  /**
   * `prefix`   -- the received text is a prefix of the sent text: the TAIL was lost.
   * `suffix`   -- the received text is a suffix of the sent text: the FRONT was lost.
   * `interior` -- neither. Bytes went missing, or were added, somewhere in between.
   */
  shape: MismatchShape
  sentBytes: number
  receivedBytes: number
  /** UTF-8 bytes present in the sent text and absent from the received one. */
  lostBytes: number
  message: string
}

/** Code points, not code units: a boundary must never fall inside a surrogate pair. */
function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length)
  let i = 0
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i++
  // Backed off if the run ended between a high and a low surrogate.
  if (i > 0 && i < a.length && a.charCodeAt(i - 1) >= 0xd800 && a.charCodeAt(i - 1) <= 0xdbff) i--
  return i
}

function commonSuffixLength(a: string, b: string, ceiling: number): number {
  const limit = Math.min(a.length, b.length, ceiling)
  let i = 0
  while (i < limit && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++
  // Backed off if the run ended between a high and a low surrogate.
  const at = a.length - i
  if (i > 0 && at < a.length && a.charCodeAt(at) >= 0xdc00 && a.charCodeAt(at) <= 0xdfff) i--
  return i
}

const EXCERPT = 48

function excerpt(s: string): string {
  if (s === '') return '(empty)'
  return s.length <= EXCERPT ? JSON.stringify(s) : `${JSON.stringify(s.slice(0, EXCERPT))}...`
}

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/**
 * `undefined` when the child received exactly what was sent. Otherwise, what went wrong.
 *
 * Exact equality, deliberately. Normalising whitespace or trimming would forgive precisely the
 * corruption this is looking for: `claudeSendLanded.test.ts` established, by counting this
 * machine's own transcripts, that a CLI stores typed text verbatim, so any difference at all is
 * a difference the child made.
 */
export function describePromptMismatch(sent: string, received: string): PromptMismatch | undefined {
  if (received === sent) return undefined

  const sentBytes = bytes(sent)
  const receivedBytes = bytes(received)

  let shape: MismatchShape
  let what: string
  if (sent.startsWith(received)) {
    shape = 'prefix'
    const lost = sent.slice(received.length)
    what =
      received === ''
        ? `it received NOTHING -- all ${sentBytes} bytes went missing`
        : `the text it received is a PREFIX of what was sent: the last ${bytes(lost)} bytes are missing`
  } else if (sent.endsWith(received)) {
    shape = 'suffix'
    const lost = sent.slice(0, sent.length - received.length)
    what = `the text it received is a SUFFIX of what was sent: the first ${bytes(lost)} bytes are missing`
  } else {
    const head = commonPrefixLength(sent, received)
    const tail = commonSuffixLength(sent, received, Math.min(sent.length, received.length) - head)
    if (head === 0 && tail === 0) {
      // Nothing in common at either end. A damaged copy keeps SOMETHING -- a truncation keeps a
      // prefix, an overwrite keeps the ends -- so sharing neither is the signature of a
      // different message rather than a broken one, and saying "interior corruption" here sends
      // the reader after a transport bug that is not there.
      shape = 'unrelated'
      what =
        `the text it received shares NOTHING with what was sent -- no common prefix and no ` +
        `common suffix -- so it is a DIFFERENT message rather than a damaged one. The byte ` +
        `counts below are two unrelated lengths and their difference means nothing. This is a ` +
        `correlation fault: something else reached the child while this send was in flight and ` +
        `was matched against it. A harness-injected block (<task-notification>, ` +
        `<system-reminder>) arriving mid-send is the known cause`
    } else {
      shape = 'interior'
      what =
        `the text it received is neither a prefix nor a suffix of what was sent, so this is INTERIOR ` +
        `corruption: the first ${bytes(sent.slice(0, head))} bytes and the last ${bytes(sent.slice(sent.length - tail))} ` +
        `bytes match, and between them ${bytes(sent.slice(head, sent.length - tail))} bytes were sent and ` +
        `${bytes(received.slice(head, received.length - tail))} arrived`
    }
  }

  // Named so an operator can tell this apart from the two send failures that came before it,
  // both of which are about text that never arrived at all rather than text that arrived wrong.
  // The framing differs by shape, not just the detail. Everything below the colon used to be
  // written for a damaged copy -- "corrupted in transport", "not a hook failure", "the
  // fragment" -- and every one of those is wrong when the child simply took a different
  // message. Telling an operator the transport is broken, and ruling out the tooling, is worse
  // than saying nothing when the transport is fine.
  const message =
    shape === 'unrelated'
      ? `the child accepted a prompt that is not the one that was sent, and not a damaged copy of ` +
        `it either: ${what}. Sent ${sentBytes} UTF-8 bytes, the child took ${receivedBytes}. ` +
        `The turn HAS been opened and recorded against the text the child actually took, because ` +
        `that is what it is working on; the send is refused so nothing downstream treats the other ` +
        `message as this one.\n` +
        `  sent     ${excerpt(sent)}\n` +
        `  received ${excerpt(received)}`
      : `the child accepted a prompt that is not the one that was sent, so the message was corrupted in ` +
        `transport: ${what}. Sent ${sentBytes} UTF-8 bytes, the child took ${receivedBytes}. ` +
        `This is not a hook failure and not a slow child -- \`conclave config check\` and \`--settle\` will ` +
        `not help. The turn HAS been opened and recorded against the text the child actually took, because ` +
        `that is what it is working on; the send is refused so nothing downstream treats the fragment as ` +
        `the message.\n` +
        `  sent     ${excerpt(sent)}\n` +
        `  received ${excerpt(received)}`

  return {
    shape,
    sentBytes,
    receivedBytes,
    // Zero for `unrelated`, because the subtraction has no referent: the two lengths belong to
    // different messages, and a "78 bytes lost" that is really 472 minus 394 invites exactly the
    // transport hunt this shape exists to prevent.
    lostBytes: shape === 'unrelated' ? 0 : Math.max(0, sentBytes - receivedBytes),
    message,
  }
}

// ------------------------------------------------------------------------------------------
// Recovery. What a sender does about a mismatch, once it has one.
// ------------------------------------------------------------------------------------------

/**
 * Why a corrupted send is RETRIED rather than only reported.
 *
 * Refusing is honest and it is not a recovery: the operator is told the message was mangled
 * and the seat is left holding a malformed turn that somebody has to cancel by hand. The
 * corruption is in the transport, not in the message -- the same bytes typed a second time
 * usually land -- so the run can repair itself, once, before it asks for help.
 *
 * Once, and the bound is the whole design:
 *
 *   - A retry is only safe if the malformed turn is OVER, and only the CHILD can say that.
 *     Neither CLI accepts input mid-turn; a re-send into an open turn is spliced into it rather
 *     than queued (#117), which turns one corrupted message into two. So the retry is gated on
 *     the child's own account of the ending -- its `Stop`, a `SessionEnd`, the process exiting,
 *     or Codex's transcript record of the abort -- and never on conclave having typed ESC.
 *     Typing ESC is something this process did; Claude Code records an interruption nowhere,
 *     and Codex's `turn_aborted` may never arrive, so a `cancelled` verdict at `assumed`
 *     confidence is compatible with a child still running the fragment. See
 *     `TurnState.childClosure` and `#recoverForRetry` in either adapter.
 *   - The single-flight claim is HELD across the whole thing. The window between the mismatch
 *     and the re-send is exactly when a second caller could type into the gap; `send()` is
 *     already the one holding the slot, so it keeps it rather than releasing and re-taking it.
 *   - A second mismatch is not transport noise, it is a broken transport. Retrying again would
 *     produce a third malformed turn and a third cancellation, and the operator would learn
 *     the same thing three failures later.
 */
export const PROMPT_SEND_ATTEMPTS = 2

/**
 * How long the cancellation and the child's confirmation may take before the retry is abandoned.
 *
 * The clock is on RECOVERY: what it bounds is the time between "the child took the wrong text"
 * and "the child has said that turn ended", after which the answer is a refusal rather than a
 * re-send. Codex adds its own cancellation evidence budget to this, because there the
 * confirmation is a transcript record the child writes after the fact -- see
 * `CANCEL_EVIDENCE_BUDGET_MS`.
 *
 * Ten seconds is long enough for a `Stop` that follows an interrupt and short enough that a
 * refused send is not mistaken for a hung one. On a CLI that reports nothing when interrupted
 * it is simply the wait before the refusal, which is the honest outcome there.
 */
export const PROMPT_RECOVERY_MS = 10_000

/**
 * The token every refusal after a spent retry carries.
 *
 * One token for both of them -- the retry that was tried and failed, and the retry that was
 * never safe to try -- because to a caller they are the same fact: this message did not get
 * through and conclave has stopped trying. What differs is the reason, which follows it.
 */
export const RETRY_EXHAUSTED = 'RETRY EXHAUSTED'

/**
 * A mismatch that has not yet been ruled final.
 *
 * Thrown by the hook path and caught by `send()`, which owns the retry budget. It is a
 * distinct type rather than a flag on the message because `send()` must not mistake any OTHER
 * failure -- a hook timeout, a dead child, a swallowed submit -- for a corruption worth
 * re-sending: those have their own repairs and re-sending on top of them is how a duplicate
 * prompt gets delivered.
 */
export class CorruptedPromptError extends Error {
  readonly mismatch: PromptMismatch
  /** The malformed turn the child opened. It exists, it is recorded, and it must be cancelled. */
  readonly turnKey: string

  constructor(mismatch: PromptMismatch, turnKey: string) {
    super(mismatch.message)
    this.name = 'CorruptedPromptError'
    this.mismatch = mismatch
    this.turnKey = turnKey
  }
}

export function isCorruptedPrompt(e: unknown): e is CorruptedPromptError {
  return e instanceof CorruptedPromptError
}

function summarise(m: PromptMismatch): string {
  return `${m.shape.toUpperCase()}, sent ${m.sentBytes} B and the child took ${m.receivedBytes} B`
}

/** The child mangled the message, then mangled the re-send. Both attempts, then the detail. */
export function promptRetryExhausted(first: PromptMismatch, again: PromptMismatch): string {
  return (
    `${RETRY_EXHAUSTED}: the child accepted a corrupted prompt, the malformed turn was cancelled, ` +
    `the message was sent again, and the child corrupted it a second time. A third attempt would ` +
    `produce a third malformed turn and tell you nothing this one has not. The transport to this ` +
    `seat is not delivering; the seat needs attention rather than another send.\n` +
    `  attempt 1  ${summarise(first)} -- cancelled\n` +
    `  attempt 2  ${summarise(again)} -- refused\n` +
    `${again.message}`
  )
}

/**
 * The child mangled the message and the re-send was never made, because the first turn could
 * not be shown to be over.
 *
 * Deliberately the same refusal as a spent retry rather than a softer one. The caller's message
 * did not arrive either way, and the difference -- that conclave declined to try -- belongs in
 * the reason, not in a second class of outcome for a caller to handle.
 */
export function promptRetryNotAttempted(mismatch: PromptMismatch, why: string): string {
  return (
    `${RETRY_EXHAUSTED}: the child accepted a corrupted prompt and it was NOT sent again, because ` +
    `${why}. Neither CLI accepts input mid-turn, so a re-send into a turn the CHILD has not said ` +
    `it finished is spliced into the malformed one rather than replacing it -- two corrupted ` +
    `messages instead of one. The malformed turn was cancelled; send again once the seat is ` +
    `idle.\n` +
    `${mismatch.message}`
  )
}
