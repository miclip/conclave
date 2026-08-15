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

/**
 * A record's identity independent of how it was written down: key order normalised
 * recursively, so `{a:1,b:2}` and `{b:2,a:1}` compare equal. Whitespace never reaches here --
 * these are already-parsed objects.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val as Record<string, unknown>)
            .sort()
            .map((k) => [k, (val as Record<string, unknown>)[k]]),
        )
      : val,
  )
}

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
   *
   * "Does not rewrite" is about the MARKER, and is narrower than it reads: Claude Code
   * transcripts do get their prefix rewritten (#122), just never as the way a compaction is
   * recorded. See `#rewriteGeneration`.
   */
  #countedCompactions = 0
  /**
   * Prefix rewrites with no compaction marker behind them, counted separately and read by
   * nobody who rotates.
   *
   * These are not compactions. Across four runs, 13 child transcripts carried zero
   * `compact_file_reference` attachments and zero boundary records while the generation
   * counter reported nine compactions (#122). What those transcripts did carry was ordinary
   * activity -- hook results, reminders, tool-listing deltas.
   *
   * Their FINAL state kept every UUID-bearing record, in order, with no duplicates. That is
   * an end-state check and no more: it cannot say what the file looked like between two
   * polls, so it rules out permanent loss and not mutation in flight. `#reserialized` is what
   * decides that question, and it decides it per poll on the records themselves.
   *
   * What rewrote the prefix is not established, and cannot be recovered from those
   * transcripts: a final state cannot say which earlier bytes moved, so reserialization,
   * mutation, deletion and reordering are all still on the table for the historical nine.
   * All that is known is that something changed bytes we had already consumed.
   *
   * Ordinary activity is not the cause. A live capture of this project's own session grew
   * 485,646 -> 659,600 bytes across a turn with an unchanged prefix hash -- append-only, and
   * an append cannot move a digest that covers only the bytes before it.
   *
   * Future occurrences do not need the history: `#reserialized` classifies each one from the
   * records at the moment it happens. This counter records what is left after that -- a real
   * change to consumed records -- and a revision is still emitted for it, because whatever we
   * derived from those records may now be false. What changed is that it no longer claims the
   * participant lost context.
   */
  #rewriteGeneration = 0
  #builtAt = 0

  constructor(opts: SessionViewOptions) {
    this.#opts = opts
    this.#tail = new RewriteAwareTail(opts.path, parseJsonLine)
    this.#parse = parserFor(opts.agent)
  }

  get compactionGeneration(): number {
    return this.#compactionGeneration
  }

  /** Unexplained rewrites. Diagnostic: see `#rewriteGeneration`. */
  get rewriteGeneration(): number {
    return this.#rewriteGeneration
  }

  #next(): number {
    return ++this.#seq
  }

  async poll(): Promise<AgentEvent[]> {
    const res = await this.#tail.poll()
    const events: AgentEvent[] = []

    if (res.rewritten) {
      const all = res.all ?? []

      // A changed digest is a claim about BYTES. Before acting on it, ask the records: if
      // everything we already consumed is still there, unchanged and in the same order, then
      // the file was re-serialised and possibly appended to, and nothing we told anyone has
      // become false. Emitting a revision there withdraws evidence that is still good, and
      // withdrawal is not free -- it clears `#emitted`, so the whole history is re-emitted
      // and every consumer must reconcile against a snapshot for nothing.
      //
      // This is the guard that closes #122 at the seam rather than at the label. The counter
      // fix stops an unexplained rewrite being *called* a compaction; this stops the common
      // case being an event at all.
      const suffix = this.#reserialized(all)
      if (suffix) {
        this.#records = all
        this.#view = this.#parse(this.#records)
        this.#builtAt = Date.now()
        // Deliberately identical to the append path from here: `#emitted` is kept, so only
        // the suffix produces events, and a compaction marker arriving in that suffix counts
        // exactly as it would have without the reserialization.
        events.push(...this.#noteDeclaredCompactions())
        events.push(...this.#emitFor(this.#view.turns))
        return events
      }

      // Everything we said about the past may now be false. Withdraw it explicitly
      // rather than letting consumers hold contradicting state.
      const replaced = [...this.#emitted.values()].flatMap((e) => e.seqs)
      this.#records = all
      this.#view = this.#parse(this.#records)
      this.#emitted.clear()
      this.#builtAt = Date.now()

      // A rewrite is how the bytes changed; a compaction is what the transcript SAYS
      // happened. They coincide on Codex and almost never on Claude Code, so they are
      // counted apart. Markers already counted are not counted again -- the rewritten view
      // still contains them, and re-counting them on every rewrite is how a byte-level digest
      // turned into nine imaginary compactions (#122).
      const declared = this.#view.compactions
      const fresh = Math.max(0, declared - this.#countedCompactions)
      // Down as well as up: a rewrite that drops the prefix drops its markers with it, and
      // leaving the high-water mark behind would silently swallow the next real compaction.
      this.#countedCompactions = declared
      this.#compactionGeneration += fresh
      if (fresh === 0) this.#rewriteGeneration++

      const provenance: Provenance[] = [
        { source: 'transcript', detail: 'transcript prefix changed; history was rewritten' },
        fresh > 0
          ? { source: 'transcript', detail: 'transcript declares a compaction' }
          : {
              source: 'transcript',
              detail: 'rewrite detected by prefix digest; no compaction marker recognised',
              caveat: true,
            },
        fresh > 0
          ? { source: 'transcript', detail: `compaction generation ${this.#compactionGeneration}` }
          : {
              source: 'transcript',
              detail:
                `transcript rewrite ${this.#rewriteGeneration}; compaction generation ` +
                `unchanged at ${this.#compactionGeneration} -- a changed digest is not ` +
                `evidence that context was lost`,
            },
      ]

      events.push({
        type: 'revision',
        // Say what was seen. Naming an unexplained rewrite `compaction` is what made routine
        // churn look like a seat losing its context, all the way through to rotation.
        reason: fresh > 0 ? 'compaction' : 'rewrite',
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
   * The records we already consumed, still an ordered prefix of the reread file?
   *
   * Returns the appended suffix (possibly empty) when so, and `undefined` when any consumed
   * record was mutated, deleted or reordered -- which is a real rewrite and keeps the
   * revision path.
   *
   * Semantic, not textual, on purpose: the whole point is that the bytes changed. Two
   * serialisations of the same record differing only in whitespace or key order are the same
   * record, and the JSON we hold has already lost the whitespace, so key order is what
   * `canonicalJson` normalises.
   *
   * Cost is a full canonicalisation of both sides, paid only on a rewrite. On the largest
   * transcript in evidence -- 57,493 records -- that is one pass, against the alternative of
   * re-emitting 57,493 records' worth of history and calling it a compaction.
   */
  #reserialized(all: Record<string, any>[]): Record<string, any>[] | undefined {
    if (all.length < this.#records.length) return undefined
    for (let i = 0; i < this.#records.length; i++) {
      if (canonicalJson(this.#records[i]) !== canonicalJson(all[i])) return undefined
    }
    return all.slice(this.#records.length)
  }

  /**
   * Raise the generation for compactions the transcript DECLARES, however they were recorded.
   *
   * A DECLARED compaction is the same event from the participant's point of view however it
   * reached the file -- context was discarded -- and rotation is watching for that event, not
   * for a particular way of writing it down. Counting only rewrites made the trigger a
   * property of Codex's file format; counting every rewrite made it a property of Claude
   * Code's flushing behaviour (#122). The marker is the thing.
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
      rewriteGeneration: this.#rewriteGeneration,
      builtAt: this.#builtAt || Date.now(),
    }
  }
}
