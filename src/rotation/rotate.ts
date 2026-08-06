/**
 * Rotation as a transaction (§7a).
 *
 *   1. Quiesce the old implementer.
 *   2. Produce the handoff.
 *   3. Start the replacement.
 *   4. Verify the replacement reproduces the recorded state.
 *   5. On success — terminate the old session.
 *   6. On failure — unquiesce the original and escalate.
 *
 * Step 6 is the whole reason this is a module rather than three calls in a loop. Without
 * an explicit rollback a failed transfer leaves the work stranded between two sessions and
 * fails *silently*: the replacement carries on from a state it could not actually
 * reproduce, and nothing in the log says so. Freezing is cheap — an idle session costs
 * nothing and keeps its context — so the price of the protocol is protocol, not resources.
 *
 * Two things are deliberately not trusted here:
 *
 *   - the advisor's account of tests and files, because it cannot see either. It writes
 *     the narrative; the orchestrator captures the record.
 *   - the replacement's report that the checks pass, because that is a claim about the
 *     same class of fact the arbiter owns. It is compared against an independent run.
 *
 * A replacement that reports a mismatch has performed a *successful* transfer of the thing
 * that matters. The failure case is one that reports agreement it did not observe.
 */

import type { AgentSession } from '../contract/session.ts'
import { envelope, type RelayMessage } from '../relay/message.ts'
import {
  acceptancePrompt,
  handoffPrompt,
  parseClaimedChecks,
  parseHandoff,
  type ClaimedCheck,
  type Handoff,
} from './handoff.ts'
import {
  blocking,
  capture,
  compare,
  type CheckResult,
  type Divergence,
  type RepoRecord,
} from './record.ts'

export interface RotationDeps {
  root: string
  /** Deliver prose to a session and resolve with its reply. Supplied by the relay. */
  exchange(session: AgentSession, text: string): Promise<string>
  /** Start a fresh implementer. Called only after the handoff parses. */
  startReplacement(): Promise<AgentSession>
  /** Verification commands. The handoff is only as strong as what these actually check. */
  checks: string[]
  checkTimeoutMs?: number
  /** Extra files whose exact content the transfer depends on, beyond those the advisor names. */
  files?: string[]
  /** Human-rank messages to replay. Delivered separately, at human rank. */
  constraints?: RelayMessage[]
  note?: (text: string) => void
  /**
   * TEST-ONLY synchronization points. Never set in production.
   *
   * `afterCapture` is awaited between the record being taken and the replacement being
   * started, which is the only place a test can inject a divergence and *know* nothing
   * downstream saw the state before it. Keying that to elapsed time does not work: the
   * interval from `rotate()` to capture contains the advisor's handoff turn, whose
   * duration is a model's business. The first live rollback attempt guessed 45 seconds and
   * flipped before capture instead of after, producing a faithfully reproduced failing
   * state -- correct behaviour, and a useless experiment.
   *
   * A poll on the orchestrator's own log gets the ordering right but only probabilistically
   * ahead of the replacement. This is a barrier, so "nothing downstream of capture saw the
   * old state" is structural rather than a timing that happened to hold.
   */
  hooks?: { afterCapture?: () => Promise<void> }
}

export interface Acceptance {
  /** The arbiter's own run, independent of anything the replacement said. */
  observed: RepoRecord
  /** Observed against the record taken at quiesce. */
  divergences: Divergence[]
  claimed: ClaimedCheck[]
  /** Where the replacement's reported exit codes disagree with the arbiter's. */
  claimMismatches: string[]
  /**
   * Checks that were failing when the handoff was recorded and are failing still.
   *
   * NOT a divergence, and deliberately not blocking: a check that exits the same way
   * before and after is exactly what a reproduced state looks like. Rotation verifies
   * continuity, not health, and refusing to rotate out of a red tree would strand the
   * session that most needs replacing.
   *
   * It is surfaced because the advisor writes the EVIDENCE section from the implementer's
   * prose and cannot run anything itself. A handoff that says the suite is green while
   * this is non-empty is the one place those two accounts can be seen to disagree.
   */
  carriedFailures: CheckResult[]
  prose: string
}

export type FailureReason =
  /** The advisor could not produce a handoff with the sections a replacement needs. */
  | 'handoff_incomplete'
  /** The replacement session could not be started at all. */
  | 'replacement_start_failed'
  /** The repository no longer produces what was recorded. Nobody's fault; still fatal. */
  | 'repository_diverged'
  /** The replacement did not report in a comparable form, or reported what is not so. */
  | 'replacement_could_not_reproduce'

export type RotationResult =
  | {
      status: 'rotated'
      replacement: AgentSession
      handoff: Handoff
      acceptance: Acceptance
    }
  | {
      status: 'rolled_back'
      reason: FailureReason
      detail: string
      /** The original, unquiesced and back in service. */
      restored: AgentSession
      handoff?: Handoff
      acceptance?: Acceptance
    }

/**
 * Roll back: return the original to service, and abandon any replacement that was started.
 *
 * Ordering matters. The original is restored first, so a failure while tearing down the
 * replacement still leaves a working session — the opposite order can lose both.
 */
async function rollback(
  old: AgentSession,
  replacement: AgentSession | undefined,
  deps: RotationDeps,
): Promise<void> {
  await old.unquiesce()
  if (replacement) {
    try {
      await replacement.close('abandoned')
    } catch (err) {
      deps.note?.(`replacement teardown failed after rollback: ${(err as Error).message}`)
    }
  }
}

export async function rotate(opts: {
  old: AgentSession
  advisor: AgentSession
  /** Why this is happening. Goes to the advisor, and into the record. */
  reason: string
  deps: RotationDeps
}): Promise<RotationResult> {
  const { old, advisor, deps } = opts
  const note = deps.note ?? (() => {})

  if (old.state !== 'running') {
    throw new Error(`cannot rotate a session in state '${old.state}'`)
  }

  // 1. Quiesce. From here the old session accepts no work but knows everything it knew.
  await old.quiesce()
  note('implementer quiesced')

  // 2. The handoff. The advisor writes the narrative; the record is captured here so the
  //    checkable half never depends on a participant's account of it.
  const authored = await deps.exchange(advisor, handoffPrompt(opts.reason))
  const parsed = parseHandoff(authored)
  if (!parsed.narrative) {
    // Nothing has been destroyed yet, which is why the parse happens before the start.
    await rollback(old, undefined, deps)
    return {
      status: 'rolled_back',
      reason: 'handoff_incomplete',
      detail: `the advisor's handoff is missing required section(s): ${parsed.missing.join(', ')}`,
      restored: old,
    }
  }

  const snap = await old.snapshot()
  const record = capture({
    root: deps.root,
    files: [...new Set([...parsed.narrative.files, ...(deps.files ?? [])])],
    checks: deps.checks,
    ...(deps.checkTimeoutMs === undefined ? {} : { checkTimeoutMs: deps.checkTimeoutMs }),
  })
  const handoff: Handoff = {
    narrative: parsed.narrative,
    record,
    constraints: deps.constraints ?? [],
    authoredBy: advisor.sessionId,
    from: { sessionId: old.sessionId, agent: old.agent },
    compactionGeneration: snap.compactionGeneration,
    at: Date.now(),
  }
  note(`handoff recorded: ${record.checks.length} check(s), ${record.files.length} file(s)`)
  // Test instrumentation only. Awaited here so that everything after this point -- the
  // replacement, its own run of the checks, and the acceptance capture -- observes the
  // same world, and it is not the world the record was taken from.
  if (deps.hooks?.afterCapture) await deps.hooks.afterCapture()

  // 3. Start the replacement.
  let replacement: AgentSession
  try {
    replacement = await deps.startReplacement()
  } catch (err) {
    await rollback(old, undefined, deps)
    return {
      status: 'rolled_back',
      reason: 'replacement_start_failed',
      detail: (err as Error).message,
      restored: old,
      handoff,
    }
  }
  await old.beginRotation()

  try {
    // Constraints go first and separately, so they arrive at human rank rather than as
    // advisor prose. Folded into the handoff they would quietly become a suggestion.
    for (const c of handoff.constraints) {
      await deps.exchange(
        replacement,
        envelope({ from: c.from, fromRank: c.fromRank, kind: c.kind, text: c.text }),
      )
    }

    // 4. Verification. The replacement demonstrates rather than acknowledges.
    const prose = await deps.exchange(replacement, acceptancePrompt(handoff))
    const claimed = parseClaimedChecks(prose)

    const observed = capture({
      root: deps.root,
      files: record.files.map((f) => f.path),
      checks: deps.checks,
      ...(deps.checkTimeoutMs === undefined ? {} : { checkTimeoutMs: deps.checkTimeoutMs }),
    })
    const divergences = compare(record, observed)

    const claimMismatches: string[] = []
    for (const [i, c] of observed.checks.entries()) {
      const claim = claimed.find((k) => k.index === i + 1)
      if (!claim) {
        claimMismatches.push(`no reported exit code for check ${i + 1} (\`${c.command}\`)`)
      } else if (claim.exitCode !== c.exitCode) {
        claimMismatches.push(
          `check ${i + 1} (\`${c.command}\`) was reported as exit ${claim.exitCode}; the arbiter observed ${c.exitCode}`,
        )
      }
    }

    const carriedFailures = observed.checks.filter(
      (c) => c.exitCode !== 0 && record.checks.find((r) => r.command === c.command)?.exitCode !== 0,
    )
    const acceptance: Acceptance = {
      observed,
      divergences,
      claimed,
      claimMismatches,
      carriedFailures,
      prose,
    }
    const hard = blocking(divergences)

    if (hard.length > 0) {
      await rollback(old, replacement, deps)
      return {
        status: 'rolled_back',
        reason: 'repository_diverged',
        detail: hard.map((d) => d.detail).join('; '),
        restored: old,
        handoff,
        acceptance,
      }
    }
    if (claimMismatches.length > 0) {
      await rollback(old, replacement, deps)
      return {
        status: 'rolled_back',
        reason: 'replacement_could_not_reproduce',
        detail: claimMismatches.join('; '),
        restored: old,
        handoff,
        acceptance,
      }
    }

    // 5. Commit. Only now is the old session's context actually given up.
    await old.close('graceful')
    note(`rotation complete; ${old.sessionId} terminated`)
    for (const d of divergences) note(`advisory: ${d.detail}`)
    for (const c of carriedFailures) {
      note(`carried forward failing: \`${c.command}\` exits ${c.exitCode}, as it did at handoff`)
    }
    return { status: 'rotated', replacement, handoff, acceptance }
  } catch (err) {
    // A throw anywhere in acceptance is a failed transfer like any other. Leaving the
    // original in `rotating` because an exchange died would strand it in a state with no
    // way out.
    await rollback(old, replacement, deps)
    return {
      status: 'rolled_back',
      reason: 'replacement_could_not_reproduce',
      detail: `acceptance failed: ${(err as Error).message}`,
      restored: old,
      handoff,
    }
  }
}
