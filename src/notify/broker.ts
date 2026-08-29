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
 * Enforced at the boundary rather than trusted: a field that is not on this list cannot reach a
 * transport even if a caller builds one, so no adapter leaks a diff by being helpful.
 *
 * ## What this does NOT guarantee, stated because it would be easy to overclaim
 *
 * `headline` is free text and its author is the OPERATING AGENT, not conclave. So this stops
 * structured leakage -- there is no field for a diff, a file body or tool output -- and it does
 * not stop a caller that puts a secret into a sentence. The length cap makes bulk leakage
 * impractical rather than impossible: a 20-character HUD line cannot carry a file, and 200
 * characters cannot carry a diff worth having.
 *
 * "The vendor never sees code" is therefore a property of the SHAPE plus a discipline about the
 * headline, not a property of the type alone. A stronger version -- conclave composing every
 * headline from record fields -- is possible and is not what this is.
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
  constructor(repoRoot: string) {
    this.#root = repoRoot
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
