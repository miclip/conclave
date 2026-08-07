/**
 * Accumulates evidence for one turn and reports when a verdict must be revised.
 *
 * `classify()` is a pure function of the evidence set, so it is order-independent by
 * construction. The order problem lives one level up, in the streaming path: an adapter
 * that emits a terminal event the moment a signal arrives can emit `completed` from a
 * `Stop`, and only afterwards read `turn_aborted` from the transcript.
 *
 * That earlier event was not merely early, it was wrong. This tracker exists so it gets
 * *withdrawn* rather than left standing next to its own contradiction — a consumer
 * following only `events()` must converge on the same state as `snapshot()`.
 *
 * Evidence is monotonic here: signals accumulate and are never dropped. So two
 * different arrival orders reach an identical final evidence set, and therefore an
 * identical final verdict and provenance. Only the intermediate events differ, which is
 * exactly what a revision is for.
 */

import type { Verdict } from '../contract/outcome.ts'
import { classify, evidence, type Evidence } from './classify.ts'

export interface VerdictUpdate {
  /**
   * Absent when a previously reported verdict was WITHDRAWN without a replacement --
   * only possible via `resetTranscript`, when compaction removed the evidence a verdict
   * rested on.
   */
  verdict?: Verdict | undefined
  /**
   * Present when this replaces a terminal verdict already reported. The adapter should
   * emit a `revision` event withdrawing the earlier `turn_end` before emitting this one.
   */
  supersedes?: Verdict | undefined
}

function sameVerdict(a: Verdict, b: Verdict): boolean {
  return (
    a.outcome === b.outcome &&
    a.confidence === b.confidence &&
    a.provenance.length === b.provenance.length &&
    a.provenance.every((p, i) => p.detail === b.provenance[i]!.detail)
  )
}

export class TurnVerdictTracker {
  #evidence: Evidence
  #verdict: Verdict | undefined

  constructor(base: Partial<Evidence> & { agent: string }) {
    this.#evidence = evidence(base)
  }

  get evidence(): Evidence {
    return this.#evidence
  }

  get verdict(): Verdict | undefined {
    return this.#verdict
  }

  /** True once a terminal verdict has been reported to consumers. */
  get settled(): boolean {
    return this.#verdict !== undefined
  }

  /** Record a hook delivery. Repeats are ignored; evidence only accumulates. */
  observeHook(event: string, payload: Record<string, unknown> = {}): VerdictUpdate | undefined {
    if (!this.#evidence.hooks.includes(event)) this.#evidence.hooks.push(event)
    this.#evidence.hookPayloads[event] = payload
    return this.#reclassify()
  }

  observeTranscript(patch: Partial<Evidence['transcript']>): VerdictUpdate | undefined {
    this.#evidence.transcript = { ...this.#evidence.transcript, ...patch }
    return this.#reclassify()
  }

  /**
   * REPLACE transcript evidence rather than merging it.
   *
   * Everything else here is monotonic, which is what makes weaker repeated evidence
   * unable to resurrect a verdict. Compaction is the one thing that breaks that
   * assumption: a rewritten transcript may no longer contain a record the tracker has
   * already seen, and continuing to hold it would mean asserting something the source of
   * truth now denies.
   *
   * So after a rewrite the transcript half is rebuilt from what the transcript currently
   * says, not merged into what it used to say. A verdict resting solely on removed
   * evidence is withdrawn -- returned as an update with `supersedes` set and no
   * `verdict`. Hook and orchestrator evidence are untouched: those channels were not
   * rewritten.
   */
  resetTranscript(state: Evidence['transcript']): VerdictUpdate | undefined {
    this.#evidence.transcript = { ...state }
    const previous = this.#verdict
    const got = classify(this.#evidence)

    if (got.state === 'in_progress') {
      if (!previous) return undefined
      this.#verdict = undefined
      return { supersedes: previous }
    }

    const next: Verdict = {
      outcome: got.outcome!,
      confidence: got.confidence!,
      provenance: got.provenance!,
    }
    if (previous && sameVerdict(previous, next)) return undefined
    this.#verdict = next
    return previous ? { verdict: next, supersedes: previous } : { verdict: next }
  }

  observeProcess(patch: Partial<Evidence['process']>): VerdictUpdate | undefined {
    this.#evidence.process = { ...this.#evidence.process, ...patch }
    return this.#reclassify()
  }

  observeOrchestrator(patch: Partial<Evidence['orchestrator']>): VerdictUpdate | undefined {
    this.#evidence.orchestrator = { ...this.#evidence.orchestrator, ...patch }
    return this.#reclassify()
  }

  /**
   * Record that we have stopped observing this turn -- the adapter walked away from the
   * transport. Routed through the tracker rather than emitted directly, because a verdict
   * the tracker does not hold makes `events()` and `snapshot()` disagree: the stream says
   * transport_lost while the snapshot still reports in_progress.
   */
  observeObservationGap(): VerdictUpdate | undefined {
    this.#evidence.observationGap = true
    return this.#reclassify()
  }

  observeElapsed(seconds: number): VerdictUpdate | undefined {
    this.#evidence.elapsedSeconds = seconds
    return this.#reclassify()
  }

  /**
   * The turn has produced nothing for `seconds`, and that is now considered too long.
   *
   * Separate from `observeElapsed` because the deadline that expired is different, and the
   * provenance a reader gets must say which -- "2700s with no Stop" reads as a turn working
   * hard, "no output for 720s" says it stopped.
   */
  observeIdle(seconds: number): VerdictUpdate | undefined {
    this.#evidence.idleSeconds = seconds
    return this.#reclassify()
  }

  #reclassify(): VerdictUpdate | undefined {
    const got = classify(this.#evidence)
    if (got.state === 'in_progress') return undefined

    const next: Verdict = {
      outcome: got.outcome!,
      confidence: got.confidence!,
      provenance: got.provenance!,
    }

    if (!this.#verdict) {
      this.#verdict = next
      return { verdict: next }
    }
    if (sameVerdict(this.#verdict, next)) return undefined

    const supersedes = this.#verdict
    this.#verdict = next
    return { verdict: next, supersedes }
  }
}
