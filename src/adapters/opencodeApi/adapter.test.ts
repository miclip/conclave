/**
 * The adapter, against a real HTTP server that speaks OpenCode's protocol badly enough to be
 * useful.
 *
 * A REAL `node:http` server rather than a stubbed `fetch`, because the things worth testing here
 * are timing: a turn that ends because `session.idle` arrived, a stream that dies mid-turn, a
 * cancel that races the boundary. A stub answers instantly and in order, which is the one
 * condition a network never provides.
 *
 * The server is spawned by injecting `spawnFn`, so no OpenCode is needed. What that cannot cover
 * — that the real routes behave as documented — was probed against a live 1.18.27 server and is
 * recorded in the commit for it.
 */

import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:http'
import test from 'node:test'
import type { AgentEvent, TurnEndEvent } from '../../contract/session.ts'
import { OpenCodeApiAdapter } from './adapter.ts'

/** A stand-in OpenCode server: sessions, prompts, and an SSE stream a test can push into. */
function fakeOpenCode(): {
  server: Server
  ready: Promise<number>
  push: (event: unknown) => void
  endStream: () => void
  posted: string[]
} {
  const clients: Array<{ write: (s: string) => void; end: () => void }> = []
  const posted: string[] = []
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    posted.push(`${req.method} ${url.split('?')[0]}`)
    if (url === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      clients.push({ write: (s) => res.write(s), end: () => res.end() })
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (url === '/session' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'ses_fake' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('')
    })
  })
  const ready = new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
  return {
    server,
    ready,
    push: (event) => clients.forEach((c) => c.write(`data: ${JSON.stringify(event)}\n\n`)),
    endStream: () => clients.forEach((c) => c.end()),
    posted,
  }
}

/** A `spawnFn` that announces a port the adapter should connect to, and spawns nothing. */
function spawnAnnouncing(port: number): NonNullable<Parameters<typeof OpenCodeApiAdapter.start>[0]['spawnFn']> {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child['stdout'] = new EventEmitter()
  child['stderr'] = new EventEmitter()
  child['exitCode'] = null
  child['signalCode'] = null
  child['kill'] = () => true
  setTimeout(() => (child['stdout'] as EventEmitter).emit('data', Buffer.from(`listening on http://127.0.0.1:${port}\n`)), 1)
  return (() => child) as unknown as NonNullable<Parameters<typeof OpenCodeApiAdapter.start>[0]['spawnFn']>
}

async function seat(): Promise<{ adapter: OpenCodeApiAdapter; fake: ReturnType<typeof fakeOpenCode>; seen: AgentEvent[]; stop: () => Promise<void> }> {
  const fake = fakeOpenCode()
  const port = await fake.ready
  const adapter = await OpenCodeApiAdapter.start({ cwd: '/tmp', role: 'implementer', spawnFn: spawnAnnouncing(port) })
  const seen: AgentEvent[] = []
  const reading = (async () => {
    for await (const e of adapter.events()) seen.push(e)
  })()
  return {
    adapter,
    fake,
    seen,
    stop: async () => {
      await adapter.close('graceful')
      await reading
      await new Promise<void>((r) => fake.server.close(() => r()))
    },
  }
}

const settle = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('a turn ends when the server says the session is idle, not when a process exits', async () => {
  // The property the run-per-turn adapter cannot have. `session.idle` is the server stating that
  // this session stopped working; process exit is an inference about a turn from the death of
  // the thing that ran it.
  const { adapter, fake, seen, stop } = await seat()
  try {
    const key = await adapter.send('do the thing', { kind: 'orchestrator' })
    await settle()
    assert.ok(seen.some((e) => e.type === 'turn_start'), 'the turn is announced when it is sent')
    assert.ok(!seen.some((e) => e.type === 'turn_end'), 'and does not end before the server says so')

    fake.push({ id: 'evt_1', type: 'session.idle', properties: { sessionID: 'ses_fake' } })
    await settle()

    const end = seen.find((e) => e.type === 'turn_end') as TurnEndEvent | undefined
    assert.equal(end?.turnKey, key)
    assert.equal(end?.verdict.outcome, 'completed')
    assert.equal(end?.verdict.confidence, 'proven', 'the server said so; this is not an inference')
  } finally {
    await stop()
  }
})

test('streamed text is child output while the turn is still open', async () => {
  // Within-turn activity, which the run-per-turn seat has none of — the reason
  // `RUN_PER_TURN_DEADLINES` gives it no silence clock at all.
  const { adapter, fake, seen, stop } = await seat()
  try {
    await adapter.send('write something', { kind: 'orchestrator' })
    fake.push({ type: 'message.part.delta', properties: { sessionID: 'ses_fake', text: 'partial' } })
    await settle()
    const msg = seen.find((e) => e.type === 'message')
    assert.equal(msg && 'text' in msg ? msg.text : undefined, 'partial')
    assert.ok(!seen.some((e) => e.type === 'turn_end'), 'output is not an ending')
  } finally {
    await stop()
  }
})

test('another session’s idle does not end this seat’s turn', async () => {
  // One server, many sessions, one stream. Ending a turn on someone else's boundary would be
  // invisible: the turn would simply finish early and the seat would look fast.
  const { adapter, fake, seen, stop } = await seat()
  try {
    await adapter.send('mine', { kind: 'orchestrator' })
    fake.push({ type: 'session.idle', properties: { sessionID: 'ses_someone_else' } })
    await settle()
    assert.ok(!seen.some((e) => e.type === 'turn_end'), 'a stranger’s boundary is not ours')
  } finally {
    await stop()
  }
})

test('a stream that dies mid-turn leaves the turn unresolved, and says so', async () => {
  // #146's rule: a verdict nobody observed must not be invented. The turn may well have finished
  // after we stopped listening, so `transport_lost` and `uncertain` are the honest pair.
  const { adapter, fake, seen, stop } = await seat()
  try {
    await adapter.send('long one', { kind: 'orchestrator' })
    await settle()
    fake.endStream()
    await settle(150)
    const end = seen.find((e) => e.type === 'turn_end') as TurnEndEvent | undefined
    assert.equal(end?.verdict.outcome, 'transport_lost')
    assert.equal(end?.verdict.confidence, 'uncertain')
    assert.equal(end?.synthesized, true, 'nothing observed this ending')
  } finally {
    await stop()
  }
})

test('a command is a POST, and does not open a turn', async () => {
  // The whole of #215, and the difference from every other adapter: nothing is typed, so nothing
  // echoes, so a command cannot be mistaken for a prompt (#207, #216).
  const { adapter, fake, seen, stop } = await seat()
  try {
    await adapter.submitRaw('/compact')
    await settle()
    assert.ok(fake.posted.includes('POST /session/ses_fake/command'), `saw ${JSON.stringify(fake.posted)}`)
    assert.ok(!seen.some((e) => e.type === 'turn_start'), 'a command is not work')
  } finally {
    await stop()
  }
})

test('cancel stops the turn without killing anything, and the verdict says who ended it', async () => {
  const { adapter, fake, seen, stop } = await seat()
  try {
    await adapter.send('long one', { kind: 'orchestrator' })
    const key = await adapter.cancel()
    assert.ok(key, 'the cancelled turn is named')
    assert.ok(fake.posted.includes('POST /session/ses_fake/abort'))

    // The server still reports idle afterwards; the turn is cancelled rather than completed
    // because this adapter asked for it, which is what `cancellationAttributable` means.
    fake.push({ type: 'session.idle', properties: { sessionID: 'ses_fake' } })
    await settle()
    const end = seen.find((e) => e.type === 'turn_end') as TurnEndEvent | undefined
    assert.equal(end?.verdict.outcome, 'cancelled')
  } finally {
    await stop()
  }
})

test('a second prompt into a working session is refused rather than queued', async () => {
  // The server does not queue it, and pretending it opened a turn would attribute the first
  // turn's events to the second.
  const { adapter, stop } = await seat()
  try {
    await adapter.send('first', { kind: 'orchestrator' })
    await assert.rejects(() => adapter.send('second', { kind: 'orchestrator' }), /already in flight/)
  } finally {
    await stop()
  }
})
