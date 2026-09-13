/**
 * A run's transport over the broker's socket. #286.
 *
 * What is proved here is what the process-level tests cannot tell apart from a process
 * exiting: that `close()` is what ends the session, that nothing is dialled before the first
 * send, and that the formatting on the wire is the transport's own -- label and all.
 */

import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { tempDir } from '../../testkit/tempDir.ts'
import { EvenRealitiesBroker } from './broker.ts'
import { BrokerBackedTransport, confirmGraceMs, DEFAULT_CONFIRM_GRACE_MS } from './brokerTransport.ts'
import type { SessionMetadata } from './client.ts'

process.env['CONCLAVE_EVEN_QUIET'] = '1'

function meta(): SessionMetadata {
  return { title: 'fix the thing', timestamp: '2026-09-11T12:00:00.000Z', cwd: '/w', status: 'busy' }
}

async function broker(t: TestContext): Promise<EvenRealitiesBroker> {
  const b = new EvenRealitiesBroker({ socketPath: join(tempDir(t, 'bt'), 'even.sock'), port: 0, token: 'tok', lingerMs: 60_000 })
  await b.start()
  t.after(() => b.close())
  return b
}

async function listed(b: EvenRealitiesBroker): Promise<string[]> {
  const body = (await (await fetch(`${b.bridge.url}/api/sessions?token=tok`)).json()) as { sessions: { id: string }[] }
  return body.sessions.map((s) => s.id)
}

async function status(b: EvenRealitiesBroker): Promise<string | null | undefined> {
  const body = (await (await fetch(`${b.bridge.url}/api/sessions?token=tok`)).json()) as { sessions: { status: string | null }[] }
  return body.sessions[0]?.status
}

/** Whether the broker has seen `run-a` let go, by either tell: off the attached list, or its session reading `idle` (#290). */
async function letGo(b: EvenRealitiesBroker): Promise<boolean> {
  return !b.status().sessions.includes('run-a') || (await status(b)) === 'idle'
}

async function until(cond: () => Promise<boolean>, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return cond()
}

async function messages(b: EvenRealitiesBroker, id: string): Promise<Record<string, unknown>[]> {
  const body = (await (await fetch(`${b.bridge.url}/api/messages?token=tok&sessionId=${id}`)).json()) as {
    messages: Record<string, unknown>[]
  }
  return body.messages
}

test('#286 the transport dials on the first send, speaks under its label, and its close() ends the session', async (t) => {
  const b = await broker(t)
  let ensured = 0
  const tr = new BrokerBackedTransport('run-a', 'patchnote', meta, async () => {
    ensured++
    return { socketPath: b.socketPath }
  })
  assert.equal(ensured, 0, 'constructing dials nothing')
  assert.deepEqual(await listed(b), [], 'and opens nothing')

  await tr.send({ kind: 'progress', headline: 'checks green' })
  assert.equal(ensured, 1)
  assert.deepEqual(await listed(b), ['run-a'], 'the first send opened the run')
  await tr.send({ kind: 'progress', headline: 'pushed' })
  assert.equal(ensured, 1, 'one connection for the life of the transport')
  // The formatting is the transport's: the kind as the title, the name in front of the line.
  assert.deepEqual(
    (await messages(b, 'run-a')).map((m) => [m['title'], m['message']]),
    [
      ['conclave', '[patchnote] checks green'],
      ['conclave', '[patchnote] pushed'],
    ],
  )

  // A veto -- an answer with nothing awaiting it -- comes back through poll. Before the
  // question below, so that what happens to the connection AFTER an answer stays the SSE
  // test's claim alone.
  await fetch(`${b.bridge.url}/api/question-response?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'run-a', answer: 'hold on' }),
  })
  assert.deepEqual(await tr.poll(), [{ text: 'hold on', from: { id: 'even-realities', kind: 'human' } }])

  // A question, answered by label, comes back as the option id.
  await tr.send({ kind: 'approval', headline: 'merge?', options: [{ id: 'yes', label: 'Merge' }] })
  const asked = tr.receive()
  // Answered once the list says the question is outstanding, not after a guess at how long
  // the frame takes: answered early, the answer would be a veto and `asked` would wait for ever.
  assert.equal(await until(async () => (await status(b)) === 'awaiting'), true, 'the question reached the bridge')
  await fetch(`${b.bridge.url}/api/question-response?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'run-a', answer: 'Merge' }),
  })
  assert.deepEqual(await asked, { option: 'yes', from: { id: 'even-realities', kind: 'human' } })

  // THE RUN IS THE SOCKET. Closing the transport is what detaches the run: the session stays
  // listed for a while (#290), reading `idle` because nothing is behind it any more.
  await tr.close()
  assert.equal(await until(() => letGo(b)), true, 'closed: the run let go')
  await tr.close()
})

test('#286 a transport turned away by a closing broker tries once more, and the retry finds a fresh one', async (t) => {
  // What a closing broker looks like from the run's end -- accepted, then dropped before any
  // frame -- played by a bare server, so this proves the retry and nothing about the broker.
  const dir = tempDir(t, 'bt')
  const turnedAway = join(dir, 'old.sock')
  const dropper = createServer((s) => s.destroy())
  await new Promise<void>((resolve) => dropper.listen(turnedAway, resolve))
  t.after(() => dropper.close())
  const fresh = new EvenRealitiesBroker({ socketPath: join(dir, 'new.sock'), port: 0, token: 'tok', lingerMs: 60_000 })
  await fresh.start()
  t.after(() => fresh.close())

  let ensured = 0
  const tr = new BrokerBackedTransport('run-a', 'x', meta, async () => ({ socketPath: ensured++ === 0 ? turnedAway : fresh.socketPath }))
  t.after(() => tr.close())
  await tr.send({ kind: 'progress', headline: 'made it' })
  assert.equal(ensured, 2, 'turned away once, then attached')
  assert.deepEqual(await listed(fresh), ['run-a'])

  // Twice is the limit: dropped twice is not a broker closing, and is reported as what it is.
  const twice = new BrokerBackedTransport('run-b', 'x', meta, async () => ({ socketPath: turnedAway }))
  t.after(() => twice.close())
  await assert.rejects(() => twice.send({ kind: 'progress', headline: 'x' }), /the broker connection closed/)
})

test('#286 a transport whose run cannot be read, or whose broker cannot be reached, fails the send and dials nothing', async (t) => {
  const dir = tempDir(t, 'bt')
  const socket = join(dir, 'nothing.sock')
  const unreadable = new BrokerBackedTransport('run-a', 'x', () => undefined, async () => ({ socketPath: socket }))
  await assert.rejects(() => unreadable.send({ kind: 'progress', headline: 'x' }), /no readable record for run run-a/)
  const unreachable = new BrokerBackedTransport('run-a', 'x', meta, async () => ({ socketPath: socket }))
  await assert.rejects(() => unreachable.send({ kind: 'progress', headline: 'x' }), /ENOENT|ECONNREFUSED/)
  assert.equal(existsSync(socket), false)
  await unreachable.close()
})

/** The device's stream for one session: every frame's arrival, and the moment it ended. */
async function stream(t: TestContext, b: EvenRealitiesBroker, id: string) {
  const ac = new AbortController()
  t.after(() => ac.abort())
  const res = await fetch(`${b.bridge.url}/api/events?token=tok&sessionId=${id}&needReplay=true`, { signal: ac.signal })
  const reader = res.body!.getReader()
  const frames: { at: number; title: string }[] = []
  const state = { endedAt: undefined as number | undefined }
  let buf = ''
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += new TextDecoder().decode(value)
      for (const line of buf.split('\n')) {
        if (line.startsWith('data: ')) {
          const msg = JSON.parse(line.slice(6)) as { type: string; title?: string }
          frames.push({ at: Date.now(), title: msg.title ?? msg.type })
        }
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1)
    }
    state.endedAt = Date.now()
  })()
  return { frames, state, pump }
}

test('#285 the confirmation is on the stream, and the stream stays up long enough to render it before the run lets go', async (t) => {
  // What the device receives, in order, with the clock: the `Received` frame, then a window in
  // which the stream is still open, then EOF -- and EOF no sooner than the grace after the run
  // called `close()`. A timer being set is not asserted anywhere; only what arrived and when.
  const b = await broker(t)
  const GRACE = DEFAULT_CONFIRM_GRACE_MS
  const tr = new BrokerBackedTransport('run-a', 'x', meta, async () => ({ socketPath: b.socketPath }), { confirmGraceMs: GRACE })
  await tr.send({ kind: 'approval', headline: 'merge?', options: [{ id: 'yes', label: 'Merge' }] })
  const asked = tr.receive()
  assert.equal(await until(async () => (await status(b)) === 'awaiting'), true)
  const device = await stream(t, b, 'run-a')

  await fetch(`${b.bridge.url}/api/question-response?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'run-a', answer: 'Merge' }),
  })
  assert.deepEqual(await asked, { option: 'yes', from: { id: 'even-realities', kind: 'human' } })
  // The run has its answer and lets go at once, as the CLI does after printing it.
  const closeAt = Date.now()
  const closing = tr.close()

  // A render opportunity: half the grace in, the frame has arrived and the stream is open.
  await new Promise((r) => setTimeout(r, GRACE / 2))
  assert.deepEqual(device.frames.map((f) => f.title), ['user_question', 'Received'], 'the confirmation reached the device')
  assert.equal(device.state.endedAt, undefined, 'and the stream is still open while it renders')

  await closing
  await device.pump
  const endedAt = device.state.endedAt!
  const received = device.frames.find((f) => f.title === 'Received')!
  assert.ok(received.at < endedAt, 'the frame came before EOF')
  assert.ok(endedAt - closeAt >= GRACE, `EOF ${endedAt - closeAt}ms after close(): before the grace`)
})

test('#285 a run that only told closes at once: the grace is for an answered question, nothing else', async (t) => {
  // The conditional half of the claim. A grace applied to every close would hold this session
  // for the whole (deliberately long) grace; a `tell` confirms nothing and has nothing to render.
  const b = await broker(t)
  const tr = new BrokerBackedTransport('run-a', 'x', meta, async () => ({ socketPath: b.socketPath }), { confirmGraceMs: 3_000 })
  await tr.send({ kind: 'progress', headline: 'checks green' })
  assert.deepEqual(await listed(b), ['run-a'])
  // Not awaited before looking: a `close` that waited would keep this from looking until it
  // was over, and a grace wrongly applied here would go unseen.
  const closing = tr.close()
  assert.equal(await until(() => letGo(b), 1_000), true, 'let go well inside the grace')
  await closing
})

test('#285 the grace is 300ms unless CONCLAVE_EVEN_CONFIRM_GRACE_MS says otherwise', () => {
  assert.equal(DEFAULT_CONFIRM_GRACE_MS, 300)
  assert.equal(confirmGraceMs({}), 300)
  assert.equal(confirmGraceMs({ CONCLAVE_EVEN_CONFIRM_GRACE_MS: '1500' }), 1_500)
  assert.equal(confirmGraceMs({ CONCLAVE_EVEN_CONFIRM_GRACE_MS: '0' }), 0, 'zero is a choice: let go at once')
  // A typo is the default, not a run that never exits or one that races the render again.
  assert.equal(confirmGraceMs({ CONCLAVE_EVEN_CONFIRM_GRACE_MS: 'soon' }), 300)
  assert.equal(confirmGraceMs({ CONCLAVE_EVEN_CONFIRM_GRACE_MS: '-1' }), 300)
  assert.equal(confirmGraceMs({ CONCLAVE_EVEN_CONFIRM_GRACE_MS: 'Infinity' }), 300)
})
