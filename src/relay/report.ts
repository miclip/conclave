/**
 * A run's terminal record, as data.
 *
 * Conclave already distinguishes `observed` from `reasoned_but_unverified` internally, then
 * exits as prose — exactly backwards for an operator whose job is to confirm the outcome. If
 * that operator is an agent, and in practice it often is, the console is a rendering with no
 * interface underneath it, and confirming a run means grepping a transcript.
 *
 * This is the interface underneath it. Every claim the summary lines make, plus the ones they
 * could not: per-turn verdicts with their confidence and provenance, what was attributed to a
 * restricted aside and how well, and what remains flagged.
 *
 * ## Two rules it is built to
 *
 * **Nothing here is re-derived.** Every field is read off the relay's own state — the same
 * state the prose lines print from. A report that recomputed a verdict could disagree with
 * the console about the same run, and then there would be two answers and no way to tell
 * which was wrong.
 *
 * The seat's `agent` id is reported and its capability grades are not. Those are a property
 * of the adapter rather than of this run, they are printed by `npm run conformance`, and
 * copying them here would create a second place for them to be wrong.
 *
 * **Absence is reported, not omitted.** `rotation.armed: false` and an empty `flags` array
 * are facts an operator acts on. A field that vanishes when it has nothing to say forces a
 * reader to distinguish "no flags" from "this build does not report flags", which is the
 * ambiguity `rotationWatch` exists to remove.
 */

import type { Confidence, Provenance } from '../contract/outcome.ts'
import type { ParticipantLaunch } from '../registry/launch.ts'
import type { ForceRecord, RunOutcome } from './run.ts'
import type { RotationRecord } from './rotationIntent.ts'
import { reportedTargeting, type ReportedTargeting } from './targeting.ts'
import type { Relay, RunDeadlines, UnexpectedWrite } from './relay.ts'

/**
 * Bumped when a consumer would break. Present from the first version, because adding it
 * later means every existing consumer has to cope with its absence.
 */
export const REPORT_SCHEMA = 1

export interface ReportedTurn {
  /** Opaque; the adapter's own key. Never parse it. */
  key: string
  state: string
  confidence?: Confidence | undefined
  /** Ordered, most decisive first. The reason a verdict is believed, not just the verdict. */
  provenance?: Provenance[] | undefined
  /** Tool names only. The arguments are evidence and can be large; the log has them. */
  tools: string[]
  startedAt?: number | undefined
  endedAt?: number | undefined
}

export interface ReportedParticipant {
  id: string
  agent: string
  rank: string
  /**
   * What the seat was for. Beside `rank` because they answer different questions and a reader
   * auditing a finished run cannot recover either from the other: rank says who deferred to
   * whom, role says which of the seats this was. At N=1 they agree, and the field is present
   * and equal to `implementer` rather than absent — the same rule `turns` follows above, for
   * the same reason. A field that vanishes when it has nothing to say makes a reader
   * distinguish "no role" from "this build does not report roles".
   */
  role: string
  /**
   * What this seat was launched with, and the model that argv names.
   *
   * `agent` alone does not identify what ran. One `agent: opencode` can be any of dozens of
   * models across a ~30x price spread (#71), so a reader could neither cost the run nor
   * repeat it. Copied from the relay's participant rather than recomputed here, per the rule
   * at the top of this file: the relay composed that argv when it launched the seat.
   *
   * `model` is `null` when the argv named none, and NOT an empty string — see
   * `modelFromArgs`. There is no token count and no cost anywhere in this report, and that
   * is a decision rather than an omission: conclave drives the operator's own CLI on the
   * operator's own subscription, and the honest thing it can offer is the join key for the
   * billing export their provider already has.
   */
  launch: ParticipantLaunch
  sessionId: string
  turns: ReportedTurn[]
  /** Times the transcript was rewritten under this session. Rotation's mechanical trigger. */
  compactionGeneration: number
}

export interface RunReport {
  schema: number
  goal: string
  cwd: string
  /**
   * The build string captured at startup.
   *
   * Reported rather than recomputed at shutdown so the record names the build that ran the
   * session, not the build that happened to be present when the report was assembled. Release
   * archives have no git history, so recomputing would silently drop the commit identity.
   */
  build: string
  /**
   * Who was answering escalations.
   *
   * Recorded because it changes what an escalation MEANS. An agent operator is the same kind
   * of thing as the participants and may share their blind spots, so its answer is another
   * opinion with authority rather than independent confirmation. A reader auditing a run
   * cannot recover that from the routing log, where both look identical.
   */
  operator: 'human' | 'agent'
  outcome: RunOutcome
  /**
   * The clocks each seat's turns were judged against.
   *
   * Beside `outcome` because it is only meaningful there. `timed_out` says a clock ran out
   * and not which one, how long it was, or whether the seat that timed out was even the one
   * the invocation configured -- so a reader deciding "overran its budget" from "cut short
   * by a tight setting" had to supply the build's defaults from memory.
   *
   * Per participant rather than per run, because the verdict is. Two seats can be on
   * different clocks or on none, and the configured policy may not have applied to the one
   * that actually timed out. `unsupported` is the case worth the shape: a seat with no
   * silence clock that goes quiet forever produces NO verdict, so a reader who took the
   * run-wide number for an answer would sit waiting for a timeout that cannot arrive.
   */
  deadlines: RunDeadlines
  startedAt: number
  endedAt: number
  durationMs: number
  /**
   * How long the run spent PAUSED, waiting for an operator to decide (#112).
   *
   * Present and `0` on every run that never paused, per this file's rule that a key which
   * vanishes when it has nothing to say cannot be told from a key a reader forgot to look for.
   *
   * This is the answer to the question the issue asked the report to answer: "ended: budget,
   * spent on work" and "ended: budget, spent on interruptions" read identically before it, and a
   * reader could only tell them apart by counting the pauses in the routing log by hand.
   */
  pausedMs: number
  /**
   * How long the run spent RUNNING, which is the figure the duration ceiling compared (#112).
   *
   * Read off `Relay.activeMs` -- the ceiling's own reading -- rather than derived here, because
   * it cannot be derived here. `durationMs - pausedMs` looks like the same quantity and is not:
   * `durationMs` starts when the FRONT END did, before any session was spawned or briefed, while
   * the ceiling window opens at the run's first turn. The difference is the launch, and it is
   * charged to neither.
   *
   * So the three time figures answer three different questions and are not an identity to be
   * checked: `durationMs` is how long the operator waited for the whole command, `pausedMs` is
   * how much of that the run spent waiting for the operator back, and this is what
   * `--max-minutes` was measured against. A run that ends on that ceiling quotes THIS number in
   * its detail.
   */
  activeMs: number
  messages: number
  participants: ReportedParticipant[]
  rotation: {
    armed: boolean
    assessments: number
    degradationsSeen: number
    complaintsSeen: number
    /** Candidates raised. Distinct from `rotations`, which are candidates ACTED on. */
    candidates: number
    rotations: number
    peakGeneration: number
    /**
     * Each accepted rotation and WHY it happened. See `rotationIntent.ts`.
     *
     * `rotations` above says how many; this says which population each belongs to, and without
     * it the count is not usable as evidence. #10 asks whether compaction predicts degradation
     * strongly enough to act on unattended, and a rotation the operator took to get a fresh
     * reader onto a just-committed criterion arrives WITH a compaction generation attached --
     * because compaction happens anyway. So it reads as "the proxy fired and the operator
     * rotated", which is exactly the correlation being measured, and any dataset built from
     * `rotations` alone confirms the hypothesis with rotations that had nothing to do with
     * degradation (#75).
     *
     * Present and empty on a run that rotated nothing, per this file's second rule: a key that
     * vanishes when it has nothing to say makes a reader distinguish "no rotations" from "this
     * build does not report why".
     */
    records: RotationRecord[]
  }
  /**
   * Every forced `/continue` and the evidence the guard read at the moment it was applied.
   *
   * Present and empty on a run that never forced a continue, so a reader can tell "no forces"
   * from "this build does not report forces" (#103). The handle already returns a copy, so the
   * report uses `relay.forceRecords()` directly rather than re-copying here.
   */
  forces: ForceRecord[]
  /**
   * Whether the advisor used the assignment syntax multi-seat dispatch depends on (#79).
   *
   * The one field in this report that is ABSENT rather than reported when it has nothing to
   * say, and the exception is argued in `targeting.ts` rather than assumed here. In short: the
   * rule at the top of this file exists because a reader could not otherwise tell "nothing to
   * report" from "this build does not report it", and that reasoning does not reach this key,
   * because whether targeting was applicable is recoverable from `participants` in this very
   * document -- count the seats whose `role` is `implementer`. A one-seat run has no `@seat` to
   * use and its advisor was never given the syntax, so a block there would be an instrument
   * reading on a quantity that does not exist.
   *
   * Present with zeros on a MULTI-seat run that instructed nothing, which is the reading that
   * must not be lost: `0 addressed of 0 turns` is a run that ended before the question could be
   * asked, and it is a different finding from `0 addressed of 9`.
   */
  targeting?: ReportedTargeting | undefined
  /**
   * Whether subagents were used, and whether any worktree appeared while they were.
   *
   * The briefing tells a subagent that MODIFIES anything to work in its own worktree. Nothing
   * enforces that and nothing can -- the repository cannot tell a subagent's write from its
   * parent's (#8) -- so what is recorded is the SHAPE a violation takes, for a reader who was
   * not watching. `delegated: true` with no worktrees is worth a look and is not a verdict:
   * a subagent that only reads is explicitly allowed the shared directory.
   */
  subagents: { delegated: boolean; worktreesCreated: string[] }
  /**
   * Turns taken by a seat whose ROLE declares it does not write, during which the tree changed.
   *
   * The second key in this document that is ABSENT rather than reported when it has nothing to
   * say, and like `targeting` the exception is argued rather than assumed -- but on different
   * grounds, and the grounds are the point.
   *
   * `flags: []` is a claim: the seats were asked and said nothing is outstanding. `rotations: 0`
   * is a claim: the watch was armed and never fired. An empty array here would NOT be a claim,
   * because the instrument cannot make it. The per-turn diff sees only paths that BECAME dirty,
   * so a non-writing seat that edits a file already dirty leaves nothing behind; and it sees
   * only inside turn boundaries, so a write between turns is invisible. "We looked and found
   * nothing" is a sentence this cannot say, and an empty array is how a reader would hear it.
   *
   * Absence says the weaker and true thing: nothing was observed. Presence says the only thing
   * this document is entitled to say -- that on these turns, in these roles, these paths
   * appeared. Read `UnexpectedWrite` before drawing a conclusion from either: on a shared root,
   * which is every root on a default run, the paths are not attributed to the seat and the
   * entry says so.
   *
   * Consequently the default run's key set is unchanged, which is a consequence and not the
   * reason. A field made conditional to keep a pinned baseline green would be exactly the
   * decision `defaultUnchanged.test.ts` exists to force into the open.
   */
  unexpectedWrites?: UnexpectedWrite[] | undefined
  /**
   * What participants say is left unresolved. Empty is a claim, not a gap.
   *
   * Reconciled, not accumulated (#131): a seat is shown its own flags when the advisor calls
   * the work done and asked which still stand, and only those are here. `restated` carries the
   * later routing-log positions where the same seat raised the same item verbatim, because a
   * concern raised on three turns is one outstanding item and three data points.
   */
  flags: { participant: string; text: string; seq: number; restated: number[] }[]
  /**
   * Raised during the run, then not restated when the seat that raised it was asked.
   *
   * A separate array rather than a status field on `flags`, so that the field an operator
   * already reads as "what is unresolved" keeps meaning exactly that. Present and empty on
   * every run that superseded nothing, per this file's second rule.
   *
   * These are RETIRED, not disproved. `NONE` from a seat that fixed everything and `NONE`
   * from a seat that had run out of context are the same four characters, so the record keeps
   * what was retired and by which message -- superseded is not the same as never-raised.
   */
  supersededFlags: { participant: string; text: string; seq: number; supersededBy: number; restated: number[] }[]
  /** Restricted asides and what was traced to each, with how well it was supported. */
  restricted: {
    seq: number
    informed: string[]
    excluded: string[]
    /**
     * One entry per attributed path PER SEAT, not per path.
     *
     * `support` is how well the path is tied to the message; `confidence` is how well it is
     * tied to the actor, and `seat` is that actor when a linked worktree names one. Two
     * dimensions because they answer different questions and a run can be strong on one and
     * weak on the other -- a `named_path` in a shared checkout still cannot exclude a second
     * writer, and a path found in a seat's own tree names its author whatever the tool inputs
     * looked like.
     *
     * At N=1 every entry is `seat: null` / `reasoned_but_unverified`, which is exactly the
     * claim this made before the fields existed. Nothing is upgraded by them.
     */
    artifacts: { path: string; support: string; seat: string | null; confidence: string }[]
    /**
     * Seats the message was withheld from and has since been GIVEN in full (#171).
     *
     * `informed` and `excluded` above are current membership: who holds the message at the
     * end of the run. This says which later message moved someone between them, which is the
     * only way a reader can tell an aside that was never withheld from the advisor from one
     * that was withheld and then handed over -- and the second is what stops an
     * `authority_conflict` re-firing for the rest of the session.
     *
     * Present and empty on every run that reconciled nothing, per this file's second rule.
     */
    reconciled: { participant: string; seq: number }[]
  }[]
}

export interface ReportInput {
  goal: string
  outcome: RunOutcome
  startedAt: number
  endedAt?: number
  build: string
}

/**
 * Assemble the record. Async because participant snapshots are.
 *
 * Snapshots rather than the live event stream: `snapshot()` is the canonical, rebuildable
 * side of the adapter seam, and a report is exactly the case its contract was written for —
 * a consumer that must not be handed provisional facts it will never see revised.
 */
export async function runReport(relay: Relay, input: ReportInput): Promise<RunReport> {
  const participants: ReportedParticipant[] = []
  for (const p of relay.participants) {
    const snap = await p.session.snapshot()
    participants.push({
      id: p.id,
      agent: snap.agent,
      rank: p.rank,
      role: p.role,
      // Copied, and the array with it: the report is handed to a caller that may keep it, and
      // a shared array would let a reader of a finished run see a list the relay still owns.
      launch: { args: [...p.launch.args], model: p.launch.model },
      sessionId: snap.sessionId,
      // Deliberately NOT gated on `snap.containedFallback`, unlike the rotation trigger in
      // `relay.ts` and the handoff record in `rotation/rotate.ts`. Those two ACT on this number
      // -- they treat it as the mechanical proof that a participant lost context, and one of
      // them spends a session on it -- so a generation from a read that could not be repeated is
      // a claim they must not make. A report only DESCRIBES, and describing is the case
      // `snapshotOrLastBuilt()`'s containment was written for: the last generation the view
      // could build is the truest answer available, and the alternative is a report that omits
      // a field or refuses to render because the transcript was busy.
      //
      // And it re-reads: this asks the session afresh every time a report is assembled rather
      // than quoting a number some earlier caller kept. Nothing downstream latches the value --
      // no baseline moves, no branch is taken on it -- so a stale reading here is a stale line
      // in one document, corrected by the next read of the same session, and not a decision the
      // run then carries.
      compactionGeneration: snap.compactionGeneration,
      turns: snap.turns.map((t) => ({
        key: String(t.key),
        state: t.state,
        confidence: t.confidence,
        provenance: t.provenance,
        tools: t.toolCalls.map((c) => c.tool),
        startedAt: t.startedAt,
        endedAt: t.endedAt,
      })),
    })
  }

  const endedAt = input.endedAt ?? Date.now()
  // Built once, because it decides whether a KEY exists and not merely what its value is. Two
  // calls could not disagree today, and a test asserting `'targeting' in report` against a
  // condition evaluated twice is a test one refactor away from meaning nothing.
  const targeting = reportedTargeting(relay.targetingWatch)
  // Built once, for the reason above it: this decides whether a KEY exists, and a condition
  // evaluated twice is a condition two callers can answer differently. The accessor already
  // copies, so what lands in the document is not a list the relay still owns.
  const unexpectedWrites = relay.unexpectedWrites()
  return {
    schema: REPORT_SCHEMA,
    goal: input.goal,
    cwd: relay.cwd,
    build: input.build,
    operator: relay.operator,
    outcome: input.outcome,
    // Read whole. Resolving a declared clock against this run's configuration is the relay's
    // job -- it holds both halves -- and the rule at the top of this file is that nothing
    // here is re-derived. A second copy of that precedence would be a second answer.
    deadlines: relay.deadlines,
    startedAt: input.startedAt,
    endedAt,
    durationMs: endedAt - input.startedAt,
    // Both read off the relay rather than recomputed here, per the rule at the top of this file.
    // The relay's handle is the only thing that saw the suspensions, and `activeMs` is the very
    // value `breached` was handed -- a second reckoning of either would be a second answer to a
    // question the ceiling has already decided.
    pausedMs: relay.pausedMs,
    activeMs: relay.activeMs,
    messages: relay.log.length,
    participants,
    // Copied field by field rather than spread, so a new counter on rotationWatch cannot
    // silently join the wire format without someone deciding it should.
    rotation: {
      armed: relay.rotationWatch.armed,
      assessments: relay.rotationWatch.assessments,
      degradationsSeen: relay.rotationWatch.degradationsSeen,
      complaintsSeen: relay.rotationWatch.complaintsSeen,
      candidates: relay.rotationWatch.candidates,
      rotations: relay.rotationWatch.rotations,
      peakGeneration: relay.rotationWatch.peakGeneration,
      // Through the relay's own accessor, which copies. The rule at the top of this file is
      // that nothing here is re-derived; the rule beside `launch` is that a report handed to a
      // caller who may keep it must not share an array the relay still owns.
      records: relay.rotationRecords(),
    },
    // Spread away entirely on a one-seat run, rather than written as a block of zeros. The
    // decision is `reportedTargeting`'s and is made in one place for both documents: a rule
    // about when a key exists, relaxed in one serializer and not the other, is how a default
    // run starts carrying a key that alleges nothing.
    //
    // Not built field by field here, which `rotation` above is: that shape is declared inline
    // in this file and so could silently widen, while this one is a named type with a single
    // constructor, and widening it means editing `ReportedTargeting`.
    ...(targeting ? { targeting } : {}),
    subagents: relay.subagentUse(),
    // Spread away entirely when nothing was observed, per the argument at the field's
    // declaration: an empty array here would read as "we looked and found nothing", which is a
    // claim this instrument is not able to make.
    ...(unexpectedWrites.length > 0 ? { unexpectedWrites } : {}),
    // Through the relay's own views, which apply the reconciliation. Splitting `relay.flags`
    // here would be a second answer to "is this still outstanding", and the rule at the top of
    // this file is that nothing is re-derived. The arrays are rebuilt per entry either way, so
    // a caller keeping the report cannot reach the flags the relay still owns.
    flags: relay.outstandingFlags().map((f) => ({
      participant: f.participant,
      text: f.text,
      seq: f.seq,
      restated: [...(f.restated ?? [])],
    })),
    supersededFlags: relay.supersededFlags().map((f) => ({
      participant: f.participant,
      text: f.text,
      seq: f.seq,
      supersededBy: f.supersededBy,
      restated: [...(f.restated ?? [])],
    })),
    restricted: relay.restrictedOrigins.map((o) => ({
      seq: o.seq,
      informed: o.informed,
      excluded: o.excluded,
      // Read off `attributions`, which is the record, rather than off the deduplicated
      // `artifacts` view: two seats can each create the same relative path in their own
      // worktrees, and a per-path view reports one of them under the other's name.
      artifacts: o.attributions.map((a) => ({
        path: a.path,
        support: a.support,
        seat: a.seat,
        confidence: a.confidence,
      })),
      // Copied, not aliased: the relay goes on mutating this list for the rest of the run,
      // and a report is a snapshot of what was true when it was taken.
      reconciled: o.reconciled.map((r) => ({ participant: r.participant, seq: r.seq })),
    })),
    // The force ledger. Added last so it does not shift the line numbers cited for the fields
    // above. The handle already returns a copy.
    forces: relay.forceRecords(),
  }
}
