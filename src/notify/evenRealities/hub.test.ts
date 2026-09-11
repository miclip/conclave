/**
 * One bridge shared by several runs. #184, #278.
 *
 * The failure this prevents is not subtle: `registry.ts` built a transport per broker on a
 * fixed port, so the second concurrent run's `listen()` met `EADDRINUSE`. The subtler one is
 * what would have happened if it had not — two runs attached to one device, each taking
 * whichever answer arrived next. #278 is what lets both ask at once without that: each run is
 * its own session on the wire, so an answer names the run it is for.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import type { SessionMetadata } from './client.ts'
import { EvenRealitiesHub, resetSharedHub, sharedHub } from './hub.ts'

/** A run's metadata as a session would describe it; mutable so a test can advance it. */
function meta(over: Partial<SessionMetadata> = {}): SessionMetadata {
  return { title: 'fix the thing', timestamp: '2026-09-11T12:00:00.000Z', cwd: '/w', status: 'busy', ...over }
}


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
  const h = new EvenRealitiesHub({ port: 0, token: 'tok' })
  await h.listen()
  return h
}

/** Answer the question outstanding on one run, as the app would. */
async function answer(h: EvenRealitiesHub, runId: string, text: string): Promise<void> {
  await fetch(`${h.bridge.url}/api/question-response?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: runId, answer: text }),
  })
}

async function sessions(h: EvenRealitiesHub): Promise<{ id: string; title: string; status: string }[]> {
  const body = (await (await fetch(`${h.bridge.url}/api/sessions?token=tok`)).json()) as {
    sessions: { id: string; title: string; status: string }[]
  }
  return body.sessions
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
  t.after(() => h.bridge.close())

  // Two views, one listen. Before this each broker built its own transport on port 3457.
  const a = h.view('run-a', 'conclave', () => meta())
  const b = h.view('run-b', 'patchnote', () => meta())
  // Both are `even-realities`: that is the transport's identity, which `--transport` resolves
  // and the run record reports. What distinguishes the runs is the name on the messages.
  assert.equal(a.name, 'even-realities')
  assert.equal(b.name, 'even-realities')
  assert.equal(a.limits.canReceive, true, 'a view is an ordinary transport to its broker')
})

test('#278 a view is a session on the wire: the id routes, the title is the run\'s goal', async (t) => {
  const h = await hub()
  t.after(() => h.bridge.close())
  h.view('run-a', 'conclave', () => meta({ title: 'merge fix-189' }))
  h.view('run-b', 'conclave', () => meta({ title: 'rebase onto main' }))

  // Two runs from the same directory: the same name, and still two sessions, because nothing
  // is looked up by name. Read off the list the app polls, not off the hub. What tells them
  // apart on the glasses is the goal, which is the title.
  assert.deepEqual(
    (await sessions(h)).map((s) => [s.id, s.title]),
    [
      ['run-a', 'merge fix-189'],
      ['run-b', 'rebase onto main'],
    ],
  )
})

test('#184 every line the operator reads is prefixed with the name, not the id', async (t) => {
  const h = await hub()
  t.after(() => h.bridge.close())

  await h.view('run-a', 'conclave', () => meta()).send({ kind: 'progress', headline: 'checks green' })
  await h.view('run-b', 'patchnote', () => meta()).send({ kind: 'progress', headline: 'checks green' })

  // Read off the wire the glasses read, replay included, rather than off anything the hub
  // says about itself. Each run's stream carries its own line and only its own.
  const ac = new AbortController()
  t.after(() => ac.abort())
  const a = await frames(`${h.bridge.url}/api/events?token=tok&sessionId=run-a&needReplay=true`, 1, ac.signal)
  const b = await frames(`${h.bridge.url}/api/events?token=tok&sessionId=run-b&needReplay=true`, 1, ac.signal)

  // The same headline from two runs has to arrive distinguishable. An id would not read on a
  // HUD; the name is what the operator already calls the thing.
  assert.deepEqual(a.map((f) => f['message']), ['[conclave] checks green'])
  assert.deepEqual(b.map((f) => f['message']), ['[patchnote] checks green'])
})

test('#278 two runs ask at once, and each is answered by name of its session, not by turn', async (t) => {
  // The constraint #184 carried, lifted. The second run's `send` used to block until the first
  // was answered, because one session multiplexed every run and an answer could not say which
  // it was for. Now it asks immediately, and the answers can arrive in either order.
  const h = await hub()
  t.after(() => h.bridge.close())
  const a = h.view('run-a', 'conclave', () => meta())
  const b = h.view('run-b', 'patchnote', () => meta())

  const askedA = await a.send(question('merge fix-189?'))
  const first = a.receive!(askedA.id)
  let secondSent = false
  const second = b.send(question('rebase?')).then(async (sent) => {
    secondSent = true
    return b.receive!(sent.id)
  })
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(secondSent, true, 'the second question is put to the glasses without waiting')
  assert.deepEqual(
    (await sessions(h)).map((s) => [s.id, s.status]),
    [
      ['run-a', 'awaiting'],
      ['run-b', 'awaiting'],
    ],
    'both outstanding, and the list says so',
  )

  // Answered second-first. Under the old serialisation this answer would have been the first
  // run's.
  await answer(h, 'run-b', 'No')
  assert.equal((await second).option, 'no', 'the run whose session was named gets the answer')
  await answer(h, 'run-a', 'Yes')
  assert.equal((await first).option, 'yes')
})

test('#278 a second question on the SAME run is still refused: one outstanding per session', async (t) => {
  // Not lifted, and not meant to be. `/question-response` names a session and no question, so
  // two outstanding on one run cannot be told apart. The surface rejects rather than guesses.
  const h = await hub()
  t.after(() => h.bridge.close())
  const a = h.view('run-a', 'conclave', () => meta())

  const one = await a.send(question('merge?'))
  const first = a.receive!(one.id)
  const two = await a.send(question('rebase?'))
  await assert.rejects(() => a.receive!(two.id), /already outstanding on session run-a/)
  await answer(h, 'run-a', 'Yes')
  assert.equal((await first).option, 'yes')
})

test('#278 a veto lands on the run whose session it names', async (t) => {
  const h = await hub()
  t.after(() => h.bridge.close())
  const a = h.view('run-a', 'conclave', () => meta())
  const b = h.view('run-b', 'patchnote', () => meta())
  await a.send({ kind: 'decided', headline: 'letting it land', options: [{ id: 'cut', label: 'Cut it short' }] })
  await b.send({ kind: 'decided', headline: 'letting it land', options: [{ id: 'cut', label: 'Cut it short' }] })

  await answer(h, 'run-b', 'Cut it short')
  assert.deepEqual(await a.poll!(), [], 'run-a was not vetoed')
  assert.deepEqual(await b.poll!(), [{ option: 'cut', from: { id: 'even-realities', kind: 'human' } }])
})

test('#184 the bridge closes with the last view, not the first', async (t) => {
  const h = await hub()
  // Closing twice is harmless; this is so a FAILED assertion below cannot leave a listening
  // server keeping the runner alive forever, which is how a mutation run hung for twenty minutes.
  t.after(() => h.bridge.close())
  const url = h.bridge.url
  h.view('run-a', 'conclave', () => meta())
  h.view('run-b', 'patchnote', () => meta())

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

  await h.release('run-a')
  // The device belongs to the machine. A run finishing must not take the glasses away from
  // one that is still going -- but the finished run leaves the list.
  assert.equal(await reachable(), true, 'still listening while another view holds it')
  assert.deepEqual(
    (await sessions(h)).map((s) => s.id),
    ['run-b'],
  )

  await h.release('run-b')
  assert.equal(await reachable(), false, 'and closed once the last one lets go')
})

test('#278 a run with two views keeps its session until both are released', async (t) => {
  const h = await hub()
  t.after(() => h.bridge.close())
  h.view('run-a', 'conclave', () => meta())
  h.view('run-a', 'conclave', () => meta())
  h.view('run-b', 'patchnote', () => meta())

  await h.release('run-a')
  assert.deepEqual((await sessions(h)).map((s) => s.id), ['run-a', 'run-b'], 'one view of run-a remains')
  await h.release('run-a')
  assert.deepEqual((await sessions(h)).map((s) => s.id), ['run-b'])
})

test('#278 a hub whose last run ended listens again for the next one', async (t) => {
  // `#listening` is a one-shot; after the last release closes the server it has to be
  // forgotten, or the next run's `send` awaits a listen that finished on a dead socket.
  const h = new EvenRealitiesHub({ port: 0, token: 'tok' })
  t.after(() => h.bridge.close())
  await h.view('run-a', 'conclave', () => meta()).send({ kind: 'progress', headline: 'one' })
  await h.release('run-a')

  const again = h.view('run-b', 'patchnote', () => meta())
  await again.send({ kind: 'progress', headline: 'two' })
  assert.deepEqual((await sessions(h)).map((s) => s.id), ['run-b'], 'reachable, on a fresh server')
})

test('#184 the process has one hub, however many runs ask for it', () => {
  // The property the whole change rests on, and the one a reader would otherwise have to
  // infer from `??=`. `registry.ts` calls this per broker; if it built a new hub each time
  // the port collision is exactly back.
  resetSharedHub()
  try {
    // Port 0 so nothing binds 3456 here. Never listened: this is about identity.
    const first = sharedHub({ port: 0, token: 'tok' })
    const second = sharedHub({ port: 0, token: 'tok' })
    assert.equal(first, second, 'a second caller gets the hub that already exists')

    // And the views off it are distinct, which is what lets two runs be told apart.
    assert.notEqual(first.view('run-a', 'conclave', () => meta()), second.view('run-b', 'patchnote', () => meta()))
  } finally {
    // Left clean for whatever runs next: a hub carrying this test's options would give the
    // next caller a bridge on the wrong port.
    resetSharedHub()
  }
})
