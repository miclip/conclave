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
import { RelayEventStream, type ObserveOptions, type RelayEvent, type RunReason } from './observe.ts'
import { RunHandle, type PauseReason, type RunOutcome, type RunPause } from './run.ts'
import {
  describeConflict,
  detectConflict,
  dirtyPaths,
  originOf,
  type AuthorityConflict,
  type RestrictedOrigin,
} from './authority.ts'
import { assess, ComplaintLedger, topicOf } from '../rotation/degradation.ts'
import { rotate, type RotationResult } from '../rotation/rotate.ts'

export type {
  ObserveOptions,
  RelayActivityEvent,
  RelayEvent,
  RelayMessageEvent,
  RelayRunEndEvent,
  RunReason,
} from './observe.ts'

export interface RelayParticipant {
  id: string
  rank: Rank
  session: AgentSession
  events: AgentEvent[]
  /** Compaction generation when this session joined. Degradation is measured against it. */
  baselineGeneration: number
  /**
   * Index into `events` at which the current session began.
   *
   * Rotation keeps the routing history and the event list, so without a cursor the
   * retired session's compaction events would be re-read every round and the replacement
   * would be judged degraded from the moment it started.
   */
  degradationCursor: number
}

/**
 * What a replacement must reproduce.
 *
 * Rotation without verification commands would be a transfer nobody demonstrated, which
 * is the thing §7a exists to prevent -- so leaving this unset does not disable the
 * *detection* of degradation, only the automatic response to it. A degraded implementer
 * with nothing to verify against escalates to the human instead.
 */
export interface RotationConfig {
  /** Commands the replacement must run and reproduce. Without these, no rotation. */
  checks: string[]
  /**
   * What mechanical degradation entitles the orchestrator to do. Default `'candidate'`.
   *
   * Two claims ride on this and they are not the same claim:
   *
   *   1. Conclave can execute a transactional rotation.
   *   2. Compaction predicts quality degradation strongly enough to act on unattended.
   *
   * The first is nearly answerable — one live run does it. The second needs a comparison
   * across sessions, because a session may compact without degrading and may degrade
   * before compacting. Until that comparison exists, compaction is a **rotation
   * candidate**: the run pauses and hands the decision to the human, who can call
   * `rotateImplementer()` and watch it happen.
   *
   * `'automatic'` is what the offline suite exercises and what a supervised operator may
   * opt into. It is not the default, because defaulting to it would encode claim 2 as
   * settled on the strength of evidence for claim 1.
   */
  onDegradation?: 'candidate' | 'automatic'
  /** Files whose exact content the transfer depends on, beyond those the advisor names. */
  files?: string[]
  checkTimeoutMs?: number
  /** TEST-ONLY. See `RotationDeps.hooks`; never set in production. */
  hooks?: { afterCapture?: () => Promise<void> }
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
  /**
   * Routing-log entries as they are recorded. Kept for callers that only want the log and
   * only want it pushed at them; `observe()` is the fuller surface, and carries the
   * participant activity this does not.
   */
  onLog?: (m: RelayMessage) => void
  /** Enables automatic rotation on mechanical degradation. See `RotationConfig`. */
  rotation?: RotationConfig
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
  /** Set by `RunHandle.requestPause()`; consumed at the next round boundary. */
  #pauseRequested: string | undefined
  #stream = new RelayEventStream()
  #ended = false

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
    const p: RelayParticipant = { id: spec.id, rank, session, events: [], baselineGeneration: 0, degradationCursor: 0 }
    this.#participants.set(spec.id, p)
    this.#attach(p)
    this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `${spec.id} joined as ${rank} (${spec.agent})` })
  }

  /**
   * Start forwarding one session's events.
   *
   * One consumer per session: the event queue delivers each event to exactly one reader.
   * This loop is that reader, and forwarding from here is what lets an observer see a turn
   * in progress -- the routing log says nothing between an instruction and the report that
   * answers it, which is the entire duration of the work.
   *
   * Separate from `#join` because rotation replaces a participant's session in place, and
   * the replacement needs its own reader. The loop closes over the session rather than
   * reading `p.session`, so the retired one's iteration ends with it rather than quietly
   * pushing the new session's events under the old reader.
   */
  #attach(p: RelayParticipant, session: AgentSession = p.session): void {
    void (async () => {
      for await (const e of session.events()) {
        if (p.session !== session) return
        p.events.push(e)
        this.#stream.emit({ type: 'activity', participant: p.id, rank: p.rank, event: e })
      }
    })()
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
    this.#stream.emit({ type: 'message', message: full })
    return full
  }

  /**
   * Follow the session as it happens: everything already emitted, then live, until the
   * run ends. Attach before `run()` or during it; a late subscriber is not short of
   * anything an early one had.
   *
   * One call is one subscription -- iterate the returned iterable once. Breaking out of
   * the loop detaches it.
   */
  observe(opts: ObserveOptions = {}): AsyncIterable<RelayEvent> {
    return this.#stream.observe(opts)
  }

  /**
   * Participant events that arrived after the run ended and were refused by the stream.
   * Expected during teardown -- a child can still be emitting -- and reported rather than
   * silently swallowed. They remain on the participant and in its transcript.
   */
  get droppedAfterEnd(): number {
    return this.#stream.droppedAfterClose
  }

  /** Terminal, and emitted exactly once however the run and `stop()` interleave. */
  #end(reason: RunReason, detail?: string): { reason: RunReason; detail?: string } {
    if (!this.#ended) {
      this.#ended = true
      this.#stream.emit({ type: 'run_end', reason, detail })
      this.#stream.close()
    }
    return detail === undefined ? { reason } : { reason, detail }
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
  /** Conflicts the human has already ruled on, so continuing does not re-raise them. */
  #adjudicated = new Set<string>()

  /**
   * Restricted human messages, and what can be traced to each. Only these can produce an
   * authority conflict: an instruction everyone saw cannot be reversed by someone who
   * could not see it.
   */
  readonly restrictedOrigins: RestrictedOrigin[] = []
  #treeAtOrigin: string[] | undefined

  say(text: string, audience: Audience = 'all', kind: MessageKind = 'constraint'): RelayMessage {
    const to = this.#resolve(audience)
    const m = this.#record({ from: 'human', fromRank: 'human', to, kind, text })
    if (m.visibility === 'restricted') {
      this.restrictedOrigins.push(originOf(m))
      // Snapshot the tree so paths appearing after this message can be attributed to it.
      this.#treeAtOrigin = dirtyPaths(this.#opts.cwd)
    }
    for (const id of to) {
      const queue = this.#pending.get(id) ?? []
      queue.push(envelope({ from: 'human', fromRank: 'human', kind, text }))
      this.#pending.set(id, queue)
    }
    return m
  }

  /**
   * Tell a participant that the human resolved a conflict in favour of proceeding.
   *
   * Human rank, because that is what it is: the human was shown both sides and chose. It
   * is deliberately NOT registered as a restricted origin — an adjudication is not work,
   * so nothing can later be detected as reversing it, and one conflict cannot breed
   * another.
   */
  #adjudicate(participantId: string, originSeq: number): void {
    const text =
      `I have seen both my earlier restricted instruction (#${originSeq}) and the advisor's ` +
      `instruction to reverse it, and I am allowing the advisor's instruction to proceed. ` +
      `This is my decision with both in view, not the advisor overriding me.`
    this.#record({ from: 'human', fromRank: 'human', to: [participantId], kind: 'constraint', text })
    const queue = this.#pending.get(participantId) ?? []
    queue.push(envelope({ from: 'human', fromRank: 'human', kind: 'constraint', text }))
    this.#pending.set(participantId, queue)
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
  /**
   * Attribute paths that appeared since a restricted message to that message.
   *
   * Coarse on purpose: it claims only that a path was not dirty when the aside was sent and
   * is now. That is enough to show the human *what* an advisor is proposing to undo, which
   * is what the adjudication needs, and it never asserts the implementer's intent.
   */
  #attributeArtifacts(): void {
    const origin = this.restrictedOrigins.at(-1)
    if (!origin || !this.#treeAtOrigin) return
    const before = new Set(this.#treeAtOrigin)
    for (const path of dirtyPaths(this.#opts.cwd)) {
      if (!before.has(path) && !origin.artifacts.includes(path)) origin.artifacts.push(path)
    }
  }

  /**
   * A point where a human is meant to decide.
   *
   * Attended and unattended runs differ here and nowhere else. `start()` suspends the loop
   * holding everything it had; `run()` has already committed to returning an outcome, so
   * the same point escalates and ends. Both record the same note, because the evidence for
   * the decision should not depend on who is watching.
   */
  async #halt(
    handle: RunHandle | undefined,
    p: { reason: PauseReason; detail: string; evidence: string[]; conflict?: AuthorityConflict },
  ): Promise<RunOutcome | undefined> {
    this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `paused (${p.reason}): ${p.detail}` })
    if (!handle) {
      return this.#end(
        'escalated',
        `${p.detail} Nobody is attending this run, so it ends here — use relay.start(goal) ` +
          `to pause at this point and decide instead.`,
      )
    }
    const decision = await handle.pauseAt({
      reason: p.reason,
      detail: p.detail,
      evidence: p.evidence,
      options: ['continue', 'rotate', 'constrain', 'abort'],
      ...(p.conflict === undefined ? {} : { conflict: p.conflict }),
      atSeq: this.#seq,
    })
    if (decision.kind === 'abort') return this.#end('stopped', decision.detail)
    this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `resumed from ${p.reason}` })
    return undefined
  }

  /**
   * Start a run you can hold onto.
   *
   * The supervised form. Pauses suspend the loop rather than ending it, so a rotation
   * candidate is a decision point rather than a dead end -- see `run.ts` for why restarting
   * `run()` is not the same as resuming.
   */
  start(goal: string): RunHandle {
    const handle = new RunHandle({
      rotate: (reason) => this.rotateImplementer(reason),
      constrain: (text, audience) => this.say(text, audience),
      requestStop: () => {
        this.#stopped = true
      },
      requestPause: (reason) => {
        this.#pauseRequested = reason
      },
    })
    void this.#loop(goal, handle).then(
      (outcome) => handle.settle(outcome),
      (err: Error) => handle.settle(this.#end('escalated', `the run threw: ${err.message}`)),
    )
    return handle
  }

  /**
   * Should this implementer be replaced?
   *
   * Called every round, because a session may compact without saying so and a session
   * that says so may not have. Returns a run-ending verdict when the answer needs a human,
   * and `undefined` when the run should carry on -- either because nothing is wrong or
   * because the rotation succeeded and there is now a fresh implementer to carry on with.
   */
  async #considerRotation(
    impl: RelayParticipant,
    prose: string,
    handle: RunHandle | undefined,
  ): Promise<RunOutcome | undefined> {
    const snap = await impl.session.snapshot()
    const verdict = assess({
      participant: impl.id,
      prose,
      baselineGeneration: impl.baselineGeneration,
      currentGeneration: snap.compactionGeneration,
      events: impl.events.slice(impl.degradationCursor),
      ledger: this.complaints,
      at: Date.now(),
    })

    if (verdict.decision === 'continue') {
      if (verdict.reason === 'unbacked') {
        // Overriding a complaint is a decision, so it is recorded as one. The count is
        // scoped and decays; a single early complaint must not read as a pattern.
        this.#record({
          from: 'orchestrator',
          fromRank: 'human',
          to: [],
          kind: 'note',
          text:
            `${impl.id} asked for a fresh session with no compaction behind it; continuing. ` +
            `unbacked complaints on this topic: ${this.complaints.count(impl.id, topicOf(prose))}`,
        })
      }
      return undefined
    }

    const detail = `${impl.id} is degraded: ${verdict.evidence.join('; ')}${verdict.complained ? ' (and said so)' : ' (and did not say so)'}`
    if (!this.#opts.rotation) {
      // Detection does not depend on configuration; the response does. Rotating with
      // nothing to verify against would be a transfer nobody demonstrated, so this goes to
      // the human instead of proceeding on an unverifiable handoff.
      return this.#end('escalated', `${detail}. No rotation checks are configured, so this needs a human.`)
    }
    if ((this.#opts.rotation.onDegradation ?? 'candidate') === 'candidate') {
      // A candidate, not a verdict. The mechanism is built and the policy is not earned:
      // nothing yet shows that compaction and degradation coincide, so acting on it
      // unattended would be inferring quality from a proxy that has never been checked
      // against quality. An attended run stops here and asks; an unattended one ends.
      const halted = await this.#halt(handle, {
        reason: 'rotation_candidate',
        detail: `${detail}. Recorded as a rotation candidate, not acted on.`,
        evidence: verdict.evidence,
      })
      return halted ?? this.#acknowledge(impl, snap.compactionGeneration)
    }

    const result = await this.rotateImplementer(detail)
    if (result.status === 'rotated') return undefined
    const halted = await this.#halt(handle, {
      reason: 'rotation_candidate',
      detail: `rotation failed (${result.reason}): ${result.detail}`,
      evidence: [...verdict.evidence, 'the original implementer is back in service'],
    })
    return halted ?? this.#acknowledge(impl, (await impl.session.snapshot()).compactionGeneration)
  }

  /**
   * The human saw this evidence and chose to carry on. Stop re-raising it.
   *
   * Without this, declining a candidate pauses again on the very next round, on the same
   * compaction, forever -- the operator either abandons the feature or stops reading the
   * pauses, and the second is worse. Moving the baseline means a *later* compaction is new
   * evidence and does pause again, which is the distinction that makes the signal worth
   * surfacing at all.
   *
   * Found by three tests hanging rather than by design.
   */
  #acknowledge(impl: RelayParticipant, generation: number): undefined {
    impl.baselineGeneration = generation
    impl.degradationCursor = impl.events.length
    this.#record({
      from: 'orchestrator',
      fromRank: 'human',
      to: [],
      kind: 'note',
      text: `rotation candidate declined at compaction generation ${generation}; a later compaction will raise it again`,
    })
    return undefined
  }

  /**
   * Run to completion without a supervisor.
   *
   * Kept as it was: every pause point is terminal for this form, because a call that has
   * already committed to returning an outcome has nowhere to suspend to. `start()` is the
   * attended form, and the difference is deliberate rather than incidental.
   */
  async run(goal: string): Promise<RunOutcome> {
    return this.#loop(goal, undefined)
  }

  async #loop(goal: string, handle: RunHandle | undefined): Promise<RunOutcome> {
    const lead = this.participants.find((p) => p.rank === 'advisor')!
    const impl = this.participants.find((p) => p.rank === 'implementer')!

    this.#record({ from: 'human', fromRank: 'human', to: [lead.id, impl.id], kind: 'goal', text: goal })

    await this.#exchange(impl, `${IMPLEMENTER_BRIEFING}\n\nThe goal for this session:\n\n${goal}\n\nAcknowledge briefly; do not start work yet.`)
    let next = await this.#exchange(lead, `${LEAD_BRIEFING}\n\nThe goal for this session:\n\n${goal}\n\nGive the implementer its first instruction.`)

    const maxRounds = this.#opts.maxRounds ?? 6
    for (let round = 1; round <= maxRounds; round++) {
      if (this.#stopped) return this.#end('stopped')

      if (this.#pauseRequested) {
        const reason = this.#pauseRequested
        this.#pauseRequested = undefined
        const halted = await this.#halt(handle, {
          reason: 'operator_requested',
          detail: reason,
          evidence: [`round ${round} of ${maxRounds}; no turn is in flight`],
        })
        if (halted) return halted
      }

      const instruction = next.prose.trim()
      if (/^DONE\b/i.test(instruction)) {
        // §7a, first paragraph: "The advisor can end the session; the human outranks that
        // and can send them back to work." Returning here regardless let the advisor
        // terminate an outstanding human instruction out of existence -- the human message
        // is queued for the next exchange, and if the advisor ends the session there is no
        // next exchange. That inverts the rank order the whole design rests on.
        //
        // Found by the first live pause run: the drift probe was injected at the pause and
        // never delivered, because the advisor considered the task finished.
        const outstanding = this.participants.filter((p) => (this.#pending.get(p.id) ?? []).length > 0)
        if (outstanding.length > 0) {
          this.#record({
            from: 'orchestrator',
            fromRank: 'human',
            to: [],
            kind: 'note',
            text:
              `advisor reported the work complete, but the human has an outstanding instruction for ` +
              `${outstanding.map((p) => p.id).join(', ')} — the human outranks the advisor, so the ` +
              `session continues rather than ending`,
          })
          if ((this.#pending.get(impl.id) ?? []).length > 0) {
            const extra = await this.#exchange(impl, this.#drain(impl.id))
            this.#record({ from: impl.id, fromRank: 'implementer', to: [lead.id], kind: 'report', text: extra.prose })
            next = await this.#exchange(
              lead,
              [this.#drain(lead.id), envelope({ from: impl.id, fromRank: 'implementer', kind: 'report', text: extra.prose })]
                .filter(Boolean)
                .join('\n\n'),
            )
          } else {
            next = await this.#exchange(lead, this.#drain(lead.id))
          }
          // Bounded by the round budget like everything else, so a human who keeps talking
          // extends the session rather than making it unstoppable.
          continue
        }
        this.#record({ from: lead.id, fromRank: 'advisor', to: [], kind: 'note', text: `advisor reports the work complete: ${instruction}` })
        return this.#end('done', instruction)
      }
      if (/^ESCALATE\b/i.test(instruction)) {
        this.#record({ from: lead.id, fromRank: 'advisor', to: [], kind: 'note', text: instruction })
        const halted = await this.#halt(handle, {
          reason: 'advisor_escalated',
          detail: instruction,
          evidence: [`the advisor asked for a human rather than issuing an instruction`],
        })
        if (halted) return halted
        // Resumed. The advisor said its piece and the human decided otherwise, so it is
        // asked again rather than having its escalation replayed as an instruction.
        next = await this.#exchange(lead, this.#drain(lead.id) || 'The human has seen your escalation and asked you to continue. Give the implementer its next instruction.')
        continue
      }

      // BEFORE delivery, not after. The point of the pause is that the human adjudicates
      // while the instruction is still a proposal.
      const conflict = detectConflict(instruction, this.restrictedOrigins)
      if (conflict && !this.#adjudicated.has(`${conflict.origin.seq}:${instruction}`)) {
        this.#adjudicated.add(`${conflict.origin.seq}:${instruction}`)
        const halted = await this.#halt(handle, {
          reason: 'authority_conflict',
          detail:
            `the advisor's instruction would reverse work traceable to your restricted ` +
            `message #${conflict.origin.seq} (matched: ${conflict.matched.join(', ')})`,
          evidence: describeConflict(conflict).split('\n'),
          conflict,
        })
        if (halted) return halted
        // Resumed: the human saw both sides and let it through. That decision has to REACH
        // the implementer, or the pause buys a delay and nothing else.
        //
        // Found live. Adjudicated, delivered, and the implementer still declined --
        // correctly, on the standing rule it was given: "proceed unless a human overrules",
        // and a human had already overruled by asking for the file. Its words:
        //
        //   > What I won't do is delete it while the conflict is unacknowledged.
        //   > [...] You tell me the human's instruction was already accounted for and
        //   > you're overriding it deliberately with that knowledge -- I'll comply.
        //
        // It named the missing message. Continuing past the conflict IS the human
        // accounting for it; the implementer simply had no way to know.
        this.#adjudicate(impl.id, conflict.origin.seq)
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
      this.#attributeArtifacts()

      // A turn that did not complete is the human's call, not the advisor's. Escalating
      // here rather than relaying the partial prose keeps the advisor from steering on a
      // report that never finished being written.
      if (report.end.verdict.outcome !== 'completed') {
        const halted = await this.#halt(handle, {
          reason: 'turn_incomplete',
          detail: `${impl.id} turn ended ${formatVerdict(report.end.verdict)}`,
          evidence: report.end.verdict.provenance.map((p) => `${p.source}: ${p.detail}`),
        })
        if (halted) return halted
      }

      // §7a. Assessed before the advisor sees the report, so a degraded implementer is
      // replaced rather than issued another instruction it cannot act on well.
      const rotated = await this.#considerRotation(impl, report.prose, handle)
      if (rotated) return rotated

      const leadAside = this.#drain(lead.id)
      next = await this.#exchange(
        lead,
        [leadAside, envelope({ from: impl.id, fromRank: 'implementer', kind: 'report', text: report.prose })]
          .filter(Boolean)
          .join('\n\n'),
      )
    }
    return this.#end('budget')
  }

  /** Unbacked complaints, per participant per topic. Feeds stall detection (§7). */
  readonly complaints = new ComplaintLedger()

  /**
   * Replace the implementer, carrying the work forward.
   *
   * The transaction lives in `rotation/rotate.ts`; this supplies the four things it cannot
   * get for itself: how to talk to a session, how to start a fresh implementer, which
   * human constraints to replay, and where to write the notes.
   *
   * Callable by the human as well as by the run loop. Nothing about it assumes the loop is
   * running -- an operator watching a session degrade should not have to wait for the
   * orchestrator to notice.
   */
  async rotateImplementer(reason: string): Promise<RotationResult> {
    const cfg = this.#opts.rotation
    if (!cfg) {
      throw new Error(
        'rotation needs verification commands: set `rotation.checks` so a replacement has ' +
          'something to reproduce. Rotating without them would be a transfer nobody demonstrated.',
      )
    }
    const advisor = this.participants.find((p) => p.rank === 'advisor')!
    const impl = this.participants.find((p) => p.rank === 'implementer')!
    const spec = this.#opts.implementer
    /** The replacement while it is proving itself, before it is anyone's session. */
    let audition: RelayParticipant | undefined

    this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `rotating ${impl.id}: ${reason}` })

    const result = await rotate({
      old: impl.session,
      advisor: advisor.session,
      reason,
      deps: {
        root: this.#opts.cwd,
        exchange: async (session, text) => {
          // The replacement is not in the participant map yet -- it is being auditioned --
          // but it gets the same exchange as everyone else. A second path here would be a
          // second set of failure modes on the least-tested code in the system.
          const p = [...this.participants, audition].find((q) => q?.session === session)
          if (!p) throw new Error('exchange requested for a session the relay does not hold')
          return (await this.#exchange(p, text)).prose
        },
        startReplacement: async () => {
          const session = await this.#opts.registry.createParticipant(spec, {
            cwd: this.#opts.cwd,
            watchdogMs: this.#opts.turnWatchdogMs,
          })
          audition = { id: `${spec.id}~replacement`, rank: 'implementer', session, events: [], baselineGeneration: 0, degradationCursor: 0 }
          this.#attach(audition)
          return session
        },
        checks: cfg.checks,
        ...(cfg.files === undefined ? {} : { files: cfg.files }),
        ...(cfg.checkTimeoutMs === undefined ? {} : { checkTimeoutMs: cfg.checkTimeoutMs }),
        ...(cfg.hooks === undefined ? {} : { hooks: cfg.hooks }),
        // Human messages only. Advisor instructions are the old session's history and
        // belong in the handoff narrative; constraints outrank it and are replayed intact.
        constraints: this.log.filter((m) => m.fromRank === 'human' && m.kind === 'constraint' && m.to.includes(impl.id)),
        note: (text) => {
          this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text })
        },
      },
    })

    if (result.status === 'rotated' && audition) {
      // Swap the session in place, so the participant id, rank and routing history survive
      // the replacement. A rotation that changed the implementer's id would break every
      // reference to it in the log that already exists.
      //
      // The audition's reader is kept rather than restarted: it is already the single
      // consumer of that session's queue, and attaching a second one would split the
      // stream. Retargeting it means giving it the promoted identity and the one events
      // array both objects now share -- the old session's reader retires itself on its
      // next event, because `#attach` checks that it still owns `p.session`.
      audition.events.unshift(...impl.events)
      audition.id = impl.id
      impl.session = result.replacement
      impl.events = audition.events
      impl.baselineGeneration = 0
      impl.degradationCursor = impl.events.length
      this.complaints.progressed(impl.id)
      this.#record({ from: 'orchestrator', fromRank: 'human', to: [], kind: 'note', text: `${impl.id} rotated into ${result.replacement.sessionId}` })
    } else if (result.status === 'rolled_back') {
      this.#record({
        from: 'orchestrator',
        fromRank: 'human',
        to: [],
        kind: 'note',
        text: `rotation rolled back (${result.reason}): ${result.detail}. ${impl.id} is back in service.`,
      })
    }
    return result
  }

  async stop(): Promise<void> {
    this.#stopped = true
    // A run that already ended keeps the reason it ended for; teardown is not a second
    // outcome. Only a relay stopped without ever finishing a run reports 'stopped'.
    this.#end('stopped')
    for (const p of this.participants) await p.session.close('graceful')
    release(this.#opts.cwd)
  }
}
