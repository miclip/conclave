/**
 * OpenCode's event vocabulary, mapped onto conclave's.
 *
 * SEPARATE FROM THE ADAPTER on purpose. The mapping is where a wire format meets a contract, and
 * it is the part most likely to be wrong in ways nothing notices: an event misread as a turn
 * boundary ends an exchange early, and one misread as child output holds a silence clock open on
 * a seat that has stopped. Both fail silently, which is the argument for testing the translation
 * on its own rather than through a running adapter.
 *
 * WHAT IS MAPPED IS WHAT WAS OBSERVED. A live server, one prompt, one turn (#217) produced
 * exactly: `server.connected`, `session.updated`, `message.updated`, `message.part.updated`,
 * `message.part.delta`, `session.status`, `session.diff`, `plugin.added`, `catalog.updated`,
 * `reference.updated`, `integration.updated`, `server.heartbeat`, `session.idle`.
 *
 * `session.error` was added later, from a SECOND capture: a turn asking for a disabled model
 * (#224). It fired where the first recording had no reason to, which is the argument for this
 * comment being a log of what has been seen rather than a claim about what exists.
 *
 * Names appear in the bundle that did NOT fire for that turn -- `session.execution.*`,
 * `session.reasoning.*`, `session.tool.*` -- because it used no tools and produced no reasoning
 * parts. They are deliberately NOT mapped here. Reading a name as a behaviour is the mistake
 * this project already made once on this agent, and an unfired event is a guess about a payload
 * shape nobody has seen.
 */

import type { AgentEvent } from '../../contract/session.ts'
import type { ServerEvent } from './sse.ts'

/** What the translator needs from the adapter to place an event in a run. */
export interface TranslationContext {
  /** The session this seat owns. Events for any other are not ours. */
  sessionId: string
  /** The turn in flight, if one is. */
  openTurnKey?: string | undefined
  next: () => number
  now: () => number
}

/**
 * Which session an event is about, or `undefined` when it does not say.
 *
 * ONE SERVER CAN HOLD MANY SESSIONS and sends all of their events down one `/event` stream, so
 * an adapter that ignored this would attribute another seat's turn to its own. Server-scoped
 * events -- `server.connected`, `server.heartbeat` -- name no session and are not session
 * events; they are about the transport.
 */
export function sessionOf(e: ServerEvent): string | undefined {
  const p = e.properties ?? {}
  for (const key of ['sessionID', 'sessionId', 'session_id']) {
    const v = p[key]
    if (typeof v === 'string') return v
  }
  const info = p['info']
  if (typeof info === 'object' && info !== null) {
    const id = (info as Record<string, unknown>)['id']
    const sid = (info as Record<string, unknown>)['sessionID']
    if (typeof sid === 'string') return sid
    if (typeof id === 'string') return id
  }
  return undefined
}

/** Whether this event says the transport is alive, independent of any turn. */
export function isTransportLiveness(e: ServerEvent): boolean {
  return e.type === 'server.heartbeat' || e.type === 'server.connected'
}

/**
 * Whether this event is a seat that is still WORKING, as opposed to one worth showing a reader.
 *
 * Two questions that were being answered by one predicate (#226). `translate` returns an event
 * only for `message.part.delta`, and the silence clock was refreshed only where it returned one
 * -- so a turn whose work is tool calls refreshed nothing. Captured on a tool-using turn: ten
 * `message.part.updated`, one `message.part.delta`. A seat spending twelve minutes inside a
 * single long tool call -- `npm test` on this repo is exactly that, and it is what runs are told
 * to use -- had no way to say it was alive, and `DEFAULT_IDLE_MS` would reach it.
 *
 * "Is this seat alive" is true of a tool call; "is this worth rendering" is not. Narration stays
 * as narrow as it was, because #219 is the bill for it being wider.
 *
 * DELIBERATELY NOT the whole session-scoped set. `session.idle` is an ending rather than work,
 * and the server-scoped events are the transport talking rather than the seat -- a heartbeat
 * keeping a wedged seat's clock alive is the exact failure the silence clock exists to catch.
 */
const SEAT_LIVENESS = new Set([
  // A part arriving: text, reasoning, or a tool call and its result. The one that matters.
  'message.part.updated',
  // A message beginning or being revised.
  'message.updated',
  // The server's own account of the session working, carrying `{status: {type: 'busy'}}`.
  'session.status',
  // The seat changed files, which is work by any reading.
  'session.diff',
])

export function isSeatLiveness(e: ServerEvent): boolean {
  return SEAT_LIVENESS.has(e.type)
}

/**
 * Whether this event means the seat finished the turn it was given.
 *
 * `session.idle` is the one observed terminal signal: it arrived once, last, after the deltas.
 * It says the SESSION is idle rather than "this turn succeeded", which is why the adapter
 * grades the outcome from what it saw rather than treating this as a verdict.
 */
export function isTurnBoundary(e: ServerEvent): boolean {
  return e.type === 'session.idle'
}

/**
 * The failure this event reports, as a line worth putting in a verdict -- or `undefined`.
 *
 * `session.error` is emitted when the turn could not be done, and the server follows it with
 * `session.idle` like any other ending. That ordering is the whole hazard (#224): an adapter
 * that reads only the boundary sees a session go idle having produced nothing and calls the turn
 * `completed`, with `proven` confidence, on a 401.
 *
 * Observed payload, opencode 1.18.27, asking for a model the account has disabled:
 *
 *     session.error {"error":{"name":"APIError","data":{"message":"Model is disabled",
 *                    "statusCode":401,"isRetryable":false}}}
 *     session.idle
 *
 * The shape is read defensively because only that one error has been seen: any of the three
 * fields may be missing on a failure of a different kind, and a translator that threw or
 * returned nothing when a field was absent would restore the silence this exists to end. The
 * fallback is the event's own JSON -- unhelpful to read, but never a lie about what happened.
 */
export function sessionError(e: ServerEvent): string | undefined {
  if (e.type !== 'session.error') return undefined
  const err = (e.properties ?? {})['error']
  if (typeof err !== 'object' || err === null) return `session.error: ${JSON.stringify(e.properties ?? {})}`
  const rec = err as Record<string, unknown>
  const data = typeof rec['data'] === 'object' && rec['data'] !== null ? (rec['data'] as Record<string, unknown>) : {}
  const name = typeof rec['name'] === 'string' ? rec['name'] : 'error'
  const message = typeof data['message'] === 'string' ? data['message'] : undefined
  const status = typeof data['statusCode'] === 'number' ? data['statusCode'] : undefined
  if (message === undefined) return `session.error: ${name}: ${JSON.stringify(err)}`
  return status === undefined ? `${name}: ${message}` : `${name}: ${message} (${status})`
}

/**
 * Text the child produced, if this event carries any.
 *
 * `message.part.delta` is the streaming form and the only one observed to carry incremental
 * text. Returning the DELTA rather than the accumulated message matters: a consumer that
 * re-emitted the whole message on every delta would report the turn's output N times, and the
 * relay's narration would grow quadratically in a long turn.
 */
export function textDelta(e: ServerEvent): string | undefined {
  if (e.type !== 'message.part.delta') return undefined
  const p = e.properties ?? {}
  for (const key of ['text', 'delta', 'content']) {
    const v = p[key]
    if (typeof v === 'string' && v !== '') return v
  }
  const part = p['part']
  if (typeof part === 'object' && part !== null) {
    const v = (part as Record<string, unknown>)['text']
    if (typeof v === 'string' && v !== '') return v
  }
  return undefined
}

/**
 * One server event as zero or one `AgentEvent`.
 *
 * ZERO IS THE COMMON CASE and is not a failure. Most of what the stream carries is about the
 * server rather than the seat -- plugins loading, catalogs updating, heartbeats -- and an
 * adapter that emitted something for each would fill a run's record with the server's
 * housekeeping. The events this returns are the ones a reader of a conclave run would recognise.
 */
export function translate(e: ServerEvent, ctx: TranslationContext): AgentEvent | undefined {
  // Not ours. A server shared between seats sends every seat's events here, and attributing
  // another session's turn to this seat is worse than seeing nothing.
  const sid = sessionOf(e)
  if (sid !== undefined && sid !== ctx.sessionId) return undefined

  const text = textDelta(e)
  if (text !== undefined) {
    return {
      type: 'message',
      role: 'assistant',
      text,
      ...(ctx.openTurnKey === undefined ? {} : { turnKey: ctx.openTurnKey as AgentEvent['turnKey'] }),
      seq: ctx.next(),
      at: ctx.now(),
      provisional: false,
    }
  }
  return undefined
}
