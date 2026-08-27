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
export type MismatchShape = 'prefix' | 'suffix' | 'interior'

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
    shape = 'interior'
    const head = commonPrefixLength(sent, received)
    const tail = commonSuffixLength(sent, received, Math.min(sent.length, received.length) - head)
    what =
      `the text it received is neither a prefix nor a suffix of what was sent, so this is INTERIOR ` +
      `corruption: the first ${bytes(sent.slice(0, head))} bytes and the last ${bytes(sent.slice(sent.length - tail))} ` +
      `bytes match, and between them ${bytes(sent.slice(head, sent.length - tail))} bytes were sent and ` +
      `${bytes(received.slice(head, received.length - tail))} arrived`
  }

  // Named so an operator can tell this apart from the two send failures that came before it,
  // both of which are about text that never arrived at all rather than text that arrived wrong.
  const message =
    `the child accepted a prompt that is not the one that was sent, so the message was corrupted in ` +
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
    lostBytes: Math.max(0, sentBytes - receivedBytes),
    message,
  }
}
