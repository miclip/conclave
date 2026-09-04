/**
 * The mapping from OpenCode's wire events to conclave's, tested on its own.
 *
 * Both directions of error here are silent. An event misread as a turn boundary ends an exchange
 * before the seat has finished; one misread as child output holds the silence clock open on a
 * seat that has stopped. Neither throws, and neither shows up in a passing adapter test — which
 * is why this is tested at the function rather than through a running session.
 *
 * The fixtures are shapes a live server actually sent for one prompt (#217), not shapes invented
 * to make a mapping look right.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { ServerEvent } from './sse.ts'
import { isTransportLiveness, isTurnBoundary, sessionOf, textDelta, translate } from './translate.ts'

const ctx = (over: Partial<Parameters<typeof translate>[1]> = {}) => ({
  sessionId: 'ses_ours',
  openTurnKey: 'turn-1',
  next: () => 1,
  now: () => 1_700_000_000_000,
  ...over,
})

test('a session event names the session it belongs to, however the payload spells it', () => {
  // One server holds many sessions and sends all of them down one stream. Getting this wrong
  // attributes another seat's turn to this one, which no later check would catch.
  assert.equal(sessionOf({ type: 'session.idle', properties: { sessionID: 'ses_a' } }), 'ses_a')
  assert.equal(sessionOf({ type: 'x', properties: { info: { sessionID: 'ses_b' } } }), 'ses_b')
  assert.equal(sessionOf({ type: 'server.heartbeat', properties: {} }), undefined, 'server events belong to no session')
})

test('another session’s events are not this seat’s', () => {
  const e: ServerEvent = { type: 'message.part.delta', properties: { sessionID: 'ses_theirs', text: 'hello' } }
  assert.equal(translate(e, ctx()), undefined, 'a delta for another session must produce nothing here')
})

test('a text delta is child output, and is the DELTA rather than the whole message', () => {
  // Re-emitting the accumulated message on every delta would report a turn's output once per
  // delta, and the relay's narration would grow quadratically across a long turn.
  const e: ServerEvent = { type: 'message.part.delta', properties: { sessionID: 'ses_ours', text: 'part' } }
  const out = translate(e, ctx())
  assert.equal(out?.type, 'message')
  assert.equal(out && 'text' in out ? out.text : undefined, 'part')
  assert.equal(out && 'role' in out ? out.role : undefined, 'assistant')
})

test('an empty delta carries nothing and is not child output', () => {
  // A seat proves it is working by SAYING something. An empty part is the stream's bookkeeping,
  // and counting it would hold the silence clock open on a turn producing nothing.
  assert.equal(textDelta({ type: 'message.part.delta', properties: { text: '' } }), undefined)
})

test('session.idle is the turn boundary, and nothing else observed is', () => {
  assert.equal(isTurnBoundary({ type: 'session.idle' }), true)
  // EVERY other type the probed turn produced, and the server-scoped ones especially. A
  // heartbeat read as a boundary would end an exchange every few seconds — the seat would look
  // like it finished instantly, on every turn, and no assertion about a turn's CONTENT would
  // catch it. This list omitted the server events until a mutation walked through the gap.
  for (const t of [
    'message.part.delta',
    'message.part.updated',
    'message.updated',
    'session.status',
    'session.updated',
    'session.diff',
    'server.heartbeat',
    'server.connected',
    'plugin.added',
    'catalog.updated',
  ]) {
    assert.equal(isTurnBoundary({ type: t }), false, `${t} must not end a turn`)
  }
})

test('heartbeats are transport liveness, not seat activity', () => {
  // The distinction the pty adapters cannot draw: they infer liveness from the child process
  // existing. A heartbeat says the SERVER is alive and says nothing about whether the seat is
  // working, so it must never reach the silence clock as child output.
  assert.equal(isTransportLiveness({ type: 'server.heartbeat' }), true)
  assert.equal(isTransportLiveness({ type: 'server.connected' }), true)
  assert.equal(translate({ type: 'server.heartbeat' }, ctx()), undefined, 'and it is not an agent event')
})

test('the server’s own housekeeping produces nothing', () => {
  // Most of the stream is not about the seat. Emitting something per frame would fill a run's
  // record with plugin loads and catalog updates.
  for (const t of ['plugin.added', 'catalog.updated', 'reference.updated', 'integration.updated', 'session.diff']) {
    assert.equal(translate({ type: t, properties: { sessionID: 'ses_ours' } }, ctx()), undefined, `${t} must not become an event`)
  }
})

test('an event whose names were never observed firing is not mapped', () => {
  // `session.execution.*`, `session.reasoning.*` and `session.tool.*` are in the bundle and did
  // NOT fire for the probed turn, so their payload shapes are unknown. Mapping them would be
  // reading a name as a behaviour — the mistake already made once on this agent (#215).
  for (const t of ['session.execution.succeeded', 'session.reasoning.delta', 'session.tool.progress']) {
    assert.equal(translate({ type: t, properties: { sessionID: 'ses_ours' } }, ctx()), undefined)
    assert.equal(isTurnBoundary({ type: t }), false, `${t} must not be treated as a boundary on the strength of its name`)
  }
})
