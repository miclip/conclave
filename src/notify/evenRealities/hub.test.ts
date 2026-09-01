/**
 * One bridge shared by several runs. #184.
 *
 * The failure this prevents is not subtle: `registry.ts` built a transport per broker on a
 * fixed port, so the second concurrent run's `listen()` met `EADDRINUSE`. The subtler one is
 * what would have happened if it had not — two runs attached to one device, each taking
 * whichever answer arrived next.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { EvenRealitiesHub, resetSharedHub, sharedHub } from './hub.ts'

/** Read Server-Sent Events until `want` frames have arrived, replay included. */
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

async function hub(): Promise<EvenRealitiesHub> {
  const h = new EvenRealitiesHub({ port: 0, token: 'tok', sessionId: 's' })
  await h.listen()
  return h
}

/** Answer whatever question is outstanding, as the app would. */
async function answer(h: EvenRealitiesHub, text: string): Promise<void> {
  await fetch(`${h.transport.bridge.url}/api/question-response?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's', answer: text }),
  })
}

const question = (headline: string) => ({
  kind: 'approval' as const,
  headline,
  options: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ],
})

test('#184 two runs share one bridge instead of fighting over the port', async (t) => {
  const h = await hub()
  t.after(() => h.transport.close())

  // Two views, one listen. Before this each broker built its own transport on port 3457.
  const a = h.view('conclave')
  const b = h.view('patchnote')
  // Both are `even-realities`: that is the transport's identity, which `--transport` resolves
  // and the run record reports. What distinguishes the runs is the name on the messages.
  assert.equal(a.name, 'even-realities')
  assert.equal(b.name, 'even-realities')
  assert.equal(a.limits.canReceive, true, 'a view is an ordinary transport to its broker')
})

test('#184 every line the operator reads is prefixed with the name, not the id', async (t) => {
  const h = await hub()
  t.after(() => h.transport.close())

  await h.view('conclave').send({ kind: 'progress', headline: 'checks green' })
  await h.view('patchnote').send({ kind: 'progress', headline: 'checks green' })

  // Read off the wire the glasses read, replay included, rather than off anything the hub
  // says about itself.
  const ac = new AbortController()
  t.after(() => ac.abort())
  const got = await frames(`${h.transport.bridge.url}/api/events?token=tok&sessionId=s&needReplay=true`, 2, ac.signal)

  // The same headline from two runs has to arrive distinguishable. An id would not read on a
  // HUD; the name is what the operator already calls the thing.
  assert.deepEqual(
    got.map((f) => f['message']),
    ['[conclave] checks green', '[patchnote] checks green'],
  )
})

test('#184 one question is outstanding at a time, because the answer names the session not the question', async (t) => {
  const h = await hub()
  t.after(() => h.transport.close())
  const a = h.view('conclave')
  const b = h.view('patchnote')

  const asked = await a.send(question('merge fix-189?'))
  const first = a.receive!(asked.id)

  // The second run asks while the first is unanswered. Its `send` does NOT resolve: the
  // question is not put to the glasses at all until the device is free, because
  // `/api/question-response` carries `{sessionId, answer}` and an answer arriving with two
  // outstanding says nothing about which it belongs to.
  let secondSent = false
  let secondDone = false
  const second = b.send(question('rebase?')).then(async (sent) => {
    secondSent = true
    const got = await b.receive!(sent.id)
    secondDone = true
    return got
  })

  await new Promise((r) => setTimeout(r, 80))
  assert.equal(secondSent, false, 'the queued question is not shown while another is outstanding')

  await answer(h, 'Yes')
  assert.equal((await first).option, 'yes', 'the run that asked first gets the answer')
  assert.equal(secondDone, false, 'and the queued one is not handed the same answer')

  await new Promise((r) => setTimeout(r, 80))
  await answer(h, 'No')
  assert.equal((await second).option, 'no', 'it asks, and is answered, when its turn comes')
})

test('#184 the bridge closes with the last view, not the first', async () => {
  const h = await hub()
  const url = h.transport.bridge.url
  h.view('conclave')
  h.view('patchnote')

  // Asked of the SOCKET, not of the hub. `send` buffers whether or not the server is up, so a
  // test that only sent would pass with the bridge already torn down -- which is exactly what
  // it is meant to catch.
  const reachable = async (): Promise<boolean> => {
    try {
      await fetch(`${url}/api/sessions?token=tok`)
      return true
    } catch {
      return false
    }
  }
  assert.equal(await reachable(), true, 'precondition: it is listening')

  await h.release()
  // The device belongs to the machine. A run finishing must not take the glasses away from
  // one that is still going.
  assert.equal(await reachable(), true, 'still listening while another view holds it')

  await h.release()
  assert.equal(await reachable(), false, 'and closed once the last one lets go')
})

test('#184 the process has one hub, however many runs ask for it', () => {
  // The property the whole change rests on, and the one a reader would otherwise have to
  // infer from `??=`. `registry.ts` calls this per broker; if it built a new hub each time
  // the port collision is exactly back.
  resetSharedHub()
  try {
    // Port 0 so nothing binds 3457 here. Never listened: this is about identity.
    const first = sharedHub({ port: 0, token: 'tok', sessionId: 's' })
    const second = sharedHub({ port: 0, token: 'tok', sessionId: 's' })
    assert.equal(first, second, 'a second caller gets the hub that already exists')

    // And the views off it are distinct, which is what lets two runs be told apart.
    assert.notEqual(first.view('conclave'), second.view('patchnote'))
  } finally {
    // Left clean for whatever runs next: a hub carrying this test's options would give the
    // next caller a bridge on the wrong port.
    resetSharedHub()
  }
})
