/**
 * Reaching a human when an agent is operating, and hearing back.
 *
 * ## Why the payload is a struct and not a string
 *
 * So that an adapter stays thin and a message renders to any surface. A HUD line and a chat
 * message are the same decision at different budgets: given a struct plus `limits.maxChars`,
 * each adapter formats what it can show, and none of them has to invent a layout. Handed a
 * pre-formatted string, every adapter would re-parse it to fit, and they would disagree.
 *
 * `href` is what makes a small message enough. The evidence still exists and the human can
 * still read it -- the message says WHERE, and the reading happens wherever they already read
 * things.
 *
 * A side effect, not the point: there is no field a diff or tool output travels in, so a
 * notification does not accidentally carry a patch. That is worth having and is not a privacy
 * boundary -- the prose is the message, and any surface that shows it reads it.
 *
 * ## Why free text is never a command
 *
 * `/continue force` is the whole word and nothing after it; a voice transcription of "continue,
 * force it" is a message and would be delivered as one. So actions are enumerated ids chosen
 * from `options`, and everything else is prose. A transport with buttons maps a tap to an id; a
 * voice surface maps an intent to an id; nothing parses English into an instruction.
 */

/** What a surface can carry. The renderer adapts to it rather than assuming. */
export interface TransportLimits {
  /** Longest headline this surface will show. A HUD line and a chat message differ by 10x. */
  maxChars: number
  /** Whether anything can come back. A write-only surface is legal and common. */
  canReceive: boolean
}

/**
 * A question or a statement, built by conclave from fields it chose.
 *
 * `runId` is OPTIONAL and that is the design, not an oversight: a merge approval refers to a
 * branch and a design question refers to nothing conclave owns. Reported usage is that runs are
 * rarely the interesting part -- they work, or the operating agent handles them -- and the
 * interactions that actually happen sit outside a run.
 */
export interface Outbound {
  /**
   * `decided` is the shape observed in real use, and it is not any of the others:
   *
   *   "Work is done and pushed (b59eed4, verify green at 93 files / 2,557 tests), but the
   *    advisor has flagged real provenance overclaims, so it's fixing those. That's the advisor
   *    doing its job, so I'll let it land rather than cut it short."
   *
   * A judgement already made, reported with an implicit veto. It is not an `approval` -- nothing
   * is waiting on an answer -- and not `progress`, because a decision was taken and the human
   * may want it back. Carried by `tell`, so it never blocks, and it may still offer options: the
   * difference between `tell` and `ask` is whether anything WAITS, not whether there is
   * something to tap.
   */
  kind: 'approval' | 'direction' | 'question' | 'progress' | 'decided'
  /** One line. Rendered by conclave, never by an adapter. */
  headline: string
  /** The main path, not a garnish: a tap is an id and never needs parsing. */
  options?: { id: string; label: string }[]
  /** Where the evidence or the conversation lives. Never the evidence itself. */
  href?: string
  runId?: string
}

/** Who answered. The distinction is the whole point of opening the loop. */
export interface Identity {
  id: string
  /**
   * `human` is the only kind that opens a closed loop.
   *
   * An agent operator writing the goal, watching the run and confirming the outcome shares
   * blind spots with the participants, so its answer is not independent evidence in the way a
   * human's is (#26, #27). Six months later the record has to be able to say which this was.
   */
  kind: 'human' | 'agent'
}

/** What came back. Exactly one of `option` or `text`. */
export interface Inbound {
  /** An id from the `options` that were offered. Never inferred from prose. */
  option?: string
  /** Free text, which is a MESSAGE and never an instruction to conclave. */
  text?: string
  from: Identity
}

export interface Transport {
  readonly name: string
  readonly limits: TransportLimits
  send(m: Outbound): Promise<{ id: string }>
  /** Absent on a write-only surface. */
  receive?(sentId: string): Promise<Inbound>
}

/** One line of the decision log. */
export interface DecisionRecord {
  at: number
  transport: string
  kind: Outbound['kind']
  headline: string
  runId?: string
  href?: string
  offered?: string[]
  /** Absent while the question stands. */
  answer?: { option?: string; text?: string; by: Identity }
  /** Set when the send itself failed. A run never waits on a notification. */
  undelivered?: string
}
