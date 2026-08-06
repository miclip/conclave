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
}

export interface Evidence {
  agent: string
  hooks: string[]
  hookPayloads: Record<string, Record<string, unknown>>
  transcript: TranscriptState
  process: ProcessState
  orchestrator: OrchestratorActions
  elapsedSeconds: number
  watchdogSeconds: number
  /** A channel we depend on went away. Says nothing about the turn itself. */
  observationGap: boolean
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
  if (ev.elapsedSeconds > ev.watchdogSeconds) {
    p.push({
      source: 'watchdog',
      detail: `${ev.elapsedSeconds.toFixed(0)}s > ${ev.watchdogSeconds.toFixed(0)}s with no Stop`,
    })
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
