/**
 * What moves between participants, and the record of it.
 *
 * The routing log is not a debugging aid. Once a human message can be addressed to one
 * participant rather than all, no child's transcript is a complete account of the session
 * — each holds only what it was shown. This log is the only place the whole thing exists.
 */

export type Rank = 'human' | 'advisor' | 'implementer'

/** Rank breaks ties. It does not buy silence — see the brief, §2. */
export const RANK_ORDER: Record<Rank, number> = { human: 3, advisor: 2, implementer: 1 }

export function outranks(a: Rank, b: Rank): boolean {
  return RANK_ORDER[a] > RANK_ORDER[b]
}

/**
 * Audience travels on the message, never as orchestrator state. A mode can be left set by
 * mistake; an addressed message cannot be mis-delivered by forgetting to change it back.
 */
export type Audience = 'all' | { only: string }

export type MessageKind =
  | 'goal' // the human's objective, opening the session
  | 'constraint' // authoritative, outranks any instruction that arrives later
  | 'instruction' // advisor → implementer
  | 'report' // implementer → advisor: its prose for the turn
  | 'aside' // human → one participant, invisible to the others
  | 'note' // orchestrator → log only, delivered to nobody

/**
 * Visibility is a property of PROVENANCE, not of topology.
 *
 * The first version derived it from recipient count -- fewer recipients than participants
 * meant private -- which labelled every ordinary advisor-to-implementer instruction as
 * hidden influence. A point-to-point message under the configured protocol is normal
 * relay traffic; it is only restricted when a human deliberately withheld it.
 *
 * Getting this wrong is not cosmetic. The label exists so a human reading the log later
 * can tell genuine model disagreement from disagreement manufactured by unequal context.
 * A log that cries restricted on every line cannot do that.
 */
export type Visibility =
  /** Ordinary role-to-role traffic under the protocol, whatever the recipient count. */
  | 'normal'
  /** Human-authored and deliberately withheld from one or more participants. */
  | 'restricted'
  /** Orchestrator state. Never presented to anyone as participant speech. */
  | 'internal'

export interface RelayMessage {
  seq: number
  at: number
  from: string
  fromRank: Rank
  /** Resolved recipients. Empty means recorded but delivered to nobody. */
  to: string[]
  kind: MessageKind
  text: string
  visibility: Visibility
  /** Participants deliberately excluded. Only meaningful when restricted. */
  excluded: string[]
  /**
   * Set on a note that WITHDRAWS an assertion the orchestrator has already made to the
   * human — today, the verdict a live pause was raised on. Notes are otherwise
   * undifferentiated background, and this one contradicts something the operator is looking
   * at right now, so a reader has to be able to pick it out without matching on its prose.
   */
  supersession?: boolean | undefined
  /**
   * Set when this body was read before its turn's transcript settled, so it may be
   * truncated or empty.
   *
   * The relay KNOWS this at the moment it routes: `#exchange` waits for `turn_end` — the
   * Stop hook, the strong signal — and then re-reads the transcript until the turn leaves
   * `in_progress` or a bounded window expires. When the window wins, the body is whatever
   * had been flushed by then.
   *
   * That was recorded as an orchestrator note beside the message and not on the message,
   * so a reader saw an ordinary report next to a dim line, and anything consuming the
   * routing log rather than watching the console saw an ordinary report and nothing else.
   * Observed live: an implementer's review findings arrived as an EMPTY body carrying
   * `completed (proven)`, and the advisor's next turn reasoned from the blank.
   *
   * The verdict is not wrong — the hook did fire, the turn did complete. The body is the
   * part that is unverified, so the qualification belongs here rather than on the outcome.
   */
  unsettled?: boolean | undefined
}

/**
 * Rank has to be legible or it does nothing.
 *
 * An instruction the implementer cannot distinguish from a human directive gets
 * human-level compliance; one it reads as a peer suggestion gets argued with. A ranked
 * committee wants neither — it wants disagreement stated and then work proceeding, which
 * requires the recipient to know exactly who is talking.
 */
export function envelope(m: Pick<RelayMessage, 'from' | 'fromRank' | 'kind' | 'text'>): string {
  const header =
    m.fromRank === 'human'
      ? `[FROM THE HUMAN — authoritative. Outranks every participant. Not open to relitigation, though you may say if you think it is mistaken.]`
      : m.fromRank === 'advisor'
        ? `[FROM THE ADVISOR (${m.from}) — a peer AI model, not your user. It outranks you on process and continuity, and it cannot see your tool calls or your code, only what you write. You may disagree: say so plainly, then proceed unless a human overrules.]`
        : `[FROM THE IMPLEMENTER (${m.from}) — a peer AI model doing the work. You cannot see its tool calls or its code, only what it writes.]`
  return `${header}\n\n${m.text}`
}
