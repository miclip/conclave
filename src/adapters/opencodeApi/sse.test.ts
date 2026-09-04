/**
 * The SSE reader, against the ways a byte stream actually arrives.
 *
 * Everything the API adapter knows comes through this parser, so its failure modes are the
 * adapter's. The cases here are the ones a network produces rather than the ones a spec
 * describes: frames split mid-line, several frames in one chunk, and frames the parser has no
 * business understanding.
 *
 * Written against real captured shapes. `server.connected`, `message.part.delta` and
 * `session.idle` are what a live OpenCode server emitted for one prompt (#217).
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { readServerEvents, type ServerEvent } from './sse.ts'

const enc = new TextEncoder()

/** A body that hands over exactly the chunks given, which is what a socket does. */
async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield enc.encode(p)
}

const collect = async (body: AsyncIterable<Uint8Array>): Promise<ServerEvent[]> => {
  const out: ServerEvent[] = []
  for await (const e of readServerEvents(body)) out.push(e)
  return out
}

test('a frame split across chunks is one event, not two halves', async () => {
  // The case a spec-shaped test misses and a socket produces constantly: TCP does not respect
  // frame boundaries, so the parser must hold a partial tail rather than parse what it has.
  const seen = await collect(chunks('data: {"id":"evt_1","type":"sess', 'ion.idle","properties":{}}\n\n'))
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.type, 'session.idle')
  assert.equal(seen[0]?.id, 'evt_1')
})

test('several frames in one chunk are several events', async () => {
  const body = chunks(
    'data: {"type":"message.part.delta"}\n\ndata: {"type":"message.part.delta"}\n\ndata: {"type":"session.idle"}\n\n',
  )
  assert.deepEqual((await collect(body)).map((e) => e.type), [
    'message.part.delta',
    'message.part.delta',
    'session.idle',
  ])
})

test('a final frame with no trailing blank line is not lost', async () => {
  // What a server closing cleanly produces. Dropping it would lose the last thing said before a
  // disconnect, which is the frame most likely to explain the disconnect.
  assert.deepEqual((await collect(chunks('data: {"type":"session.idle"}'))).map((e) => e.type), ['session.idle'])
})

test('CRLF framing is read the same as LF', async () => {
  const seen = await collect(chunks('data: {"type":"server.heartbeat"}\r\n\r\n'))
  assert.deepEqual(seen.map((e) => e.type), ['server.heartbeat'])
})

test('a comment or keep-alive carries no data and yields nothing', async () => {
  assert.deepEqual(await collect(chunks(': keep-alive\n\n')), [])
})

test('an unparseable frame is dropped with a reason, not thrown on', async () => {
  // The stream may gain fields, comments, or a truncated write. An adapter that dies on an
  // unfamiliar frame dies when the server is upgraded under it, which is a worse failure than
  // missing one event.
  const dropped: string[] = []
  const out: ServerEvent[] = []
  for await (const e of readServerEvents(chunks('data: not json\n\ndata: {"type":"session.idle"}\n\n'), (_raw, why) => dropped.push(why))) {
    out.push(e)
  }
  assert.deepEqual(dropped, ['not JSON'], 'the drop is reported rather than silent')
  assert.deepEqual(out.map((e) => e.type), ['session.idle'], 'and the stream continues')
})

test('a frame with no type is dropped rather than guessed at', async () => {
  // Dispatch is on `type`. Inventing one would attribute an unknown event's properties to a known
  // event, which is worse than not seeing it.
  const dropped: string[] = []
  const out: ServerEvent[] = []
  for await (const e of readServerEvents(chunks('data: {"id":"evt_2","properties":{}}\n\n'), (_r, why) => dropped.push(why))) {
    out.push(e)
  }
  assert.deepEqual(dropped, ['no type'])
  assert.deepEqual(out, [])
})

test('properties survive, because they carry the session the event is about', async () => {
  // Not decoration: `properties` is how an event says WHICH session it belongs to, and a server
  // shared between seats sends every seat's events down one stream.
  const seen = await collect(chunks('data: {"type":"session.idle","properties":{"sessionID":"ses_abc"}}\n\n'))
  assert.deepEqual(seen[0]?.properties, { sessionID: 'ses_abc' })
})
