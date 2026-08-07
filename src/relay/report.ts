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
import type { RunOutcome } from './run.ts'
import type { Relay } from './relay.ts'

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
   * Who was answering escalations.
   *
   * Recorded because it changes what an escalation MEANS. An agent operator is the same kind
   * of thing as the participants and may share their blind spots, so its answer is another
   * opinion with authority rather than independent confirmation. A reader auditing a run
   * cannot recover that from the routing log, where both look identical.
   */
  operator: 'human' | 'agent'
  outcome: RunOutcome
  startedAt: number
  endedAt: number
  durationMs: number
  messages: number
  participants: ReportedParticipant[]
  rotation: {
    armed: boolean
    assessments: number
    degradationsSeen: number
    complaintsSeen: number
    rotations: number
    peakGeneration: number
  }
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
  /** What participants said was left unresolved. Empty is a claim, not a gap. */
  flags: { participant: string; text: string; seq: number }[]
  /** Restricted asides and what was traced to each, with how well it was supported. */
  restricted: {
    seq: number
    informed: string[]
    excluded: string[]
    artifacts: { path: string; support: string }[]
  }[]
}

export interface ReportInput {
  goal: string
  outcome: RunOutcome
  startedAt: number
  endedAt?: number
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
      sessionId: snap.sessionId,
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
  return {
    schema: REPORT_SCHEMA,
    goal: input.goal,
    cwd: relay.cwd,
    operator: relay.operator,
    outcome: input.outcome,
    startedAt: input.startedAt,
    endedAt,
    durationMs: endedAt - input.startedAt,
    messages: relay.log.length,
    participants,
    // Copied field by field rather than spread, so a new counter on rotationWatch cannot
    // silently join the wire format without someone deciding it should.
    rotation: {
      armed: relay.rotationWatch.armed,
      assessments: relay.rotationWatch.assessments,
      degradationsSeen: relay.rotationWatch.degradationsSeen,
      complaintsSeen: relay.rotationWatch.complaintsSeen,
      rotations: relay.rotationWatch.rotations,
      peakGeneration: relay.rotationWatch.peakGeneration,
    },
    subagents: relay.subagentUse(),
    flags: relay.flags.map((f) => ({ participant: f.participant, text: f.text, seq: f.seq })),
    restricted: relay.restrictedOrigins.map((o) => ({
      seq: o.seq,
      informed: o.informed,
      excluded: o.excluded,
      artifacts: o.artifacts.map((path) => ({
        path,
        // Defaulted rather than optional: a consumer that had to handle a missing support
        // level would have to invent a default anyway, and would pick a different one.
        support: o.artifactSupport[path] ?? 'text_match',
      })),
    })),
  }
}
