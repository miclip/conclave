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
 *
 * ## One seat, and one tree
 *
 * Nothing here knows how many seats a run has. It is handed a session, an advisor, and a
 * `root` -- and that root is ONE SEAT'S working tree, which is what makes the transaction
 * seat-local at any N (#78). The relay decides which seat; this decides whether the transfer
 * holds. The N=1 case is the identity case rather than a branch: there is one tree, it is the
 * operator's cwd, and this file cannot tell the difference.
 *
 * ## A gate that cannot be applied is not a gate that was failed
 *
 * Acceptance can fail two ways and they are not the same fact (#76). A replacement that
 * answers and does not reproduce is a bad draw. A replacement that produces nothing observable
 * at all means the transport acceptance depends on is not working, and no replacement can pass
 * while that holds -- so those two get different reasons, and the second names what it saw.
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
  type CheckSpec,
} from './record.ts'

export interface RotationDeps {
  /**
   * The working tree this rotation is scoped to.
   *
   * ONE SEAT'S tree, not the run's. Everything mechanical about a transfer is read from here
   * -- HEAD, the named files, and the checks -- so at N>1 this is the worktree the rotating
   * seat has been working in, and the replacement is verified against the work that seat
   * actually did (D7, #78). At N=1 the seat's tree IS the operator's cwd and this is that
   * directory, which is why nothing about the transaction had to change for the singular case.
   *
   * Reading the integration checkout instead would compare a replacement against a tree its
   * predecessor never wrote to: every file digest would match trivially, and the checks would
   * measure somebody else's merged work.
   */
  root: string
  /** Deliver prose to a session and resolve with its reply. Supplied by the relay. */
  exchange(session: AgentSession, text: string): Promise<string>
  /** Start a fresh implementer. Called only after the handoff parses. */
  startReplacement(): Promise<AgentSession>
  /**
   * What the orchestrator can say about the replacement's transport, asked for only when the
   * replacement produced nothing at all.
   *
   * The distinction in #76 is between "this replacement did not meet the bar" and "nothing
   * could have met it", and the second is a claim about the transport rather than about the
   * model. This is the evidence behind that claim -- how many events the session emitted, what
   * state it is in -- and it comes from the relay because `rotate()` sees one string and cannot
   * tell an empty reply from a child that never spoke.
   *
   * Optional: a caller that has no transport to describe (the tests' fake exchange) simply
   * says less, and the classification is unchanged.
   */
  transportEvidence?: (session: AgentSession) => string[]
  /**
   * Verification commands. The handoff is only as strong as what these actually check.
   *
   * A bare string is `required`. Declare relevance explicitly to keep a check that does not
   * exercise the transferred artifact from gating the transfer -- see `CheckRelevance`.
   */
  checks: CheckSpec[]
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
  /**
   * Where the replacement's reported exit codes disagree with the arbiter's, on checks
   * declared `required`. These block: the transfer is refused and rolled back.
   */
  claimMismatches: string[]
  /**
   * The same disagreement on `informational` or `unrelated` checks.
   *
   * Reported and never blocking. A check can reproduce faithfully and still say nothing
   * about the transferred artifact, and rolling a rotation back on one of those strands the
   * session that most needed replacing for a reason unconnected to the work.
   *
   * Kept separate from `claimMismatches` rather than merged with a flag, because a caller
   * that treated the two alike is the bug this split exists to prevent.
   */
  advisoryMismatches: string[]
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
  /**
   * The replacement produced NO observable output at all, so the gate could not be applied.
   *
   * Split out of `replacement_could_not_reproduce` because the two invite opposite responses
   * and used to be reported identically (#76). The acceptance gate requires an observed turn,
   * and that turn travels the same transport as everything else -- so a transport fault
   * disables the mechanism meant to route around a fault, and every replacement inherits it.
   *
   *   observable output, gate not met  -- this replacement did not do it; another might
   *   no observable output at all      -- no replacement can pass while this holds
   *
   * The rollback is right either way, and that was never the bug. The bug was that the
   * operator could not tell which one they were in, so the second looked like the first and
   * invited a retry, and the retry looked the same again. A caller that acts on this reason
   * should stop rotating and say so, because the fix is upstream of rotation entirely: hook
   * trust, the provider, or the CLI.
   */
  | 'acceptance_unobservable'

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
      /**
       * What was observed of the replacement's transport, on the reason that rests on it.
       *
       * Only `acceptance_unobservable` carries this, and it carries it because that reason is
       * an assertion about something nobody can see afterwards: the session is closed by the
       * time the caller reads the result. A verdict of "no replacement can pass" that does not
       * say what it observed is the verdict this project keeps finding in itself -- true, and
       * missing the fact that would let anyone act on it.
       */
      evidence?: string[]
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

/**
 * One turn asked of the replacement, and whether anything came back.
 *
 * `silent` is not a failure of the reply's CONTENT -- that is the acceptance comparison's
 * business, further down. It is the absence of a reply at all: the send threw, or it returned
 * and the turn produced nothing. Both mean the same thing about the transport, and both mean
 * the gate has nothing to apply itself to.
 */
type ReplacementTurn = { kind: 'observed'; prose: string } | { kind: 'silent'; detail: string }

/**
 * Talk to the replacement, and keep "it said nothing" separate from "it said the wrong thing".
 *
 * Every exchange with the replacement goes through here, including the constraint replays: a
 * transport that cannot deliver a constraint will not deliver the acceptance turn either, and
 * discovering that one turn later would report it as a failure to reproduce (#76).
 *
 * The throw is caught rather than left to the outer handler on purpose. That handler covers
 * everything in the acceptance block -- including `capture()`, which shells out and can fail
 * for reasons that have nothing to do with a child process -- so classifying every throw in it
 * as a transport fault would be the same over-claim in the opposite direction.
 */
async function ask(
  replacement: AgentSession,
  text: string,
  deps: RotationDeps,
): Promise<ReplacementTurn> {
  let prose: string
  try {
    prose = await deps.exchange(replacement, text)
  } catch (err) {
    return { kind: 'silent', detail: `the exchange did not complete: ${(err as Error).message}` }
  }
  if (prose.trim() === '') return { kind: 'silent', detail: 'the turn came back with no prose at all' }
  return { kind: 'observed', prose }
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
    /**
     * The replacement never spoke. Roll back, and say which of #76's two cases this is.
     *
     * Written once and used from both call sites below, because the whole point of the
     * distinction is that it is stated in the same words wherever it is reached -- an operator
     * who has to compare two phrasings to work out whether they are being told the same thing
     * is being told nothing.
     */
    const unobservable = async (turn: { detail: string }): Promise<RotationResult> => {
      await rollback(old, replacement, deps)
      return {
        status: 'rolled_back',
        reason: 'acceptance_unobservable',
        detail:
          `the replacement produced no observable output: ${turn.detail}. Acceptance requires an ` +
          `observed turn, and that turn travels the same transport as everything else — so while ` +
          `this holds NO replacement can pass and rotation is not the remedy. The fault is ` +
          `upstream of rotation: hook trust, the provider, or the CLI itself.`,
        restored: old,
        handoff,
        evidence: deps.transportEvidence?.(replacement) ?? [],
      }
    }

    // Constraints go first and separately, so they arrive at human rank rather than as
    // advisor prose. Folded into the handoff they would quietly become a suggestion.
    for (const c of handoff.constraints) {
      const ack = await ask(
        replacement,
        envelope({ from: c.from, fromRank: c.fromRank, kind: c.kind, text: c.text }),
        deps,
      )
      // Only silence is read here. A constraint is not answered with anything the transaction
      // grades -- it is delivered -- so any reply at all is enough to show the transport works,
      // and the acceptance turn below is where content starts to matter.
      if (ack.kind === 'silent') return unobservable(ack)
    }

    // 4. Verification. The replacement demonstrates rather than acknowledges.
    const turn = await ask(replacement, acceptancePrompt(handoff), deps)
    if (turn.kind === 'silent') return unobservable(turn)
    const prose = turn.prose
    const claimed = parseClaimedChecks(prose)

    const observed = capture({
      root: deps.root,
      files: record.files.map((f) => f.path),
      checks: deps.checks,
      ...(deps.checkTimeoutMs === undefined ? {} : { checkTimeoutMs: deps.checkTimeoutMs }),
    })
    const divergences = compare(record, observed)

    const claimMismatches: string[] = []
    const advisoryMismatches: string[] = []
    for (const [i, c] of observed.checks.entries()) {
      // Relevance is what the ORCHESTRATOR declared, carried on the arbiter's own result.
      // Reading it from anything the replacement produced would let the replacement decide
      // which of its failures counted.
      const into = c.relevance === 'required' ? claimMismatches : advisoryMismatches
      const suffix = c.relevance === 'required' ? '' : ` [${c.relevance}]`
      const claim = claimed.find((k) => k.index === i + 1)
      if (!claim) {
        into.push(`no reported exit code for check ${i + 1} (\`${c.command}\`)${suffix}`)
      } else if (claim.exitCode !== c.exitCode) {
        into.push(
          `check ${i + 1} (\`${c.command}\`) was reported as exit ${claim.exitCode}; ` +
            `the arbiter observed ${c.exitCode}${suffix}`,
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
      advisoryMismatches,
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
    for (const m of advisoryMismatches) note(`advisory: ${m}`)
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
