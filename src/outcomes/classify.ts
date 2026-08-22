/**
 * Composite terminal-outcome classification.
 *
 * Ported from spikes/transcripts/outcomes.py, which was validated 17/17 against the
 * recorded corpus. The port is checked for parity against that same corpus in
 * src/outcomes/classify.test.ts -- a rewrite of a rule engine is exactly the kind of
 * change that stays plausible while quietly disagreeing with its predecessor.
 *
 * Rule order is deliberate and load-bearing. See the comments on each rule.
 */

import type {
  Confidence,
  Outcome,
  Provenance,
  TurnLiveness,
  Verdict,
} from '../contract/outcome.ts'

export interface ProcessState {
  alive: boolean
  /** How it ended, when known: 'graceful' | 'sigterm' | 'sigkill' | 'already-exited'. */
  howEnded?: string | undefined
}

export interface OrchestratorActions {
  sentCancel: boolean
  sentPermissionDecision?: 'allow' | 'deny' | undefined
  /** False once anyone other than the orchestrator can type into the child. */
  inputIsMediated: boolean
}

export interface TranscriptState {
  exists: boolean
  hasAssistantAfterPrompt: boolean
  finalStopReason?: string | undefined
  toolResultError: boolean
  /** Codex only. Claude Code writes no equivalent record anywhere. */
  turnAbortedReason?: string | undefined
  taskComplete: boolean
  /**
   * Codex only: the error an otherwise-terminal `task_complete` carried (#35).
   *
   * Separate from `taskComplete` rather than a flag on it, because the two facts are both true
   * at once and they mean opposite things. The turn's machinery reached its end -- so the
   * record IS terminal, and treating it as "still going" would leave the turn open forever --
   * but what it produced is a failure, and grading that `completed` is what made an errored
   * turn indistinguishable from one that legitimately said nothing. Observed live as
   * `usage_limit_exceeded` with `last_agent_message: null`.
   *
   * Holds the message rather than a boolean so the verdict can say WHY without the classifier
   * having to reach back into the transcript for it.
   */
  taskCompleteError?: string | undefined
}

/**
 * How the child was started, and whether this turn has heard a word from it.
 *
 * Read by exactly one rule -- the deadline -- and it changes no outcome, only what the
 * provenance says. The distinction it exists to draw (#82): a turn that emitted nothing AT ALL
 * and a turn that emitted and then went quiet read identically today, and they are different
 * findings. The second is a turn that stopped. The first is a child that never started, which on
 * every CLI here is what a rejected model looks like from the outside -- the process is alive,
 * the prompt is consumed, and nothing is ever produced.
 */
export interface LaunchState {
  /** The model this child's argv named, or `null` when it named none. */
  model: string | null
  /**
   * Whether this is the FIRST turn the session was sent.
   *
   * The gate on the whole diagnosis, and not a detail: on a later turn the launch has already
   * been proved to work, so naming the model there would point an operator at the one thing the
   * run has evidence AGAINST.
   */
  firstTurn: boolean
  /** True once the child has produced anything whatsoever during this turn. */
  produced: boolean
}

export interface Evidence {
  agent: string
  hooks: string[]
  hookPayloads: Record<string, Record<string, unknown>>
  transcript: TranscriptState
  process: ProcessState
  orchestrator: OrchestratorActions
  elapsedSeconds: number
  /**
   * Seconds since the turn last produced ANYTHING, when an idle deadline has expired.
   *
   * Zero means no idle deadline has fired. Kept separate from `elapsedSeconds` because the
   * two answer different questions -- "has this run too long" versus "has it stopped
   * speaking" -- and a turn can be hung at two minutes while its elapsed budget has forty
   * left.
   */
  idleSeconds: number
  watchdogSeconds: number
  /** A channel we depend on went away. Says nothing about the turn itself. */
  observationGap: boolean
  /**
   * Absent when the adapter does not report it, and absent is the ONLY safe default: a
   * `firstTurn: false, produced: false` stand-in would be a claim about a session nobody
   * measured, and it would silence the diagnosis on precisely the adapters that never made it.
   */
  launch?: LaunchState | undefined
}

export function emptyTranscriptState(): TranscriptState {
  return { exists: false, hasAssistantAfterPrompt: false, toolResultError: false, taskComplete: false }
}

export function evidence(partial: Partial<Evidence> & { agent: string }): Evidence {
  return {
    hooks: [],
    hookPayloads: {},
    transcript: emptyTranscriptState(),
    process: { alive: true },
    orchestrator: { sentCancel: false, inputIsMediated: true },
    elapsedSeconds: 0,
    idleSeconds: 0,
    watchdogSeconds: 300,
    observationGap: false,
    ...partial,
  }
}

function verdict(outcome: Outcome, confidence: Confidence, provenance: Provenance[]): Verdict {
  return { outcome, confidence, provenance }
}

/**
 * Returns `in_progress` rather than an Outcome when no terminal evidence exists.
 * "Still going" and "ended somehow" are different claims; silence supports only the
 * first, so they get different return values rather than different confidences.
 */
export function classify(ev: Evidence): { state: TurnLiveness } & Partial<Verdict> {
  const p: Provenance[] = []

  // 1. A permission we explicitly refused.
  //
  //    This outranks `turn_aborted` because on Codex a refusal is *implemented* as an
  //    abort: denying the dialog writes `turn_aborted reason=interrupted`, byte-identical
  //    to a user cancellation. The abort is the mechanism, not the reason. Ranking the
  //    abort first would report every refused permission as a plain cancellation and
  //    lose why the turn ended.
  if (ev.orchestrator.sentPermissionDecision === 'deny' && ev.hooks.includes('PermissionRequest')) {
    const tool = ev.hookPayloads['PermissionRequest']?.['tool_name']
    p.push({ source: 'hook', detail: `PermissionRequest tool=${String(tool)}` })
    p.push({ source: 'orchestrator', detail: 'denied' })
    if (ev.transcript.turnAbortedReason) {
      p.push({
        source: 'transcript',
        detail: `turn_aborted reason=${ev.transcript.turnAbortedReason} (how the refusal ended the turn)`,
      })
    }
    if (!ev.orchestrator.inputIsMediated) {
      p.push({
        source: 'orchestrator',
        detail: 'input not mediated: another writer may have answered the dialog',
        caveat: true,
      })
      return { state: 'permission_refused', ...verdict('permission_refused', 'uncertain', p) }
    }
    return { state: 'permission_refused', ...verdict('permission_refused', 'inferred', p) }
  }

  // 2. `turn_aborted` outranks `Stop`. An evidence PRECEDENCE rule, deliberately not
  //    first-one-wins, because the two records may arrive in either order and arrival
  //    order is not semantics.
  //
  //    `turn_aborted` establishes that the turn was cancelled. `Stop` establishes only
  //    that the turn reached a terminal boundary -- "this turn is over" -- which a
  //    cancelled turn also is. Reading Stop as completion in the presence of an abort
  //    would upgrade a cancellation into a success on weaker evidence.
  //
  //    Codex writes this; Claude Code writes nothing equivalent anywhere.
  if (ev.transcript.turnAbortedReason) {
    p.push({ source: 'transcript', detail: `turn_aborted reason=${ev.transcript.turnAbortedReason}` })
    if (ev.hooks.includes('Stop')) {
      p.push({
        source: 'hook',
        detail: 'Stop also fired: a terminal boundary was reached, not that the turn completed',
        caveat: true,
      })
      p.push({
        source: 'transcript',
        detail: 'corroborating channel, not independent evidence: likely one shared cause',
        caveat: true,
      })
    }
    return { state: 'cancelled', ...verdict('cancelled', 'proven', p) }
  }

  // 2b. `task_complete` that carried an ERROR (#35).
  //
  //     Terminal, `proven`, and NOT `completed`. The record is the child's own statement that
  //     the turn's machinery finished; the error is its statement that what came out is a
  //     failure. Both are the transcript speaking directly, which is why this is `proven`
  //     rather than inferred from an absence.
  //
  //     Ranked HERE, and the position is the whole rule. Below `turn_aborted`, because an
  //     abort says the turn was cancelled, which is a more specific account of an ending than
  //     "it ended badly". Above `Stop`, because Codex reaches a turn boundary on an errored
  //     completion too -- so a `Stop` is very likely present, and letting rule 3 see it first
  //     grades the turn `completed/proven` and hands the relay an empty message to forward.
  //     That is #35 exactly: the run churned advisor turns toward its budget asking for a
  //     resend of a turn that had failed for a reason nobody was shown.
  //
  //     Above the deadline rule for the same reason it is above `Stop`: this is positive
  //     evidence from the child about how the turn ended, and it must supersede a verdict a
  //     clock minted from silence rather than be buried by one.
  if (ev.transcript.taskCompleteError !== undefined) {
    p.push({
      source: 'transcript',
      detail: `task_complete carried an error -- ${ev.transcript.taskCompleteError}`,
    })
    if (ev.hooks.includes('Stop')) {
      p.push({
        source: 'hook',
        detail: 'Stop also fired: a terminal boundary was reached, not that the turn succeeded',
        caveat: true,
      })
    }
    p.push({
      source: 'transcript',
      // Said out loud because the absence is the operationally important part: there is no
      // report to forward, and inventing one from the error text would put the vendor's words
      // into the participant's mouth and route them onward as though it had said them.
      detail: 'the turn produced no report; the error is the only account of what happened',
      caveat: true,
    })
    return { state: 'unknown_abnormal_end', ...verdict('unknown_abnormal_end', 'proven', p) }
  }

  // 3. Positive completion, with no abort record to outrank it.
  if (ev.hooks.includes('Stop')) {
    p.push({ source: 'hook', detail: 'Stop' })
    if (ev.transcript.finalStopReason) {
      p.push({ source: 'transcript', detail: `stop_reason=${ev.transcript.finalStopReason}` })
    }
    if (ev.transcript.toolResultError) {
      p.push({
        source: 'transcript',
        detail: 'a tool reported an error but the turn still completed',
        caveat: true,
      })
    }
    return { state: 'completed', ...verdict('completed', 'proven', p) }
  }

  // 3b. The transcript evidences completion even though no Stop arrived. Hook-loss
  //     recovery, and it must outrank the process rule below: a turn that finished and
  //     whose Stop was lost, in a session we then shut down, would otherwise be reported
  //     as a death the evidence contradicts.
  if (
    ev.transcript.hasAssistantAfterPrompt &&
    (ev.transcript.finalStopReason === 'end_turn' || ev.transcript.finalStopReason === 'stop_sequence')
  ) {
    p.push({ source: 'transcript', detail: `stop_reason=${ev.transcript.finalStopReason}` })
    p.push({
      source: 'hook',
      detail: 'no Stop delivery; completion recovered from the transcript',
      caveat: true,
    })
    return { state: 'completed', ...verdict('completed', 'inferred', p) }
  }

  // 3c. We cancelled it ourselves, with nothing from the child recording it. Outranks
  //     process death: we ended the turn, and a later shutdown says nothing about it.
  if (ev.orchestrator.sentCancel) {
    p.push({ source: 'orchestrator', detail: 'sent ESC' })
    if (ev.orchestrator.inputIsMediated) {
      return { state: 'cancelled', ...verdict('cancelled', 'assumed', p) }
    }
    p.push({
      source: 'orchestrator',
      detail: 'input not mediated: another writer may have ended the turn',
      caveat: true,
    })
    return { state: 'cancelled', ...verdict('cancelled', 'uncertain', p) }
  }

  // 4. The child is gone, and nothing above explained the turn's end.
  if (!ev.process.alive) {
    let confidence: Confidence
    if (ev.hooks.includes('SessionEnd')) {
      const reason = ev.hookPayloads['SessionEnd']?.['reason']
      p.push({ source: 'hook', detail: `SessionEnd reason=${String(reason)}` })
      confidence = 'proven'
    } else {
      // SIGKILL leaves neither a SessionEnd nor, often, a transcript at all.
      p.push({ source: 'process', detail: 'exited with no SessionEnd (unclean death)', caveat: true })
      confidence = 'inferred'
    }
    // Observed on Codex 0.146.0: a SIGTERMed turn produces no Stop, no SessionEnd, and a
    // transcript that simply stops -- no task_complete, no turn_aborted. State plainly
    // that the child announced nothing, so this reads as a conclusion drawn from absence
    // rather than as a terminal record someone forgot to name.
    if (
      !ev.transcript.taskComplete &&
      !ev.transcript.turnAbortedReason &&
      !ev.transcript.hasAssistantAfterPrompt
    ) {
      p.push({
        source: 'transcript',
        detail: 'the child emitted no terminal record; this is inferred from its death alone',
        caveat: true,
      })
    }
    if (ev.process.howEnded) p.push({ source: 'process', detail: ev.process.howEnded })
    return { state: 'process_exited', ...verdict('process_exited', confidence, p) }
  }

  // A pending PermissionRequest with no decision recorded is deliberately NOT treated as
  // a refusal. The live acceptance run showed why: the hook fires when the dialog opens,
  // so inferring refusal from "no Stop yet" settled the turn while the user was still
  // being asked -- and every allow then had to be walked back. A pending decision is
  // `in_progress` until something actually ends the turn.

  // 6. We lost the ability to observe. Not a statement about the turn.
  if (ev.observationGap) {
    p.push({ source: 'transport', detail: 'observation channel lost; turn state unobservable' })
    p.push({
      source: 'transport',
      detail: 'the child may still be running; this asserts nothing about the turn',
      caveat: true,
    })
    return { state: 'transport_lost', ...verdict('transport_lost', 'uncertain', p) }
  }

  // 7. Deadline, deliberately last and deliberately never `cancelled`. Silence does not
  //    distinguish a long turn from an abandoned one.
  //
  //    Nor does it distinguish a stuck child from a finished one whose `Stop` was lost, and this
  //    rule cannot: it sees a clock reading and no transcript. That question is settled OUTSIDE
  //    the classifier, by the adapters, which consult the child's transcript the moment a
  //    deadline fires and feed any proof of completion back through `resetTranscript` -- so a
  //    turn that really finished is superseded by rule 5 before anyone reads this one. What
  //    reaches here is a deadline with no surviving evidence of an ending. See `Outcome`.
  if (ev.elapsedSeconds > ev.watchdogSeconds || ev.idleSeconds > 0) {
    p.push(
      ev.idleSeconds > 0
        ? {
            source: 'watchdog',
            // Says SILENCE, not duration. A reader seeing "2700s with no Stop" concludes the
            // turn was working hard; "no output for 720s" says it stopped, which is the
            // actual finding and the one that tells them where to look.
            detail: `no output for ${ev.idleSeconds.toFixed(0)}s, and no Stop`,
          }
        : {
            source: 'watchdog',
            detail: `${ev.elapsedSeconds.toFixed(0)}s > ${ev.watchdogSeconds.toFixed(0)}s with no Stop`,
          },
    )
    // A first turn that produced NOTHING is a different finding from a turn that stopped, and
    // until #82 the two read identically. Named here rather than left to the operator because
    // the launch is the one thing they can check in seconds and the one thing a silent child
    // cannot tell them: a CLI given a model it does not have consumes the prompt, says nothing,
    // and is killed by this clock twelve minutes later.
    //
    // A CANDIDATE cause, worded as one. Validation refuses the models it can prove wrong before
    // the run starts; what reaches here is the residue -- an agent whose models cannot be
    // enumerated, an entitlement, a provider outage, a name valid for one account and not
    // another -- so this must not assert what it cannot know.
    if (ev.launch && ev.launch.firstTurn && !ev.launch.produced) {
      p.push({
        source: 'orchestrator',
        detail:
          ev.launch.model === null
            ? 'the first turn produced no output at all, rather than emitting and stopping: the ' +
              'child never started work. Its argv named no model, so a provider default or a ' +
              'configuration file chose one'
            : `the first turn produced no output at all, rather than emitting and stopping: the ` +
              `child never started work. It was launched with model '${ev.launch.model}', which ` +
              `is a candidate cause -- a model a CLI rejects looks exactly like this`,
        caveat: true,
      })
    }
    p.push({
      source: 'watchdog',
      detail: 'completion is uncertain; this is not evidence of cancellation',
      caveat: true,
    })
    if (!ev.orchestrator.inputIsMediated) {
      p.push({
        source: 'orchestrator',
        detail: 'input not mediated: a direct keystroke could have ended it unseen',
        caveat: true,
      })
      return { state: 'unknown_abnormal_end', ...verdict('unknown_abnormal_end', 'uncertain', p) }
    }
    return { state: 'timed_out', ...verdict('timed_out', 'uncertain', p) }
  }

  return { state: 'in_progress' }
}
