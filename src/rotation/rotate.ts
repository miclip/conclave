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

import type { AgentSession, SessionState } from '../contract/session.ts'
import { envelope, type RelayMessage } from '../relay/message.ts'
import {
  acceptancePrompt,
  handoffPrompt,
  parseClaimedChecks,
  parseHandoff,
  UNKNOWN_GENERATION,
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
  /**
   * Something between quiescing and starting the replacement threw, so there is no handoff.
   *
   * The stage that threw is named in `detail`, and the stages are the notification that the
   * session was frozen, the advisor's exchange, the snapshot taken off the original, the
   * repository capture, and the test-only barrier. They
   * share a reason because they share the only thing a caller can act on: the original was
   * frozen, nothing was created or destroyed, and it has been put back. Distinguishing them in
   * the TYPE would invite a caller to branch on a difference that changes nothing it does.
   *
   * It exists at all because these used to throw straight out of `rotate()`, past the rollback,
   * leaving the original quiesced -- alive, holding everything it knew, and unable to accept
   * work -- with no caller anywhere holding the knowledge that it had to be unquiesced. A
   * transcript read that gave up, a `git` that was not on PATH, or an advisor whose transport
   * died was enough to strand the seat that way.
   */
  | 'handoff_not_recorded'
  /** The replacement session could not be started at all. */
  | 'replacement_start_failed'
  /**
   * The original refused to enter `rotating`, so the transaction never opened.
   *
   * The one failure whose two sessions are both live when it happens: the handoff is written
   * and the replacement is already started, and the only thing that did not happen is the
   * original's own transition out of `quiesced`. So it cannot share `replacement_start_failed`
   * -- nothing is wrong with the replacement, and a caller told that would look in the wrong
   * place -- and it cannot share `handoff_not_recorded`, because the handoff WAS recorded and
   * is returned with this.
   *
   * Both are put back: the original is unquiesced and the replacement, which has proved
   * nothing and been told nothing, is closed as abandoned. What it says to a caller is that
   * the ORIGINAL is the unhealthy one, which is worth knowing before rotating it again --
   * `beginRotation()` is a state-machine transition, and a session that cannot make it is
   * unlikely to survive the acceptance turn either.
   */
  | 'rotation_not_begun'
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
  /**
   * The transfer succeeded and the ORIGINAL could not be confirmed disposed of.
   *
   * A third outcome rather than a flag on either of the other two, because it is a different
   * claim from both and the two it sits between are the two things a caller acts on.
   *
   * ## Why this is not `rolled_back`
   *
   * `rolled_back` means one thing to every caller: the original is back in service and the
   * replacement has been abandoned. Neither half is true here. The replacement passed the
   * acceptance gate -- it reproduced the recorded state, against the arbiter's own run of the
   * checks -- and `old.close('graceful')` is the COMMIT, one statement past the last decision
   * the transaction makes. A close that rejects has not un-proved anything.
   *
   * Reporting it as a rollback is not merely pessimistic, it is false in the direction that
   * loses work: the caller promotes nobody, the proven replacement is closed as abandoned, and
   * the original it is told to keep using is the session whose teardown just failed. That was
   * the observed behaviour on the mid-teardown path, and it ended with both seats gone and the
   * caller told one of them was working.
   *
   * ## Why it is not plain `rotated` either
   *
   * Because the disposal is genuinely unknown, and nothing downstream can find out.
   *
   * All four adapters -- `claude`, `codex`, `kimi`, `opencode` -- assign `#state = 'terminated'`
   * as the LAST statement of `close()`'s `try`, after the pty is terminated, the receiver
   * stopped, and, on `kimi`, the run directory removed. Established by reading them rather than
   * assumed. Two things follow, and only the first is about the state:
   *
   *   - the observable state after a rejecting close is whatever it was on entry, which on this
   *     path is `rotating`. `terminated` is not reachable on any adapter in this tree today: the
   *     only statement past the assignment is the `finally` that ends the event queue, and
   *     `AsyncQueue.close()` cannot throw.
   *
   *   - the PHYSICAL disposal is unknowable either way, and that is the part `oldState` cannot
   *     help with. Every step before the assignment can reject AFTER doing its work --
   *     `#pty.terminate()` may have killed the child with `#receiver.stop()` rejecting behind
   *     it, or the terminate may be what failed and the child is still holding a pty, a port, or
   *     a worktree. Nothing out here distinguishes those.
   *
   * So `oldState` is carried as evidence of how far the teardown GOT, never as a claim about
   * what survived it. Folding this into `rotated` would hand the caller a success with no field
   * to hang either fact on, and the thing an operator has to be told -- there may be an orphaned
   * child, go and look -- would exist nowhere. A leaked child is not hypothetical here: it is
   * the failure `close()`'s own comments describe, where a rollback left a Claude CLI running
   * and the node process could not exit for 26 minutes.
   *
   * A caller must therefore promote and use `replacement` exactly as it would for `rotated`,
   * and separately record that the outgoing session's disposal is unconfirmed.
   *
   * This does NOT settle #146. That issue is about the adapters: `close('graceful')` does not
   * guarantee a terminal `turn_end` for a live turn on any of them, neither one-shot adapter
   * escalates past SIGTERM, and the 3s cap drops a verdict silently. Those are the reasons a
   * close fails and a child survives it. This outcome only stops the orchestrator from
   * MISREPORTING the result when it does.
   */
  | {
      status: 'rotated_cleanup_failed'
      replacement: AgentSession
      handoff: Handoff
      acceptance: Acceptance
      /** What `close('graceful')` rejected with. */
      detail: string
      /**
       * The original's state as read AFTER the failed close, not as it was assumed to be.
       *
       * `rotating` on every adapter in this tree: they record `terminated` last, so a close that
       * rejects has not reached it, and the session is left sitting in a transaction it will
       * never leave. `terminated` would mean an adapter recorded the state before its teardown
       * finished -- none does, and the contract does not forbid one, so the field carries the
       * value rather than asserting it away.
       *
       * Read rather than inferred, and evidence of how far `close()` got rather than of what
       * survived it. Neither value says whether a child is still running.
       */
      oldState: SessionState
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
 *
 * The restore is attempted first and the teardown happens either way. A rollback reached from
 * the rotation transition is a rollback of a session whose state machine has just refused
 * something, so "unquiesce also throws" is a live possibility there rather than a theoretical
 * one -- and a replacement left running because the ORIGINAL could not be restored is a second
 * live child nobody holds a reference to. The restore failure still propagates: a caller told
 * `rolled_back` is being told the original is back in service, and swallowing this would make
 * that a lie in the one case where it matters.
 *
 * Its own narration cannot throw. Everything in here runs while something else has already
 * failed, and there is nothing left to undo if the reporting of it fails too — this is the
 * one place in the file where a `note` is guarded rather than covered.
 */
async function rollback(
  old: AgentSession,
  replacement: AgentSession | undefined,
  deps: RotationDeps,
): Promise<void> {
  const say = (text: string): void => {
    try {
      deps.note?.(text)
    } catch {
      // Deliberately nothing: see above.
    }
  }
  try {
    await old.unquiesce()
  } finally {
    if (replacement) {
      try {
        await replacement.close('abandoned')
      } catch (err) {
        say(`replacement teardown failed after rollback: ${(err as Error).message}`)
      }
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

  // 2. The handoff. The advisor writes the narrative; the record is captured here so the
  //    checkable half never depends on a participant's account of it.
  /**
   * Everything from here to the replacement's start is inside the rollback's care.
   *
   * The original is frozen from the line above, and a session left quiesced is not a session
   * that merely failed to rotate -- it is one that cannot be given work and that nobody is
   * going to unfreeze, because the only code that knows it was frozen is this function. So
   * every step between the freeze and the start has to end in either a handoff or a rollback,
   * and `stage` is what lets the reason say which step did not.
   *
   * The advisor exchange is in here too, not only the snapshot and the capture. It is the
   * first thing that happens after the freeze and it talks to a child process over a
   * transport that dies; leaving it outside would leave the widest window of all uncovered.
   *
   * So is the line that merely SAYS the session was frozen. `note` is the caller's function --
   * it writes to a REPL, a log, a stream something else may have closed -- and a throw from it
   * one statement after `quiesce()` stranded the seat in exactly the state this whole block
   * exists to prevent. Narration is not allowed to be the reason a session cannot be given
   * work again, and the way to make sure of that is to cover it, not to trust it.
   */
  let handoff: Handoff
  let stage = 'the post-quiesce notification'
  try {
    note('implementer quiesced')

    stage = "the advisor's handoff exchange"
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

    stage = 'the snapshot of the original session'
    const snap = await old.snapshot()
    /**
     * A contained fallback is an answer, not a reading.
     *
     * `snapshot()` on both adapters is contained: when the transcript will not answer it hands back
     * the last projection the view managed to build rather than rejecting, which is what keeps
     * a wedged transcript from stranding a session that has already been quiesced. The turns
     * in it are as true as they were at that read. `compactionGeneration` is not the same kind
     * of fact: it is the mechanical evidence the participant lost context, the handoff is where
     * it is recorded for anyone reviewing the rotation afterwards, and a generation from a read
     * that could not be repeated is a claim about a transcript state nobody observed. So the
     * rotation proceeds -- it was decided elsewhere, on other grounds -- and records that the
     * signal could not be established rather than a number that would be believed.
     */
    const generation = snap.containedFallback ? UNKNOWN_GENERATION : snap.compactionGeneration
    if (snap.containedFallback) {
      // Says only what is true of BOTH conditions the flag now covers: nothing was read just
      // now. A stale projection was read earlier; a never-read never was, and calling that a
      // "fallback" would name a prior read it does not have.
      note('compaction generation unverified: nothing in this snapshot was read just now')
    }
    stage = 'the repository capture'
    const record = capture({
      root: deps.root,
      files: [...new Set([...parsed.narrative.files, ...(deps.files ?? [])])],
      checks: deps.checks,
      ...(deps.checkTimeoutMs === undefined ? {} : { checkTimeoutMs: deps.checkTimeoutMs }),
    })
    handoff = {
      narrative: parsed.narrative,
      record,
      constraints: deps.constraints ?? [],
      authoredBy: advisor.sessionId,
      from: { sessionId: old.sessionId, agent: old.agent },
      compactionGeneration: generation,
      at: Date.now(),
    }
    note(`handoff recorded: ${record.checks.length} check(s), ${record.files.length} file(s)`)
    // Test instrumentation only. Awaited here so that everything after this point -- the
    // replacement, its own run of the checks, and the acceptance capture -- observes the
    // same world, and it is not the world the record was taken from.
    stage = 'the post-capture barrier'
    if (deps.hooks?.afterCapture) await deps.hooks.afterCapture()
  } catch (err) {
    await rollback(old, undefined, deps)
    return {
      status: 'rolled_back',
      reason: 'handoff_not_recorded',
      detail: `${stage} failed: ${(err as Error).message}`,
      restored: old,
    }
  }

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
  /**
   * The point of no return, and the last place both sessions are still recoverable.
   *
   * `beginRotation()` rejects if the original is not in `quiesced` -- which it is, from step 1
   * -- and can reject for transport reasons besides. Left unguarded it threw out of `rotate()`
   * with the original frozen AND the replacement running: the one failure that loses both
   * sessions at once, and the exact shape the rollback exists to make impossible. It is
   * outside the block below rather than inside it because everything in there assumes the
   * transaction is open.
   */
  try {
    await old.beginRotation()
  } catch (err) {
    await rollback(old, replacement, deps)
    return {
      status: 'rolled_back',
      reason: 'rotation_not_begun',
      detail: `the original could not enter 'rotating': ${(err as Error).message}`,
      restored: old,
      handoff,
    }
  }

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
      files: handoff.record.files.map((f) => f.path),
      checks: deps.checks,
      ...(deps.checkTimeoutMs === undefined ? {} : { checkTimeoutMs: deps.checkTimeoutMs }),
    })
    const divergences = compare(handoff.record, observed)

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
      (c) => c.exitCode !== 0 && handoff.record.checks.find((r) => r.command === c.command)?.exitCode !== 0,
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
    /**
     * The commit, and the one statement in the block whose failure is not a failed transfer.
     *
     * It was covered by the acceptance handler, which did the only thing that handler knows how
     * to do. Both of its outcomes were wrong, and differently wrong:
     *
     *   close rejects mid-teardown -- the shape today's adapters actually produce, since all
     *   four assign `#state = 'terminated'` as the last statement of the `try`. The state never
     *   left `rotating`, `unquiesce()` accepts that, and the rollback SUCCEEDS. The result says
     *   `rolled_back` with the original `restored` and reading `running`, over a transport that
     *   has just been disposed of, and the replacement that proved itself is closed as
     *   abandoned. Both seats gone and the caller told one of them is working.
     *
     *   close rejects with the state already `terminated` -- not reachable on any adapter in
     *   this tree, and handled anyway because it is a legal `AgentSession`: `rollback()` calls
     *   `unquiesce()`, the state machine refuses it, and the throw is raised from inside the
     *   catch block, so it escapes `rotate()` rather than becoming a result. The caller gets an
     *   exception for a transfer that succeeded, and the rollback has already abandoned the
     *   replacement it would have needed a reference to.
     *
     * So it is caught here, where the difference between "the transfer failed" and "the
     * transfer succeeded and the loser would not die" is still visible. See
     * `rotated_cleanup_failed`.
     */
    let cleanupFailure: string | undefined
    try {
      await old.close('graceful')
    } catch (err) {
      /**
       * Normalised rather than cast, because this string is the FLAG as well as the message.
       *
       * Everywhere else in this file `(err as Error).message` produces a bad sentence when the
       * throw is not an `Error` -- a `detail` reading `acceptance failed: undefined`. Here it
       * produces a bad OUTCOME: `cleanupFailure` stays `undefined`, the check below is false,
       * and a close that rejected is reported as `rotated` with nothing anywhere saying the
       * outgoing session was never disposed of. A rejected promise, a thrown string, or a
       * `throw undefined` from a transport layer is enough. The one thing this must never do is
       * turn a failure into a clean success, so the value is made a string before it is trusted
       * as evidence that there was one.
       */
      cleanupFailure = err instanceof Error ? err.message : String(err)
    }

    /**
     * Past the commit, narration cannot fail the rotation it is narrating.
     *
     * `note` is the caller's function -- a REPL, a log, a stream something else may have closed
     * -- and every line below runs AFTER the original has been terminated. A throw from one of
     * them was caught by the acceptance handler, which did the only thing it knows how to do:
     * roll back. That means `unquiesce()` on a session that has just been closed, which throws
     * `cannot unquiesce a terminated session`, which escapes `rotate()` entirely. The caller
     * then gets an exception for a rotation that SUCCEEDED -- the old session terminated, the
     * replacement live and holding the handoff, and no reference to it returned to anybody.
     *
     * Rolling back is not a weaker option here, it is an incoherent one: there is nothing left
     * to roll back to. So these are guarded rather than covered, which is the same rule
     * `rollback()` follows and for the same reason -- when there is nothing left to undo, the
     * reporting of a problem must not become one.
     *
     * Each line is guarded on its own, so one closed stream does not silence the rest. Failures
     * BEFORE this point are untouched and still roll back: that is what the try/catch is for,
     * and it still covers everything up to and including `close()` itself.
     */
    const report = (text: string): void => {
      try {
        note(text)
      } catch {
        // Deliberately nothing: see above.
      }
    }
    if (cleanupFailure === undefined) {
      report(`rotation complete; ${old.sessionId} terminated`)
    } else {
      // Said in the completion line rather than appended as an advisory, because it is not
      // advisory: an operator reading `terminated` on a session that may still be holding a pty
      // has been told the opposite of what happened.
      report(
        `rotation complete; ${old.sessionId} could NOT be confirmed disposed of: ${cleanupFailure}. ` +
          `Its state reads '${old.state}'; the child may still be running. The replacement is live ` +
          `and holds the handoff.`,
      )
    }
    for (const d of divergences) report(`advisory: ${d.detail}`)
    for (const m of advisoryMismatches) report(`advisory: ${m}`)
    for (const c of carriedFailures) {
      report(`carried forward failing: \`${c.command}\` exits ${c.exitCode}, as it did at handoff`)
    }
    if (cleanupFailure !== undefined) {
      return {
        status: 'rotated_cleanup_failed',
        replacement,
        handoff,
        acceptance,
        detail: cleanupFailure,
        oldState: old.state,
      }
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
