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
import { EvenRealitiesBridge } from './client.ts'

async function bridge(): Promise<EvenRealitiesBridge> {
  // Port 0: the OS picks a free one, so two runs never collide.
  const b = new EvenRealitiesBridge({ port: 0, token: 'tok', sessionId: 's' })
  await b.listen()
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

  const reading = frames(`${b.url}/api/events?sessionId=s&token=tok`, 1, ac.signal)
  // Let the stream attach before sending, or the message is buffered rather than pushed --
  // which is correct behaviour and not what this test is about.
  await new Promise((r) => setTimeout(r, 100))
  b.send({ type: 'notification', title: 'Decided', message: 'letting the advisor fix land' })

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
  b.send({ type: 'notification', title: 'A', message: 'first' })
  b.send({ type: 'notification', title: 'B', message: 'second' })

  const ac = new AbortController()
  t.after(() => ac.abort())
  const seen = await frames(`${b.url}/api/events?sessionId=s&token=tok&needReplay=true`, 2, ac.signal)
  assert.deepEqual(
    seen.map((m) => m['message']),
    ['first', 'second'],
    'both, in order',
  )
})

test('#184 a question is answered through /api/question-response', async (t) => {
  const b = await bridge()
  t.after(() => b.close())

  const asked = b.ask({
    header: 'Approval',
    question: 'Merge fix-er-adapter?',
    options: [
      { label: 'Merge', description: '' },
      { label: 'Hold', description: '' },
    ],
  })
  await new Promise((r) => setTimeout(r, 50))
  const posted = await fetch(`${b.url}/api/question-response?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's', answer: 'Merge' }),
  })
  assert.equal(posted.status, 200)
  assert.deepEqual(await asked, { answer: 'Merge' })
})

test('#184 a second concurrent question is refused rather than queued', async (t) => {
  // `/question-response` carries no question id, so two outstanding questions cannot be told
  // apart -- and the second answer would be attributed to whichever was being held.
  const b = await bridge()
  t.after(() => b.close())

  const first = b.ask({ header: 'A', question: 'first?', options: [] })
  await assert.rejects(
    () => b.ask({ header: 'B', question: 'second?', options: [] }),
    /already outstanding/,
  )
  await fetch(`${b.url}/api/question-response?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's', answer: 'done' }),
  })
  assert.deepEqual(await first, { answer: 'done' })
})

test('#184 an unparseable answer is `skip`, never an invented one', async (t) => {
  const b = await bridge()
  t.after(() => b.close())
  const asked = b.ask({ header: 'A', question: 'go?', options: [] })
  await new Promise((r) => setTimeout(r, 50))
  await fetch(`${b.url}/api/question-response?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  })
  assert.deepEqual(await asked, { answer: 'skip' }, 'an unreadable body is not an answer')
})

test('#184 closing answers an outstanding question rather than hanging its caller', async () => {
  const b = await bridge()
  const asked = b.ask({ header: 'A', question: 'go?', options: [] })
  await b.close()
  assert.deepEqual(await asked, { answer: 'skip' }, 'nobody answered, and that is the truth')
})
