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
  /**
   * A deadline expired AND the child's own transcript does not show the turn finishing.
   *
   * ## #36 is a PARTIAL fix, and this is where that shows
   *
   * The clock alone could not tell a child stuck mid-work from one that finished normally and
   * whose `Stop` hook never arrived -- both produce silence, and the two want opposite
   * responses: the first must not be sent to, the second is simply done. So the adapters ask
   * the transcript when a clock fires (`Claude#reconsiderDeadline`). That recovered two
   * populations, and left a third that no verified incident has yet produced but the mechanism
   * plainly still admits:
   *
   *   RECOVERED  a hang that stops writing. A child that stopped working also stopped
   *              appending to its transcript, so the SILENCE clock reaches it at twelve
   *              minutes instead of the absolute one at forty-five. The verdict is the same
   *              label; what changed is that it arrives while it is still worth acting on.
   *
   *   RECOVERED  a lost `Stop`. The transcript is terminal, so the tracker supersedes the
   *              deadline verdict with `completed` through an ordinary `late_signal` revision
   *              and it never reaches a reader as this at all.
   *
   *   NOT FIXED  a turn that keeps working. Substantive child output refreshes the silence
   *              clock and nothing else, so a continuously productive turn runs into the
   *              absolute deadline, which is refreshed by nothing and fires unconditionally at
   *              forty-five minutes. Its transcript at that moment says `in_progress` -- which
   *              is not evidence the turn ended -- so the re-check changes nothing and the run
   *              reports a working turn as `timed_out`.
   *
   *              SEEN IN THE WILD, three times, which this comment used to deny (#227). Counted
   *              across the fifteen most recent run logs in this repo: 77 turn verdicts, 74
   *              `completed`, 3 `timed_out` -- and all three fired on a turn that was still
   *              working, with the evidence line recording the terminal at that instant:
   *              `Nesting… 5 0s · ↓ 14.0k tokens`, `Spinning… 5 0s · ↓ 4 .1k tokens`, and
   *              `Brewing…` for the silence clock. TWO of the three were then withdrawn and
   *              replaced with `completed`, which is the proof they were productive rather than
   *              wedged.
   *
   *              The observed #36 report remains the static-transcript hang in the first row: a
   *              child took a tool result, went quiet, and the run sat ~44 minutes. This row is
   *              still not to be cited as the thing #36 was filed about -- it is its own
   *              population now, and #227 is where its cost was measured.
   *
   * The absolute clock is kept rather than retired at the child's first output, and that is a
   * decision rather than an omission: `--max-turns` and `--max-minutes` are checked at turn
   * boundaries and nowhere else, so a turn output can extend without limit is a run no ceiling
   * can end. See `DEFAULT_WATCHDOG_MS` for the attempt and the revert.
   *
   * What survives to be reported as `timed_out`, therefore, is a turn with NO evidence that it
   * ended: one still working, one wedged, or one whose evidence could not be read -- and those
   * are deliberately the same answer here. See `#reconsiderDeadline` for the cases and why "no
   * evidence" must not mean "finished".
   *
   * Still says completion is uncertain, and still never says why.
   */
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
  /**
   * The child said so itself, on a documented output stream.
   *
   * Distinct from `hook` because the two are believed for different reasons and fail in
   * different ways. A hook is a handler WE registered: it can be registered but untrusted,
   * killed by its own timeout, or lost in delivery, and a reader who sees `hook:` will go
   * looking for it in `.claude/settings.json` or `~/.codex/config.toml`. A record the child
   * printed on a mode it documents can be none of those things, and there is nowhere to go
   * looking.
   *
   * Distinct from `transcript` too, which means a file we parsed after the fact. `announced`
   * is neither registered nor recovered -- it is what the child chose to say while running.
   *
   * OpenCode is the adapter this exists for: it needs no hook registration, no sidecar and no
   * trust decision, and recording its evidence as `hook:` erased exactly the difference the
   * seam was built to preserve (#52).
   */
  | 'announced'
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
  caveat?: boolean | undefined
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
