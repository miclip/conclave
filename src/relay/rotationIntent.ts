/**
 * Why a rotation happened, as a fact rather than as prose.
 *
 * Rotation was built as recovery and is being used as an instrument. An operator who
 * preregisters a criterion and then replaces the implementer so a fresh reader applies it is
 * doing something methodologically sound and methodologically UNRELATED to degradation -- and
 * until #75 the record could not tell that apart from "the proxy fired and the operator
 * agreed".
 *
 * ## Why the distinction is load-bearing rather than tidy
 *
 * #10 asks whether compaction predicts degradation strongly enough to act on unattended. Any
 * dataset assembled from rotation records mixes two populations:
 *
 *   - rotations taken BECAUSE a proxy fired -- the population the claim is about
 *   - rotations taken because the operator wanted a blind reader -- noise
 *
 * The second arrives WITH a compaction generation attached, because compaction happens anyway.
 * So it reads as "the proxy fired and the operator rotated", which is precisely the correlation
 * #10 exists to measure. The experiment would be confirmed by rotations that had nothing to do
 * with degradation, and it would get worse the more disciplined the operator was, since
 * methodological rotation is a habit of exactly the people who would run the experiment
 * properly.
 *
 * One field plus a prompt is enough for an analysis to exclude the second population. That is
 * all this is.
 *
 * ## Classified from the ACTIVE PAUSE, and from nothing else
 *
 * The temptations are the compaction generation and the reason text, and both are wrong for
 * the same reason: they are what the contamination looks like. A generation is attached to
 * every long session whatever prompted the rotation, so classifying on it would label the
 * methodological rotation as proxy-driven -- the exact error. And the reason is the operator's
 * own words; deciding from them means grepping free text for "degrad", which is a
 * classification that changes when somebody rephrases a sentence.
 *
 * What DOES say which population a rotation belongs to is the question that was in front of the
 * operator when they chose it. A `rotation_candidate` pause about this seat is the proxy
 * asking; rotating there is agreeing with it. Any other pause -- or no pause at all -- is the
 * operator arriving with their own reason, and that reason is the thing worth recording.
 *
 *   node --test src/relay/rotationIntent.test.ts
 */

import type { SessionState } from '../contract/session.ts'
import type { RunPause } from './run.ts'

/**
 * The population a rotation belongs to.
 *
 * Three members rather than the two #75 names, and the third is the one that would otherwise be
 * misfiled. `onDegradation: 'automatic'` rotates on detection without asking anybody, so there
 * is no pause to read and the default classification below would call it operator-initiated --
 * putting a purely proxy-driven rotation into the population an analysis is meant to EXCLUDE,
 * which is #75's contamination running backwards. It is declared by the detector at the call
 * site, because the detector is the only thing that knows.
 */
export type RotationIntent =
  /** A `rotation_candidate` pause was in front of the operator and they chose to rotate. */
  | 'candidate_accepted'
  /** The detector rotated under `onDegradation: 'automatic'`. Nobody was asked. */
  | 'degradation_automatic'
  /** The operator arrived with their own reason. Everything else. */
  | 'operator_requested'

/**
 * One accepted rotation, as an analysis reads it.
 *
 * Only ACCEPTED rotations are recorded. A rolled-back rotation replaced nothing, and putting it
 * here would let a count of this array disagree with `rotationWatch.rotations`, which is the
 * counter every summary line and report already quotes.
 */
export interface RotationRecord {
  /** The seat whose session was replaced. */
  seat: string
  intent: RotationIntent
  /**
   * Why, in whoever's words are the honest ones.
   *
   * The operator's own sentence when they initiated it, and the pause's detail when they
   * accepted a candidate -- there the proxy is what said something, and the operator's
   * contribution was agreement. Never empty: `requiresStatedReason` is what enforces that at
   * the point a reason could still be asked for.
   */
  reason: string
  /** The session that took the seat. Opaque; the adapter's own id. */
  replacement: string
  /**
   * Set when the OUTGOING session could not be confirmed disposed of (`rotated_cleanup_failed`).
   *
   * The rotation is recorded either way, and belongs here either way: a replacement proved
   * itself and took the seat, which is exactly what this array counts. What the field adds is
   * the half the count cannot carry -- the loser's teardown rejected, so there may be a child
   * still holding a pty or a worktree, and an analysis reading this array as "N clean handovers"
   * would be reading past it.
   *
   * `outgoingState` is how far `close()` got and nothing more: `terminated` means it reached the
   * state assignment, `rotating` means it did not. Neither says whether a process survived. See
   * `rotated_cleanup_failed` in `rotation/rotate.ts`, and #146 for why the adapters cannot
   * currently answer the question it leaves open.
   */
  cleanupFailure?: { detail: string; outgoingState: SessionState } | undefined
  at: number
}

/**
 * Does the pause in front of the operator make this an ACCEPTED CANDIDATE?
 *
 * Both halves are needed and neither is enough. The reason says the proxy is what raised this;
 * the scope says which seat it raised it about. At N>1 a `rotation_candidate` pause about
 * `implementer-2` can be answered by rotating some other seat, and recording that as "the proxy
 * fired and the operator agreed" would attribute one seat's evidence to another's replacement.
 *
 * `undefined` -- no pause -- is `operator_requested` rather than an error. An embedder holding a
 * relay can call `rotateSeat` with no run in flight, and that is the plainest possible case of
 * an operator arriving with their own reason.
 */
export function rotationIntentFor(pause: RunPause | undefined, seatId: string): RotationIntent {
  if (pause?.reason !== 'rotation_candidate') return 'operator_requested'
  const scope = pause.resolution.scope
  return scope.kind === 'participant' && scope.participantId === seatId
    ? 'candidate_accepted'
    : 'operator_requested'
}

/**
 * Must this rotation carry a reason the operator actually stated?
 *
 * True exactly where the record would otherwise be a fiction. An accepted candidate has the
 * proxy's own detail to carry and asking for more would be a toll on the common case; an
 * operator-initiated rotation has NOTHING but what the operator says, and the alternative to
 * asking is inheriting whatever pause happens to be on screen -- which is how a rotation chosen
 * for method ends up recorded in the proxy's words.
 *
 * A predicate rather than a check inside the rotation, so a front end can ask BEFORE it starts a
 * transaction it would have to abandon. The console prompts on it; the handle throws on it.
 */
export function requiresStatedReason(pause: RunPause | undefined, seatId: string): boolean {
  return rotationIntentFor(pause, seatId) !== 'candidate_accepted'
}
