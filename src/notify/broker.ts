/**
 * Ask a human, or tell them, and record which happened.
 *
 * Two verbs, and the difference is whether anything waits:
 *
 *   - `tell` is one-way. A transport that is down drops the message and the run does not care.
 *   - `ask` waits for an answer, and a transport that is down is REPORTED rather than thrown --
 *     because the question is still answerable at the console, over mosh, or by the operating
 *     agent. The channel is an extra door, never a lock.
 *
 * That rule outranks the rest of this file. A notification layer that can stop a run is worse
 * than no notification layer, and it fails in the direction nobody tests.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DecisionRecord, Identity, Inbound, Outbound, Transport } from './types.ts'

export const DECISIONS_RELATIVE = '.conclave/decisions.ndjson'

export function decisionsPath(repoRoot: string): string {
  return join(repoRoot, DECISIONS_RELATIVE)
}

/**
 * The keys an adapter may ever see.
 *
 * Keeps the payload predictable: an adapter formats these and nothing else, so adding a field
 * is a decision made here rather than a thing one transport starts doing. A caller that builds
 * a richer object finds the extra keys simply do not travel.
 *
 * NOT a privacy boundary, and worth saying so plainly because an earlier draft of this file
 * claimed it was. `headline` is free text written by the operating agent: prose is the message,
 * and any surface that displays it has read it. What the shape does is keep a notification from
 * accidentally carrying a patch -- useful, incidental, and not a guarantee about anything.
 */
const ALLOWED = new Set(['kind', 'headline', 'options', 'href', 'runId'])

/** Strip anything not on the allow-list, and hold the headline to what the surface can show. */
export function forTransport(m: Outbound, limits: { maxChars: number }): Outbound {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(m)) if (ALLOWED.has(k) && v !== undefined) out[k] = v
  const headline = String(out['headline'] ?? '')
  // Truncated rather than refused: a surface that cannot show the whole line should still show
  // the line. The evidence was never in here anyway -- `href` is what carries the rest.
  if (headline.length > limits.maxChars) out['headline'] = `${headline.slice(0, limits.maxChars - 1)}…`
  return out as unknown as Outbound
}

export class Broker {
  readonly #root: string
  readonly #operator: 'agent' | 'human'
  /**
   * How long one `tell` holds the channel, when a human is operating.
   *
   * A budget for the CHANNEL, not for the episode -- the shape `sessionRecord` already uses for
   * its write-failure warnings, so a run producing a hundred of something produces one line a
   * minute rather than a hundred.
   */
  static readonly HUMAN_TELL_EVERY_MS = 60_000

  /**
   * `operator` decides whether there is a budget at all, and the asymmetry is the point.
   *
   * With an AGENT operating, the operating agent is already the rate limiter and has the context
   * to be a good one: it decides what is worth a human's attention. A budget behind that would
   * be a filter behind a filter, and would make the outer one unpredictable -- a message the
   * operating agent judged worth sending would vanish for reasons it cannot see.
   *
   * With a HUMAN operating there is no filter, and this is the mode where a HUD floods.
   * Conclave knows which it has because `--operator agent|human` is explicit; #27 chose explicit
   * over detection on the grounds that detection here would be guessing.
   */
  constructor(repoRoot: string, opts: { operator?: 'agent' | 'human' } = {}) {
    this.#root = repoRoot
    this.#operator = opts.operator ?? 'agent'
  }

  /** The last delivered `tell`, for the budget. Read from the record so it survives a process. */
  #lastTellAt(): number | undefined {
    for (const d of [...this.decisions()].reverse()) {
      if (d.answer === undefined && d.undelivered === undefined) return d.at
    }
    return undefined
  }

  #record(r: DecisionRecord): void {
    const p = decisionsPath(this.#root)
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, `${JSON.stringify(r)}\n`)
  }

  /** Every decision recorded, oldest first. */
  decisions(): DecisionRecord[] {
    const p = decisionsPath(this.#root)
    if (!existsSync(p)) return []
    const out: DecisionRecord[] = []
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue
      // A corrupt line is skipped, not thrown on. This log is appended to by a process that can
      // be killed mid-write, and a reader that dies on a torn last line would lose every
      // decision before it -- which is the opposite of what a record is for.
      try {
        out.push(JSON.parse(line) as DecisionRecord)
      } catch {
        continue
      }
    }
    return out
  }

  /**
   * Take any late answers and attach each to the decision it vetoes.
   *
   * A `decided` message offers an override and does not wait for one. The tap therefore lands
   * after `tell` has returned, and this is where it is collected -- against the most recent
   * decision that offered options and has not been answered, oldest first, because a human
   * answering two outstanding vetoes answers them in the order they were shown.
   *
   * Returns what it attached, so a caller can act on it. The record is updated by APPENDING a
   * second line for the same decision rather than rewriting the first: an append-only log that
   * edited its own history could not be trusted about anything else in it, and "this was
   * decided, then vetoed" is the sequence worth keeping.
   */
  async collectVetoes(transport: Transport): Promise<{ headline: string; option?: string; text?: string }[]> {
    if (!transport.poll) return []
    let replies: Inbound[]
    try {
      replies = await transport.poll()
    } catch {
      // A transport that cannot be polled has nothing to say. Never fatal: this runs on a
      // caller's ordinary path and must not be able to stop it.
      return []
    }
    if (replies.length === 0) return []

    const open = this.decisions().filter((d) => d.offered !== undefined && d.answer === undefined && d.undelivered === undefined)
    const attached: { headline: string; option?: string; text?: string }[] = []
    for (const [i, reply] of replies.entries()) {
      const target = open[i]
      if (!target) break
      // An option that was never offered is refused here as it is in `ask`: a surface that
      // invents one would otherwise widen the choice the caller enumerated.
      if (reply.option !== undefined && !target.offered?.includes(reply.option)) continue
      this.#record({
        at: Date.now(),
        transport: transport.name,
        kind: target.kind,
        headline: target.headline,
        ...(target.runId ? { runId: target.runId } : {}),
        ...(target.offered ? { offered: target.offered } : {}),
        answer: {
          ...(reply.option === undefined ? {} : { option: reply.option }),
          ...(reply.text === undefined ? {} : { text: reply.text }),
          by: reply.from,
        },
      })
      attached.push({
        headline: target.headline,
        ...(reply.option === undefined ? {} : { option: reply.option }),
        ...(reply.text === undefined ? {} : { text: reply.text }),
      })
    }
    return attached
  }

  /** One-way. Never throws, never waits: a dropped notification is recorded and forgotten. */
  async tell(m: Outbound, transport: Transport): Promise<void> {
    // `offered` is recorded for a `tell` as well as an `ask`. A `decided` message carries the
    // override the human was given, and a record that dropped it could not later answer "were
    // they offered the chance to stop this?" -- which is the only interesting question about a
    // decision somebody did not veto.
    const offered = m.options?.map((o) => o.id)
    const base = {
      at: Date.now(),
      transport: transport.name,
      kind: m.kind,
      headline: m.headline,
      ...(m.href ? { href: m.href } : {}),
      ...(offered ? { offered } : {}),
    }
    // Budgeted only for a human operator, and never for a question -- `ask` is someone waiting
    // on an answer, and dropping it would hang the caller rather than quieten the channel.
    if (this.#operator === 'human') {
      const last = this.#lastTellAt()
      if (last !== undefined && Date.now() - last < Broker.HUMAN_TELL_EVERY_MS) {
        // Recorded, not silently dropped. A message the budget swallowed is still something the
        // operator asked to be sent, and a channel that quietly ate it would be indistinguishable
        // from one that was not working.
        this.#record({ ...base, ...(m.runId ? { runId: m.runId } : {}), undelivered: 'budgeted' })
        return
      }
    }
    try {
      await transport.send(forTransport(m, transport.limits))
      this.#record({ ...base, ...(m.runId ? { runId: m.runId } : {}) })
    } catch (err) {
      this.#record({
        ...base,
        ...(m.runId ? { runId: m.runId } : {}),
        undelivered: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Ask, and wait for the answer.
   *
   * Returns `undefined` when the transport could not carry the question or could not receive --
   * NOT an exception, because the caller's fallback is to ask the way it always could. The
   * record says the question was never delivered, so a later reader can tell "nobody answered"
   * from "nobody was asked".
   */
  async ask(m: Outbound, transport: Transport): Promise<{ option?: string; text?: string; by: Identity } | undefined> {
    const offered = m.options?.map((o) => o.id)
    const base = {
      at: Date.now(),
      transport: transport.name,
      kind: m.kind,
      headline: m.headline,
      ...(m.runId ? { runId: m.runId } : {}),
      ...(m.href ? { href: m.href } : {}),
      ...(offered ? { offered } : {}),
    }
    if (!transport.limits.canReceive || !transport.receive) {
      this.#record({ ...base, undelivered: `${transport.name} cannot receive` })
      return undefined
    }
    let reply: Inbound
    try {
      const sent = await transport.send(forTransport(m, transport.limits))
      reply = await transport.receive(sent.id)
    } catch (err) {
      this.#record({ ...base, undelivered: err instanceof Error ? err.message : String(err) })
      return undefined
    }
    // An option that was never offered is refused rather than passed through. A transport that
    // invents one is malfunctioning, and accepting it would let a surface widen the choice the
    // caller enumerated.
    if (reply.option !== undefined && !offered?.includes(reply.option)) {
      this.#record({ ...base, undelivered: `answered with an option that was not offered: ${reply.option}` })
      return undefined
    }
    const answer = {
      ...(reply.option === undefined ? {} : { option: reply.option }),
      ...(reply.text === undefined ? {} : { text: reply.text }),
      by: reply.from,
    }
    this.#record({ ...base, answer })
    return answer
  }
}
