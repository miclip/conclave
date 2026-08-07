/**
 * The reconciliation loop:
 *
 *   read new records
 *     -> detect compaction boundary
 *     -> invalidate affected derived turns
 *     -> rebuild the canonical view from surviving history
 *     -> emit replacement events carrying provenance
 *
 * This is why `events()` and `snapshot()` are separate. `events()` is a live,
 * provisional stream that is allowed to be wrong and to say so afterwards.
 * `snapshot()` is rebuilt from whatever the transcript currently contains and is
 * always authoritative. Consumers use the first for responsiveness and reconcile
 * against the second after compaction, restart, or known delivery loss.
 *
 * A compaction is not an error and not a gap; it is the source of truth changing its
 * mind about the past. Anything derived from the old bytes is void.
 */

import type {
  AgentEvent,
  Guarantees,
  SessionSnapshot,
  TurnRecord,
} from '../contract/session.ts'
import type { Provenance } from '../contract/outcome.ts'
import { isTerminal } from '../contract/outcome.ts'
import { RewriteAwareTail, parseJsonLine } from './tail.ts'
import { parserFor, type ParsedTranscript } from './parse.ts'

interface EmittedTurn {
  seqs: number[]
  textLength: number
  toolCount: number
  ended: boolean
}

export interface SessionViewOptions {
  path: string
  agent: string
  sessionId: string
  cwd: string
  guarantees: Guarantees
}

export class TranscriptSessionView {
  readonly #tail: RewriteAwareTail<Record<string, any>>
  readonly #parse: (r: Record<string, any>[]) => ParsedTranscript
  readonly #opts: SessionViewOptions

  #records: Record<string, any>[] = []
  #view: ParsedTranscript = { turns: [], declaredCompaction: false, compactions: 0 }
  #emitted = new Map<string, EmittedTurn>()
  #seq = 0
  #compactionGeneration = 0
  /**
   * Compaction markers already counted, so an append is not re-counted every poll.
   *
   * The generation used to increment ONLY when the tail reported a rewritten prefix. Claude
   * Code does not rewrite: it APPENDS `compact_file_reference` attachments and leaves the
   * history in place -- verified against a real 57,493-line transcript with five markers at
   * lines 2194 through 12184 and records intact either side.
   *
   * So on Claude Code the counter could never move, and it never did: 34 assessments across
   * four live oath-lang runs, peak generation pinned at exactly 0. Every negative result from
   * the degradation experiment was unfalsifiable, because a true null and an instrument that
   * cannot fire are indistinguishable from outside.
   */
  #countedCompactions = 0
  #builtAt = 0

  constructor(opts: SessionViewOptions) {
    this.#opts = opts
    this.#tail = new RewriteAwareTail(opts.path, parseJsonLine)
    this.#parse = parserFor(opts.agent)
  }

  get compactionGeneration(): number {
    return this.#compactionGeneration
  }

  #next(): number {
    return ++this.#seq
  }

  async poll(): Promise<AgentEvent[]> {
    const res = await this.#tail.poll()
    const events: AgentEvent[] = []

    if (res.rewritten) {
      // Everything we said about the past may now be false. Withdraw it explicitly
      // rather than letting consumers hold contradicting state.
      const replaced = [...this.#emitted.values()].flatMap((e) => e.seqs)
      this.#records = res.all ?? []
      this.#view = this.#parse(this.#records)
      this.#emitted.clear()
      this.#compactionGeneration++
      this.#builtAt = Date.now()

      const provenance: Provenance[] = [
        { source: 'transcript', detail: 'transcript prefix changed; history was rewritten' },
        {
          source: 'transcript',
          detail: this.#view.declaredCompaction
            ? 'transcript declares a compaction'
            : 'rewrite detected by prefix digest; no compaction marker recognised',
          caveat: !this.#view.declaredCompaction,
        },
        { source: 'transcript', detail: `compaction generation ${this.#compactionGeneration}` },
      ]

      events.push({
        type: 'revision',
        reason: 'compaction',
        replaces: replaced,
        provenance,
        seq: this.#next(),
        at: this.#builtAt,
        provisional: false,
      })
      // Re-emit the surviving history so a consumer that only follows events() ends up
      // agreeing with snapshot().
      events.push(...this.#emitFor(this.#view.turns))
      return events
    }

    if (res.appended.length === 0) return events

    this.#records.push(...res.appended)
    this.#view = this.#parse(this.#records)
    this.#builtAt = Date.now()
    events.push(...this.#noteDeclaredCompactions())
    events.push(...this.#emitFor(this.#view.turns))
    return events
  }

  /**
   * Raise the generation for compactions the transcript DECLARES, however they were recorded.
   *
   * A rewrite and an appended marker are the same event from the participant's point of view
   * -- context was discarded -- and rotation is watching for that event, not for a particular
   * way of writing it down. Counting only rewrites made the trigger a property of Codex's
   * file format.
   *
   * No `replaces`: the history is still there, so nothing previously emitted is withdrawn.
   * That is the honest difference from the rewrite path, and it is why this is a separate
   * method rather than a flag on that one.
   */
  #noteDeclaredCompactions(): AgentEvent[] {
    const declared = this.#view?.compactions ?? 0
    if (declared <= this.#countedCompactions) return []
    const fresh = declared - this.#countedCompactions
    this.#countedCompactions = declared
    this.#compactionGeneration += fresh

    return [
      {
        type: 'revision',
        reason: 'compaction',
        replaces: [],
        provenance: [
          { source: 'transcript', detail: 'transcript declares a compaction' },
          {
            source: 'transcript',
            detail: `compaction generation ${this.#compactionGeneration}`,
          },
          {
            source: 'transcript',
            detail: 'history was appended to rather than rewritten, so nothing is withdrawn',
            caveat: true,
          },
        ],
        seq: this.#next(),
        at: this.#builtAt,
        provisional: false,
      },
    ]
  }

  /** Diff the rebuilt view against what we have already told consumers. */
  #emitFor(turns: TurnRecord[]): AgentEvent[] {
    const out: AgentEvent[] = []
    for (const turn of turns) {
      const key = String(turn.key)
      let seen = this.#emitted.get(key)

      if (!seen) {
        seen = { seqs: [], textLength: 0, toolCount: 0, ended: false }
        this.#emitted.set(key, seen)
        const seq = this.#next()
        seen.seqs.push(seq)
        out.push({
          type: 'turn_start',
          prompt: turn.prompt,
          turnKey: turn.key,
          seq,
          at: this.#builtAt,
          provisional: true,
        })
      }

      for (let i = seen.toolCount; i < turn.toolCalls.length; i++) {
        const seq = this.#next()
        seen.seqs.push(seq)
        out.push({
          type: 'tool_use',
          tool: turn.toolCalls[i]!.tool,
          // The serialized input, not the parsed object: this is the only channel through
          // which a consumer watching events -- rather than polling snapshots -- can see
          // which files a participant touched.
          input: turn.toolCalls[i]!.args,
          failed: turn.toolCalls[i]!.failed,
          turnKey: turn.key,
          seq,
          at: this.#builtAt,
          provisional: true,
        })
      }
      seen.toolCount = turn.toolCalls.length

      const text = turn.assistantText ?? ''
      if (text.length > seen.textLength) {
        const seq = this.#next()
        seen.seqs.push(seq)
        out.push({
          type: 'message',
          role: 'assistant',
          text: text.slice(seen.textLength),
          turnKey: turn.key,
          seq,
          at: this.#builtAt,
          provisional: true,
        })
        seen.textLength = text.length
      }

      if (!seen.ended && isTerminal(turn.state)) {
        seen.ended = true
        const seq = this.#next()
        seen.seqs.push(seq)
        out.push({
          type: 'turn_end',
          verdict: {
            outcome: turn.state,
            confidence: turn.confidence ?? 'inferred',
            provenance: turn.provenance ?? [
              { source: 'transcript', detail: 'derived from transcript state' },
            ],
          },
          // Nothing announced this to us; we concluded it by reading the file.
          synthesized: true,
          turnKey: turn.key,
          seq,
          at: this.#builtAt,
          provisional: true,
        })
      }
    }
    return out
  }

  /** Canonical. Rebuilt from the transcript as it currently exists. */
  async snapshot(): Promise<SessionSnapshot> {
    await this.poll()
    return {
      sessionId: this.#opts.sessionId,
      agent: this.#opts.agent,
      cwd: this.#opts.cwd,
      turns: this.#view.turns.map((t) => ({ ...t, toolCalls: t.toolCalls.map((c) => ({ ...c })) })),
      guarantees: this.#opts.guarantees,
      compactionGeneration: this.#compactionGeneration,
      builtAt: this.#builtAt || Date.now(),
    }
  }
}
