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
import type { DecisionRecord, Identity, Inbound, Outbound, Transport, TransportLimits } from './types.ts'

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

/**
 * Strip anything not on the allow-list, and hold the headline to what the surface can show.
 *
 * A surface that cannot present a choice gets the labels folded into the headline --
 * `Merge? — Yes / No` -- so the operator can read what is on offer (#292). The structured
 * options still travel: an answer is routed by them, and the broker resolves a label said
 * back against them. The question comes first and is kept whole whenever it fits; only the
 * choices are cut to the room that remains, because a question with its choices cut is still
 * a question and choices with their question cut are not.
 */
// Both facts are REQUIRED, not defaulted: a caller that forgot to say whether the surface can
// show a choice would otherwise get a line with the choices silently left off, which is the
// exact failure this exists to end.
export function forTransport(m: Outbound, limits: Pick<TransportLimits, 'maxChars' | 'canPresentOptions'>): Outbound {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(m)) if (ALLOWED.has(k) && v !== undefined) out[k] = v
  const headline = String(out['headline'] ?? '')
  // Truncated rather than refused: a surface that cannot show the whole line should still show
  // the line. The evidence was never in here anyway -- `href` is what carries the rest.
  if (headline.length >= limits.maxChars) {
    if (headline.length > limits.maxChars) out['headline'] = `${headline.slice(0, limits.maxChars - 1)}…`
    return out as unknown as Outbound
  }
  const options = limits.canPresentOptions === false ? m.options ?? [] : []
  if (options.length === 0) return out as unknown as Outbound
  const shown = `${headline} — ${options.map((o) => o.label).join(' / ')}`
  out['headline'] = shown.length > limits.maxChars ? `${shown.slice(0, limits.maxChars - 1)}…` : shown
  return out as unknown as Outbound
}

/**
 * The one offered option whose label is this text, or nothing.
 *
 * Strict on purpose, because this is the only place prose becomes an action (#292). The whole
 * label and nothing more -- "merge it" is not `Merge`, and neither is "merge, then deploy" --
 * trimmed and compared case-insensitively, because a surface that cannot render a choice
 * leaves the operator to type or say the label, and neither reliably preserves case or
 * whitespace. Two options shown as the same label are refused rather than guessed between: a
 * caller that offered them made the text ambiguous, and the text stays a message.
 *
 * AND TERMINAL PUNCTUATION GOES THE SAME WAY, for the same reason. Measured on the glasses,
 * which take voice and nothing else: `Yes` offered, "Yes." recorded, no match -- a full stop
 * is neither whitespace nor case, so the rule could essentially never fire on the one surface
 * it was written for. Dictation ends a sentence; the operator did not choose to. That is an
 * artefact of the channel exactly as case and whitespace are, and normalising it is not a
 * step towards guessing.
 *
 * The line is still the same line: only a trailing run of `.`, `!`, `?` and `,` is cut, and
 * only from the end. "Yes, go ahead" keeps its comma because the words after it are the
 * operator's own, and it stays a message. Nothing here forgives a prefix, an initial, a
 * synonym or a word the operator did not say.
 */
const TERMINAL = /[.!?,]+$/

export function resolveLabel(text: string, options: { id: string; label: string }[]): string | undefined {
  const said = text.trim().toLowerCase().replace(TERMINAL, '').trim()
  if (said === '') return undefined
  const hits = options.filter((o) => o.label.trim().toLowerCase().replace(TERMINAL, '').trim() === said)
  return hits.length === 1 ? hits[0]!.id : undefined
}

/**
 * The answer as the record and the caller see it: a tap's id alone, a message's text alone, or
 * -- when `text` is exactly an offered label -- the resolved id WITH the text kept beside it,
 * so a reader can tell a match from a tap.
 */
function resolveAnswer(
  reply: Inbound,
  options: { id: string; label: string }[] | undefined,
): { option?: string; text?: string; by: Identity } {
  const matched = reply.option === undefined && reply.text !== undefined && options ? resolveLabel(reply.text, options) : undefined
  return {
    ...(reply.option !== undefined ? { option: reply.option } : matched !== undefined ? { option: matched } : {}),
    ...(reply.text === undefined ? {} : { text: reply.text }),
    by: reply.from,
  }
}

/** `offered` and `labels` for a record, from the options a message carried. */
function offeredOf(m: Outbound): { offered?: string[]; labels?: Record<string, string> } {
  if (!m.options) return {}
  return { offered: m.options.map((o) => o.id), labels: Object.fromEntries(m.options.map((o) => [o.id, o.label])) }
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
      // Text that is exactly an offered label is that option, resolved against what the RECORD
      // says was shown -- this runs in a process that never saw the `tell`, so the record is
      // the only witness to the labels (#292). Older records carry no labels, and their text
      // stays text.
      const options = target.offered?.map((id) => ({ id, label: target.labels?.[id] ?? '' })).filter((o) => o.label !== '')
      const answer = resolveAnswer(reply, options)
      this.#record({
        at: Date.now(),
        transport: transport.name,
        kind: target.kind,
        headline: target.headline,
        ...(target.runId ? { runId: target.runId } : {}),
        ...(target.offered ? { offered: target.offered } : {}),
        ...(target.labels ? { labels: target.labels } : {}),
        answer,
      })
      const { by: _by, ...said } = answer
      attached.push({ headline: target.headline, ...said })
    }
    return attached
  }

  /** One-way. Never throws, never waits: a dropped notification is recorded and forgotten. */
  async tell(m: Outbound, transport: Transport): Promise<void> {
    // `offered` is recorded for a `tell` as well as an `ask`. A `decided` message carries the
    // override the human was given, and a record that dropped it could not later answer "were
    // they offered the chance to stop this?" -- which is the only interesting question about a
    // decision somebody did not veto.
    const base = {
      at: Date.now(),
      transport: transport.name,
      kind: m.kind,
      headline: m.headline,
      ...(m.href ? { href: m.href } : {}),
      ...offeredOf(m),
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
    const base = {
      at: Date.now(),
      transport: transport.name,
      kind: m.kind,
      headline: m.headline,
      ...(m.runId ? { runId: m.runId } : {}),
      ...(m.href ? { href: m.href } : {}),
      ...offeredOf(m),
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
    if (reply.option !== undefined && !base.offered?.includes(reply.option)) {
      this.#record({ ...base, undelivered: `answered with an option that was not offered: ${reply.option}` })
      return undefined
    }
    // Text that is exactly an offered label is that option, and the text is kept beside the id
    // (#292). Anything else is a message for the caller to read.
    const answer = resolveAnswer(reply, m.options)
    this.#record({ ...base, answer })
    return answer
  }
}
