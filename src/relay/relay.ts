/**
 * The two-party relay. Build order step 5.
 *
 * Deliberately mechanical: no orchestrator model, no summarisation, no intelligence of
 * its own. It declares a lead, starts both sessions, routes prose between them with rank
 * made legible, delivers human messages to one participant or all, and records everything
 * that moved. Confirm the loop is stable before adding anything clever.
 *
 * What it does NOT do, on purpose:
 *   - see or forward tool calls, diffs, file contents or reasoning traces. Prose only,
 *     in both directions, and all of it — the full narration of a turn rather than its
 *     closing message.
 *   - decide anything. Ending a session, rotation and escalation are §7a's, and are not
 *     implemented here.
 */

import type { AgentEvent, AgentSession, TurnEndEvent } from '../contract/session.ts'
import { formatVerdict } from '../contract/outcome.ts'
import { AgentRegistry } from '../registry/registry.ts'
import type { ParticipantSpec } from '../registry/types.ts'
import { acquire, release } from '../workspace/sessionLock.ts'
import {
  envelope,
  type Audience,
  type MessageKind,
  type Rank,
  type RelayMessage,
  type Visibility,
} from './message.ts'

export interface RelayParticipant {
  id: string
  rank: Rank
  session: AgentSession
  events: AgentEvent[]
}

export interface RelayOptions {
  registry: AgentRegistry
  cwd: string
  /** The advisor. Steers, and cannot see the implementer's tools. */
  lead: ParticipantSpec
  implementer: ParticipantSpec
  /** Exchanges before the relay stops and hands back to the human. */
  maxRounds?: number
  /** Per-turn deadline, handed to each adapter's watchdog rather than kept here. */
  turnWatchdogMs?: number
  onLog?: (m: RelayMessage) => void
}

const LEAD_BRIEFING = `You are the ADVISOR on a two-agent coding session, and you are in charge of it.

Another AI model — the implementer — does the actual work in this repository. You cannot
see its tool calls, its diffs, or its code. You see only the prose it writes back, exactly
as a human following along would. You share its working directory, so you can read files
and run commands yourself to check any claim it makes; prefer doing that over believing it.

Your job is to give it one concrete instruction at a time and react to what comes back.
Reply with the instruction itself and nothing else — no preamble, no restating the plan.
Keep it short. If the work looks finished, reply exactly DONE. If it has gone wrong or
stalled and needs a human, reply exactly ESCALATE: followed by why.`

const IMPLEMENTER_BRIEFING = `You are the IMPLEMENTER on a two-agent coding session.

Another AI model — the advisor — is steering. It cannot see your tool calls or your code,
only what you write, so your prose is the entire report. Say what you did, what you found,
and anything you are unsure about.

It outranks you on process, but you are not required to agree with it. If an instruction
is wrong, say so plainly and say why, then proceed unless a human overrules. Silent
compliance is worse than disagreement.`

export class Relay {
  readonly log: RelayMessage[] = []
  #participants = new Map<string, RelayParticipant>()
  #seq = 0
  #opts: RelayOptions
  #stopped = false

  private constructor(opts: RelayOptions) {
    this.#opts = opts
  }

  static async start(opts: RelayOptions): Promise<Relay> {
    const relay = new Relay(opts)
    // Sequential rather than parallel: two CLIs negotiating terminals and hook trust at
    // once produces interleaved failures that are miserable to attribute.
    await relay.#join(opts.lead, 'advisor')
    await relay.#join(opts.implementer, 'implementer')
    // Records what the tree looked like before the participants touched it, so the
    // operator's own tooling can refuse to sweep their work into an unrelated commit.
    acquire(opts.cwd, [
      { id: opts.lead.id, agent: opts.lead.agent },
      { id: opts.implementer.id, agent: opts.implementer.agent },
    ])
    return relay
  }

  get participants(): RelayParticipant[] {
    return [...this.#participants.values()]
  }

  async #join(spec: ParticipantSpec, rank: Rank): Promise<void> {
    const session = await this.#opts.registry.createParticipant(spec, {
      cwd: this.#opts.cwd,
      watchdogMs: this.#opts.turnWatchdogMs,
    })
    const p: RelayParticipant = { id: spec.id, rank, session, events: [] }
    this.#participants.set(spec.id, p)
    // One consumer per session: the event queue delivers each event to exactly one reader.
    void (async () => {
      for await (const e of session.events()) p.events.push(e)
    })()
    this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `${spec.id} joined as ${rank} (${spec.agent})` })
  }

  #record(m: Omit<RelayMessage, 'seq' | 'at' | 'visibility' | 'excluded'>): RelayMessage {
    // Derived from provenance, never from recipient count. An advisor instruction reaches
    // one participant and is entirely ordinary; a human message that skips one is not.
    let visibility: Visibility = 'normal'
    let excluded: string[] = []
    if (m.kind === 'note') {
      visibility = 'internal'
    } else if (m.fromRank === 'human') {
      const missing = [...this.#participants.keys()].filter((id) => !m.to.includes(id))
      if (missing.length > 0) {
        visibility = 'restricted'
        excluded = missing
      }
    }

    const full: RelayMessage = { ...m, visibility, excluded, seq: ++this.#seq, at: Date.now() }
    this.log.push(full)
    this.#opts.onLog?.(full)
    return full
  }

  /**
   * Every point at which one participant knew something another did not, because we
   * withheld it.
   *
   * This is the whole reason restricted messages are labelled. When two participants
   * disagree, a human needs to be able to tell whether they disagree about the work or
   * merely hold different information — and only the orchestrator can answer that,
   * because only it routed both sides.
   */
  audit(): { seq: number; at: number; informed: string[]; excluded: string[]; text: string }[] {
    return this.log
      .filter((m) => m.visibility === 'restricted')
      .map((m) => ({ seq: m.seq, at: m.at, informed: m.to, excluded: m.excluded, text: m.text }))
  }

  /** Participants that held withheld information at or before `seq`. */
  asymmetryAt(seq: number): { informed: string[]; excluded: string[] } {
    const informed = new Set<string>()
    const excluded = new Set<string>()
    for (const m of this.log) {
      if (m.seq > seq || m.visibility !== 'restricted') continue
      for (const id of m.to) informed.add(id)
      for (const id of m.excluded) excluded.add(id)
    }
    return { informed: [...informed], excluded: [...excluded] }
  }

  #resolve(audience: Audience): string[] {
    if (audience === 'all') return [...this.#participants.keys()]
    if (!this.#participants.has(audience.only)) {
      throw new Error(`unknown participant '${audience.only}'`)
    }
    return [audience.only]
  }

  /**
   * Deliver text to a participant and return its prose for that turn.
   *
   * Prose comes from the snapshot rather than the event stream: the snapshot is
   * authoritative and carries the full narration, where a turn_end carries only a verdict.
   */
  async #exchange(p: RelayParticipant, text: string): Promise<{ prose: string; end: TurnEndEvent }> {
    const before = p.events.length
    await p.session.send(text, { kind: 'peer_relay' })

    // No timeout of its own. The adapter's watchdog guarantees a terminal verdict for a
    // hung turn -- that is what it is for -- so a deadline here would be a second clock
    // racing the first.
    //
    // An earlier version threw after ten minutes, which killed both sessions on a turn
    // that was merely long. It discarded working sessions to report a timeout, and it did
    // so with a hardcoded throw rather than the `timed_out` verdict the design already
    // defines. Losing the session is worse than waiting for it.
    let end: TurnEndEvent | undefined
    while (!end) {
      end = p.events.slice(before).find((e) => e.type === 'turn_end') as TurnEndEvent | undefined
      if (!end) await new Promise((r) => setTimeout(r, 250))
    }

    const snap = await p.session.snapshot()
    const prose = snap.turns.at(-1)?.assistantText ?? ''
    return { prose, end }
  }

  /**
   * A human message. Addressed to one participant or all, and recorded either way.
   *
   * Not delivered as a turn — it is queued as context the next exchange carries, so a
   * constraint does not consume a turn of its own.
   */
  #pending = new Map<string, string[]>()

  say(text: string, audience: Audience = 'all', kind: MessageKind = 'constraint'): RelayMessage {
    const to = this.#resolve(audience)
    const m = this.#record({ from: 'human', fromRank: 'human', to, kind, text })
    for (const id of to) {
      const queue = this.#pending.get(id) ?? []
      queue.push(envelope({ from: 'human', fromRank: 'human', kind, text }))
      this.#pending.set(id, queue)
    }
    return m
  }

  #drain(id: string): string {
    const queue = this.#pending.get(id) ?? []
    this.#pending.set(id, [])
    return queue.join('\n\n')
  }

  /**
   * Run the session. Returns why it stopped.
   *
   * The relay itself decides nothing beyond the round budget: DONE and ESCALATE are the
   * advisor's calls, and both hand back to the human rather than being acted on. §7a's
   * rotation and termination authority is not implemented here.
   */
  async run(goal: string): Promise<{ reason: 'done' | 'escalated' | 'budget' | 'stopped'; detail?: string }> {
    const lead = this.participants.find((p) => p.rank === 'advisor')!
    const impl = this.participants.find((p) => p.rank === 'implementer')!

    this.#record({ from: 'human', fromRank: 'human', to: [lead.id, impl.id], kind: 'goal', text: goal })

    await this.#exchange(impl, `${IMPLEMENTER_BRIEFING}\n\nThe goal for this session:\n\n${goal}\n\nAcknowledge briefly; do not start work yet.`)
    let next = await this.#exchange(lead, `${LEAD_BRIEFING}\n\nThe goal for this session:\n\n${goal}\n\nGive the implementer its first instruction.`)

    const maxRounds = this.#opts.maxRounds ?? 6
    for (let round = 1; round <= maxRounds; round++) {
      if (this.#stopped) return { reason: 'stopped' }

      const instruction = next.prose.trim()
      if (/^DONE\b/i.test(instruction)) {
        this.#record({ from: lead.id, fromRank: 'advisor', to: [], kind: 'note', text: `advisor reports the work complete: ${instruction}` })
        return { reason: 'done', detail: instruction }
      }
      if (/^ESCALATE\b/i.test(instruction)) {
        this.#record({ from: lead.id, fromRank: 'advisor', to: [], kind: 'note', text: instruction })
        return { reason: 'escalated', detail: instruction }
      }

      this.#record({ from: lead.id, fromRank: 'advisor', to: [impl.id], kind: 'instruction', text: instruction })
      const aside = this.#drain(impl.id)
      const report = await this.#exchange(
        impl,
        [aside, envelope({ from: lead.id, fromRank: 'advisor', kind: 'instruction', text: instruction })]
          .filter(Boolean)
          .join('\n\n'),
      )
      this.#record({ from: impl.id, fromRank: 'implementer', to: [lead.id], kind: 'report', text: report.prose })
      this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `${impl.id} turn: ${formatVerdict(report.end.verdict)}` })

      // A turn that did not complete is the human's call, not the advisor's. Escalating
      // here rather than relaying the partial prose keeps the advisor from steering on a
      // report that never finished being written.
      if (report.end.verdict.outcome !== 'completed') {
        return {
          reason: 'escalated',
          detail: `${impl.id} turn ended ${formatVerdict(report.end.verdict)}`,
        }
      }

      const leadAside = this.#drain(lead.id)
      next = await this.#exchange(
        lead,
        [leadAside, envelope({ from: impl.id, fromRank: 'implementer', kind: 'report', text: report.prose })]
          .filter(Boolean)
          .join('\n\n'),
      )
    }
    return { reason: 'budget' }
  }

  async stop(): Promise<void> {
    this.#stopped = true
    for (const p of this.participants) await p.session.close('graceful')
    release(this.#opts.cwd)
  }
}
