/**
 * Terminal outcomes, and how much we are entitled to claim about them.
 *
 * `Stop` is evidence of normal completion, not a universal turn-finalisation event, so
 * there is no single signal an adapter can emit as `turnEnd`. Every terminal statement
 * therefore carries its own evidence: what it claims, how strongly, and from where.
 *
 * The point of the provenance chain is to stop downstream code from quietly upgrading
 * an inference into a fact. A UI that renders `cancelled/assumed` the same as
 * `completed/proven` has thrown away the only thing protecting it from lying.
 *
 * Empirical basis: spikes/hooks/FINDINGS.md and spikes/transcripts/FINDINGS.md.
 */

export const OUTCOMES = [
  /** A positive completion signal was received. Currently the only proven outcome. */
  'completed',
  /** The turn was deliberately ended before completing. */
  'cancelled',
  /** A permission decision was pending and the turn never completed. */
  'permission_refused',
  /** The child process is gone. */
  'process_exited',
  /** A deadline expired. Says completion is uncertain -- never says why. */
  'timed_out',
  /** An observation channel went away. Says nothing about the turn itself. */
  'transport_lost',
  /** There is evidence the turn ended, but not why. */
  'unknown_abnormal_end',
] as const

export type Outcome = (typeof OUTCOMES)[number]

/**
 * Deliberately NOT an Outcome. Three statements are easy to collapse and must not be:
 *
 *   inProgress            no terminal evidence exists
 *   unknown_abnormal_end  evidence the turn ended, but not why
 *   cancelled             cancellation is known, because we caused it
 *
 * Silence supports only the first.
 */
export type TurnLiveness = 'in_progress' | Outcome

export const CONFIDENCES = [
  /** A positive signal from the child says so. */
  'proven',
  /** Composite of signals, none decisive alone. */
  'inferred',
  /** Our own bookkeeping. Unverifiable from the child. */
  'assumed',
  /** Absence of evidence only. */
  'uncertain',
] as const

export type Confidence = (typeof CONFIDENCES)[number]

export type ProvenanceSource =
  | 'hook'
  | 'transcript'
  | 'process'
  | 'orchestrator'
  | 'watchdog'
  | 'transport'

export interface Provenance {
  source: ProvenanceSource
  /** Human-readable, e.g. "Stop" or "turn_aborted reason=interrupted". */
  detail: string
  /**
   * Set when this entry is a caveat rather than support. A verdict carrying caveats is
   * still a verdict, but callers rendering it must not drop these.
   */
  caveat?: boolean
}

export interface Verdict {
  outcome: Outcome
  confidence: Confidence
  /** Ordered, most decisive first. Never empty. */
  provenance: Provenance[]
}

/**
 * How well a given outcome is supported for a given adapter. The conformance suite
 * grades by this rather than pass/fail, so an unverified claim cannot masquerade as a
 * tested one.
 */
export const EVIDENCE_LEVELS = [
  /** Produced in a real run against the installed CLI version, fixture captured. */
  'observed',
  /**
   * Produced in a real run, but against an older CLI than the one installed. Proves the
   * record and the parser shape existed; does not prove the current version still emits
   * it under the same circumstances. Schemas drift, and a fixture cannot notice.
   */
  'observed_historically',
  /** Derived from an event the vendor documents or the binary declares, not yet seen. */
  'inferred_from_documented_event',
  /** Argued from the design. No fixture, no documentation. */
  'reasoned_but_unverified',
  /** This adapter cannot produce this outcome at all. */
  'unsupported',
] as const

export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number]

export function isTerminal(state: TurnLiveness): state is Outcome {
  return state !== 'in_progress'
}

/**
 * True when a verdict rests on something other than a positive signal from the child.
 * Callers that need to distinguish "we know" from "we think" should branch on this
 * rather than on the outcome.
 */
export function isProvisional(v: Verdict): boolean {
  return v.confidence !== 'proven'
}

export function formatVerdict(v: Verdict): string {
  const chain = v.provenance
    .map((p) => `${p.caveat ? '! ' : ''}${p.source}:${p.detail}`)
    .join('; ')
  return `${v.outcome} (${v.confidence}) [${chain}]`
}
