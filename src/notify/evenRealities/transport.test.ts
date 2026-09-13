/**
 * The `Transport` wrapper, driven through the broker the way the operating agent drives it.
 *
 *   node --test src/notify/evenRealities/transport.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { tempDir } from '../../testkit/tempDir.ts'
import { Broker } from '../broker.ts'
import { TransportRefused, transportNames, resolveTransport } from '../registry.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BrokerBackedTransport } from './brokerTransport.ts'
import { EvenRealitiesBridge, type SessionMetadata } from './client.ts'
import { SessionRecorder } from '../../workspace/sessionRecord.ts'

/** A run's metadata as a session would describe it; mutable so a test can advance it. */
function meta(over: Partial<SessionMetadata> = {}): SessionMetadata {
  return { title: 'fix the thing', timestamp: '2026-09-11T12:00:00.000Z', cwd: '/w', status: 'busy', ...over }
}

import { EvenRealitiesTransport } from './transport.ts'

/** A live run's record, written by the real writer, so the registry has something to resolve. */
function record(root: string, id: string): SessionRecorder {
  return new SessionRecorder(root, {
    id,
    pid: process.pid,
    cwd: root,
    goal: 'the goal on the glasses',
    front: 'session',
    operator: 'agent',
    state: 'running',
    startedAt: 1_700_000_000_000,
    messages: 0,
    participants: [],
    build: 'test-build',
  })
}

/** One run's transport over a bridge that is listening. */
async function up(): Promise<EvenRealitiesTransport<EvenRealitiesBridge>> {
  const bridge = new EvenRealitiesBridge({ port: 0, token: 'tok' })
  await bridge.listen()
  bridge.openSession('run-1', () => meta())
  return new EvenRealitiesTransport(bridge, 'run-1')
}

/** Answer whatever question is outstanding on the run, as the app would. */
async function answer(t: EvenRealitiesTransport<EvenRealitiesBridge>, text: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 80))
  await fetch(`${t.bridge.url}/api/question-response?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'run-1', answer: text }),
  })
}

test('#184 it is registered, so --transport even-realities resolves', (t2) => {
  // Resolved against a real run, because that is the only way it resolves now (#278).
  const root = tempDir(t2, 'conclave-er-registry')
  execFileSync('git', ['init', '-q'], { cwd: root })
  record(root, 'run-1')
  const was = process.cwd()
  process.chdir(root)
  try {
    assert.ok(transportNames().includes('even-realities'))
    const t = resolveTransport('even-realities', { runId: 'run-1' })
    assert.equal(t?.name, 'even-realities')
    assert.equal(t?.limits.canReceive, true)
    assert.ok(t instanceof BrokerBackedTransport, 'a run speaks through the broker, never a bridge of its own (#286)')
  } finally {
    process.chdir(was)
  }
})

test('#278 resolving with --run names that run; without one, or an unreadable one, it is refused', (t2) => {
  // The id ROUTES: it is what the glasses send back on `/question-response`. The friendly name
  // is a label on the messages and never the id, because two runs in one directory share it.
  // No id is minted in the absence of a run, and no run is resolved whose record cannot be
  // read: a session is a run, and its list entry is that run's record.
  //
  // And resolving TOUCHES NOTHING (#286): the socket is dialled, and the broker started, on the
  // first send. A command with nothing to send starts no daemon.
  const root = tempDir(t2, 'conclave-er-registry')
  execFileSync('git', ['init', '-q'], { cwd: root })
  record(root, '20260911-114005-36207')
  const was = process.cwd()
  process.chdir(root)
  process.env['CONCLAVE_NOTIFY_NAME'] = 'shown'
  const socket = join(root, 'even.sock')
  process.env['CONCLAVE_EVEN_SOCKET'] = socket
  try {
    const t = resolveTransport('even-realities', { runId: '20260911-114005-36207' })
    assert.equal((t as BrokerBackedTransport).runId, '20260911-114005-36207')
    assert.equal((t as BrokerBackedTransport).label, 'shown', 'the name labels messages')
    assert.throws(() => resolveTransport('even-realities'), TransportRefused)
    assert.throws(() => resolveTransport('even-realities', { runId: '  ' }), /needs the run/, 'blank is absent')
    assert.throws(() => resolveTransport('even-realities', { runId: 'nope' }), /no readable record for run nope/)
    assert.ok(resolveTransport('fake'), 'a transport that needs no run is untouched')
    assert.equal(existsSync(socket), false, 'nothing was dialled or started by resolving')
  } finally {
    delete process.env['CONCLAVE_NOTIFY_NAME']
    delete process.env['CONCLAVE_EVEN_SOCKET']
    process.chdir(was)
  }
})

test('#184 a tap on an offered option comes back as that option', async (t2) => {
  // The label is what the glasses show and what the answer carries; the id is what the broker
  // refuses if it was never offered. Mapping one to the other here is what keeps a tap an
  // action rather than prose.
  const t = await up()
  t2.after(() => t.bridge.close())
  const dir = tempDir(t2, 'conclave-er')

  const asking = new Broker(dir).ask(
    {
      kind: 'approval',
      headline: 'Merge fix-er-adapter?',
      options: [
        { id: 'yes', label: 'Merge' },
        { id: 'no', label: 'Hold' },
      ],
      href: 'https://example.test/pr/1',
    },
    t,
  )
  await answer(t, 'Merge')

  assert.deepEqual(await asking, { option: 'yes', by: { id: 'even-realities', kind: 'human' } })
  const [rec] = new Broker(dir).decisions()
  assert.equal(rec?.answer?.by.kind, 'human', 'a human answered, and the record says so')
  assert.equal(rec?.transport, 'even-realities')
})

test('#184 speech that is not an offered label comes back as text for the caller', async (t2) => {
  // The rule the whole inbound design rests on: nothing here parses English into an action. An
  // utterance is text, and the operating agent -- which has the context -- decides what it meant.
  const t = await up()
  t2.after(() => t.bridge.close())

  const asking = new Broker(tempDir(t2, 'conclave-er')).ask(
    { kind: 'approval', headline: 'Merge?', options: [{ id: 'yes', label: 'Merge' }] },
    t,
  )
  await answer(t, 'hold off until the advisor finishes')

  const got = await asking
  assert.equal(got?.option, undefined, 'speech must not become an option')
  assert.equal(got?.text, 'hold off until the advisor finishes')
})

test('#184 a tell is a notification and never opens a question', async (t2) => {
  // `tell` must not put a dialog in front of someone that nothing is waiting on. Asserted by
  // the bridge staying answerable: a question outstanding would refuse the next one.
  const t = await up()
  t2.after(() => t.bridge.close())

  await new Broker(tempDir(t2, 'conclave-er')).tell({ kind: 'decided', headline: 'letting the advisor fix land' }, t)

  const { messages: msgs } = (await (await fetch(`${t.bridge.url}/api/messages?sessionId=run-1&token=tok`)).json()) as {
    messages: { type: string; title?: string }[]
  }
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0]?.type, 'notification', 'a tell announces')
  assert.equal(msgs[0]?.title, 'Decided', 'and the kind names it')
})

test('#184 a veto tapped after the decision reaches the broker through poll', async (t2) => {
  // End to end on the real surface: a `decided` notification carrying an override, a tap that
  // arrives with nothing waiting for it, and the broker attaching it to the decision it vetoes.
  const t = await up()
  t2.after(() => t.bridge.close())
  const dir = tempDir(t2, 'conclave-er')
  const b = new Broker(dir)

  await b.tell(
    {
      kind: 'decided',
      headline: 'letting the advisor fix land rather than cutting short',
      options: [{ id: 'cut', label: 'Cut it short' }],
    },
    t,
  )

  // The notification carries the override, so a glance shows what can be done about it.
  const { messages: msgs } = (await (await fetch(`${t.bridge.url}/api/messages?sessionId=run-1&token=tok`)).json()) as {
    messages: { message: string }[]
  }
  assert.match(msgs[0]?.message ?? '', /Cut it short/, 'the veto is on screen')

  // Tapped later, through the endpoint the app uses, with nothing awaiting a reply.
  await fetch(`${t.bridge.url}/api/question-response?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'run-1', answer: 'Cut it short' }),
  })

  const taken = await b.collectVetoes(t)
  assert.deepEqual(taken, [{ headline: 'letting the advisor fix land rather than cutting short', option: 'cut' }])
  const all = b.decisions()
  assert.equal(all.length, 2, 'the decision, then the veto')
  assert.equal(all[1]?.answer?.by.kind, 'human')
})

/** `POST /api/prompt`, as the app sends the operator's message. */
async function promptText(t: EvenRealitiesTransport<EvenRealitiesBridge>, text: string): Promise<Response> {
  await new Promise((r) => setTimeout(r, 80))
  return fetch(`${t.bridge.url}/api/prompt?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'run-1', text }),
  })
}

test('#280 a prompt reaches the broker as a MESSAGE on the free-text path, and cannot select an unoffered option', async (t2) => {
  // THE INVARIANT THE NARROWING EXISTS TO KEEP. `/api/prompt` is served, so the operator's typed
  // message now arrives; what must not change is what it can do. It takes exactly the path a
  // typed `/question-response` takes: text is text for the caller to read, a label that was
  // offered is that option, and an id -- even a plausible one, even an offered one's -- is
  // never a way to choose. If a prompt could become an instruction, the third answer below
  // would come back as an option.
  const t = await up()
  t2.after(() => t.bridge.close())
  const dir = tempDir(t2, 'conclave-er')
  const offer = { kind: 'approval' as const, headline: 'Merge?', options: [{ id: 'yes', label: 'Merge' }] }

  // Free text is a message, recorded as one.
  const spoken = new Broker(dir).ask(offer, t)
  assert.equal((await promptText(t, 'hold off until the advisor finishes')).status, 202)
  const said = await spoken
  assert.equal(said?.option, undefined, 'a prompt must not become an option')
  assert.equal(said?.text, 'hold off until the advisor finishes')
  assert.equal(said?.by.kind, 'human')

  // A prompt naming an option's ID is text, not that option: only the label the glasses showed
  // was offered on the wire, and the broker never parses prose into an action.
  const byId = new Broker(dir).ask(offer, t)
  assert.equal((await promptText(t, 'yes')).status, 202)
  assert.deepEqual(await byId, { text: 'yes', by: { id: 'even-realities', kind: 'human' } })

  // A prompt naming an option that was NEVER offered is text too, and the record shows a
  // message, never a refused option: nothing on this path can produce `option: 'no'`.
  const unoffered = new Broker(dir).ask(offer, t)
  assert.equal((await promptText(t, 'no')).status, 202)
  assert.deepEqual(await unoffered, { text: 'no', by: { id: 'even-realities', kind: 'human' } })

  // And the same path as a tap: the offered LABEL is that option, as it is on /question-response.
  const tapped = new Broker(dir).ask(offer, t)
  assert.equal((await promptText(t, 'Merge')).status, 202)
  assert.deepEqual(await tapped, { option: 'yes', by: { id: 'even-realities', kind: 'human' } })

  const recs = new Broker(dir).decisions()
  assert.deepEqual(
    recs.map((r) => [r.answer?.option, r.answer?.text, r.undelivered]),
    [
      [undefined, 'hold off until the advisor finishes', undefined],
      [undefined, 'yes', undefined],
      [undefined, 'no', undefined],
      ['yes', undefined, undefined],
    ],
    'four answers, three of them messages; none an option that was not offered',
  )

  // With nothing asked, a prompt is refused and nothing reaches the broker: not as a veto, not
  // as anything. A prompt is not a way to start.
  assert.equal((await promptText(t, 'start the next thing')).status, 409)
  assert.deepEqual(await t.poll(), [], 'not held as a late answer either: nothing for the broker to collect')
  assert.equal(new Broker(dir).decisions().length, 4, 'nothing was recorded for it')
})

test('#285 the echo of an answer is cut to the same line as a headline', async (t2) => {
  // `client.ts` cannot import the transport's `HUD_CHARS` without importing conclave, so it
  // carries its own copy; this is what keeps the two one number.
  const t = await up()
  t2.after(() => t.bridge.close())
  assert.equal(EvenRealitiesBridge.CONFIRM_CHARS, t.limits.maxChars)
})
