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
  howEnded?: string
}

export interface OrchestratorActions {
  sentCancel: boolean
  sentPermissionDecision?: 'allow' | 'deny'
  /** False once anyone other than the orchestrator can type into the child. */
  inputIsMediated: boolean
}

export interface TranscriptState {
  exists: boolean
  hasAssistantAfterPrompt: boolean
  finalStopReason?: string
  toolResultError: boolean
  /** Codex only. Claude Code writes no equivalent record anywhere. */
  turnAbortedReason?: string
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

  // 1. `turn_aborted` outranks `Stop`. This is an evidence PRECEDENCE rule, deliberately
  //    not a first-one-wins rule, because the two records may arrive in either order and
  //    arrival order is not semantics.
  //
  //    The two say different things. `turn_aborted` establishes that the turn was
  //    cancelled. `Stop` establishes only that the turn reached a terminal boundary --
  //    it is the child announcing "this turn is over", which a cancelled turn also is.
  //    Reading Stop as "completed" in the presence of an abort would upgrade a
  //    cancellation into a success on the strength of a weaker signal.
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
      // Do NOT read agreement as independent confirmation. Both records plausibly come
      // from one internal lifecycle transition, so they corroborate a single source
      // rather than testing it twice. Confidence stays where turn_aborted alone puts it.
      p.push({
        source: 'transcript',
        detail: 'corroborating channel, not independent evidence: likely one shared cause',
        caveat: true,
      })
    }
    return { state: 'cancelled', ...verdict('cancelled', 'proven', p) }
  }

  // 2. Positive completion, in the absence of any abort record.
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

  // 2b. The transcript evidences completion even though no Stop arrived.
  //
  //     This is the hook-loss recovery path, and its position in the order is the whole
  //     point: it must outrank the process-exit rule below. A turn that finished and
  //     whose Stop delivery was lost, in a session we then shut down, would otherwise be
  //     reported as `process_exited` -- cleanup manufacturing an outcome the evidence
  //     contradicts.
  //
  //     Confidence is `inferred`, never `proven`: the transcript shows the model stopped
  //     generating, while `Stop` is what the child uses to announce a finished turn.
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

  // 3. A dead process explains a missing Stop on its own, so it outranks the
  //    permission and cancellation rules below.
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
    if (ev.process.howEnded) p.push({ source: 'process', detail: ev.process.howEnded })
    return { state: 'process_exited', ...verdict('process_exited', confidence, p) }
  }

  // 4. A permission decision was pending and the turn never completed. The hook fires
  //    on REQUEST, not on decision, so it proves nothing alone -- but an allow would
  //    have produced a Stop, which rule 1 already caught.
  if (ev.hooks.includes('PermissionRequest')) {
    const tool = ev.hookPayloads['PermissionRequest']?.['tool_name']
    p.push({ source: 'hook', detail: `PermissionRequest tool=${String(tool)}` })
    p.push({ source: 'hook', detail: 'no Stop after the request' })
    if (ev.orchestrator.sentPermissionDecision === 'deny') {
      p.push({ source: 'orchestrator', detail: 'denied' })
      return { state: 'permission_refused', ...verdict('permission_refused', 'inferred', p) }
    }
    if (ev.orchestrator.inputIsMediated) {
      p.push({ source: 'orchestrator', detail: 'mediated input, no allow recorded' })
      return { state: 'permission_refused', ...verdict('permission_refused', 'inferred', p) }
    }
    p.push({
      source: 'orchestrator',
      detail: 'input not mediated: refusal indistinguishable from cancellation at the dialog',
      caveat: true,
    })
    return { state: 'permission_refused', ...verdict('permission_refused', 'uncertain', p) }
  }

  // 5. We cancelled it ourselves. Unverifiable from Claude Code -- pure bookkeeping,
  //    trustworthy only while we own all input.
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

  // 6. We lost the ability to observe. Not a statement about the turn.
  if (ev.observationGap) {
    p.push({ source: 'transport', detail: 'observation channel lost; turn state unobservable' })
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
