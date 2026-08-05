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
  verdict: Verdict
  /**
   * Present when this replaces a terminal verdict already reported. The adapter should
   * emit a `revision` event withdrawing the earlier `turn_end` before emitting this one.
   */
  supersedes?: Verdict
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
  #verdict?: Verdict

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

  observeProcess(patch: Partial<Evidence['process']>): VerdictUpdate | undefined {
    this.#evidence.process = { ...this.#evidence.process, ...patch }
    return this.#reclassify()
  }

  observeOrchestrator(patch: Partial<Evidence['orchestrator']>): VerdictUpdate | undefined {
    this.#evidence.orchestrator = { ...this.#evidence.orchestrator, ...patch }
    return this.#reclassify()
  }

  observeElapsed(seconds: number): VerdictUpdate | undefined {
    this.#evidence.elapsedSeconds = seconds
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
