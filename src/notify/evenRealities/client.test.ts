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
import { EventEmitter } from 'node:events'
import { ServerResponse } from 'node:http'
import { EvenRealitiesBridge, deliver, type SessionMetadata } from './client.ts'

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

test('#290 detaching a run settles its question skip and keeps everything else: the entry, the stream, the buffer', async (t) => {
  // The broker's hang-up path. `closeSession` ends the stream and drops the buffer; this
  // settles only the question, so a session retained after its run has gone reads its own
  // status rather than `awaiting`, and the app can still reconnect to it and replay it.
  const b = await bridge()
  t.after(() => b.close())
  const ac = new AbortController()
  t.after(() => ac.abort())
  const reading = frames(`${b.url}/api/events?sessionId=run-1&token=tok`, 2, ac.signal)
  // Let the stream attach first, so both frames below are pushed to it rather than buffered.
  await new Promise((r) => setTimeout(r, 100))
  const one = b.ask('run-1', q)
  await new Promise((r) => setTimeout(r, 20))

  b.detachSession('run-1')
  // Raced, because a detach that cleared the question without settling it would hang here, not fail.
  const settled = await Promise.race([one, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 1_000))])
  assert.deepEqual(settled, { answer: 'skip' }, 'nobody answered, and that is the truth')
  assert.deepEqual(b.sessions(), ['run-1'], 'still open')
  const listed = (await (await fetch(`${b.url}/api/sessions?token=tok`)).json()) as { sessions: { status: string }[] }
  assert.equal(listed.sessions[0]?.status, 'busy', "the run's own status, not awaiting")
  // The stream was not ended: a push after the detach still reaches the client it had.
  b.send('run-1', { type: 'notification', title: 'after', message: 'still here' })
  assert.deepEqual((await reading).map((f) => f['type']), ['user_question', 'notification'])
  const buffered = (await (await fetch(`${b.url}/api/messages?token=tok&sessionId=run-1`)).json()) as { messages: unknown[] }
  assert.equal(buffered.messages.length, 2, 'the buffer is intact')
  // Idempotent, and harmless on an unknown id.
  b.detachSession('run-1')
  b.detachSession('run-9')
})

/** `POST /api/prompt`, as the app sends the operator's message. */
async function prompt(b: EvenRealitiesBridge, body: unknown): Promise<Response> {
  return fetch(`${b.url}/api/prompt?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

test('#280 a prompt with no text is refused in the vendor\'s words, before the session is looked at', async (t) => {
  // Their handler reads `text` first and answers `Missing 'text' field` before it knows whether
  // a session was named; so does this one, so an app that sends both wrongly hears what theirs
  // would say. Empty string counts as missing, as `!text` makes it there.
  const b = await bridge()
  t.after(() => b.close())
  const asked = b.ask('run-1', q)
  await new Promise((r) => setTimeout(r, 50))

  for (const body of [{}, { sessionId: 'run-1' }, { sessionId: 'run-1', text: 42 }, { sessionId: 'run-1', text: '' }, 'not json']) {
    const r = await prompt(b, body)
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.deepEqual(await r.json(), { error: "Missing 'text' field" }, JSON.stringify(body))
  }
  // Neither session error was reached: text first.
  const neither = await prompt(b, { sessionId: 'run-9' })
  assert.deepEqual(await neither.json(), { error: "Missing 'text' field" }, 'an unknown session with no text is still a text error')

  const status = (await (await fetch(`${b.url}/api/status?sessionId=run-1&token=tok`)).json()) as { state: string }
  assert.equal(status.state, 'awaiting', 'none of those was an answer')
  await respond(b, { sessionId: 'run-1', answer: 'Yes' })
  assert.deepEqual(await asked, { answer: 'Yes' })
})

test('#280 a prompt that names no session, or an unknown one, is refused as /question-response refuses it', async (t) => {
  const b = await bridge()
  t.after(() => b.close())
  let settled = false
  const asked = b.ask('run-1', q).then((a) => {
    settled = true
    return a
  })
  await new Promise((r) => setTimeout(r, 50))

  const missing = await prompt(b, { text: 'go' })
  assert.equal(missing.status, 400)
  assert.deepEqual(await missing.json(), { error: "Missing 'sessionId'" })
  const unknown = await prompt(b, { text: 'go', sessionId: 'run-9' })
  assert.equal(unknown.status, 404)
  assert.deepEqual(await unknown.json(), { error: 'Session not found' })

  await new Promise((r) => setTimeout(r, 20))
  assert.equal(settled, false, 'neither was an answer to run-1')
  assert.deepEqual(b.sessions(), ['run-1'], 'and no session was started for run-9: theirs creates one, this does not')
  await respond(b, { sessionId: 'run-1', answer: 'Yes' })
  assert.deepEqual(await asked, { answer: 'Yes' })
})

test('#280 a prompt to a run with a question outstanding is that question\'s answer, and gets the vendor\'s 202', async (t) => {
  const b = await bridge()
  t.after(() => b.close())
  const asked = b.ask('run-1', q)
  await new Promise((r) => setTimeout(r, 50))

  const r = await prompt(b, { sessionId: 'run-1', text: 'hold off until the advisor finishes' })
  assert.equal(r.status, 202)
  assert.deepEqual(await r.json(), { ok: true, sessionId: 'run-1', provider: 'claude' })
  assert.deepEqual(await asked, { answer: 'hold off until the advisor finishes' })

  // Consumed: the same prompt again has nothing to answer.
  const again = await prompt(b, { sessionId: 'run-1', text: 'hold off until the advisor finishes' })
  assert.equal(again.status, 409)
  const status = (await (await fetch(`${b.url}/api/status?sessionId=run-1&token=tok`)).json()) as { state: string }
  assert.equal(status.state, 'busy', 'the run\'s own word again, nothing awaiting')
})

test('#280 a prompt to a run with nothing outstanding is refused, explained, and leaves no trace', async (t) => {
  // The narrowing itself. Their `/prompt` starts a session and steers it; this one answers a
  // question or does nothing at all. Not buffered, not a late answer, not a message on the
  // stream, and not held for the next question either.
  const b = await bridge()
  t.after(() => b.close())
  b.send('run-1', { type: 'notification', title: 'n', message: 'before' })

  const r = await prompt(b, { sessionId: 'run-1', text: 'merge it' })
  assert.equal(r.status, 409, 'the session exists and the body is fine; its STATE has no question')
  const body = (await r.json()) as { error: string; note: string }
  assert.equal(body.error, 'No question is outstanding on this session')
  assert.match(body.note, /accepted only as the answer to a question outstanding/)

  assert.deepEqual(b.takeUnsolicited('run-1'), [], 'not a veto: nothing was decided')
  const { messages } = (await (await fetch(`${b.url}/api/messages?sessionId=run-1&token=tok`)).json()) as {
    messages: { message: string }[]
  }
  assert.deepEqual(messages.map((m) => m.message), ['before'], 'nothing pushed, nothing buffered')

  // Not held either: the next question waits for its own answer.
  const asked = b.ask('run-1', q)
  await new Promise((r) => setTimeout(r, 50))
  const status = (await (await fetch(`${b.url}/api/status?sessionId=run-1&token=tok`)).json()) as { state: string }
  assert.equal(status.state, 'awaiting', 'the refused prompt did not pre-answer it')
  await respond(b, { sessionId: 'run-1', answer: 'Yes' })
  assert.deepEqual(await asked, { answer: 'Yes' })
})

test('#280 `cwd` and `provider` in a prompt body select nothing and change nothing', async (t) => {
  // Theirs reads them to pick a provider and start a session in a directory. Here they are
  // accepted, because an app sends them, and ignored: the run is the one named, the provider
  // on the wire is the claimed one, and the run's own cwd is what the list still says.
  const b = await bridge()
  t.after(() => b.close())
  const asked = b.ask('run-1', q)
  await new Promise((r) => setTimeout(r, 50))

  const r = await prompt(b, { sessionId: 'run-1', text: 'ok', provider: 'codex', cwd: '/elsewhere' })
  assert.equal(r.status, 202)
  assert.deepEqual(await r.json(), { ok: true, sessionId: 'run-1', provider: 'claude' }, 'not the provider the body claimed')
  assert.deepEqual(await asked, { answer: 'ok' })
  assert.deepEqual(b.sessions(), ['run-1'], 'no session started anywhere')
  const { sessions } = (await (await fetch(`${b.url}/api/sessions?token=tok`)).json()) as { sessions: { cwd: string; provider: string }[] }
  assert.deepEqual([sessions[0]?.cwd, sessions[0]?.provider], ['/w', 'claude'])

  // With nothing outstanding, the same body is still refused: a provider or a cwd is not a way in.
  const refused = await prompt(b, { sessionId: 'run-1', text: 'ok', provider: 'codex', cwd: '/elsewhere' })
  assert.equal(refused.status, 409)
})

test('#280 the unmatched-route refusal lists /api/prompt as served and says what a prompt can be', async (t) => {
  // The 404 body is the only thing a device on the wrong path ever sees, and it used to say
  // this surface "does not accept prompts". That is now false in one narrow way, and the body
  // has to be true again without becoming an invitation.
  const b = await bridge()
  t.after(() => b.close())
  const r = await fetch(`${b.url}/api/interrupt?token=tok`, { method: 'POST' })
  assert.equal(r.status, 404)
  const body = (await r.json()) as { error: string; served: string[]; note: string }
  assert.equal(body.error, 'Not found')
  assert.deepEqual(body.served, [...EvenRealitiesBridge.SERVED].sort())
  assert.ok(body.served.includes('/api/prompt'), 'served, so listed')
  assert.match(body.note, /POST \/api\/prompt is accepted only as the answer to a question outstanding/)
  assert.doesNotMatch(body.note, /does not accept prompts/, 'the old claim, now false')
})

/**
 * Attach a stream and give it time to be on the wire, so what follows is PUSHED rather than
 * buffered for replay. `want` counts the frames the reader waits for. Wrapped, because an
 * async function that returns a promise hands back its RESOLUTION, and awaiting that here
 * would wait for frames that nothing has sent yet.
 */
async function attached(t: import('node:test').TestContext, b: EvenRealitiesBridge, want: number) {
  const ac = new AbortController()
  t.after(() => ac.abort())
  const reading = frames(`${b.url}/api/events?sessionId=run-1&token=tok`, want, ac.signal)
  await new Promise((r) => setTimeout(r, 100))
  return { reading }
}

test('#285 a /api/question-response answer is confirmed on the stream, and the stream is closed right behind it', async (t) => {
  // The device's report, twice: "it disconnected", immediately after an answer that had worked.
  // `notify ask` exits on the answer and the exit ends the stream, so the last thing the
  // glasses saw was a drop. Now the last thing is what was received -- and closing the bridge
  // the instant `ask` resolves, as the CLI does, must not be soon enough to lose it.
  const b = await bridge()
  const { reading } = await attached(t, b, 2)
  const asked = b.ask('run-1', q)
  await new Promise((r) => setTimeout(r, 50))

  const posted = await respond(b, { sessionId: 'run-1', answer: 'Yes' })
  assert.equal(posted.status, 200, 'the vendor\'s status, unchanged')
  assert.deepEqual(await asked, { answer: 'Yes' })
  await b.close()

  const seen = await reading
  assert.deepEqual(seen[0]?.['type'], 'user_question')
  assert.deepEqual(seen[1], { type: 'notification', title: 'Received', message: 'Yes' }, 'the echo, on the wire, before the close')
})

test('#285 a /api/prompt answer is confirmed the same way, echoing the text', async (t) => {
  const b = await bridge()
  const { reading } = await attached(t, b, 2)
  const asked = b.ask('run-1', q)
  await new Promise((r) => setTimeout(r, 50))

  const r = await prompt(b, { sessionId: 'run-1', text: 'hold until the advisor finishes' })
  assert.equal(r.status, 202, 'the vendor\'s status, unchanged')
  assert.deepEqual(await asked, { answer: 'hold until the advisor finishes' })
  await b.close()

  const seen = await reading
  assert.deepEqual(seen[1], { type: 'notification', title: 'Received', message: 'hold until the advisor finishes' })
})

test('#285 the answer is not given until the confirmation has left: the write callback gates ask', async (t) => {
  // The receipt tests above cannot tell the two orders apart in one process: a write queued
  // before `end()` goes out either way. What they cannot see is the CALLBACK -- the kernel
  // taking the bytes -- and that is what `notify ask`'s exit depends on. So the callback for
  // the confirmation frame is held back here, and `ask` must not have resolved before it fired.
  let delivered = false
  const write = ServerResponse.prototype.write
  t.mock.method(ServerResponse.prototype, 'write', function (this: ServerResponse, ...args: unknown[]) {
    const cb = args.find((a) => typeof a === 'function') as ((err?: Error | null) => void) | undefined
    if (!cb || !String(args[0]).includes('"Received"')) return (write as Function).apply(this, args)
    return (write as Function).call(this, args[0], (err?: Error | null) => {
      setTimeout(() => {
        delivered = true
        cb(err)
      }, 30)
    })
  })
  const b = await bridge()
  t.after(() => b.close())
  await attached(t, b, 2)
  const asked = b.ask('run-1', q)
  await new Promise((r) => setTimeout(r, 50))

  await respond(b, { sessionId: 'run-1', answer: 'Yes' })
  assert.deepEqual(await asked, { answer: 'Yes' })
  assert.equal(delivered, true, 'ask resolved before the confirmation had reached the kernel')
})

test('#285 with nobody attached the answer still lands, and the confirmation waits in the buffer', async (t) => {
  // The glasses might be off. Nothing to write to is not a reason to hold the run's answer,
  // and the echo is buffered like anything else so a client that reconnects with `needReplay`
  // sees the outcome rather than a question that vanished.
  const b = await bridge()
  t.after(() => b.close())
  const asked = b.ask('run-1', q)
  await new Promise((r) => setTimeout(r, 20))
  await respond(b, { sessionId: 'run-1', answer: 'No' })
  assert.deepEqual(await asked, { answer: 'No' })

  const ac = new AbortController()
  t.after(() => ac.abort())
  const seen = await frames(`${b.url}/api/events?sessionId=run-1&token=tok&needReplay=true`, 2, ac.signal)
  assert.deepEqual(seen[1], { type: 'notification', title: 'Received', message: 'No' })
})

test('#285 a client that left before the answer does not hold it, and the next one still gets the echo', async (t) => {
  const b = await bridge()
  t.after(() => b.close())
  const gone = new AbortController()
  void frames(`${b.url}/api/events?sessionId=run-1&token=tok`, 9, gone.signal).catch(() => undefined)
  await new Promise((r) => setTimeout(r, 100))
  const asked = b.ask('run-1', q)
  await new Promise((r) => setTimeout(r, 20))
  gone.abort()
  await new Promise((r) => setTimeout(r, 50))

  await respond(b, { sessionId: 'run-1', answer: 'skip' })
  assert.deepEqual(await asked, { answer: 'skip' }, 'a gone client is not a reason to hold the answer')
  const { messages } = (await (await fetch(`${b.url}/api/messages?sessionId=run-1&token=tok`)).json()) as {
    messages: { type: string; message?: string }[]
  }
  assert.deepEqual(messages.at(-1), { id: 2, type: 'notification', title: 'Received', message: 'skip' })
})

test('#285 the echo is cut to the line the transport can show, one short and an ellipsis', async (t) => {
  const b = await bridge()
  t.after(() => b.close())
  const asked = b.ask('run-1', q)
  await new Promise((r) => setTimeout(r, 20))
  const long = 'x'.repeat(300)
  await prompt(b, { sessionId: 'run-1', text: long })
  assert.deepEqual(await asked, { answer: long }, 'the run gets all of it; only the echo is cut')
  const { messages } = (await (await fetch(`${b.url}/api/messages?sessionId=run-1&token=tok`)).json()) as {
    messages: { message?: string }[]
  }
  const echo = messages.at(-1)?.message ?? ''
  assert.equal(EvenRealitiesBridge.CONFIRM_CHARS, 120, 'the HUD line')
  assert.equal(echo.length, EvenRealitiesBridge.CONFIRM_CHARS)
  assert.equal(echo, `${'x'.repeat(EvenRealitiesBridge.CONFIRM_CHARS - 1)}…`)
})

test('#285 a write that loses the race with the end of its stream does not take the process down', async (t) => {
  // The guard in `deliver` looks before it writes, and nothing checked can change between the
  // look and the write. This is the one that does not go through `deliver`'s guard at all: the
  // heartbeat, and any write the guard has already passed when the stream ends underneath it.
  // On this Node a write after end EMITS `error` on the response, and an unlistened `error`
  // is an uncaught exception. The end is forced here between the look and the write.
  const write = ServerResponse.prototype.write
  t.mock.method(ServerResponse.prototype, 'write', function (this: ServerResponse, ...args: unknown[]) {
    if (String(args[0]).includes('"Received"') && !this.writableEnded) this.end()
    return (write as Function).apply(this, args)
  })
  const b = await bridge()
  t.after(() => b.close())
  await attached(t, b, 1)
  const asked = b.ask('run-1', q)
  await new Promise((r) => setTimeout(r, 50))
  await respond(b, { sessionId: 'run-1', answer: 'Yes' })
  assert.deepEqual(await asked, { answer: 'Yes' }, 'the answer still lands')
  // The `error` is emitted on a later tick; a process that was going to die does so here.
  await new Promise((r) => setTimeout(r, 50))
})

/** A client no server would hand out: an emitter with whatever `write` the case needs. */
function fakeClient(over: Partial<Record<'write' | 'destroyed' | 'writableEnded' | 'socket', unknown>>): ServerResponse {
  const c = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    socket: { writable: true },
    write: (_d: string, cb: (err?: Error | null) => void) => {
      cb(null)
      return true
    },
    ...over,
  })
  return c as unknown as ServerResponse
}

test('#285 deliver settles on every client failure, never rejects, and drops the client that failed', async () => {
  const ok = fakeClient({})
  const throws = fakeClient({
    write: () => {
      throw new Error('EPIPE')
    },
  })
  const errs = fakeClient({ write: (_d: string, cb: (err?: Error | null) => void) => (cb(new Error('ERR_STREAM_DESTROYED')), false) })
  // These three must be SKIPPED, not written and caught: a write after end EMITS `error`, and
  // one to an unwritable socket buffers its callback for ever. A write that merely threw would
  // leave the same set behind, so each records whether it was asked at all.
  const written: string[] = []
  const skipped = (why: string, over: Record<string, unknown>) =>
    fakeClient({
      ...over,
      write: (_d: string, cb: (err?: Error | null) => void) => {
        written.push(why)
        cb(null)
        return true
      },
    })
  const ended = skipped('ended', { writableEnded: true })
  const destroyed = skipped('destroyed', { destroyed: true })
  const unwritable = skipped('unwritable', { socket: { writable: false } })
  // `_writeRaw` returns false and never calls back once the socket is destroyed underneath a
  // response that has not yet heard so. `close` is what arrives; `deliver` waits on it too.
  const silent = fakeClient({ write: () => false })
  setTimeout(() => silent.emit('close'), 20)

  const clients = new Set([ok, throws, errs, ended, destroyed, unwritable, silent])
  await deliver(clients, 'data: x\n\n')
  assert.deepEqual([...clients], [ok, silent], 'the two that took it stay; the five that could not are dropped')
  assert.deepEqual(written, [], 'none of the three was written to')
  assert.equal(silent.listenerCount('close'), 0, 'the close listener does not accumulate per write')
  assert.equal(ok.listenerCount('close'), 0)

  await deliver(new Set(), 'data: x\n\n')
})

/** `GET /api/sessions/:id/history`, as the app asks for it on opening a session. */
async function history(b: EvenRealitiesBridge, id: string, query = ''): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${b.url}/api/sessions/${id}/history?token=tok${query}`)
  return { status: r.status, body: await r.json() }
}

test('#284 history is the tail of the buffer, oldest first, and the limit is clamped the way theirs is', async (t) => {
  // Theirs: `Math.min(parseInt(req.query.limit) || 10, 10)` in the route, then
  // `slice(-Math.min(limit, 10))` in the provider. Every case below is that arithmetic run by
  // hand, including the one nobody would design: a negative limit is truthy, survives both
  // `min`s, and `slice(-(-5))` drops the first five instead of keeping the last.
  const b = await bridge()
  t.after(() => b.close())
  for (let i = 1; i <= 13; i++) b.send('run-1', { type: 'notification', title: 'conclave', message: `n${i}` })
  const texts = async (query: string) => {
    const { status, body } = await history(b, 'run-1', query)
    assert.equal(status, 200, query || '(no limit)')
    return (body as { history: { text: string }[] }).history.map((e) => e.text)
  }
  const n = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `n${from + i}`)

  assert.equal(EvenRealitiesBridge.HISTORY_ITEMS, 10)
  assert.deepEqual(await texts(''), n(4, 13), 'missing: the last ten, oldest first')
  assert.deepEqual(await texts('&limit=abc'), n(4, 13), 'junk: NaN is falsy, so ten')
  assert.deepEqual(await texts('&limit=0'), n(4, 13), 'zero: falsy, so ten')
  assert.deepEqual(await texts('&limit=3'), n(11, 13), 'three: the last three')
  assert.deepEqual(await texts('&limit=25'), n(4, 13), 'huge: capped at ten')
  assert.deepEqual(await texts('&limit=-5'), n(6, 13), 'negative: theirs drops the head, so does this')
  assert.deepEqual(await texts('&limit=-50'), [], 'negative past the end: nothing, as theirs')
})

test('#284 an entry is the vendor\'s `{ role, text }` and nothing else; only the echo is the user\'s', async (t) => {
  // Their `getHistory` pushes `{ role: msg.type, text }` from a transcript, where `msg.type` is
  // `user` or `assistant`. Nothing in this buffer is a transcript: it all went TO the device,
  // so it is all conclave's turn -- except the #285 confirmation, which is the operator's answer
  // echoed back. A scrollback showing that as the assistant's would have conclave answering
  // its own question.
  const b = await bridge()
  t.after(() => b.close())
  b.send('run-1', { type: 'notification', title: 'Decided', message: 'merge it — Veto' })
  b.send('run-1', {
    type: 'user_question',
    questions: [
      { question: 'first?', header: 'A', options: [] },
      { question: 'second?', header: 'B', options: [] },
    ],
  })
  const asked = b.ask('run-1', q)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal((await respond(b, { sessionId: 'run-1', answer: 'Yes' })).status, 200)
  assert.deepEqual(await asked, { answer: 'Yes' })

  const { body } = await history(b, 'run-1')
  const entries = (body as { history: Record<string, unknown>[] }).history
  assert.deepEqual(entries, [
    { role: 'assistant', text: 'merge it — Veto' },
    { role: 'assistant', text: 'first?\nsecond?' },
    { role: 'assistant', text: 'go?' },
    { role: 'user', text: 'Yes' },
  ])
  for (const e of entries) assert.deepEqual(Object.keys(e), ['role', 'text'], 'no invented field')
  assert.deepEqual(Object.keys(body as object), ['history'], 'and no invented field on the envelope')
})

test('#284 an unknown session is `{ history: [] }` at 200, as theirs, and the id is decoded and refused as Express does', async (t) => {
  // Not `/messages`' choice copied across: the SDK's `getSessionMessages` returns `[]` for an
  // id it has no transcript for, so their route answers 200 with an empty list and no `error`.
  const b = await bridge()
  t.after(() => b.close())
  b.openSession('run 2', () => meta({ title: 'spaced' }))
  b.send('run 2', { type: 'notification', title: 'conclave', message: 'here' })

  assert.deepEqual(await history(b, 'run-9'), { status: 200, body: { history: [] } })
  const decoded = await history(b, 'run%202')
  // Only that the decoded id reached ITS session: the entry's shape is the mapping test's claim.
  assert.deepEqual((decoded.body as { history: { text: string }[] }).history.map((e) => e.text), ['here'], 'decoded')
  // An undecodable id is Express's 400, not a lookup: their router refuses `Failed to decode
  // param` with `status = 400` before the handler runs (`router/lib/layer.js`, `decodeParam`).
  // The status is theirs. The JSON body is OURS -- theirs is Express's default HTML page,
  // which is no contract -- so only the status is held to the vendor here.
  // Observed on the log line as well as the wire: `#log` is one line per request, with the
  // status served, and the 400 was once written AFTER a 200 for the same request had been.
  const quiet = process.env['CONCLAVE_EVEN_QUIET']
  delete process.env['CONCLAVE_EVEN_QUIET']
  const lines: string[] = []
  // The method itself, not a bound copy: what is put back must be the very function that was
  // there, or the test leaves `process.stderr.write` a different object than it found.
  const originalWrite = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    if (String(chunk).startsWith('[even] ')) lines.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  t.after(() => {
    process.stderr.write = originalWrite
    if (quiet !== undefined) process.env['CONCLAVE_EVEN_QUIET'] = quiet
  })
  assert.equal((await history(b, '%E0%A4%A')).status, 400, 'undecodable: refused as Express refuses it')
  process.stderr.write = originalWrite
  if (quiet !== undefined) process.env['CONCLAVE_EVEN_QUIET'] = quiet
  assert.equal(process.stderr.write, originalWrite, 'stderr is exactly as it was found')
  assert.equal(lines.length, 1, `one log line for one request, got: ${JSON.stringify(lines)}`)
  assert.match(lines[0]!, /^\[even\] \S+ 400 GET \/api\/sessions\/%E0%A4%A\/history\n$/, 'the status served, not one that was not')
  assert.equal((await fetch(`${b.url}/api/sessions?token=tok`)).status, 200, 'and the server is still up')
})

test('#284 the history route is served, listed as served, and only as GET', async (t) => {
  const b = await bridge()
  t.after(() => b.close())
  assert.ok(EvenRealitiesBridge.SERVED.has('/api/sessions/:id/history'))
  const r = await fetch(`${b.url}/api/sessions/run-1/history?token=tok`, { method: 'POST' })
  assert.equal(r.status, 404, 'theirs is `router.get`; a POST is unmatched')
  const body = (await r.json()) as { served: string[] }
  assert.deepEqual(body.served, [...EvenRealitiesBridge.SERVED].sort())
  assert.ok(body.served.includes('/api/sessions/:id/history'), 'served, so listed')
  assert.equal((await fetch(`${b.url}/api/sessions/run-1/history`)).status, 401, 'and behind the token like the rest')
})
