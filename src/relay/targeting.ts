/**
 * Whether the advisor actually USED the assignment syntax, counted per turn (#79).
 *
 * Multi-seat dispatch depends on the advisor writing `@seat` / `@role`. `parseDecisions`
 * proves the orchestrator can PARSE that syntax; nothing proves `MULTI_SEAT_BRIEFING` can
 * ELICIT it. And the failure is invisible from inside: a reply that names nobody is routed by
 * fallback to the longest-idle seat and produces a perfectly ordinary task, so a run whose
 * advisor never learned the syntax and a run whose advisor deliberately serialised its work
 * leave the same record. Concurrency simply does not happen, every test stays green, and the
 * only symptom is a seat that looks idle.
 *
 * It is worse than lost parallelism. A seat blocked at the merge boundary takes NOTHING except
 * a repair addressed to it by name (`untargetedTarget` in `relay.ts` routes around it while any
 * other seat is free), so an advisor that never addresses a seat cannot unblock one. The seat
 * stays blocked for the rest of the run and the escalation that would report it needs a repair
 * attempt that never arrives.
 *
 * ## What this is for
 *
 * Deciding, AFTERWARDS, whether a briefing works. So the unit is the advisor turn and the
 * question is the one an operator can act on: of the turns that tried to instruct, how many
 * named a seat, and which seats did they name. A run where every turn was unaddressed on a
 * multi-seat run is the finding — and it has to be legible as one, in the record, rather than
 * inferred by someone who noticed a seat sitting still.
 *
 * TRIED TO INSTRUCT, not produced work, and the difference is the whole of the second
 * correction this file took. Whether the advisor USED the syntax and whether anything was
 * DISPATCHED are two axes, and the counting used to collapse them: recording happened after
 * validation and queue admission, so every turn that used `@seat`/`@role` and then failed — the
 * parser refused it, or the turn itself died — was recorded as nothing, and the summary could
 * report that no turn ever used the syntax. That is this instrument stating the opposite of
 * what happened, in the one direction that misleads, because "the briefing did not take" and
 * "the briefing took and the reply was wrong" have opposite repairs. So `addressed` carries the
 * first axis and `TargetingOutcome` the second, on every turn, independently.
 *
 * ## Two rules it is built to, and they are `rotationWatch`'s
 *
 * **A negative result is only evidence if the instrument was known to be live.** `applicable`
 * is a property of the OPTIONS, fixed before the run starts, exactly as `rotationWatch.armed`
 * is and for the reason issue #31 gives: a value assigned once something has happened reports
 * `false` on every run that ended before it happened, and "not measured" then reads as
 * "measured, and nothing was there". `0 addressed of 0 turns` and `0 addressed of 9 turns` are
 * different findings and the counters must never collapse them.
 *
 * **A one-seat run pays nothing, and that includes the documents.** It has no second seat to
 * address, `MULTI_SEAT_BRIEFING` is not in its advisor's briefing, and every reply it can write
 * is unaddressed by construction. A counter reporting under-use there would be reporting on a
 * thing that cannot happen, and a line that is noise on the common run is a line readers learn
 * to skip — including on the run where it means something. So `applicable` gates everything:
 * nothing is counted, no note is written, no summary line is printed, and NO BLOCK IS
 * SERIALIZED — `conclave status --json` and the run report carry no `targeting` key at all.
 *
 * ## Two single sources of truth, and both are structural
 *
 * **One store, written at one site.** `records` is the whole of what this instrument holds --
 * there are no counters beside it -- and every turn that tried to instruct is appended exactly
 * once, at a finalization site the turn cannot exit around (`Relay.#finaliseTargeting`, in a
 * `finally` at the foot of the advisor turn). Neither half is tidiness.
 *
 * The site is what makes the denominator contract true: it was stated three times and broken
 * three times, always the same way -- a recorder placed on the path a turn took, and then an
 * exit added above it. Recording moved below validation and every refused turn vanished; the
 * queue ceiling was hoisted out of the admission loop and every ceiling-refused batch vanished
 * with it, so a run that ended at the ceiling on its one addressed turn reported `NONE used
 * @seat/@role`. An exit added next year now records something honest, marked `unclassified`,
 * instead of nothing at all.
 *
 * The single store is what makes each repair cost one edit instead of five. Every previous fix
 * added a mutable counter and threaded it through the recorder, the two sums, the serializer and
 * both prose surfaces; the edit that gets forgotten is the one nothing fails on. Now the
 * aggregates are a projection (`targetingReading`) and the classification behind them is one
 * table (`UNDISPATCHED`) with one row per outcome. A sixth outcome does not compile until its
 * row exists, and adding the row is the whole change.
 *
 * **One derivation, and one set of words.** `targetingReading` is the only thing that looks at
 * an outcome: it produces the counts, the reading, and the evidence split into what may be
 * quoted as usage and what may not. The run report serializes it, and every sentence either
 * prose surface prints is written HERE from it -- `targetingSummary` for the end-of-run line
 * both front-ends write, `targetingStatusLine` for the live `conclave status` line.
 * `sessionView.ts` renders one string and decides nothing. The surfaces used to each decide, and they disagreed: the summary
 * was taught that truncated-only evidence settles nothing while the status line went on
 * certifying that "the syntax IS reaching the advisor" from the same counters. An instrument
 * whose surfaces contradict each other is worse than one that is simply wrong, because the
 * operator now has to pick which to believe.
 *
 * The rule those words are held to, and it outlived two attempts to state it in arithmetic
 * alone: **no count that includes an uncertain turn may be described as usage, and no
 * certification may rest on one.** `targetingElicited` excludes the truncated turns, and both
 * prose surfaces then quietly added them back -- `N further turns used @seat/@role without
 * dispatching` counted them, and the status line hung `so the syntax IS reaching the advisor`
 * off that total. The sentence is the half that gets read, so an exclusion the prose does not
 * honour is not an exclusion. `turnClauses` splits the evidence into what may carry a usage
 * claim and what may not, and the two are joined in the output, never summed.
 *
 * That last part is the one place this instrument departs from `rotationWatch`, which reports
 * `armed: false` on every run rather than vanishing. The reason the two differ is what the
 * absence would mean. Nothing else in a status document says whether rotation was configured,
 * so an absent rotation block leaves a reader guessing and #103 is what that guess cost.
 * Whether targeting was applicable IS recoverable from the same document, exactly and without
 * inference: count the participants whose role is `implementer`. So absence here says something
 * a reader can check rather than something they must assume — and on a multi-seat run, where
 * they cannot check it any other way, the block is always present, zeros and all.
 *
 *   node --test src/relay/targetingWatch.test.ts
 */

import type { Outcome } from '../contract/outcome.ts'
import type { ParseFailure, ParseResult, TaskTarget } from './dispatch.ts'
import type { CeilingBreach } from './guardrails.ts'

/**
 * What became of a turn that tried to assign work.
 *
 * The distinction this instrument was missing, and it is the one an operator acts on. All six
 * values mean the advisor tried to instruct; they differ in whether anything was dispatched and,
 * where nothing was, in WHY -- and in none of them do they say whether the advisor used the
 * syntax. `addressed` answers that, independently, on all four. Keeping the two axes apart is
 * the whole correction: an outcome that also encoded the form is an outcome that loses the form
 * every time the outcome is bad.
 *
 *   - `admitted` — the reply parsed and its instructions went into the queue.
 *   - `invalid` — the reply used `@seat`/`@role` and `parseDecisions` refused it, so the run
 *     halted and re-asked and nothing was queued. See `refusal` for which rule refused it.
 *   - `ceiling` — the reply used `@seat`/`@role`, PARSED WHOLE and validated, and a run ceiling
 *     refused the batch before any of it was admitted. See `ceiling` for which ceiling.
 *   - `incomplete` — the reply used `@seat`/`@role` and the TURN did not complete: it timed
 *     out, the transport was lost, the child exited. Nothing was queued, and the run halted on
 *     the verdict rather than on anything about the reply.
 *
 * `ceiling` is the strongest evidence of the four short of admission, and it was the last one
 * still being thrown away. The reply was written whole, `parseDecisions` accepted it, every
 * seat it named exists -- and then the batch met the queue ceiling and the run ended without
 * the instrument ever seeing it, because recording sat below the ceiling check. A run whose
 * advisor addressed its one instructing turn and hit the ceiling read as a run that had never
 * instructed anything at all.
 *
 * `unadmitted` is the net under the other four, and it is the one this instrument now depends
 * on for its denominator. The reply was whole, `parseDecisions` accepted it, no ceiling refused
 * it -- and the turn still ended without any of it being admitted. One route reaches it today:
 * a turn failed on a verdict the adapter WITHDREW while the operator was reading the pause, so
 * the dispatch decision was taken on a claim that no longer stands and the reply was never
 * dispatched. Filing that as `incomplete` is what the record used to do, and it is the one
 * thing it must not say -- the adapter's last word is that the turn ended. `unadmitted` says
 * what is true of it: read whole, valid, and never admitted. See `UnadmittedReason`.
 *
 * It is also what the FINALIZATION SITE lands on when a future exit is added and nobody
 * classifies it. That is deliberate. Every other outcome is claimed by a specific site, so a
 * new `continue advisor` between the ceiling and admission would once have gone unrecorded and
 * silently shrunk the denominator; now it is recorded, counted, and marked `unclassified`,
 * which is a defect an operator can SEE rather than a number that quietly stopped being the
 * count it claims to be.
 *
 * `incomplete` is kept apart from all of them because the reading it supports is not the same
 * KIND of reading. The other three rest on a reply the advisor finished writing; a turn that
 * died mid-sentence may have been cut off between `@seat` and the body, so its FORM is partly
 * an artefact of where the text stopped. It is recorded -- excluding it would let a run whose
 * advisor targeted every turn and finished none report `NONE`, which is the false negative
 * this instrument exists to prevent -- but it is NOT elicitation and it is NOT under-use. It is
 * an uncertainty bucket sitting outside both conclusions, and `targetingElicited` leaves it out
 * for exactly that reason. A run with nothing but incomplete evidence is inconclusive, and every
 * surface has to say so rather than resolving it in either direction.
 *
 * There is no value here for "unaddressed", and there never will be, because that is the OTHER
 * axis. `addressed` carries it, on every one of these six, and a reply that named nobody and
 * dispatched nothing is `{ addressed: false, outcome: <whichever> }` rather than an outcome of
 * its own. That pairing is what let the unaddressed failures be recorded at last: they used to
 * be dropped entirely, because the only bucket that would have taken them was
 * `unaddressedTurns`, whose name means "named nobody, so one instruction went out by fallback"
 * -- and nothing went out. They now land in `unaddressedFailedTurns`, which asserts neither
 * elicitation nor under-use, so the denominator is honest and no conclusion is borrowed from a
 * turn that did not earn one.
 */
export type TargetingOutcome = 'admitted' | 'invalid' | 'ceiling' | 'incomplete' | 'unadmitted' | 'withdrawn'

/**
 * Why a whole, valid reply was never admitted -- the `unadmitted` outcome's detail.
 *
 * A classification and not prose, for the reason `refusal` and `ceiling` carry one: this is an
 * audit record and free text invites matching on it.
 *
 *   - `verdict_superseded` — the turn was failed on a verdict that was later withdrawn and
 *     replaced with `completed`, and the replacement arrived after the dispatch decision had
 *     already been taken on the retracted one. Nothing was wrong with the reply; the run had
 *     simply already given up on it. This is what the reconciliation exists to say out loud.
 *     A REPLACEMENT is what makes this outcome available: the adapter's last word is that the
 *     turn ended `completed`, which is what establishes the reply as whole and valid. A
 *     withdrawal with nothing behind it establishes the opposite and is the `withdrawn` outcome,
 *     not this one.
 *   - `unclassified` — the finalization site was reached by a route it does not know about.
 *     Unreachable as this file stands, and it is kept for the reason above: an exit added later
 *     records something honest and visibly unexplained rather than nothing at all.
 */
export type UnadmittedReason = 'verdict_superseded' | 'unclassified'

/**
 * One advisor turn that tried to assign work, and how it addressed it.
 *
 * A `DONE` and an `ESCALATE` are not here: they assigned nothing and were never asked to name
 * a seat, and counting them would report under-use by an advisor that was not assigning
 * anything.
 *
 * A batch the queue ceiling refused USED to be excluded on that same sentence, and it did not
 * belong in it. A ceiling-refused batch is an assignment -- a whole, valid, parsed one that
 * named real seats -- and the only reason it dispatched nothing is that the run had reached a
 * limit the operator set. Reading it as "the advisor was not assigning anything" turned the
 * strongest evidence this instrument can collect short of admission into no evidence at all,
 * and a run that ended on the ceiling at its first addressed turn reported that it had never
 * instructed anything.
 *
 * Every turn whose reply reached for the syntax is here, whatever became of it, and that is
 * the correction #79 needed most. Recording used to happen only after validation and queue
 * admission, but the parser decides the FORM before it validates anything -- so
 * `@seat nobody-here: do the thing` left through the halt/re-ask path recorded as nothing at
 * all, and the run could then report `NONE used @seat/@role`. That is the instrument stating
 * the opposite of what happened, in the one direction that misleads: it says the briefing
 * failed when the briefing WORKED and the advisor got the target wrong. Those two findings have
 * opposite repairs -- rewrite the briefing, versus fix the seat names in it.
 *
 * "Whatever became of it" is the whole rule and it admits no exceptions worth making. A turn
 * that timed out holding an `@seat` line is the same class of evidence, weaker: excluding it
 * because the reading is uncertain would let a run whose advisor targeted every turn and never
 * finished one report `NONE`, which is the exact failure again with a different cause. So it is
 * recorded, and `outcome` and `verdict` carry the uncertainty rather than the absence.
 */
export interface TargetingRecord {
  /**
   * WHICH advisor turn this was, counted by the run: 1 for the first pass of the advisor loop,
   * and the same number `maxAdvisorTurns` bounds and a pause quotes as "advisor turn 3 of 8".
   *
   * The run's counter and NOT `TurnEndEvent.seq`, which is what this originally used. That seq
   * is a SESSION-LOCAL sequence owned by the adapter: it counts the turns of one child, it
   * includes the opening briefing exchange the advisor loop never sees, and it restarts at 1
   * whenever a session behind a seat is replaced. Two of those three already bite -- a reader
   * joining `turn` against the ceiling's own numbering was off by the briefing turns, and
   * "advisor turn 1" in the summary meant a different turn from "advisor turn 1" in the
   * evidence. The third does not bite today only because `#rotateSeatDeclaring` refuses any
   * seat that is not rank `implementer`, so the advisor's session is never swapped; a key whose
   * uniqueness rests on a refusal somewhere else is a key that stops being unique the day that
   * refusal is relaxed, and this is an audit record.
   *
   * An audit key, not an order. Records are already in order because they are appended in it.
   */
  readonly turn: number
  /**
   * Whether the reply used `@seat`/`@role` at all.
   *
   * Carried from `parseDecisions` (`DecisionForm`), never re-read from the prose and never
   * inferred from the targets: an addressed `@role implementer:` and an unaddressed reply on a
   * run whose fallback is that same role produce identical `TaskTarget`s, so the target cannot
   * answer this question.
   */
  readonly addressed: boolean
  /**
   * What the reply named, in the order it named them, as `describeTarget` renders it.
   *
   * Empty on an unaddressed turn. This is what the reply ASKED FOR rather than what was
   * dispatched: the instrument measures a briefing's effect on an advisor, and a target the
   * scheduler later queued, redirected or never reached is still a target the advisor named.
   *
   * On an `invalid` record these are the names as WRITTEN and they are not seats of this run --
   * one of them is usually why the reply was refused. That is the point: an operator deciding
   * whether to fix the briefing or fix the seat names in it needs to read the name the advisor
   * reached for.
   */
  readonly targets: readonly string[]
  /** Whether the dispatcher took this turn's work or the parser refused it. */
  readonly outcome: TargetingOutcome
  /**
   * Which parse rule refused it, on an `invalid` record only.
   *
   * The classification, not the prose: `unknown_target` says the advisor addressed a seat this
   * run does not have, `stray_prose` says the reply was only half in the addressed form, and
   * those want different repairs. The detail sentence stays in the routing log, where an
   * operator reading the run in sequence is; an audit record carrying free prose invites
   * matching on it.
   *
   * Absent unless `outcome` is `invalid`, which is the only outcome a parse rule produced.
   */
  readonly refusal?: ParseFailure['why']
  /**
   * Which ceiling refused the batch, on a `ceiling` record only.
   *
   * The classification and not the prose, for the reason `refusal` carries one: an operator
   * reading `queue_depth` knows to raise `--max-queue` or to let the seats drain, and one
   * reading `turns` knows the run simply ran out of budget with a valid instruction in hand.
   * The ceiling's own sentence stays in the routing log, where it already is.
   *
   * Usually `queue_depth` -- the check this record is written at is the batch-sized queue
   * projection -- but not necessarily: that same check asks every ceiling, so a batch can be
   * stopped by the duration or turn ceiling with its instructions still unadmitted. Recording
   * the kind rather than assuming the site is what keeps the two from being confused.
   */
  readonly ceiling?: CeilingBreach['kind']
  /**
   * How the turn ended, on an `incomplete` record only: `timed_out`, `transport_lost`, and so
   * on. Never `completed`, which is what every other outcome was reached on.
   *
   * Carried because it is what tells a reader how far to trust the record. A `timed_out` reply
   * may have been cut off mid-directive, so the form it appears to be in is partly an artefact
   * of the cut; the same reply under `permission_refused` was written whole and stopped for a
   * reason that says nothing about the briefing at all.
   *
   * NEITHER counts as elicitation, and an earlier version of this sentence said both did. Every
   * `incomplete` record is unsettled evidence: the run never read the reply to a readable end,
   * so it cannot say the form it appears to be in is the form the advisor wrote. That is true
   * whatever ended the turn -- that a `permission_refused` reply is more trustworthy than a
   * `timed_out` one is a judgement for whoever reads the record, not a licence for the
   * instrument to certify the briefing off it. This field is what lets them make it.
   */
  readonly verdict?: Outcome
  /**
   * Why a whole, valid reply was never admitted, on an `unadmitted` record only.
   *
   * `verdict_superseded` is the reconciliation this record exists to make legible: the turn was
   * failed on a verdict the adapter withdrew while the operator was reading the pause, so the
   * run had already stopped dispatching it by the time the replacement said the turn had ended.
   * The reply is not truncated and it is not malformed -- it is simply a whole instruction that
   * arrived after the run had decided otherwise, and the record has to be able to say that
   * without either calling the turn incomplete or claiming it dispatched.
   */
  readonly unadmitted?: UnadmittedReason
}

/**
 * What the instrument has observed: the records, and the two facts fixed before the run started.
 *
 * `records` is the ONLY store, and there are no counters beside it. That is a reversal of what
 * this file used to say, so the argument is worth keeping: the counters were held as fields on
 * `rotationWatch`'s precedent -- "a number that started disagreeing with the array it was
 * computed from would be worse than either alone" -- and the conclusion drawn from it was the
 * wrong one. Two stores that must agree cannot be made safe by writing them together; they can
 * only be made safe by there not being two. Every repair to this instrument added a counter, and
 * each one had to be threaded through the recorder, the two sums, the serializer and both prose
 * surfaces. A sixth outcome would have needed the same five edits, and the edit that gets
 * forgotten is the one nothing fails on.
 *
 * So the aggregates are a projection -- `targetingReading` -- and the classification that drives
 * them is one table, `UNDISPATCHED`, with one row per outcome. Adding an outcome means adding a
 * row; nothing else in this file, and nothing at all outside it, has to change. The serialized
 * documents still carry the counters, because a probe reading `status --json` cannot run a
 * projection, but those are rendered from the records at write time and cannot drift from them.
 */
export interface TargetingWatch {
  /**
   * Whether addressing was POSSIBLE on this run: more than one implementer seat, which is the
   * same condition that puts `MULTI_SEAT_BRIEFING` in the advisor's briefing.
   *
   * The SAME expression, not a second one that agrees today. An instrument that counted
   * under-use on a run whose advisor was never taught the syntax would be measuring the wrong
   * thing while looking right.
   */
  applicable: boolean
  /** Implementer seats this run has. Reported so the summary can say what "applicable" meant. */
  seats: number
  /** Every advisor turn that tried to instruct, in the order they were taken. */
  records: TargetingRecord[]
  /**
   * The turn being taken RIGHT NOW, if one is: an attempt that exists and has not finalized.
   *
   * Not a record and never counted as one. A record is what a turn TURNED OUT to be, written
   * once at the finalizer; this is what a turn is so far, and the two are never both present for
   * the same turn -- the finalizer clears this in the same synchronous block that appends.
   *
   * It exists because the recording site that makes the denominator honest also makes the LIVE
   * reading late: the record is written on the turn's way out, so a turn that suspends before it
   * -- at the `turn_incomplete` pause an operator may sit in front of for minutes -- is invisible
   * to every surface while it is the most interesting turn of the run. A run whose first turn
   * fell back and whose second is paused holding `@seat seat-beta` would report `NONE ... used
   * @seat/@role` for the whole pause: a finding against the briefing, printed off the one turn
   * that contradicts it, at the moment an operator is deciding whether to intervene.
   *
   * Undefined between turns and on any run not mid-turn, which is every serialized end-of-run
   * document. Reading it is optional for a probe; ignoring it costs only the live reading.
   */
  pending?: TargetingPending | undefined
}

/**
 * An advisor turn in flight, as much of it as is known before it ends.
 *
 * Deliberately three fields and not the relay's whole attempt: what a turn has NAMED and whether
 * it addressed anyone are fixed by the parser the moment the reply is read, and everything else
 * about the turn -- whether a ceiling refused it, whether its verdict still stands, whether it
 * was admitted -- is exactly what is not settled yet. A projection that read those would be
 * reporting an outcome for a turn that has not had one.
 */
export interface TargetingPending {
  /** Which advisor turn, on the run's own numbering. The same key its record will carry. */
  readonly turn: number
  /** Whether the reply used `@seat`/`@role`, off `parseDecisions`. Fixed once the reply parses. */
  readonly addressed: boolean
  /** What it named, as written and unvalidated. Empty on the unaddressed form. */
  readonly targets: readonly string[]
}

/**
 * Record one advisor turn's assignment attempt. Appends, and computes nothing.
 *
 * ONE call site -- `Relay.#finaliseTargeting`, in a `finally` the advisor turn cannot exit
 * around -- and that placement, not any arithmetic, is what makes `targetingReading`'s
 * denominator "every turn that tried to instruct". It was stated three times before and broken
 * three times, always the same way: a recorder on the path a turn took, and then an exit added
 * above it. Validation moved above it and every refused turn vanished; the queue ceiling was
 * hoisted out of the admission loop and every ceiling-refused batch vanished with it.
 *
 * The one-seat gate lives here because it is the same rule at every site, and a rule written
 * twice is a rule that gets relaxed once. Returns whether anything was recorded, so a caller can
 * gate its routing-log note on the same answer rather than re-testing `applicable` beside it.
 */
export function recordTargetingTurn(w: TargetingWatch, record: TargetingRecord): boolean {
  if (!w.applicable) return false
  w.records.push(record)
  return true
}

/**
 * What a reply NAMED, rendered as the advisor would have had to write it — parsed or refused.
 *
 * One reader for every recording site, because they see the same reply through different
 * shapes: an admitted reply and a ceiling-refused one carry their targets on the decisions, a
 * parse refusal carries them on `ParseRefusal.named`, and a reply on a turn that died can be
 * either. A copy of "where do I find the names" per site is a place for the answer to drift,
 * and the one that drifts is the one nothing dispatches on.
 *
 * Empty on the unaddressed form by construction: it named nobody, and the fallback target a
 * decision carries belongs to the ORCHESTRATOR. Crediting the advisor with that name would
 * report the syntax as elicited on a run whose advisor never wrote it.
 */
export function namedTargets(result: ParseResult): string[] {
  if (!result.ok) return result.named.map(describeTarget)
  if (result.form !== 'addressed') return []
  return result.decisions.flatMap((d) => (d.kind === 'instruct' ? [describeTarget(d.target)] : []))
}

/**
 * WHAT each way of ending a turn is evidence OF. One row per outcome, and the only such place.
 *
 * Every aggregate, every clause and every parenthetical below is driven from this table, so
 * adding a sixth `TargetingOutcome` is adding a row here and editing nothing else -- not the
 * recorder, not the sums, not the serializer, not either prose surface. The previous shape
 * needed all five, and the edit that gets forgotten is the one nothing fails on. The type is
 * exhaustive, so a new outcome does not compile until its row exists.
 *
 * `evidence` is the load-bearing field and it answers exactly one question: **may a turn that
 * ended this way be quoted as having USED `@seat`/`@role`?**
 *
 *   - `confirmed` — yes. The parser read the reply to the end and accepted its form, so
 *     "used the syntax and did not dispatch" is literally true of it. A parse refusal counts
 *     here: the form is decided BEFORE validation, so `@seat nobody-here: do the thing` is a
 *     reply that demonstrably wrote the syntax and got the target wrong.
 *   - `unsettled` — no. A turn cut off mid-reply may have been cut between `@seat` and the
 *     body, so the form it appears to be in is partly an artefact of where the text stopped.
 *
 * That distinction is why the table exists rather than a `switch` per consumer. `targetingElicited`
 * had it right and both prose surfaces then quietly undid it -- `N further turns used @seat/@role
 * without dispatching` counted the truncated ones, and the status line certified the briefing off
 * that same total. An exclusion the sentences do not honour is not an exclusion, and the sentence
 * is the half that gets read.
 *
 * The `addressed` axis crosses this and is NOT in the table: a reply that named nobody is never
 * `confirmed` whatever became of it, because it did not write the syntax. See `bucketOf`.
 */
interface OutcomeShape {
  /** Whether a turn ending this way may be quoted as having used `@seat`/`@role`. */
  readonly evidence: 'confirmed' | 'unsettled'
  /** How the summary's per-turn list introduces this group. */
  readonly clause: string
  /** The sentence appended after that list, saying how far to trust it. */
  readonly note: string
  /** How the one-line status surface names it, after a count. */
  readonly why: string
  /** The per-turn detail: which rule, which ceiling, which verdict, which reason. */
  readonly detail: (r: TargetingRecord) => string
}

const UNDISPATCHED: Record<Exclude<TargetingOutcome, 'admitted'>, OutcomeShape> = {
  invalid: {
    evidence: 'confirmed',
    clause: 'refused by the parser',
    note: '',
    why: 'refused',
    detail: (r) => r.refusal ?? 'refused',
  },
  // Said as a ceiling and not as a fault of the reply, because it is not one. The reply parsed,
  // the seats it named exist, and what stopped it is a limit the operator set -- so the repair
  // is the ceiling or the pace of the run, and pointing a reader at the briefing or the seat
  // names here would send them to fix something that is working.
  ceiling: {
    evidence: 'confirmed',
    clause: 'refused whole by a run ceiling before admission',
    note: 'the reply itself was valid and named real seats',
    why: 'refused whole by a ceiling',
    detail: (r) => r.ceiling ?? 'ceiling',
  },
  // A whole valid reply the run had already stopped dispatching. Said as what it is, because the
  // repair is neither the briefing nor the seat names: the run failed this turn on a verdict its
  // own adapter then withdrew, and the reply was collateral.
  unadmitted: {
    evidence: 'confirmed',
    clause: 'valid and never admitted',
    note: 'the reply was read whole and the run had already stopped dispatching it',
    why: 'valid and never admitted',
    detail: (r) => r.unadmitted ?? 'unadmitted',
  },
  // The turn has NO verdict: one was reported, the adapter withdrew it, and nothing was put in
  // its place. Its own outcome rather than a shade of `unadmitted`, and `unsettled` rather than
  // `confirmed`, because those two say the opposite of each other about the only question that
  // matters here. `unadmitted` means a whole valid reply the run had stopped dispatching -- and
  // what makes it whole is the REPLACEMENT, an adapter saying the turn ended `completed` after
  // all. With nothing behind the withdrawal there is no such statement: the last thing anyone
  // said about this turn is that the claim it had ended was wrong. Filing it as `unadmitted`
  // certified elicitation off a turn its own adapter says is still open, which is the same
  // overclaim as certifying off a truncated reply, reached from a different direction.
  //
  // The withdrawn verdict is NOT carried. It is a retracted claim, and a record that quotes one
  // is a record a reader will weigh -- and the reading that matters ("this settles nothing") is
  // the same whichever verdict was taken back.
  withdrawn: {
    evidence: 'unsettled',
    clause: 'left open by a verdict withdrawn with nothing put in its place',
    note:
      'an UNCERTAIN reading and not elicitation, since the last word on this turn is that the ' +
      'claim it had ended was withdrawn',
    why: 'on a turn whose verdict was withdrawn with no replacement',
    detail: () => 'verdict withdrawn, no replacement',
  },
  incomplete: {
    evidence: 'unsettled',
    clause: 'appeared to name a seat on a turn that did not complete',
    note:
      'an UNCERTAIN reading held OUTSIDE the elicited count, since a reply cut off mid-directive ' +
      'may not be the form it looks like',
    why: 'on a turn that did not complete',
    detail: (r) => r.verdict ?? 'incomplete',
  },
}

/**
 * The one group that is not an outcome: a reply that named NOBODY and dispatched nothing.
 *
 * It spans every non-admitted outcome, because what decides it is the other axis. An empty
 * reply, a truncated one that stopped before it said anything, and a whole valid unaddressed
 * batch a ceiling refused are one group here, and the reason they are not split is that the
 * split would let the weakest reading borrow the strongest one's confidence: only the ceiling
 * case is real evidence of non-use, and a counter mixing it with the other two would report a
 * negative result the run did not earn. In the denominator, credited to nothing.
 */
const NAMED_NOBODY: Omit<OutcomeShape, 'evidence'> = {
  clause: 'named nobody and dispatched nothing',
  note: 'evidence of NEITHER kind, since nothing here reached for the syntax and nothing went out',
  why: 'that named nobody and dispatched nothing',
  detail: (r) => r.refusal ?? r.ceiling ?? r.verdict ?? r.unadmitted ?? 'undispatched',
}

/**
 * Which of the four things one recorded turn is, crossing the two axes in the one place.
 *
 *   - `dispatched` — named a seat and its work was admitted. The concurrency answer.
 *   - `fallback` — named nobody and its one instruction went out by fallback routing. Under-use,
 *     and the finding this instrument exists to make legible.
 *   - `confirmed` — demonstrably wrote the syntax and dispatched nothing. Elicitation.
 *   - `unsettled` — settles nothing: never read to a settled end (cut off, or left open by a
 *     withdrawn verdict), or named nobody and dispatched nothing at all.
 */
type TargetingBucket = 'dispatched' | 'fallback' | 'confirmed' | 'unsettled'

/**
 * Whether the reply behind this record was READ TO THE END, which is not the same question as
 * whether it may be quoted as usage.
 *
 * Off the same `evidence` column `bucketOf` reads, and that column answers both questions because
 * it means one thing: the parser saw the whole reply. `confirmed` outcomes are the ones a parser
 * read out -- refused, refused by a ceiling, valid and never admitted -- and `unsettled` is the
 * one where it did not, because the turn stopped mid-reply.
 *
 * Asked SEPARATELY from the bucket because the bucket is about usage evidence and folds the two
 * apart: a reply that named nobody cannot be quoted as usage whatever became of it, so `bucketOf`
 * puts every unaddressed failure in `unsettled` -- including a whole reply the parser read and
 * refused, which is settled evidence of non-use and nothing like a fragment. Reading the `none`
 * rule off the bucket would therefore suppress the under-use finding on a run whose advisor
 * merely wrote one unparseable reply, which is a different mistake in the other direction.
 */
function readWhole(r: TargetingRecord): boolean {
  return r.outcome === 'admitted' || UNDISPATCHED[r.outcome].evidence === 'confirmed'
}

function bucketOf(r: TargetingRecord): TargetingBucket {
  if (r.outcome === 'admitted') return r.addressed ? 'dispatched' : 'fallback'
  // Named nobody, so nothing about this turn can be evidence that the briefing produced the
  // syntax -- whatever the outcome says about why it did not dispatch.
  if (!r.addressed) return 'unsettled'
  return UNDISPATCHED[r.outcome].evidence
}

/**
 * The counters, as the documents carry them. DERIVED, never held.
 *
 * They exist because a probe reading `conclave status --json` cannot run a projection, and
 * because `0 addressed of 0 turns` and `0 addressed of 9` are different findings that a reader
 * must be able to tell apart without parsing the record list. They are computed from `records`
 * at write time, so they cannot disagree with it.
 *
 * The two newest are optional on the way back IN: `status --json` documents written by an
 * earlier build are still on disk and still read by `formatSession`, and a required field would
 * make the status renderer report `NaN` for every one of them.
 */
export interface TargetingCounts {
  addressedTurns: number
  unaddressedTurns: number
  invalidTurns: number
  ceilingTurns: number
  incompleteTurns: number
  unadmittedTurns?: number
  withdrawnTurns?: number
  unaddressedFailedTurns?: number
}

/**
 * The denominator, for a reader who holds ONLY the serialized counters. Not used by the reading.
 *
 * `targetingReading` computes `conclusion.turns` as `records.length` and never comes here, and
 * the separation is deliberate: this function enumerates the outcomes that have a named counter
 * today, so a sixth outcome would be missing from it until somebody remembered. Inside the
 * instrument that would be a denominator quietly smaller than the run; out here, on a document
 * whose counters a probe is reading, it is the best that shape can do -- and the `PARTITION`
 * regression makes the shape's completeness a decision rather than an accident.
 *
 * The contract this is an approximation OF: every turn that tried to instruct. A turn the parser
 * refused,
 * a turn a ceiling refused, a turn that died holding a directive and a turn whose whole valid
 * reply was never admitted are all turns the advisor spent trying to assign work. Reading
 * `1 of 2` where the second turn was refused would be describing the run as if that turn had not
 * happened.
 *
 * The contract is kept by WHERE the recording happens -- one finalization site the turn cannot
 * exit around -- rather than by this sum. A sum is only as complete as the set of things
 * somebody remembered to count, which is exactly what kept going wrong.
 *
 * The uncertain turns are in the DENOMINATOR while `targetingElicited` leaves them out of the
 * numerator, and that is deliberate rather than an inconsistency. Whether a turn tried to
 * instruct is not in doubt on a truncated turn -- the advisor was asked for an instruction and
 * spent the turn -- so it belongs in the count of turns the briefing was tested on. What is in
 * doubt is what it wrote, which is the numerator's question.
 */
export function targetingTurns(w: TargetingCounts): number {
  return (
    w.addressedTurns +
    w.unaddressedTurns +
    w.invalidTurns +
    w.ceilingTurns +
    w.incompleteTurns +
    (w.unadmittedTurns ?? 0) +
    (w.withdrawnTurns ?? 0) +
    (w.unaddressedFailedTurns ?? 0)
  )
}

/**
 * Elicitation, for a reader who holds ONLY the serialized counters. Not used by the reading.
 *
 * `targetingReading` computes `conclusion.elicited` from the bucket partition -- the turns that
 * dispatched, plus the confirmed group -- and never comes here, for the reason `targetingTurns`
 * gives above.
 *
 * Turns whose reply DEMONSTRABLY contained `@seat`/`@role`: it was written whole and read whole.
 * The answer to the question #79 was written to ask: did `MULTI_SEAT_BRIEFING` get the syntax
 * out of this advisor. Zero here, on a run with instructing turns, is the finding. Non-zero with
 * `addressedTurns` at zero is the OTHER finding, and it was previously indistinguishable from
 * the first -- four times over, since the refused turns, the ceiling-refused batches, the turns
 * that did not complete and the whole replies a withdrawn verdict stranded were all recorded as
 * nothing at all.
 *
 * The `evidence: 'unsettled'` outcomes are NOT in this sum, and the exclusion is the point.
 * Elicitation is a claim about what the advisor WROTE, and a turn that died mid-reply is a turn
 * whose text stopped at an arbitrary point. Counting it here would let a run that never once
 * produced a readable instruction certify the briefing as working -- the mirror of the failure
 * this instrument was built for, and just as wrong. The turns that named nobody are not in it
 * either, and could not be.
 *
 * Neither is counted AGAINST the briefing. A turn in either bucket belongs to no conclusion, so
 * a run whose only targeting evidence is there is INCONCLUSIVE: not elicited, not NONE.
 */
export function targetingElicited(w: TargetingCounts): number {
  return w.addressedTurns + w.invalidTurns + w.ceilingTurns + (w.unadmittedTurns ?? 0)
}

/**
 * Which of the readings this run is evidence for.
 *
 * The readings are opposites wearing the same arithmetic -- `addressedTurns` is 0 in three of
 * them -- so the surfaces cannot each decide for themselves. They did, and they disagreed: the
 * end-of-run summary was taught that truncated-only evidence is inconclusive while the live
 * status line went on printing that the syntax "IS reaching the advisor" from the same counters.
 * An instrument whose surfaces contradict each other is worse than one that is simply wrong,
 * since the operator now has to decide which of them to believe.
 *
 *   - `unmeasured` — no turn tried to instruct. The briefing is untested, which is NOT a
 *     negative result (#31: a null is only evidence if the instrument was known to be live);
 *   - `dispatched` — at least one turn named a seat and its work was admitted. The syntax works
 *     and the run dispatched by name, whatever else also happened;
 *   - `elicited` — the syntax was written in a reply that was read whole, and nothing dispatched
 *     by name. The briefing WORKS and something after it did not, so the repair is the seat
 *     names, the ceilings or the run -- not the briefing's prose;
 *   - `none` — whole replies were read, and not one of them used the syntax. The finding this
 *     instrument exists to make legible;
 *   - `inconclusive` — the only turns that reached for the syntax never reached a settled
 *     readable end (cut off mid-reply, or left open by a withdrawn verdict), or nothing readable
 *     arrived at all. This resolves NOTHING, and the word is chosen so that it cannot be
 *     mistaken for either of the two findings it sits between;
 *   - `pending` — a turn that named a seat is IN FLIGHT and has not been recorded yet, and no
 *     settled turn has already answered the question. Distinct from `inconclusive`, which is a
 *     verdict about turns that are over: this one says the answer is still being written, which
 *     is a different thing to tell an operator who is deciding whether to intervene, and a
 *     different thing for a probe polling `status --json` to key on.
 *
 * ## Why a pending turn cannot leave the reading at `none`
 *
 * The same argument as `inconclusive`'s, at a different point in time. A turn holding
 * `@seat seat-beta` that is paused at its `turn_incomplete` guard may settle as elicitation, so
 * `NONE of 1 instructing turns used @seat/@role` -- printed while an operator reads that very
 * pause -- resolves an open question in the direction the settled turns happen to lean, about
 * the one turn that contradicts them. A pending turn that named NOBODY suppresses nothing, for
 * the reason an unreadable turn does not: `addressed` is fixed by the parser and will not change
 * when the turn settles, so it can never become evidence of elicitation.
 *
 * Settled POSITIVE evidence still outranks it. `dispatched` and `elicited` are facts about turns
 * that are over, and a turn in flight does not withdraw them; those runs report their reading
 * with the in-flight turn named beside it, claiming nothing about it.
 *
 * ## Why `inconclusive` outranks `none`
 *
 * A truncated turn holding an `@seat` fragment is uncertainty that points AT elicitation: settle
 * it and the run may turn out to be `elicited`. Reporting `none` beside it would resolve that
 * uncertainty in the direction the run happens to lean, which is how a briefing that works gets
 * rewritten. So any truncated turn suppresses `none`.
 *
 * The line is WAS THE REPLY READ TO THE END, and it is not "did it address anyone" — which is
 * what this rule used to say, and the correction matters because the two look identical on every
 * settled turn. `addressed` on a turn that stopped mid-reply is a fact about the FRAGMENT that
 * arrived, not about the reply the advisor was writing: a turn cut off after "Right, let's" named
 * nobody and was one clause away from naming someone. `NONE of 2 instructing turns used
 * `@seat`/`@role`` is a claim about both of them, and one of them is a sentence that stops.
 *
 * So EVERY cut-off turn suppresses `none`, addressed or not, and a run reporting the under-use
 * finding is a run where every recorded turn was read out whole. The old asymmetry rested on
 * "they cannot become evidence of elicitation however they are settled", which is true of a whole
 * reply that named nobody and false of a fragment that had not named anyone yet.
 *
 * Turns that were read whole and named nobody keep the position that argument was written for.
 * A reply the parser read and refused, or one a ceiling refused whole, IS settled evidence of
 * non-use; it never contradicts a `none` that the fallback turns earned, and it is reported
 * beside the finding in a clause that claims nothing. They produce `inconclusive` only when there
 * is nothing else at all, which is the truthful reading of a run whose every advisor turn came
 * back empty: not a briefing that failed, a run that never got an answer.
 */
export type TargetingConclusionKind =
  | 'unmeasured'
  | 'dispatched'
  | 'elicited'
  | 'none'
  | 'inconclusive'
  | 'pending'

export interface TargetingConclusion {
  kind: TargetingConclusionKind
  /** Implementer seats, carried so a renderer need not reach past this object. */
  seats: number
  /** The denominator: every turn that tried to instruct. */
  turns: number
  /** Turns that named a seat AND had their work admitted — the concurrency answer. */
  dispatched: number
  /** Turns whose reply was read whole and used the syntax — the elicitation answer. */
  elicited: number
  /** Of those, the ones that dispatched nothing: refused, ceiling-refused, or stranded. */
  elicitedUndispatched: number
  /** Turns that named nobody in a whole reply, so one instruction went out by fallback. */
  fellBack: number
  /**
   * Turns holding an apparent directive that never reached a settled readable end — cut off
   * mid-reply, or left open by a verdict the adapter withdrew with nothing behind it. Settles
   * nothing. The name predates the second kind; the per-outcome clause says which one a turn was.
   */
  truncated: number
  /**
   * Every turn whose reply was never read to the end, addressed or not — `truncated` and the
   * cut-off turns that named nobody together. One of these is what makes `none` unavailable.
   */
  cutOff: number
  /** Turns that named nobody and dispatched nothing. Settles nothing. */
  unreadable: number
  /** `truncated + unreadable`: in the denominator, credited to no conclusion. */
  uncertain: number
}

/**
 * ONE projection, and everything downstream is a rendering of it.
 *
 * The counts, the reading, the evidence split into what may be quoted as usage and what may
 * not, and who was named. `targetingSummary`, `targetingStatusLine` and `reportedTargeting` all
 * consume this and none of them looks at an outcome or re-derives a count; `sessionView.ts`
 * consumes a string. There is one classification of a turn in this codebase and it is
 * `bucketOf`, driven by `UNDISPATCHED`.
 *
 * Pure, and takes only what it reads: the two facts fixed before the run and the records. It
 * accepts a serialized `ReportedTargeting` as readily as the live watch, which is what lets the
 * live status line and the end-of-run summary be the same function of the same evidence.
 */
export interface TargetingEvidence {
  /** How many turns are in this group. */
  turns: number
  /** One clause per outcome present, naming the turns by number. For the multi-line summary. */
  clauses: string[]
  /** The same groups as bare counts, for the one-line status surface. */
  why: string
}

export interface TargetingReading {
  applicable: boolean
  /** The counters, derived. Serialized by `reportedTargeting`; nothing else should read them. */
  counts: Required<TargetingCounts>
  conclusion: TargetingConclusion
  /** Evidence that MAY be quoted as having used `@seat`/`@role`. */
  confirmed: TargetingEvidence
  /** Evidence that may NOT be, and on which nothing may be certified. */
  unsettled: TargetingEvidence
  /**
   * The turn in flight, carried through untouched so every surface names it in the same words.
   *
   * Outside both evidence groups on purpose. `confirmed` and `unsettled` are groups of RECORDS,
   * and a pending turn has none: putting it in either would make it a length somebody counts,
   * and it would then be counted twice the moment its record lands.
   */
  pending?: TargetingPending
  /** Every target named, and how often, in first-named order. */
  named: [string, number][]
}

export function targetingReading(w: {
  applicable: boolean
  seats: number
  records: readonly TargetingRecord[]
  pending?: TargetingPending | undefined
}): TargetingReading {
  // The partition, taken once. Every number below is a length of one of these arrays or a sum of
  // two, and NOT a sum of the named counters -- which is where the last hole was: `turns` and
  // `elicited` were read off `targetingTurns`/`targetingElicited`, and those enumerate the
  // outcomes that have a named counter today. A sixth outcome with an `UNDISPATCHED` row would
  // have landed in its evidence bucket, been quoted in the prose, and been missing from the
  // denominator and possibly from the elicitation sum -- an instrument reporting `1 of 1` about
  // a run that took two turns. Counting the partition instead makes the row genuinely the whole
  // change: a record cannot be in a bucket and out of the total, because the total IS the
  // records.
  const bucket: Record<TargetingBucket, TargetingRecord[]> = {
    dispatched: [],
    fallback: [],
    confirmed: [],
    unsettled: [],
  }
  for (const r of w.records) bucket[bucketOf(r)].push(r)
  // Uncertainty that points AT elicitation, and uncertainty that cannot. An unsettled turn that
  // ADDRESSED someone may turn out to have written the syntax once it is settled, so it
  // suppresses the under-use finding; one that named nobody never can, so it does not. Read off
  // the `addressed` axis rather than off `outcome === 'incomplete'`, so an unsettled outcome
  // added later inherits the right behaviour instead of the wrong one by omission.
  //
  // A row added to `UNDISPATCHED` with `evidence: 'unsettled'` that can appear on an ADDRESSED
  // reply also feeds the INCONCLUSIVE sentence below, which currently says "on a turn that did
  // not complete". Check that sentence when adding such a row; it is accurate for every outcome
  // in this class today. Checked for `withdrawn`: a turn whose only verdict was withdrawn has no
  // verdict, so it did not complete either -- and the per-outcome clause inside the bracket says
  // which of the two kinds it was, since that is where the difference belongs.
  const unread = bucket.unsettled.filter((r) => r.addressed).length
  const unreadable = bucket.unsettled.length - unread
  // Every turn whose reply was never read to the end, addressed or not, and the ONLY thing that
  // decides whether `none` is available. See `TargetingConclusionKind`: a turn cut off before it
  // finished is a fragment, and `addressed` is then a fact about the fragment rather than about
  // the reply -- so a cut-off turn that named nobody YET may have been about to name someone, and
  // `NONE of N instructing turns used @seat/@role` is a claim about all N of them.
  const cutOff = w.records.filter((r) => !readWhole(r)).length
  const dispatched = bucket.dispatched.length
  // The turn in flight, and the ONE thing it is allowed to decide: that a negative reading is not
  // available yet. It contributes to no count below -- not the denominator, not elicitation, not
  // the uncertainty bucket -- because every one of those is a length of a record array, and this
  // turn has no record. It gets one when it ends, and this field is cleared in the same breath.
  const inFlight = w.pending?.addressed === true
  // Elicitation is exactly the turns a parser read to the end and accepted the form of: the ones
  // that dispatched, plus the confirmed group. Read off the buckets for the same reason the
  // denominator is.
  const elicited = dispatched + bucket.confirmed.length
  const conclusion: TargetingConclusion = {
    // Ordered, and the order IS the rule. Positive evidence first, in descending strength;
    // uncertainty only decides a run that has none. Reversing any pair here changes what an
    // operator is told about a run whose evidence points both ways, which is most real runs.
    //
    // `dispatched` and `elicited` sit ABOVE the in-flight test because they are settled: a turn
    // that is still going does not withdraw a turn that already dispatched by name. Everything
    // below it is either a negative finding or a verdict about turns that are over, and neither
    // may be reported while the turn that could overturn it is still being written.
    kind:
      w.records.length === 0 && w.pending === undefined
        ? 'unmeasured'
        : dispatched > 0
          ? 'dispatched'
          : elicited > 0
            ? 'elicited'
            : inFlight
              ? 'pending'
              : cutOff > 0
                ? 'inconclusive'
                : bucket.fallback.length > 0
                  ? 'none'
                  : w.records.length === 0
                    ? 'pending'
                    : 'inconclusive',
    seats: w.seats,
    // The denominator, and it is the record count itself rather than anything summed. "Every
    // turn that tried to instruct" is a property of where the recording happens, and this is the
    // only expression of it that cannot be made false by an outcome nobody remembered to add.
    turns: w.records.length,
    dispatched,
    elicited,
    elicitedUndispatched: bucket.confirmed.length,
    fellBack: bucket.fallback.length,
    truncated: unread,
    cutOff,
    unreadable,
    uncertain: bucket.unsettled.length,
  }
  const named = new Map<string, number>()
  for (const r of w.records) for (const t of r.targets) named.set(t, (named.get(t) ?? 0) + 1)
  return {
    applicable: w.applicable,
    counts: compatCounts(w.records, bucket),
    conclusion,
    confirmed: evidenceOf(w.records, 'confirmed', bucket.confirmed.length),
    unsettled: evidenceOf(w.records, 'unsettled', bucket.unsettled.length),
    ...(w.pending === undefined
      ? {}
      : { pending: { turn: w.pending.turn, addressed: w.pending.addressed, targets: [...w.pending.targets] } }),
    named: [...named],
  }
}

/**
 * The named counters the documents carry. A COMPATIBILITY PROJECTION, and an input to nothing.
 *
 * `conclusion` above is computed from the bucket partition and never from these. That separation
 * is the point rather than a style: these fields enumerate the outcomes that exist today, so a
 * sixth outcome silently has no field here -- which is a wire-format decision somebody must
 * make, and exactly the kind of omission that must not be able to move a conclusion while it is
 * pending. The `PARTITION` regression asserts they still account for every recorded turn, so the
 * decision is forced rather than discovered later by a reader doing arithmetic on a document.
 *
 * They exist at all because a probe reading `conclave status --json` cannot run a projection,
 * and because `0 addressed of 0 turns` and `0 addressed of 9` are different findings a reader
 * must be able to tell apart without parsing the record list.
 */
function compatCounts(
  records: readonly TargetingRecord[],
  bucket: Record<TargetingBucket, TargetingRecord[]>,
): Required<TargetingCounts> {
  const addressedWith = (outcome: TargetingOutcome): number =>
    records.filter((r) => r.addressed && r.outcome === outcome).length
  return {
    addressedTurns: bucket.dispatched.length,
    unaddressedTurns: bucket.fallback.length,
    invalidTurns: addressedWith('invalid'),
    ceilingTurns: addressedWith('ceiling'),
    incompleteTurns: addressedWith('incomplete'),
    unadmittedTurns: addressedWith('unadmitted'),
    withdrawnTurns: addressedWith('withdrawn'),
    unaddressedFailedTurns: records.filter((r) => !r.addressed && r.outcome !== 'admitted').length,
  }
}

/**
 * One evidence group, rendered from the records and the table. Per turn, and as bare counts.
 *
 * Per turn because the turn number is what makes this joinable to the routing log, the ceiling's
 * numbering and the pause evidence -- the whole argument behind `TargetingRecord.turn`. A
 * grouped count would be a statistic; this is an address. The bare counts exist for the one-line
 * status surface, which has no room for turn numbers, and they are built here so the two cannot
 * name different kinds.
 */
function evidenceOf(
  records: readonly TargetingRecord[],
  bucket: 'confirmed' | 'unsettled',
  turns: number,
): TargetingEvidence {
  const at = (shape: Omit<OutcomeShape, 'evidence'>, group: TargetingRecord[]): string =>
    `${shape.clause} — ` +
    group
      .map((r) => `turn ${r.turn}: ${shape.detail(r)}${r.targets.length ? ` (${r.targets.join(', ')})` : ''}`)
      .join('; ') +
    (shape.note === '' ? '' : `; ${shape.note}`)
  const clauses: string[] = []
  const why: string[] = []
  // In table order, which is the order a reader is meant to weigh them in: the strongest
  // evidence first within each group.
  for (const [outcome, shape] of Object.entries(UNDISPATCHED) as [
    Exclude<TargetingOutcome, 'admitted'>,
    OutcomeShape,
  ][]) {
    if (shape.evidence !== bucket) continue
    const group = records.filter((r) => r.addressed && r.outcome === outcome)
    if (group.length === 0) continue
    clauses.push(at(shape, group))
    why.push(`${group.length} ${shape.why}`)
  }
  // The cross-outcome group, last, and only in the unsettled bucket -- a reply that named nobody
  // can never be quoted as having used the syntax.
  if (bucket === 'unsettled') {
    const group = records.filter((r) => !r.addressed && r.outcome !== 'admitted')
    if (group.length > 0) {
      clauses.push(at(NAMED_NOBODY, group))
      why.push(`${group.length} ${NAMED_NOBODY.why}`)
    }
  }
  // Only the kinds that actually happened. `(0 refused, 1 on a turn that did not complete)`
  // invites a reader to look for a refusal there is none of.
  return { turns, clauses, why: why.join(', ') }
}

/**
 * The `targeting` block as a document carries it, or nothing at all.
 *
 * ONE type and ONE rule, shared by `RunReport` and `SessionStatus` rather than declared beside
 * each. The rule -- omit unless the run had a seat to address -- is the kind that goes wrong by
 * being written twice: one serializer relaxed, or one forgotten, and a default run starts
 * carrying a key that alleges nothing while a multi-seat run stops carrying the one that
 * alleges everything.
 *
 * `applicable` is `true` and can be nothing else, and it is kept rather than dropped as
 * redundant: a block read on its own -- lifted into a spreadsheet, quoted in an issue -- has to
 * say what it is asserting about, and `seats: 3` alone does not state the rule that made the
 * measurement meaningful.
 */
export interface ReportedTargeting {
  /** Always `true`. The block is absent, not `false`, when the run had one implementer seat. */
  applicable: true
  /** Implementer seats. `> 1` is what `applicable` means, reported so a reader need not ask. */
  seats: number
  addressedTurns: number
  unaddressedTurns: number
  /**
   * Turns that used `@seat`/`@role` and were refused before dispatch. See
   * `TargetingWatch.invalidTurns`: a reader adding this to `addressedTurns` gets the number of
   * turns the briefing elicited the syntax from, which is not the number that dispatched.
   */
  invalidTurns: number
  /**
   * Turns whose VALID `@seat`/`@role` batch a run ceiling refused whole. See
   * `TargetingWatch.ceilingTurns`: elicitation that dispatched nothing, and a reader adding it
   * to `addressedTurns` and `invalidTurns` gets the number of turns the briefing got the syntax
   * out of.
   */
  ceilingTurns: number
  /**
   * Turns that used `@seat`/`@role` on a turn that did not complete. See
   * `TargetingWatch.incompleteTurns`: an uncertainty bucket, OUTSIDE the elicitation sum and
   * outside the under-use one. A reader must not add it to either.
   */
  incompleteTurns: number
  /**
   * Turns whose whole valid `@seat`/`@role` reply was never admitted, for a reason that is
   * neither a refusal nor a ceiling. See `TargetingWatch.unadmittedTurns`: elicitation, so a
   * reader adds it to `addressedTurns`, `invalidTurns` and `ceilingTurns` for the number of
   * turns the briefing got the syntax out of.
   */
  unadmittedTurns: number
  /**
   * Turns whose reported verdict was withdrawn with NOTHING put in its place, so the turn has no
   * verdict at all. An uncertainty bucket like `incompleteTurns`, OUTSIDE the elicitation sum and
   * outside the under-use one: the last word on such a turn is that the claim it had ended was
   * wrong, which establishes nothing about the reply. A reader must not add it to either.
   */
  withdrawnTurns: number
  /**
   * Turns that named NOBODY and dispatched nothing. See
   * `TargetingWatch.unaddressedFailedTurns`: in the denominator, credited to no conclusion, and
   * NOT to be added to `unaddressedTurns` -- that counter means a fallback dispatch happened.
   */
  unaddressedFailedTurns: number
  /**
   * What the counts above add up to, decided ONCE for every document and every renderer.
   *
   * Serialized rather than left for each reader to derive, and that is the point: a probe, a
   * dashboard and this project's own status line all used to re-implement the reading, and the
   * one that drifted reported a briefing as working on evidence nobody had read to the end. See
   * `TargetingConclusionKind` for what the six values mean and why `inconclusive` outranks `none`.
   */
  conclusion: TargetingConclusionKind
  /**
   * The advisor turn in flight when this document was written, if there was one.
   *
   * Absent from any document written between turns, which is every end-of-run report. A probe
   * must not add it to any counter here: it has no outcome yet, so it is in none of them, and
   * the counter it will land in is decided when it ends. It is present so that a reader of a
   * LIVE document can tell "no turn has used the syntax" from "no turn has used the syntax and
   * one that named a seat is still being written" -- see `TargetingWatch.pending`.
   */
  pending?: { turn: number; addressed: boolean; targets: string[] }
  /**
   * Per advisor turn that tried to instruct, in order: whether it addressed anyone, what it
   * named, and what became of it. `refusal` appears only on `invalid` records, `ceiling` only
   * on `ceiling` ones, `verdict` only on `incomplete` ones and `unadmitted` only on
   * `unadmitted` ones.
   */
  records: {
    turn: number
    addressed: boolean
    targets: string[]
    outcome: TargetingOutcome
    refusal?: ParseFailure['why']
    ceiling?: CeilingBreach['kind']
    verdict?: Outcome
    unadmitted?: UnadmittedReason
  }[]
}

/**
 * What a document should carry for this run, which on a one-seat run is nothing.
 *
 * Copied, records and all: both callers write repeatedly from a live relay, and handing out the
 * array it still owns would let a reader of an earlier document see a list that moved
 * underneath it. The counters are rendered from those same records by `targetingReading` at this
 * moment, so a document can never carry a count that disagrees with the turns beside it.
 */
export function reportedTargeting(w: TargetingWatch): ReportedTargeting | undefined {
  if (!w.applicable) return undefined
  const reading = targetingReading(w)
  return {
    applicable: true,
    seats: w.seats,
    ...reading.counts,
    // From the same projection the prose surfaces render, never a second reading of the counters
    // sitting beside it in this object.
    conclusion: reading.conclusion.kind,
    // Projected to the three fields a reader may have, never handed out whole: the relay holds
    // its in-flight turn as an object carrying the turn's `turn_end` and its dispatch state, and
    // serializing that would put a live event -- and an outcome this turn has not reached -- in
    // a document that says it has no outcome.
    ...(reading.pending === undefined
      ? {}
      : {
          pending: {
            turn: reading.pending.turn,
            addressed: reading.pending.addressed,
            targets: [...reading.pending.targets],
          },
        }),
    records: w.records.map((r) => ({
      turn: r.turn,
      addressed: r.addressed,
      targets: [...r.targets],
      outcome: r.outcome,
      // Omitted rather than `undefined` where they do not apply: `outcome` already says which
      // of the four, if any, this record can carry, and a key present with no value is a key
      // a probe has to interpret.
      ...(r.refusal === undefined ? {} : { refusal: r.refusal }),
      ...(r.ceiling === undefined ? {} : { ceiling: r.ceiling }),
      ...(r.verdict === undefined ? {} : { verdict: r.verdict }),
      ...(r.unadmitted === undefined ? {} : { unadmitted: r.unadmitted }),
    })),
  }
}

/** `@seat implementer-2` / `@role implementer`, as the advisor would have had to write it. */
export function describeTarget(target: TaskTarget): string {
  return target.kind === 'seat' ? `@seat ${target.seat}` : `@role ${target.role}`
}

/** `1 turn` / `2 turns`, since every count below is quoted in a sentence. */
function turnWord(n: number): string {
  return `${n} turn${n === 1 ? '' : 's'}`
}

/**
 * The turn in flight, in the words BOTH prose surfaces use for it, or nothing when there is none.
 *
 * One wording, for the reason every other sentence in this file is written once: the live status
 * line and the end-of-run summary are read by the same operator minutes apart, and a turn
 * described as "still being taken" on one and as anything else on the other is two instruments.
 *
 * It says what the turn NAMED and refuses to say what that means. "Appears to name" rather than
 * "used", because the reply that named it may still turn out to have been cut off mid-directive
 * -- the same reason a truncated record is unsettled evidence -- and because a turn quoted with
 * the word "used" is a turn some later count will want to add up.
 */
function pendingClause(p: TargetingPending | undefined): string | undefined {
  if (p === undefined) return undefined
  return p.addressed
    ? `advisor turn ${p.turn} is still being taken and appears to name ` +
        `${p.targets.join(', ') || 'a seat'}, so it has settled nothing yet`
    : `advisor turn ${p.turn} is still being taken and named nobody, so it has settled nothing yet`
}

/**
 * One line an operator can read to know whether the advisor used the syntax the run depends on.
 *
 * `undefined` — printed by nobody — when targeting was not applicable. That is the one-seat
 * rule: there is no question to answer, and answering it anyway is how a line stops being read.
 * Nothing else reports it there either — `reportedTargeting` writes no block — so a one-seat run
 * says nothing about targeting anywhere. A reader who wants to know whether targeting was even
 * possible counts the run's implementer seats, which every document already lists.
 *
 * Renders `targetingReading` and classifies nothing. The rule every branch below is held to:
 * **no count that includes an unsettled turn may be described as usage, and no certification may
 * rest on one.** `reading.confirmed` is the only group that may appear under the word "used";
 * `reading.unsettled` gets its own clause, which claims nothing.
 */
export function targetingSummary(w: TargetingWatch): string | undefined {
  if (!w.applicable) return undefined
  const { conclusion: c, confirmed, unsettled, named, pending } = targetingReading(w)
  // Nothing measured. Distinct from "measured, and the advisor never targeted", and the
  // distinction is the whole of #31 restated: a run that ended before its advisor issued any
  // work is uninformative about the briefing, not evidence against it.
  if (c.kind === 'unmeasured') {
    return (
      `advisor targeting: ${c.seats} implementer seats — 0 turns produced an instruction, so ` +
      `nothing was measured; this is not a negative result`
    )
  }
  const turns = c.turns
  const breakdown =
    named.length === 0 ? '' : `\n  addressed to: ${named.map(([t, n]) => `${t} (${n})`).join(', ')}`
  const fellBack = c.fellBack === 0 ? '' : `, and ${c.fellBack} named nobody and went out by fallback`
  // The unsettled turns, said in their own sentence wherever they appear beside a confirmed
  // count. Never folded into one, because the fold is the overclaim: a total that mixes them
  // cannot be described with the word "used".
  const unsettledTail =
    unsettled.turns === 0
      ? ''
      : `\n  ${turnWord(unsettled.turns)} settled nothing either way [${unsettled.clauses.join(' | ')}]`
  // The turn in flight, on its own line for the same reason: it is not a record, it is in none of
  // the counts above, and a reader must not be able to add it to one. Appended to every branch,
  // including the ones whose reading it does not change -- a run that dispatched by name and has
  // a turn open is still a run with a turn open, and the surface that hides it is the surface an
  // operator reads while waiting for it.
  const inFlightTail = pendingClause(pending) === undefined ? '' : `\n  ${pendingClause(pending)}`
  // A turn that named a seat is open, and nothing settled has already answered the question. Its
  // own branch ahead of every reading below, because each of those is a claim about a question
  // this run is still in the middle of answering -- `NONE` most of all, which would report the
  // briefing as having failed off the settled turns while the turn holding `@seat` is paused in
  // front of the operator reading it. Says what is known, names what is open, concludes nothing.
  //
  // `confirmed` is empty by construction here, as in the inconclusive branch: this reading is
  // reached on `elicited === 0`.
  if (c.kind === 'pending') {
    return (
      `advisor targeting: NOT SETTLED YET — ${pendingClause(pending)}, on a run with ${c.seats} ` +
      `implementer seats. ` +
      (turns === 0 ? `No turn has been recorded yet` : `${turnWord(turns)} recorded so far`) +
      (c.fellBack === 0 ? '' : `, ${c.fellBack} of which went out by fallback to one seat`) +
      `, and this turn is neither elicitation nor under-use until it ends` +
      breakdown +
      unsettledTail
    )
  }
  if (c.kind === 'inconclusive') {
    // Nothing but uncertain evidence: either the only turns that reached for the syntax never
    // reached a settled readable end -- cut off mid-reply, or left open by a verdict the adapter
    // withdrew with nothing behind it -- or nothing readable arrived at all.
    //
    // The explanation below is written for BOTH, and that is the repair rather than a tidy-up: it
    // used to say "a reply that was cut off may not be the form it looks like", which is a
    // sentence about truncation, and a turn whose verdict was withdrawn had its reply described as
    // cut off when nobody had said any such thing. What the two kinds share is exactly what the
    // reading rests on -- no settled end, so nothing establishes that the apparent directive was
    // complete -- and WHICH kind a turn was stays in the clause `UNDISPATCHED` writes for it.
    //
    // Its own branch, ahead of both zero-addressed readings below, because it is neither of them
    // and saying either would be a claim this run cannot support. `ELICITED` would certify a
    // briefing on the strength of a reply nobody read to the end -- the mirror of the failure
    // this instrument exists to prevent, and just as wrong. `NONE` would report a briefing as
    // having failed when the fragment that survived is an `@seat` line. So this branch resolves
    // nothing, names the uncertainty, and says what would settle it. Neither word appears in it,
    // and neither does "the syntax IS reaching the advisor", which is the same certification in
    // other clothes.
    //
    // `confirmed` is empty by construction here: this reading is reached on `elicited === 0`.
    if (c.truncated > 0) {
      return (
        `advisor targeting: INCONCLUSIVE — ${c.truncated} of ${turns} instructing ` +
        `turn${turns === 1 ? '' : 's'} appear${c.truncated === 1 ? 's' : ''} to have written ` +
        `@seat/@role, and not one of them reached a settled readable end ` +
        `[${unsettled.clauses.join(' | ')}]${fellBack}, on a run with ${c.seats} implementer seats. ` +
        `Nothing dispatched by name, so this run never dispatched concurrently — but nothing ` +
        `establishes that the apparent directive was complete, so this run is evidence NEITHER ` +
        `that the briefing works NOR that it does not. Settle it on a run whose advisor turns end ` +
        `on a verdict that stands before changing the briefing or the seat names` +
        breakdown +
        inFlightTail
      )
    }
    // A run that DID route instructions by fallback and also lost a turn before its reply was
    // read out. The under-use finding is what this run points at and it is not available: the
    // fallback turns are settled evidence of non-use, and the cut-off one is a sentence that
    // stops, which is evidence of nothing. Said as a finding that is NOT SETTLED rather than as
    // no finding, because the difference decides whether an operator waits for another turn or
    // goes and rewrites the briefing.
    //
    // Its own branch because both sentences below are false of it: instructions DID dispatch
    // here, by fallback, and a reply WAS read that could have carried a directive.
    if (c.fellBack > 0) {
      return (
        `advisor targeting: INCONCLUSIVE — not one of ${turns} instructing ` +
        `turn${turns === 1 ? '' : 's'} was read whole and used @seat/@role, and ` +
        `${turnWord(c.cutOff)} never reached a settled readable end ` +
        `[${unsettled.clauses.join(' | ')}], on a run with ${c.seats} implementer seats. ` +
        `${c.fellBack} named nobody and went out by fallback to one seat, so nothing dispatched ` +
        `by name — but a turn nobody can read to a settled end may have used @seat/@role in the ` +
        `part that never landed, so the under-use finding this run points at is NOT settled. ` +
        `Settle it on a run whose advisor turns end on a verdict that stands before changing the ` +
        `briefing or the seat names` +
        breakdown +
        inFlightTail
      )
    }
    // The other way to reach it: every instructing turn named nobody AND dispatched nothing --
    // empty replies, refusals, turns that died before they said anything. `NONE` is wrong here
    // for a different reason than above: not because a fragment might have been a directive, but
    // because no reply was ever read that could have carried one. The briefing was not tested.
    return (
      `advisor targeting: INCONCLUSIVE — ${turns} instructing turn${turns === 1 ? '' : 's'} ` +
      `produced nothing that names a seat and nothing that dispatched ` +
      `[${unsettled.clauses.join(' | ')}], on a run with ${c.seats} implementer seats. ` +
      `Nothing dispatched by name, so this run never dispatched concurrently — but no reply was ` +
      `read that could have carried a directive, so this run is evidence NEITHER that the ` +
      `briefing works NOR that it does not. Settle it on a run whose advisor turns produce a ` +
      `readable instruction before changing the briefing or the seat names` +
      inFlightTail
    )
  }
  // The syntax reached the advisor and nothing it wrote ever dispatched. Said BEFORE the
  // under-use branch below and in place of it, because those two readings are opposites wearing
  // the same arithmetic: `addressedTurns` is 0 in both, and reporting "NONE used @seat/@role"
  // for a run whose advisor wrote `@seat` on every turn would send a reader to rewrite a
  // briefing that is working.
  //
  // The word NONE is deliberately absent from this branch, down to "not one of them dispatched".
  // It belongs to exactly one reading in this instrument -- the advisor never wrote the syntax --
  // so an operator or a grep can treat it as that reading's marker, and the tests guard it as a
  // bare token for the same reason.
  //
  // The bracket carries the CONFIRMED clauses only. "Not one of them dispatched" is a sentence
  // about the turns just counted as having written the syntax, and a truncated turn listed
  // inside it reads as one of them -- which is the count `c.elicited` was built to exclude.
  if (c.kind === 'elicited') {
    return (
      `advisor targeting: the briefing ELICITED @seat/@role — ${c.elicited} of ${turns} ` +
      `instructing turn${turns === 1 ? '' : 's'} wrote it in a reply that was read whole — but ` +
      `not one of them dispatched [${confirmed.clauses.join(' | ')}]${fellBack}, on a run with ` +
      `${c.seats} implementer seats. ` +
      `Nothing dispatched by name, so this run never dispatched concurrently — but the advisor ` +
      `IS reaching for the syntax, so a briefing rewrite is not what this run is asking for` +
      breakdown +
      unsettledTail +
      inFlightTail
    )
  }
  // The finding this whole instrument exists to make legible, said first and said plainly. An
  // operator reading `0 of 9` down a line of counters has to do the arithmetic and then decide
  // it matters; a run where the briefing did not take is not a statistic about the run.
  //
  // Reached only when whole replies were read and none of them used the syntax: not one the
  // parser threw away, not one a ceiling refused, not one that died holding it -- the truncated
  // case has its own branch above precisely because NONE would be a guess there.
  //
  // "EVERY instruction was routed by fallback" only when that is true. A run reaching this
  // reading can still hold turns that dispatched nothing at all, and describing those as
  // fallback routing would credit the run with instructions it never issued.
  if (c.kind === 'none') {
    return (
      `advisor targeting: NONE of ${turns} instructing turn${turns === 1 ? '' : 's'} used ` +
      `@seat/@role on a run with ${c.seats} implementer seats — ` +
      (unsettled.turns === 0
        ? `every instruction was routed by fallback to one seat`
        : `${c.fellBack} of them went out by fallback to one seat`) +
      `, so this run never dispatched concurrently and a blocked seat could ` +
      `not have been repaired` +
      unsettledTail +
      inFlightTail
    )
  }
  // And the turns that used the syntax without dispatching, appended rather than dropped, on a
  // run where some turns did dispatch by name. `2 of 4 addressed` with a third turn refused is a
  // different run from `2 of 4` with two unaddressed, and the tail is the only place that
  // difference is said.
  //
  // `confirmed.turns` and NOT that plus the unsettled ones, which is what this counted before.
  // This sentence says "used @seat/@role", so only the turns that demonstrably did may be in its
  // number; the unsettled ones get `unsettledTail`, which claims nothing.
  const tail =
    confirmed.turns === 0
      ? ''
      : `\n  ${confirmed.turns} further turn${confirmed.turns === 1 ? '' : 's'} used ` +
        `@seat/@role without dispatching [${confirmed.clauses.join(' | ')}]`
  return (
    `advisor targeting: ${c.dispatched} of ${turns} instructing turns addressed a seat ` +
    `(${c.fellBack} named nobody and went out by fallback), ${c.seats} implementer ` +
    `seats${breakdown}${tail}${unsettledTail}${inFlightTail}`
  )
}

/**
 * The same answer as one line, for the live `conclave status` surface. See `targetingSummary`.
 *
 * Here rather than in `sessionView.ts`, and that placement is the fix rather than a tidy-up. The
 * status renderer used to rebuild this wording from the counters itself, and rebuilding it is
 * what let the two drift: the summary was taught that truncated-only evidence settles nothing
 * while this line went on printing `so the syntax IS reaching the advisor` from the same
 * numbers. Whichever surface an operator happened to read decided whether they rewrote a
 * briefing that works. Now both are renderings of `targetingReading` in one file, and neither
 * can be edited without the other being in front of the editor.
 *
 * Takes the SERIALIZED block, because that is what a status document holds, and reads its
 * records rather than its counters -- so a document written by a build that had different
 * counters still renders correctly from the turns it recorded.
 *
 * Returns the line's BODY, without the `targeting:` label, so the caller keeps its own column
 * alignment and this keeps every word that makes a claim.
 *
 * `undefined` on a one-seat run for the reason `targetingSummary` returns it, and ALSO on a
 * multi-seat run that has instructed nothing -- which is where the two surfaces differ on
 * purpose. The end-of-run summary says "nothing was measured" because by then it is a negative
 * result; a prose reader watching a run that started thirty seconds ago is not helped by a line
 * saying nothing has been measured yet. The JSON block is present either way, because a probe
 * must be able to tell an instrument that was live and saw nothing from one that was never
 * there (#31).
 */
export function targetingStatusLine(t: {
  applicable: boolean
  seats: number
  records: readonly TargetingRecord[]
  pending?: TargetingPending | undefined
}): string | undefined {
  if (!t.applicable) return undefined
  const { conclusion: c, confirmed, unsettled, pending } = targetingReading(t)
  if (c.kind === 'unmeasured') return undefined
  // Said in its own clause wherever it appears, and never inside a count described as having
  // used the syntax. A truncated turn only APPEARS to have written it and a turn that named
  // nobody demonstrably did not, so a total containing either cannot carry the word "used" --
  // which is exactly what this line used to do, on the same total that carried "IS reaching".
  const unsettledClause =
    unsettled.turns === 0 ? [] : [`${turnWord(unsettled.turns)} settled nothing (${unsettled.why})`]
  // The confirmed clause, and the ONLY place the certification appears. Gated on the confirmed
  // group, which holds turns the parser read to the end and nothing else.
  const confirmedClause =
    confirmed.turns === 0
      ? []
      : [
          `${confirmed.turns} used @seat/@role without dispatching (${confirmed.why}), so the ` +
            `syntax IS reaching the advisor`,
        ]
  // The turn in flight, in the same words the summary gives it, as its own clause. It is in no
  // count on this line -- `c.turns` is the settled turns and nothing else -- so it can never be
  // read as part of one, and when it ends its record moves the counts by exactly one.
  const inFlightClause = pendingClause(pending)
  const pendingClauses = inFlightClause === undefined ? [] : [inFlightClause]
  const lead =
    `${c.dispatched} of ${c.turns} instructing turns named a seat (@seat/@role), ` +
    `${c.seats} implementer seats`
  // Joined, never summed. Two clauses side by side is the whole of the repair: one number the
  // reader may read as usage, one they may not, and no total that spans both.
  const after = (...clauses: string[][]): string => {
    const all = clauses.flat()
    return all.length === 0 ? '' : ` — ${all.join(', and ')}`
  }
  switch (c.kind) {
    case 'dispatched':
    case 'elicited':
      return `${lead}${after(confirmedClause, unsettledClause, pendingClauses)}`
    case 'none':
      return (
        `${lead} — NONE addressed, so nothing has dispatched concurrently` +
        after(unsettledClause, pendingClauses).replace(' — ', ', and ')
      )
    case 'pending':
      // The line this whole field exists for, and it is a LIVE line: an operator sitting in front
      // of a `turn_incomplete` pause on the turn that holds `@seat seat-beta` used to read `NONE
      // addressed, so nothing has dispatched concurrently` -- a finding against the briefing,
      // computed off the turns that are over, while the turn that contradicts them was the one
      // they were being asked about. The word NONE does not appear in this branch, and neither
      // does any certification: the answer is being written and the line says so.
      //
      // No `lead` when nothing is recorded yet: `0 of 0 instructing turns named a seat` is a
      // vacuous count an operator has to decode, and the clause below says the whole of what is
      // known.
      return c.turns === 0
        ? `${c.seats} implementer seats — NOT SETTLED YET: ${inFlightClause}`
        : `${lead} — NOT SETTLED YET: ${inFlightClause}` +
            after(unsettledClause).replace(' — ', ', and ')
    default:
      // Nothing settled either way. "The syntax IS reaching the advisor" is a certification, and
      // a reply nobody read to the end cannot support one -- an operator told that mid-run stops
      // looking at the briefing. Neither may it read NONE, which would send them to rewrite it.
      // So the line says the one true thing: this has not been settled either way yet.
      if (c.truncated > 0) {
        return (
          `${lead} — INCONCLUSIVE: ${c.truncated} wrote @seat/@role only on turns that never ` +
          `reached a settled readable end (${unsettled.why}), so nothing establishes that the ` +
          `apparent directive was complete and nothing yet shows whether the briefing works` +
          after(pendingClauses)
        )
      }
      // The same reading the summary's middle branch renders, and here for the same reason: this
      // run routed by fallback, so neither "nothing dispatched" nor "no reply has been read" is
      // true of it, and the finding it points at is the one the cut-off turn withholds.
      if (c.fellBack > 0) {
        return (
          `${lead} — INCONCLUSIVE: ${c.fellBack} named nobody and went out by fallback, but ` +
          `${turnWord(c.cutOff)} never reached a settled readable end (${unsettled.why}), so a ` +
          `turn nobody can read to a settled end may have used @seat/@role and the under-use ` +
          `finding is not settled` +
          after(pendingClauses)
        )
      }
      return (
        `${lead} — INCONCLUSIVE: no reply has been read that could carry a directive ` +
        `(${unsettled.why}), so nothing yet shows whether the briefing works` + after(pendingClauses)
      )
  }
}
