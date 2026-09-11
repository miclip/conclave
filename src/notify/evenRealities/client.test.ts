/**
 * The Even Realities bridge, driven the way the glasses app drives it.
 *
 * No hardware needed and none simulated: the app is an HTTP client, so a test that speaks HTTP
 * exercises the same surface. What it cannot check is whether the HUD renders what we send,
 * which is the one thing the glasses have to answer.
 *
 *   node --test src/notify/evenRealities/client.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { EvenRealitiesBridge, type SessionMetadata } from './client.ts'

/** A run's metadata as a session would describe it; mutable so a test can advance it. */
function meta(over: Partial<SessionMetadata> = {}): SessionMetadata {
  return { title: 'fix the thing', timestamp: '2026-09-11T12:00:00.000Z', cwd: '/w', status: 'busy', ...over }
}


async function bridge(): Promise<EvenRealitiesBridge> {
  // Port 0: the OS picks a free one, so two runs never collide.
  const b = new EvenRealitiesBridge({ port: 0, token: 'tok' })
  await b.listen()
  b.openSession('run-1', () => meta())
  return b
}

/** Read Server-Sent Events until `want` frames have arrived. */
async function frames(url: string, want: number, signal: AbortSignal): Promise<Record<string, unknown>[]> {
  const res = await fetch(url, { signal })
  const reader = res.body!.getReader()
  const out: Record<string, unknown>[] = []
  let buf = ''
  while (out.length < want) {
    const { value, done } = await reader.read()
    if (done) break
    buf += new TextDecoder().decode(value)
    for (const chunk of buf.split('\n\n')) {
      const line = chunk.split('\n').find((l) => l.startsWith('data: '))
      if (line) out.push(JSON.parse(line.slice(6)) as Record<string, unknown>)
    }
    buf = ''
  }
  return out
}

/** `POST /api/question-response`, as the app sends it. */
async function respond(b: EvenRealitiesBridge, body: unknown): Promise<Response> {
  return fetch(`${b.url}/api/question-response?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const q = { header: 'Approval', question: 'go?', options: [{ label: 'Yes', description: '' }] }

test('#184 an unauthorised request is refused, on the stream and on the API', async (t) => {
  const b = await bridge()
  t.after(() => b.close())

  assert.equal((await fetch(`${b.url}/api/sessions`)).status, 401, 'no token')
  assert.equal((await fetch(`${b.url}/api/sessions?token=wrong`)).status, 401, 'wrong token')
  assert.equal((await fetch(`${b.url}/api/sessions?token=tok`)).status, 200, 'query token')
  const withHeader = await fetch(`${b.url}/api/sessions`, { headers: { authorization: 'Bearer tok' } })
  assert.equal(withHeader.status, 200, 'bearer header')
})

test('#184 a notification reaches a connected client as an SSE frame', async (t) => {
  const b = await bridge()
  t.after(() => b.close())
  const ac = new AbortController()
  t.after(() => ac.abort())

  const reading = frames(`${b.url}/api/events?sessionId=run-1&token=tok`, 1, ac.signal)
  // Let the stream attach before sending, or the message is buffered rather than pushed --
  // which is correct behaviour and not what this test is about.
  await new Promise((r) => setTimeout(r, 100))
  b.send('run-1', { type: 'notification', title: 'Decided', message: 'letting the advisor fix land' })

  const [msg] = await reading
  assert.equal(msg?.['type'], 'notification')
  assert.equal(msg?.['title'], 'Decided')
  assert.equal(msg?.['message'], 'letting the advisor fix land')
})

test('#184 a client that connects late can replay what it missed', async (t) => {
  // Their own server does this, and it is what makes a notification survive the glasses being
  // off: the message is buffered, not lost, and `needReplay` collects it.
  const b = await bridge()
  t.after(() => b.close())
  b.send('run-1', { type: 'notification', title: 'A', message: 'first' })
  b.send('run-1', { type: 'notification', title: 'B', message: 'second' })

  const ac = new AbortController()
  t.after(() => ac.abort())
  const seen = await frames(`${b.url}/api/events?sessionId=run-1&token=tok&needReplay=true`, 2, ac.signal)
  assert.deepEqual(
    seen.map((m) => m['message']),
    ['first', 'second'],
    'both, in order',
  )
})

test('#184 a question is answered through /api/question-response', async (t) => {
  const b = await bridge()
  t.after(() => b.close())

  const asked = b.ask('run-1', {
    header: 'Approval',
    question: 'Merge fix-er-adapter?',
    options: [
      { label: 'Merge', description: '' },
      { label: 'Hold', description: '' },
    ],
  })
  await new Promise((r) => setTimeout(r, 50))
  const posted = await respond(b, { sessionId: 'run-1', answer: 'Merge' })
  assert.equal(posted.status, 200)
  assert.deepEqual(await asked, { answer: 'Merge' })
})

test('#184 a second concurrent question on one run is refused rather than queued', async (t) => {
  // `/question-response` carries a session id and no question id, so two outstanding on one
  // session cannot be told apart -- and the second answer would be attributed to whichever
  // was being held.
  const b = await bridge()
  t.after(() => b.close())

  const first = b.ask('run-1', { header: 'A', question: 'first?', options: [] })
  await assert.rejects(() => b.ask('run-1', { header: 'B', question: 'second?', options: [] }), /already outstanding/)
  await respond(b, { sessionId: 'run-1', answer: 'done' })
  assert.deepEqual(await first, { answer: 'done' })
})

test('#278 two runs can each have a question outstanding, and each answer reaches its own', async (t) => {
  // The constraint the hub used to enforce across every run, lifted: the session is the run,
  // so the answer names the run and nothing has to wait for another run's operator.
  const b = await bridge()
  t.after(() => b.close())
  b.openSession('run-2', () => meta({ title: 'the other thing', cwd: '/p' }))

  const one = b.ask('run-1', q)
  const two = b.ask('run-2', q)
  await new Promise((r) => setTimeout(r, 50))

  // Answered in the OPPOSITE order to the asking. A server that handed an answer to whichever
  // question it was holding first would give run-1's promise "No".
  await respond(b, { sessionId: 'run-2', answer: 'No' })
  await respond(b, { sessionId: 'run-1', answer: 'Yes' })
  assert.deepEqual(await one, { answer: 'Yes' })
  assert.deepEqual(await two, { answer: 'No' })
})

test('#278 an answer that names no session, or an unknown one, settles nothing', async (t) => {
  // The statuses and the strings are the vendor's (`routes/core.js`): 400 "Missing 'sessionId'"
  // and 404 "Session not found". Before #278 any body at all settled the one question, whoever
  // it was for.
  const b = await bridge()
  t.after(() => b.close())
  let settled = false
  const asked = b.ask('run-1', q).then((a) => {
    settled = true
    return a
  })
  await new Promise((r) => setTimeout(r, 50))

  const missing = await respond(b, { answer: 'Yes' })
  assert.equal(missing.status, 400)
  assert.deepEqual(await missing.json(), { error: "Missing 'sessionId'" })

  const unknown = await respond(b, { sessionId: 'run-9', answer: 'Yes' })
  assert.equal(unknown.status, 404)
  assert.deepEqual(await unknown.json(), { error: 'Session not found' })

  const unreadable = await respond(b, 'not json')
  assert.equal(unreadable.status, 400, 'an unparseable body names no session either')

  await new Promise((r) => setTimeout(r, 20))
  assert.equal(settled, false, 'none of those was an answer to run-1')
  await respond(b, { sessionId: 'run-1', answer: 'Yes' })
  assert.deepEqual(await asked, { answer: 'Yes' })
})

test('#184 an answer with no readable text is `skip`, never an invented one', async (t) => {
  const b = await bridge()
  t.after(() => b.close())
  const asked = b.ask('run-1', { header: 'A', question: 'go?', options: [] })
  await new Promise((r) => setTimeout(r, 50))
  await respond(b, { sessionId: 'run-1', answer: 42 })
  assert.deepEqual(await asked, { answer: 'skip' }, 'a body that carries no string is not an answer')
})

test('#278 the stream, status and messages are per run, and refuse a missing or unknown id', async (t) => {
  const b = await bridge()
  t.after(() => b.close())
  b.openSession('run-2', () => meta({ title: 'the other thing', cwd: '/p' }))
  b.send('run-1', { type: 'notification', title: 'A', message: 'for one' })
  b.send('run-2', { type: 'notification', title: 'B', message: 'for two' })
  b.send('run-2', { type: 'notification', title: 'C', message: 'for two again' })

  // Each stream carries its own run's messages, and its ids start at 1 for that run: the
  // buffer and its counter are the session's, as in their `routes/events.js`.
  const ac = new AbortController()
  t.after(() => ac.abort())
  const one = await frames(`${b.url}/api/events?sessionId=run-1&token=tok&needReplay=true`, 1, ac.signal)
  const two = await frames(`${b.url}/api/events?sessionId=run-2&token=tok&needReplay=true`, 2, ac.signal)
  assert.deepEqual(one.map((m) => m['message']), ['for one'])
  assert.deepEqual(two.map((m) => m['message']), ['for two', 'for two again'])

  const msgs = (await (await fetch(`${b.url}/api/messages?sessionId=run-2&after=1&token=tok`)).json()) as {
    messages: { id: number; message: string }[]
    state: string
    sessionId: string
  }
  assert.deepEqual(msgs.messages.map((m) => [m.id, m.message]), [[2, 'for two again']], 'after= is per run')
  assert.equal(msgs.sessionId, 'run-2')

  const status = await fetch(`${b.url}/api/status?sessionId=run-1&token=tok`)
  assert.deepEqual(await status.json(), { state: 'busy', sessionId: 'run-1', provider: 'claude' })

  for (const path of ['/api/events', '/api/status', '/api/messages']) {
    assert.equal((await fetch(`${b.url}${path}?token=tok`)).status, 400, `${path} without a session`)
  }
  for (const path of ['/api/events', '/api/status']) {
    assert.equal((await fetch(`${b.url}${path}?sessionId=run-9&token=tok`)).status, 404, `${path} for an unknown run`)
  }
  // `/messages` for an unknown session is empty rather than 404, because that is what theirs
  // returns: `getMessages` has no buffer and answers `[]`.
  const none = (await (await fetch(`${b.url}/api/messages?sessionId=run-9&token=tok`)).json()) as {
    messages: unknown[]
    state: string
  }
  assert.deepEqual(none, { messages: [], state: 'idle', sessionId: 'run-9', provider: 'claude' })
})

test('#278 /api/sessions lists one entry per open run, in the vendor\'s six fields, from the run', async (t) => {
  const b = await bridge()
  t.after(() => b.close())
  b.openSession('run-2', () => meta({ title: 'the other thing', cwd: '/p' }))
  const asked = b.ask('run-2', q)

  const { sessions } = (await (await fetch(`${b.url}/api/sessions?token=tok`)).json()) as {
    sessions: Record<string, unknown>[]
  }
  // `id`, not `sessionId`: the vendor's `core.js` reads `s.id`, and the key the app never
  // looked at is why it never opened anything (#278). The other five are the vendor's list
  // item, each from the run's own record. `status` is the bridge's `awaiting` while a question
  // is outstanding, and the run's own word otherwise.
  assert.deepEqual(sessions, [
    { id: 'run-1', title: 'fix the thing', timestamp: '2026-09-11T12:00:00.000Z', cwd: '/w', provider: 'claude', status: 'busy' },
    { id: 'run-2', title: 'the other thing', timestamp: '2026-09-11T12:00:00.000Z', cwd: '/p', provider: 'claude', status: 'awaiting' },
  ])

  await respond(b, { sessionId: 'run-2', answer: 'Yes' })
  await asked
  b.closeSession('run-2')
  const after = (await (await fetch(`${b.url}/api/sessions?token=tok`)).json()) as { sessions: { id: string }[] }
  assert.deepEqual(
    after.sessions.map((s) => s.id),
    ['run-1'],
    'a closed run leaves the list',
  )
})

test('#278 the list re-reads the run on every request, and keeps the last reading it could get', async (t) => {
  // Activity after the session opened has to change the ordering on the glasses without the
  // session being reopened; and a record that cannot be read THIS time is not blanks -- the
  // last true reading stands.
  const b = new EvenRealitiesBridge({ port: 0, token: 'tok' })
  await b.listen()
  t.after(() => b.close())
  let now: SessionMetadata | undefined = meta({ timestamp: '2026-09-11T12:00:00.000Z' })
  b.openSession('run-1', () => now)
  const list = async (): Promise<Record<string, unknown>> =>
    ((await (await fetch(`${b.url}/api/sessions?token=tok`)).json()) as { sessions: Record<string, unknown>[] }).sessions[0]!

  assert.equal((await list())['timestamp'], '2026-09-11T12:00:00.000Z')
  now = meta({ timestamp: '2026-09-11T12:05:00.000Z', status: 'idle' })
  assert.equal((await list())['timestamp'], '2026-09-11T12:05:00.000Z', 'advanced without reopening')
  assert.equal((await list())['status'], 'idle')
  now = undefined
  assert.equal((await list())['timestamp'], '2026-09-11T12:05:00.000Z', 'unreadable now: the last reading stands')
  assert.deepEqual(await (await fetch(`${b.url}/api/status?sessionId=run-1&token=tok`)).json(), {
    state: 'idle',
    sessionId: 'run-1',
    provider: 'claude',
  })
})

test('#278 each listing asks a run once, so its fields and its status are one snapshot', async (t) => {
  // A status derived from a second reading could disagree with the timestamp beside it.
  const b = new EvenRealitiesBridge({ port: 0, token: 'tok' })
  await b.listen()
  t.after(() => b.close())
  let asked = 0
  b.openSession('run-1', () => {
    asked++
    return meta({ timestamp: `2026-09-11T12:00:0${asked}.000Z`, status: asked % 2 ? 'busy' : 'idle' })
  })
  asked = 0
  const { sessions } = (await (await fetch(`${b.url}/api/sessions?token=tok`)).json()) as {
    sessions: { timestamp: string; status: string }[]
  }
  assert.equal(asked, 1, 'described exactly once for the listing')
  assert.deepEqual([sessions[0]?.timestamp, sessions[0]?.status], ['2026-09-11T12:00:01.000Z', 'busy'], 'both from that one reading')
})

test('#278 the title on the wire is cut to the vendor\'s length; null status is served as null', async (t) => {
  const b = new EvenRealitiesBridge({ port: 0, token: 'tok' })
  await b.listen()
  t.after(() => b.close())
  b.openSession('run-1', () => meta({ title: 'y'.repeat(100), status: null }))
  const { sessions } = (await (await fetch(`${b.url}/api/sessions?token=tok`)).json()) as {
    sessions: { title: string; status: unknown }[]
  }
  assert.equal(sessions[0]?.title, 'y'.repeat(64))
  assert.equal(sessions[0]?.status, null, 'what is not known is not guessed')
})

test('#278 a session whose run cannot be described is not opened', async (t) => {
  // An entry with no run behind it is the invented list item this surface refuses to serve.
  const b = await bridge()
  t.after(() => b.close())
  assert.throws(() => b.openSession('run-9', () => undefined), /no metadata for session run-9/)
  assert.deepEqual(b.sessions(), ['run-1'])
})

test('#278 the buffer is per run, 500 deep, and the ids are monotonic within it', async (t) => {
  // What their `events.js` does: `MAX_MESSAGES_PER_SESSION = 500`, `nextId` per session. A
  // client that replays after a long absence gets the last 500 of ITS run, not of the machine.
  const b = await bridge()
  t.after(() => b.close())
  b.openSession('run-2', () => meta({ title: 'the other thing', cwd: '/p' }))
  for (let i = 1; i <= 501; i++) b.send('run-1', { type: 'notification', title: 'n', message: `m${i}` })
  b.send('run-2', { type: 'notification', title: 'n', message: 'other' })

  const kept = (await (await fetch(`${b.url}/api/messages?sessionId=run-1&token=tok`)).json()) as {
    messages: { id: number; message: string }[]
  }
  assert.equal(kept.messages.length, 500, 'the 501st pushed the first out')
  assert.equal(kept.messages[0]?.id, 2)
  assert.equal(kept.messages[0]?.message, 'm2')
  assert.equal(kept.messages[499]?.id, 501)
  const ids = kept.messages.map((m) => m.id)
  assert.deepEqual(ids, [...ids].sort((x, y) => x - y), 'monotonic')

  const other = (await (await fetch(`${b.url}/api/messages?sessionId=run-2&token=tok`)).json()) as {
    messages: { id: number }[]
  }
  assert.deepEqual(
    other.messages.map((m) => m.id),
    [1],
    "run-2's counter is its own",
  )
})

test('#278 a live push reaches the stream of the run it is for, and no other', async (t) => {
  // Replay is per run by construction of the buffer; this is the LIVE path, where a loop over
  // every client on the bridge would put run-1's line on run-2's glasses and no replay-based
  // test would notice.
  const b = await bridge()
  t.after(() => b.close())
  b.openSession('run-2', () => meta({ title: 'the other thing', cwd: '/p' }))
  const ac = new AbortController()
  t.after(() => ac.abort())
  const one = frames(`${b.url}/api/events?sessionId=run-1&token=tok`, 1, ac.signal)
  const two = frames(`${b.url}/api/events?sessionId=run-2&token=tok`, 1, ac.signal)
  await new Promise((r) => setTimeout(r, 100))

  b.send('run-1', { type: 'notification', title: 'n', message: 'for one' })
  assert.deepEqual((await one).map((m) => m['message']), ['for one'])
  // Sent AFTER run-1's. If run-2's stream had been given run-1's line, this is not its first frame.
  b.send('run-2', { type: 'notification', title: 'n', message: 'for two' })
  assert.deepEqual((await two).map((m) => m['message']), ['for two'])
})

test('#278 opening a run that is already open keeps what it has', async (t) => {
  // A second view of the same run in one process joins it; a reset would drop the buffer a
  // client has not replayed yet and the question the operator is looking at.
  const b = await bridge()
  t.after(() => b.close())
  b.send('run-1', { type: 'notification', title: 'n', message: 'kept' })
  b.openSession('run-1', () => meta())
  const { messages } = (await (await fetch(`${b.url}/api/messages?sessionId=run-1&token=tok`)).json()) as {
    messages: { message: string }[]
  }
  assert.deepEqual(messages.map((m) => m.message), ['kept'])
})

test('#278 a bridge that is listening refuses to listen again', async (t) => {
  // A second server would leak the first: still bound, still holding the loop open, and with
  // `#server` overwritten nothing could ever close it. Found as a twenty-minute hang.
  const b = await bridge()
  t.after(() => b.close())
  await assert.rejects(() => b.listen(), /already listening/)
})

test('#278 sending to a run that was never opened is an error, not a session', async (t) => {
  // Their server creates a session on first push. This one does not: a run the hub has not
  // opened is a run nothing will close, and a message under it would be a session the glasses
  // could open and nobody would ever answer for.
  const b = await bridge()
  t.after(() => b.close())
  assert.throws(() => b.send('run-9', { type: 'notification', title: 'n', message: 'x' }), /no session run-9/)
  await assert.rejects(() => b.ask('run-9', q), /no session run-9/)
})

test('#184 closing a run answers its outstanding question rather than hanging its caller', async (t) => {
  const b = await bridge()
  t.after(() => b.close())
  b.openSession('run-2', () => meta({ title: 'the other thing', cwd: '/p' }))
  const one = b.ask('run-1', q)
  const two = b.ask('run-2', q)
  b.closeSession('run-1')
  assert.deepEqual(await one, { answer: 'skip' }, 'nobody answered, and that is the truth')
  await new Promise((r) => setTimeout(r, 20))
  await respond(b, { sessionId: 'run-2', answer: 'Yes' })
  assert.deepEqual(await two, { answer: 'Yes' }, "closing one run does not settle another's")
  await b.close()
})
