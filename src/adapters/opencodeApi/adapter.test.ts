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
  /** What was POSTed, by path -- so a test can assert on a body and not merely on the call. */
  bodies: Array<{ path: string; body: string }>
} {
  const clients: Array<{ write: (s: string) => void; end: () => void }> = []
  const posted: string[] = []
  const bodies: Array<{ path: string; body: string }> = []
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
      if (req.method === 'POST') bodies.push({ path: url.split('?')[0] ?? '', body })
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
    bodies,
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

async function seat(
  extra: Partial<Parameters<typeof OpenCodeApiAdapter.start>[0]> = {},
): Promise<{ adapter: OpenCodeApiAdapter; fake: ReturnType<typeof fakeOpenCode>; seen: AgentEvent[]; stop: () => Promise<void> }> {
  const fake = fakeOpenCode()
  const port = await fake.ready
  const adapter = await OpenCodeApiAdapter.start({ cwd: '/tmp', role: 'implementer', spawnFn: spawnAnnouncing(port), ...extra })
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
/** Longer than the adapter's coalescing interval, so a flushed message has landed (#219). */
const FLUSH_SETTLE_MS = 400

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
    // PAST THE FLUSH INTERVAL. Deltas are coalesced (#219) -- a token at a time is not narration
    // a human can read -- so text appears one flush later rather than one event later.
    await settle(FLUSH_SETTLE_MS)
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

test('#220 a turn that goes silent is ended by the clock, not left open forever', async () => {
  // THE 72-MINUTE HANG. The first run to seat this adapter sent a prompt, the seat produced
  // nothing -- no output, no error, not one event -- and the turn stayed open indefinitely
  // because the adapter declared two deadline clocks and armed neither.
  //
  // Nothing else can catch this. There is no process to notice exiting, and the server emits
  // nothing at all when it stalls, so a clock is the only instrument that applies.
  const fake = fakeOpenCode()
  const port = await fake.ready
  const adapter = await OpenCodeApiAdapter.start({
    cwd: '/tmp',
    role: 'implementer',
    spawnFn: spawnAnnouncing(port),
    // Milliseconds, so the deadline is reachable in a test. Production is 135 minutes.
    watchdogMs: 120,
    idleMs: 120,
  })
  const seen: AgentEvent[] = []
  const reading = (async () => {
    for await (const e of adapter.events()) seen.push(e)
  })()
  try {
    await adapter.send('a prompt this seat will never answer', { kind: 'orchestrator' })
    // Nothing pushed: the server accepts the prompt and says nothing, which is what happened.
    await settle(400)

    const end = seen.find((e) => e.type === 'turn_end') as TurnEndEvent | undefined
    assert.ok(end, 'a silent turn must still end, or the run can never reach a boundary')
    assert.equal(end?.synthesized, true, 'nothing from the child said this; the clock did')
    assert.equal(end?.verdict.confidence, 'uncertain', 'a deadline is not proof the seat stopped')
  } finally {
    await adapter.close('graceful')
    await reading
    await new Promise<void>((r) => fake.server.close(() => r()))
  }
})

// NOT TESTED HERE, and stated rather than faked: that streamed output pushes the silence
// deadline out. A test was written for it and REMOVED, because it passed with the activity
// record deleted -- the clock never fired inside its window either way, so it asserted nothing
// while looking like a guard. Two mutations proved that: removing `touch` and removing
// `lastActivityAt` both left it green.
//
// The mechanism is shared with the pty adapters -- the watchdog reads `lastActivityAt` and this
// adapter sets it on every child event -- and `watchdog.test.ts` covers the clock itself. What is
// missing is an adapter-level test that the wiring between them is connected, and that is worth
// having: the whole of #220 was wiring that was never connected.

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

test('#221 args that cannot reach a server seat are stated at startup, in the operator\u2019s own spelling', async () => {
  // Half of #221 is that the un-deliverable ones are SAID. A notice that merely summarised them
  // ("some launch args were ignored") would leave the operator to guess which, so the assertion
  // is on the exact flags they typed appearing in the text.
  const dropped = ['--dangerously-skip-permissions', '--log-level', 'DEBUG']
  const { adapter, stop } = await seat({ ignoredArgs: dropped })
  try {
    const notice = (adapter.startupNotices ?? []).join('\n')
    for (const arg of dropped) assert.ok(notice.includes(arg), `the notice names ${arg}: ${notice}`)
    assert.ok(/#221/.test(notice), 'and points at why, so the reason outlives this conversation')
  } finally {
    await stop()
  }
})

test('#221 a seat given nothing to drop starts without a notice', async () => {
  // The quiet default matters: a notice on every run is a notice nobody reads.
  const { adapter, stop } = await seat()
  try {
    assert.equal(adapter.startupNotices, undefined)
  } finally {
    await stop()
  }
})

test('#221 the seat\u2019s model travels with every prompt, not only the first', async () => {
  // A server outlives the turn, so there is no launch to carry the model -- it has to ride each
  // prompt. A model that reached only the opening turn would be the same silent drop #221 is
  // about, one turn later.
  const { adapter, fake, stop } = await seat({ model: 'anthropic/claude-sonnet-4-5' })
  try {
    await adapter.send('first', { kind: 'orchestrator' })
    fake.push({ type: 'session.idle', properties: { sessionID: 'ses_fake' } })
    await settle()
    await adapter.send('second', { kind: 'orchestrator' })
    await settle()
    const prompts = fake.bodies.filter((b) => b.path.endsWith('/prompt_async'))
    assert.equal(prompts.length, 2, `two prompts were posted: ${fake.posted.join(' | ')}`)
    for (const p of prompts) {
      assert.deepEqual(JSON.parse(p.body).model, { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' })
    }
  } finally {
    await stop()
  }
})

test('#224 a turn the server said failed is not graded completed', async () => {
  // THE DEFECT, in the order the wire produced it: an error, then the ordinary idle. Reading
  // only the boundary put `completed` / `proven` -- the strongest grade there is -- on a 401,
  // and the operator saw an empty report and nothing else.
  const { adapter, fake, seen, stop } = await seat()
  try {
    await adapter.send('use a model this account cannot have', { kind: 'orchestrator' })
    fake.push({
      type: 'session.error',
      properties: {
        sessionID: 'ses_fake',
        error: { name: 'APIError', data: { message: 'Model is disabled', statusCode: 401 } },
      },
    })
    fake.push({ type: 'session.idle', properties: { sessionID: 'ses_fake' } })
    await settle()

    const end = seen.find((e) => e.type === 'turn_end') as TurnEndEvent | undefined
    assert.ok(end, 'the turn still ends -- the boundary is what closes it')
    assert.equal(end.verdict.outcome, 'unknown_abnormal_end')
    assert.match(
      JSON.stringify(end.verdict.provenance),
      /Model is disabled/,
      `the server's own words survive into the verdict: ${JSON.stringify(end.verdict)}`,
    )
  } finally {
    await stop()
  }
})

test('#224 the operator hears the failure while the run is still going, not only in the report', async () => {
  // A disabled model or an expired key is fixable DURING a run, but only by someone who is told.
  // Not fatal: the stream is healthy and the seat can take another prompt.
  const { adapter, fake, seen, stop } = await seat()
  try {
    await adapter.send('anything', { kind: 'orchestrator' })
    fake.push({
      type: 'session.error',
      properties: { sessionID: 'ses_fake', error: { name: 'APIError', data: { message: 'Model is disabled', statusCode: 401 } } },
    })
    await settle()
    const err = seen.find((e) => e.type === 'error')
    assert.ok(err, `an error event reaches the run: ${JSON.stringify(seen.map((e) => e.type))}`)
    assert.equal('fatal' in err ? err.fatal : undefined, false, 'one bad turn does not retire the session')
  } finally {
    await stop()
  }
})

test('#224 a stranger’s failure does not condemn this seat’s turn', async () => {
  // One server, many sessions, one stream. The boundary check already filters by session and
  // this has to as well, or a second seat's bad model name grades our good turn as failed.
  const { adapter, fake, seen, stop } = await seat()
  try {
    await adapter.send('mine', { kind: 'orchestrator' })
    fake.push({
      type: 'session.error',
      properties: { sessionID: 'ses_someone_else', error: { name: 'APIError', data: { message: 'not ours', statusCode: 401 } } },
    })
    fake.push({ type: 'session.idle', properties: { sessionID: 'ses_fake' } })
    await settle()
    const end = seen.find((e) => e.type === 'turn_end') as TurnEndEvent | undefined
    assert.equal(end?.verdict.outcome, 'completed', 'our turn is judged on our own session’s events')
  } finally {
    await stop()
  }
})

test('#224 a turn nothing went wrong in is still completed and proven', async () => {
  // The change must not make every quiet turn suspicious. `session.idle` with no error before it
  // is the ordinary ending and keeps the grade it had.
  const { adapter, fake, seen, stop } = await seat()
  try {
    await adapter.send('fine', { kind: 'orchestrator' })
    fake.push({ type: 'session.idle', properties: { sessionID: 'ses_fake' } })
    await settle()
    const end = seen.find((e) => e.type === 'turn_end') as TurnEndEvent | undefined
    assert.equal(end?.verdict.outcome, 'completed')
    assert.equal(end?.verdict.confidence, 'proven')
  } finally {
    await stop()
  }
})

test('#226 a turn working inside a tool is not killed by the silence clock', async () => {
  // THE DEFECT, as the clock sees it. `translate` returns an event only for
  // `message.part.delta`, and the silence clock was refreshed only where it returned one -- so a
  // turn spent inside a long tool call refreshed nothing. Captured on a real tool-using turn:
  // ten `message.part.updated`, one delta. `npm test` on this repo is minutes, and it is what
  // runs are told to check with.
  //
  // Asserted through the CLOCK rather than through a field, because the field is not the
  // promise: what a seat needs is not to be killed while it is working.
  const { adapter, fake, seen, stop } = await seat({ idleMs: 300, watchdogMs: 60_000 })
  try {
    await adapter.send('run the checks', { kind: 'orchestrator' })
    // Four tool parts across well over one idle period. Nothing a reader would want to see.
    for (let i = 0; i < 4; i++) {
      fake.push({
        type: 'message.part.updated',
        properties: { sessionID: 'ses_fake', part: { type: 'tool', tool: 'bash', state: { status: 'running' } } },
      })
      await settle(150)
    }
    assert.ok(!seen.some((e) => e.type === 'turn_end'), 'a working turn survives its own quiet')
    assert.ok(!seen.some((e) => e.type === 'message'), 'and none of it was rendered (#219)')
  } finally {
    await stop()
  }
})

test('#226 a turn that is genuinely silent is still killed', async () => {
  // The other half, and the one that makes the test above mean something: widening liveness must
  // not retire the clock. Same timings, no events at all.
  const { adapter, seen, stop } = await seat({ idleMs: 300, watchdogMs: 60_000 })
  try {
    await adapter.send('a prompt this seat will never answer', { kind: 'orchestrator' })
    await settle(900)
    assert.ok(seen.some((e) => e.type === 'turn_end'), 'silence still reaches a verdict')
  } finally {
    await stop()
  }
})

test('#226 a heartbeat does not keep a wedged seat alive, because it names no session', async () => {
  // A transport that keeps talking while the seat is stuck is exactly what the silence clock
  // exists to catch.
  //
  // WHAT ACTUALLY GUARDS THIS is the session filter, not the liveness set, and the distinction
  // is worth writing down because a mutation found it: adding `server.heartbeat` to the set left
  // this test green. Server-scoped events name no session, `sessionOf` returns undefined, and
  // the `=== this.sessionId` check excludes them however the set is spelled. The set is the
  // second line here, not the first.
  const { adapter, fake, seen, stop } = await seat({ idleMs: 300, watchdogMs: 60_000 })
  try {
    await adapter.send('go', { kind: 'orchestrator' })
    for (let i = 0; i < 4; i++) {
      fake.push({ type: 'server.heartbeat', properties: {} })
      fake.push({ type: 'plugin.added', properties: { id: 'anthropic' } })
      await settle(150)
    }
    assert.ok(seen.some((e) => e.type === 'turn_end'), 'housekeeping is not the seat working')
  } finally {
    await stop()
  }
})

test('#226 a session-scoped event that is not work does not refresh the clock either', async () => {
  // THIS is what pins the liveness set. `session.updated` carries our own sessionID, so it
  // passes the session filter and only membership decides -- which is what makes a mutation
  // that widens the set fail here rather than nowhere.
  const { adapter, fake, seen, stop } = await seat({ idleMs: 300, watchdogMs: 60_000 })
  try {
    await adapter.send('go', { kind: 'orchestrator' })
    for (let i = 0; i < 4; i++) {
      fake.push({ type: 'session.updated', properties: { sessionID: 'ses_fake', info: { id: 'ses_fake' } } })
      await settle(150)
    }
    assert.ok(seen.some((e) => e.type === 'turn_end'), 'metadata changing is not the seat working')
  } finally {
    await stop()
  }
})

test('#226 another seat’s tool work does not keep this seat alive', async () => {
  // One server, many sessions, one stream -- the same filter every other rule here needs.
  const { adapter, fake, seen, stop } = await seat({ idleMs: 300, watchdogMs: 60_000 })
  try {
    await adapter.send('mine', { kind: 'orchestrator' })
    for (let i = 0; i < 4; i++) {
      fake.push({
        type: 'message.part.updated',
        properties: { sessionID: 'ses_someone_else', part: { type: 'tool' } },
      })
      await settle(150)
    }
    assert.ok(seen.some((e) => e.type === 'turn_end'), 'not ours, not our liveness')
  } finally {
    await stop()
  }
})
