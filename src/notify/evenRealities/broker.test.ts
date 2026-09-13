/**
 * One bridge across processes. #286.
 *
 * `hub.test.ts` proves two runs in ONE process share the device. These prove the same thing
 * across a socket: two clients that know nothing of each other -- as two `conclave notify`
 * invocations in two terminals would not -- appear on one `/api/sessions`, are answered by
 * name of their session, leave the list by hanging up, and the broker outlives the last of
 * them by exactly the linger.
 *
 * The clients here are real `net` connections to a real Unix socket, and everything is read
 * off the HTTP surface the glasses read, so a broker that kept two bridges, or dropped a
 * session on the wrong disconnect, would fail here rather than on the device.
 *
 * ONE CLAIM, ONE TEST. Each test is the designated guard of one behaviour, and the mutation
 * that breaks that behaviour is meant to fail that test alone. So a test does not re-assert
 * what another test owns even where it would be cheap to: the hang-up test does not check
 * that the list emptied (that is the removal test's), and the refresh test reads the
 * timestamp rather than the title (the title is the listing test's).
 */

import { strict as assert } from 'node:assert'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { tempDir } from '../../testkit/tempDir.ts'
import type { SessionMetadata } from './client.ts'
import {
  brokerAlive,
  brokerSocketPath,
  DEFAULT_LINGER_MS,
  DEFAULT_SESSION_LINGER_MS,
  EvenRealitiesBroker,
  EvenRealitiesBrokerClient,
  lingerMs,
  sessionLingerMs,
  START_GRACE_MS,
} from './broker.ts'

// The bridge logs one line per request to stderr; that is for an operator, not this output.
process.env['CONCLAVE_EVEN_QUIET'] = '1'

function meta(over: Partial<SessionMetadata> = {}): SessionMetadata {
  return { title: 'fix the thing', timestamp: '2026-09-11T12:00:00.000Z', cwd: '/w', status: 'busy', ...over }
}

const question = (text: string) => ({
  header: 'Approval',
  question: text,
  options: [
    { label: 'Yes', description: '' },
    { label: 'No', description: '' },
  ],
})

/**
 * A broker on a socket of its own, on port 0, torn down after the test whatever happened.
 * The session linger is the default unless a test's claim is about it: `close()` disarms
 * every retention, so a thirty-second one costs an uninterested test nothing.
 */
async function broker(t: TestContext, lingerMs = 60_000, sessionLingerMs?: number) {
  const b = new EvenRealitiesBroker({
    socketPath: join(tempDir(t, 'broker'), 'even.sock'),
    port: 0,
    token: 'tok',
    lingerMs,
    ...(sessionLingerMs === undefined ? {} : { sessionLingerMs }),
  })
  await b.start()
  t.after(() => b.close())
  return b
}

/** A run's end: connected and opened, closed after the test if the test did not. */
async function client(t: TestContext, b: EvenRealitiesBroker, sessionId: string, m = meta()) {
  const c = await EvenRealitiesBrokerClient.connect(b.socketPath)
  t.after(() => c.close())
  const opened = await c.open(sessionId, m)
  return { c, opened }
}

interface Listed {
  id: string
  title: string
  timestamp: string
  status: string | null
}

async function sessions(b: EvenRealitiesBroker): Promise<Listed[]> {
  const body = (await (await fetch(`${b.bridge.url}/api/sessions?token=tok`)).json()) as { sessions: Listed[] }
  return body.sessions
}

/** Answer the question outstanding on one run, as the app would. */
async function answer(b: EvenRealitiesBroker, sessionId: string, text: string): Promise<void> {
  await fetch(`${b.bridge.url}/api/question-response?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, answer: text }),
  })
}

/** Poll until `cond` holds or `ms` elapse. Disconnection is asynchronous; a fixed sleep would race it. */
async function until(cond: () => Promise<boolean>, ms = 2_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return cond()
}

/** `p`, or a rejection after `ms`: for awaiting a shutdown that a mutation could make never come. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(what)), ms))])
}

/**
 * Until the broker has seen `sessionId`'s run hang up, by whichever of its two tells shows
 * first: the run off the attached list, or its session reading `idle`. Disconnection is
 * asynchronous; a test that asserts on either tell waits here on the other, so a mutation of
 * the one it asserts cannot stall it into failing for a reason that is not its claim.
 */
async function detached(b: EvenRealitiesBroker, sessionId: string): Promise<void> {
  await until(
    async () =>
      !b.status().sessions.includes(sessionId) || (await sessions(b)).find((s) => s.id === sessionId)?.status === 'idle',
  )
}

/** The event stream for one session, as the app holds it: what has arrived, and whether it has ended. */
async function stream(t: TestContext, b: EvenRealitiesBroker, sessionId: string) {
  const ac = new AbortController()
  t.after(() => ac.abort())
  const res = await fetch(`${b.bridge.url}/api/events?token=tok&sessionId=${sessionId}&needReplay=true`, { signal: ac.signal })
  const state = { status: res.status, text: '', ended: false }
  // A stream still open when the test ends is aborted by the hook above; that is the test
  // finishing, not the stream ending, so it is neither `ended` nor a rejection.
  const pump =
    res.status === 200
      ? (async () => {
          const reader = res.body!.getReader()
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            state.text += new TextDecoder().decode(value)
          }
          state.ended = true
        })().catch(() => {})
      : Promise.resolve()
  return { state, pump }
}

/** What `/api/messages` holds for one session: the replay buffer, as the app reads it. */
async function messages(b: EvenRealitiesBroker, sessionId: string): Promise<{ id: number; title?: string }[]> {
  const body = (await (await fetch(`${b.bridge.url}/api/messages?token=tok&sessionId=${sessionId}`)).json()) as {
    messages: { id: number; title?: string }[]
  }
  return body.messages
}

test('#286 two independent socket clients appear together in /api/sessions, on one bridge', async (t) => {
  const b = await broker(t)
  const a = await client(t, b, 'run-a', meta({ title: 'merge fix-189' }))
  const c = await client(t, b, 'run-b', meta({ title: 'rebase onto main' }))

  // Both told the same address and the same token: there is one bridge, and it is the
  // broker's. A client that was handed a port of its own would be the per-process bridge
  // this exists to replace.
  assert.deepEqual(a.opened, { url: b.bridge.url, token: 'tok' })
  assert.deepEqual(c.opened, { url: b.bridge.url, token: 'tok' })

  // Read off the list the app polls, not off the broker: two entries, each the run's own goal.
  assert.deepEqual(
    (await sessions(b)).map((s) => [s.id, s.title]),
    [
      ['run-a', 'merge fix-189'],
      ['run-b', 'rebase onto main'],
    ],
  )
})

test('#286 an answer reaches the client whose session it names, whichever asked first', async (t) => {
  const b = await broker(t)
  const { c: a } = await client(t, b, 'run-a')
  const { c } = await client(t, b, 'run-b')

  const first = a.ask(question('merge fix-189?'))
  const second = c.ask(question('rebase?'))
  assert.equal(
    await until(async () => (await sessions(b)).every((s) => s.status === 'awaiting')),
    true,
    'both outstanding, and the list says so',
  )

  // Answered second-first, and the first stays open: a broker that routed by turn would
  // hand `No` to run-a here.
  await answer(b, 'run-b', 'No')
  assert.deepEqual(await second, { answer: 'No' })
  assert.equal((await sessions(b)).find((s) => s.id === 'run-a')?.status, 'awaiting', 'run-a is still waiting')
  await answer(b, 'run-a', 'Yes')
  assert.deepEqual(await first, { answer: 'Yes' })
})

test('#286 a tell goes out under the session that sent it, and a veto comes back to it', async (t) => {
  const b = await broker(t)
  const { c: a } = await client(t, b, 'run-a')
  const { c } = await client(t, b, 'run-b')

  await a.tell({ type: 'notification', title: 'Decided', message: 'letting it land — Cut it short' })
  await c.tell({ type: 'notification', title: 'Decided', message: 'letting it land — Cut it short' })
  const messages = async (id: string) =>
    ((await (await fetch(`${b.bridge.url}/api/messages?token=tok&sessionId=${id}`)).json()) as { messages: unknown[] })
      .messages.length
  assert.equal(await messages('run-a'), 1)
  assert.equal(await messages('run-b'), 1)

  // A late answer with nothing awaiting it is a veto, and it belongs to the run it names.
  await answer(b, 'run-b', 'Cut it short')
  assert.deepEqual(await a.poll(), [], 'run-a was not vetoed')
  assert.deepEqual(await c.poll(), [{ answer: 'Cut it short' }])
})

test('#290 hanging up detaches the run: its session stays listed as idle, and only that session changes', async (t) => {
  // Before #290 the session left the list with the socket, and the thread the operator had
  // just answered was gone from the app before it could go back to it. Now the run leaves and
  // the session stays, reading `idle` -- the run's last word about itself, minus a status it
  // is no longer there to have.
  const b = await broker(t)
  const { c: a } = await client(t, b, 'run-a')
  await client(t, b, 'run-b')
  assert.deepEqual((await sessions(b)).map((s) => [s.id, s.status]), [['run-a', 'busy'], ['run-b', 'busy']])

  // No `close` frame: the socket is the liveness. A run that crashed would look exactly like this.
  a.close()
  assert.equal(await until(async () => (await sessions(b))[0]?.status === 'idle'), true, 'run-a reads idle once the broker sees the hang-up')
  assert.deepEqual((await sessions(b)).map((s) => [s.id, s.status]), [['run-a', 'idle'], ['run-b', 'busy']], 'still listed, and run-b untouched')
  assert.equal(await brokerAlive(b.socketPath), true, 'the broker is still serving')
})

test('#290 a reconnect inside the retention gets 200 and the replay, and /api/prompt is still refused', async (t) => {
  // The app's move after an answer: reconnect the event stream with `needReplay`. Against a
  // closed session that was 404 and a fall back to the list; against a retained one it is the
  // stream, with everything the run sent. Nothing is outstanding on it, so a prompt is the
  // same 409 it always was -- retention lists the thread, it does not reopen it to input.
  const b = await broker(t)
  const { c: a } = await client(t, b, 'run-a')
  await a.tell({ type: 'notification', title: 'Decided', message: 'letting it land' })
  a.close()
  await detached(b, 'run-a')

  const { state } = await stream(t, b, 'run-a')
  assert.equal(state.status, 200, 'the reconnect finds the session')
  assert.equal(await until(async () => state.text.includes('"Decided"')), true, 'and the replay carries what the run sent')
  assert.deepEqual((await messages(b, 'run-a')).map((m) => m.title), ['Decided'], 'the buffer is the same one /api/messages reads')

  const refused = await fetch(`${b.bridge.url}/api/prompt?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'do the other thing', sessionId: 'run-a' }),
  })
  assert.equal(refused.status, 409, 'a prompt with nothing to answer is refused, retained or not')
})

test('#290 a retained session expires: the stream ends and the id is gone, at the session linger and not before', async (t) => {
  const LINGER = 400
  const b = await broker(t, 60_000, LINGER)
  const { c: a } = await client(t, b, 'run-a')
  const { state, pump } = await stream(t, b, 'run-a')
  const left = Date.now()
  a.close()
  await detached(b, 'run-a')
  assert.equal(state.ended, false, 'the stream the app holds survives the run letting go')

  await within(pump, LINGER + 2_000, 'the stream never ended')
  const gone = Date.now() - left
  assert.ok(gone >= LINGER, `the stream ended ${gone}ms after the hang-up: before the session linger`)
  assert.deepEqual(await sessions(b), [], 'and the session is off the list')
  assert.equal((await stream(t, b, 'run-a')).state.status, 404, 'a reconnect after the retention is the 404 it should be')
})

test('#290 the same session id reattaching inside its retention takes the session back, buffer and all, and outlives the old expiry', async (t) => {
  // The run reconnected, or a new invocation took up the id, before the retention ran out.
  // Three things could go wrong, and each is a distinct line: the bridge could keep
  // describing the old attachment (a list that still says `idle` with a stale timestamp),
  // the old expiry could fire and close the session under the new connection, or the buffer
  // could be reset as though this were a fresh open.
  const LINGER = 300
  const b = await broker(t, 60_000, LINGER)
  const { c: first } = await client(t, b, 'run-a', meta({ timestamp: '2026-09-11T12:00:00.000Z' }))
  await first.tell({ type: 'notification', title: 'Decided', message: 'letting it land' })
  first.close()
  await detached(b, 'run-a')

  const { c: second } = await client(t, b, 'run-a', meta({ timestamp: '2026-09-11T13:00:00.000Z', status: 'busy' }))
  assert.deepEqual(
    (await sessions(b)).map((s) => [s.id, s.status, s.timestamp]),
    [['run-a', 'busy', '2026-09-11T13:00:00.000Z']],
    'the list describes the new attachment, not the idle one it replaced',
  )
  assert.deepEqual((await messages(b, 'run-a')).map((m) => m.title), ['Decided'], 'the buffer came with it')

  // Past the point the first retention would have expired: the session is still the second run's.
  await new Promise((r) => setTimeout(r, LINGER + 200))
  assert.deepEqual((await sessions(b)).map((s) => [s.id, s.status]), [['run-a', 'busy']], 'the old expiry did not close the new attachment')
  assert.equal(await second.tell({ type: 'notification', title: 't', message: 'still here' }), 2, 'and the id sequence continued')
})

test('#290 a run that leaves mid-question is retained too: its question is settled, and the session reads idle', async (t) => {
  // Every detach retains; only the broker's shutdown closes at once. The run's end of the
  // question was released when its socket closed; the bridge's end is settled `skip` by the
  // detach, so the list does not say `awaiting` of a run that is not there -- and the
  // session, stream and replay stay, question frame included, like any other retained run.
  const b = await broker(t)
  const { c: a } = await client(t, b, 'run-a')
  const asked = a.ask(question('merge?'))
  await until(async () => (await sessions(b))[0]?.status === 'awaiting')
  a.close()
  await assert.rejects(asked, /the broker connection closed/, 'the socket side of the ask is released')

  assert.equal(await until(async () => (await sessions(b))[0]?.status === 'idle'), true, 'idle, not awaiting: the bridge side is settled')
  const { state } = await stream(t, b, 'run-a')
  assert.equal(state.status, 200, 'the stream is still served')
  assert.equal(await until(async () => state.text.includes('"user_question"')), true, 'and replays the question the run left')
  assert.deepEqual((await messages(b, 'run-a')).map((m) => m.id), [1], 'the buffer is intact')
  // A late answer is a veto now -- nothing is pending -- and it does not revive `awaiting`.
  await answer(b, 'run-a', 'Yes')
  assert.equal((await sessions(b))[0]?.status, 'idle', 'still idle after a late answer')
})

test('#290 a retained session is not an attached run: it holds neither the status list nor the broker linger', async (t) => {
  // The broker's lifetime counts runs, and a run that has gone is gone whatever its session
  // is doing. A retained session counted as attached would keep the broker up for the
  // session linger -- thirty seconds by default -- on top of its own; and `status` would
  // name a run that is not there to be stopped.
  const LINGER = 300
  const b = await broker(t, LINGER, 30_000)
  const { c: a } = await client(t, b, 'run-a')
  const { state, pump } = await stream(t, b, 'run-a')
  const left = Date.now()
  a.close()
  await detached(b, 'run-a')
  assert.deepEqual(b.status().sessions, [], 'no run attached, whatever the glasses list')

  // The broker lingers out on ITS clock; the retained session goes with it, not after it.
  await within(b.closed, LINGER + 2_000, 'the retained session held the broker up')
  const shut = Date.now() - left
  assert.ok(shut >= LINGER, `shut down ${shut}ms after the hang-up: before the broker linger`)
  await within(pump, 1_000, 'the retained stream outlived the broker')
  assert.equal(state.ended, true)
})

test('#290 close() takes a retained session down at once, and leaves no expiry armed behind it', async (t) => {
  // Shutdown is immediate whatever is retained: `bridge.close()` closes every session, and
  // the expiry that would have closed this one is disarmed rather than left to fire into a
  // bridge that is gone -- a timer that is not unref'd holds the process open until it fires,
  // and the default one is thirty seconds. Observed by counting the bridge's `closeSession`
  // calls past the linger: a leftover expiry is one more.
  //
  // Two runs, in the two states a shutdown meets: run-a already gone and retained, and run-b
  // still attached -- whose hang-up, when `close()` ends its connection, must not retain it
  // onto a bridge that is going down either.
  const LINGER = 300
  const b = await broker(t, 60_000, LINGER)
  const { c: a } = await client(t, b, 'run-a')
  const { c: held } = await client(t, b, 'run-b')
  const { state, pump } = await stream(t, b, 'run-a')
  a.close()
  await detached(b, 'run-a')
  let closes = 0
  const real = b.bridge.closeSession.bind(b.bridge)
  b.bridge.closeSession = (id) => {
    closes++
    real(id)
  }

  await within(b.close(), 2_000, 'close() waited on the retention')
  await within(pump, 1_000, 'the retained stream outlived the broker')
  assert.equal(state.ended, true)
  assert.equal(await until(async () => held.closed), true, 'the attached run was disconnected')
  assert.equal(closes, 2, 'each closed once, by the bridge going down')
  await new Promise((r) => setTimeout(r, LINGER + 200))
  assert.equal(closes, 2, 'and neither again by an expiry the shutdown should have disarmed')
})

test('#286 a session is one connection: a second claim is refused while the first holds it', async (t) => {
  // The bridge's `openSession` joins an open id, because within a process two views of one
  // run are one run. Across the socket a second connection is a second process, and closing
  // either would close the session out from under the other. So: refused while held, and
  // the first holder's hang-up releases both its question and the id.
  const b = await broker(t)
  // A bystander, so run-a's hang-up is never the LAST disconnect: what happens then is the
  // linger test's claim, and this one must not depend on it.
  await client(t, b, 'run-z')
  const { c: a } = await client(t, b, 'run-a')
  const asked = a.ask(question('merge?'))
  await until(async () => (await sessions(b)).find((s) => s.id === 'run-a')?.status === 'awaiting')

  const again = await EvenRealitiesBrokerClient.connect(b.socketPath)
  t.after(() => again.close())
  await assert.rejects(() => again.open('run-a', meta()), /already open from another connection/)

  a.close()
  await assert.rejects(asked, /the broker connection closed/, 'the first holder is not left waiting')
  // The broker sees the hang-up a moment after the client does.
  await new Promise((r) => setTimeout(r, 50))
  await again.open('run-a', meta())
  assert.deepEqual((await sessions(b)).map((s) => s.id), ['run-z', 'run-a'], 'free once the first is gone')
})

test('#286 the broker lingers after its last run disconnects, then shuts itself down', async (t) => {
  // A second of linger, not less: the "still up just after" probe below is wall-clock, and
  // under a starved event loop (the full suite, four files at once) a 200ms window was once
  // gone before the probe ran. The claim is unchanged; the margin is what the machine needs.
  const LINGER = 1_000
  const b = await broker(t, LINGER)
  const { c: a } = await client(t, b, 'run-a')

  // A bare connection, held open throughout and never opening a session, is not a run. Idle
  // counted by sockets rather than sessions would hold the port for as long as this stays
  // connected. (Found by mutation.)
  const held = await EvenRealitiesBrokerClient.connect(b.socketPath)
  t.after(() => held.close())

  // A run attaching during the linger cancels it: that is what the linger is FOR. The
  // hang-up is asynchronous, so the broker is given a moment to see it before run-b dials;
  // not a wait on the list emptying, which is the removal test's claim, not this one's.
  a.close()
  await new Promise((r) => setTimeout(r, 50))
  const { c } = await client(t, b, 'run-b')
  await new Promise((r) => setTimeout(r, LINGER + 100))
  assert.equal(await brokerAlive(b.socketPath), true, 'attached again inside the window: still up')

  // The last one leaves. Not down at once -- the next invocation is expected within the
  // window -- and down once the window passes, socket file included (Node unlinks it when
  // the server closes; the assertion is on the observable, not on a line of the broker's).
  const left = Date.now()
  c.close()
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(await brokerAlive(b.socketPath), true, 'still up just after the last disconnect')
  await within(b.closed, LINGER + 3_000, 'did not linger out')
  assert.ok(Date.now() - left >= LINGER, `shut down ${Date.now() - left}ms after the last disconnect: before the linger`)
  assert.equal(await brokerAlive(b.socketPath), false, 'nothing is serving the socket')
  assert.equal(existsSync(b.socketPath), false, 'and the file is gone')
  await assert.rejects(() => fetch(`${b.bridge.url}/api/sessions?token=tok`), 'the port is released')
})

test('#286 a broker nobody ever attached to lingers out, but not before its first run could dial', async (t) => {
  // Started and abandoned -- the run that started it died before opening -- is the same idle,
  // with a floor: at a linger of zero the start-armed timer fired before a client could
  // connect, so the first window is at least `START_GRACE_MS` whatever the linger is. And a
  // connection that never opens a session -- a probe, as `brokerAlive` is -- is not a run:
  // counted as one, its hang-up re-armed the zero linger and shut the broker down under the
  // run it was probing for. (Both found by mutation.)
  const b = await broker(t, 0)
  const started = Date.now()
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(await brokerAlive(b.socketPath), true, 'a zero linger still gives the first run time to connect')
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(await brokerAlive(b.socketPath), true, 'and a probe hanging up did not shorten the window')
  await within(b.closed, 3_000, 'did not linger out')
  assert.ok(Date.now() - started >= START_GRACE_MS, 'not before the grace')
  assert.equal(await brokerAlive(b.socketPath), false)
})

test('#286 a connection arriving while the broker closes is turned away, not opened onto a dead bridge', async (t) => {
  // `close()` takes the bridge down and then the socket server; a run connecting in between
  // used to be opened onto a bridge whose port was already gone, and handed that address.
  // Now the connection is ended without a frame, which the transport reads as "try again".
  const b = await broker(t)
  const slow = b.bridge.close.bind(b.bridge)
  b.bridge.close = async () => {
    await new Promise((r) => setTimeout(r, 300))
    await slow()
  }
  const closing = b.close()
  await new Promise((r) => setTimeout(r, 30))
  const late = await EvenRealitiesBrokerClient.connect(b.socketPath)
  t.after(() => late.close())
  await assert.rejects(() => late.open('run-late', meta()), /the broker connection closed/)
  await closing
  assert.equal(await brokerAlive(b.socketPath), false)
})

test('#286 close() answers a pending question skip, and the frame is on the wire before EOF', async (t) => {
  // The bridge settles a pending `ask` as `skip` when its session closes; the broker closes
  // the bridge BEFORE ending the connections, so that frame is written while the socket can
  // still take it. Ended first, the client would see EOF with the question unanswered --
  // which is the truth too, but a worse one: "nobody answered" is what `skip` says.
  const b = await broker(t)
  const { c: a } = await client(t, b, 'run-a')
  const asked = a.ask(question('merge?'))
  await until(async () => (await sessions(b))[0]?.status === 'awaiting')

  await b.close()
  assert.deepEqual(await asked, { answer: 'skip' })
  assert.equal(await until(async () => a.closed), true, 'and then the connection ended')
})

test('#286 status and stop need no session, and neither touches the linger', async (t) => {
  const b = await broker(t, 200, 7_000)
  const { c: a } = await client(t, b, 'run-a')
  const asker = await EvenRealitiesBrokerClient.connect(b.socketPath)
  t.after(() => asker.close())
  const s = await asker.status()
  assert.deepEqual(s, {
    pid: process.pid,
    socketPath: b.socketPath,
    url: b.bridge.url,
    token: 'tok',
    startedAt: s.startedAt,
    lingerMs: 200,
    sessionLingerMs: 7_000,
    sessions: ['run-a'],
  })
  assert.ok(Date.parse(s.startedAt) <= Date.now(), 'startedAt is when it bound')

  // The asker hanging up is not a run leaving: run-a is still served past the linger.
  asker.close()
  await new Promise((r) => setTimeout(r, 300))
  assert.deepEqual((await sessions(b)).map((x) => x.id), ['run-a'])

  // `stop` is acknowledged, then everything ends: the run's socket, the bridge, the file.
  const stopper = await EvenRealitiesBrokerClient.connect(b.socketPath)
  await stopper.stop()
  await within(b.closed, 2_000, 'did not stop')
  assert.equal(await until(async () => a.closed), true, 'the attached run was disconnected')
  assert.equal(await brokerAlive(b.socketPath), false)
})

test('#286 an answered question does not end the stream: the glasses stay attached while the run does', async (t) => {
  // #285's story, under the broker. The bridge answers, echoes `Received` on the stream, and
  // leaves the stream open; only the session closing ends it, and the session is the run's
  // socket. Before the broker, `conclave notify ask` closed the bridge on exit and the device
  // saw every answer as a dropped connection. Now the run's socket is what ends the stream,
  // and until it closes the device keeps its connection across the answer.
  const b = await broker(t)
  const { c: a } = await client(t, b, 'run-a')
  const asked = a.ask(question('merge?'))
  await until(async () => (await sessions(b))[0]?.status === 'awaiting')

  const { state } = await stream(t, b, 'run-a')

  await answer(b, 'run-a', 'Yes')
  assert.deepEqual(await asked, { answer: 'Yes' })
  assert.equal(await until(async () => state.text.includes('"Received"')), true, 'the confirmation went out on the stream')
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(state.ended, false, 'and the stream is still open after the answer')
  assert.deepEqual((await sessions(b)).map((x) => [x.id, x.status]), [['run-a', 'busy']], 'the run is still listed, no longer awaiting')

  // The run lets go, and the stream is still open: the session outlives the run (#290), and
  // when the stream ends is the retention's claim, not this one's.
  a.close()
  await detached(b, 'run-a')
  assert.equal(state.ended, false, 'the run letting go did not end it either')
})

test('#286 a frame the broker cannot use is refused in words, and the connection goes on', async (t) => {
  // Raw, so junk can be sent that the client class would never build. Each reply is read as
  // one line; the connection must survive every one of these, because the run on the other
  // end may be mid-question, and dropping it would settle that question `skip`.
  const b = await broker(t)
  const socket = connect(b.socketPath)
  await new Promise<void>((resolve, reject) => socket.once('connect', resolve).once('error', reject))
  t.after(() => socket.destroy())
  const replies: Record<string, unknown>[] = []
  let buf = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buf += chunk
    let at: number
    while ((at = buf.indexOf('\n')) !== -1) {
      replies.push(JSON.parse(buf.slice(0, at)) as Record<string, unknown>)
      buf = buf.slice(at + 1)
    }
  })
  const send = async (line: string): Promise<Record<string, unknown>> => {
    const n = replies.length
    socket.write(`${line}\n`)
    await until(async () => replies.length > n, 1_000)
    const r = replies[n]
    assert.ok(r, `no reply to ${line}`)
    return r
  }
  const refused = async (line: string, why: RegExp): Promise<void> => {
    const r = await send(line)
    assert.equal(r['type'], 'error', `${line} is refused`)
    assert.match(String(r['message']), why)
  }

  // Not JSON, and JSON that is not an object.
  await refused('{not json', /not JSON/)
  await refused('null', /not a frame/)
  await refused('42', /not a frame/)
  await refused('"open"', /not a frame/)
  await refused('[]', /not a frame/)
  // An object that is not a frame.
  await refused('{}', /needs a numeric id/)
  await refused('{"type":"dance","id":1}', /unknown frame type "dance"/)
  await refused('{"type":"tell","msg":{}}', /needs a numeric id/)
  // Opens that carry nothing a session could be listed from.
  await refused('{"type":"open"}', /open needs a sessionId/)
  await refused('{"type":"open","sessionId":"run-a"}', /needs the metadata/)
  await refused('{"type":"open","sessionId":"run-a","meta":{"title":"t"}}', /title, timestamp, cwd/)
  await refused('{"type":"open","sessionId":"run-a","meta":{"title":"t","timestamp":"s","cwd":"/","status":"lost"}}', /status must be/)
  assert.deepEqual(await sessions(b), [], 'none of those opened anything')

  // A good open, and then bad payloads on the open session: each refused BY ID, so a client
  // awaiting that id is released, and none reaches the bridge's buffer.
  assert.equal((await send(JSON.stringify({ type: 'open', sessionId: 'run-a', meta: meta() })))['type'], 'opened')
  const shapes: [string, RegExp][] = [
    ['{"type":"tell","id":7,"msg":42}', /notification or a user_question/],
    ['{"type":"tell","id":7,"msg":{"type":"sms","body":"x"}}', /not "sms"/],
    ['{"type":"tell","id":7,"msg":{"type":"notification","title":"t"}}', /is \{ title, message \}/],
    ['{"type":"tell","id":7,"msg":{"type":"user_question","questions":[{"question":"q"}]}}', /header, question, options/],
    ['{"type":"tell","id":7,"msg":{"type":"user_question","questions":[{"question":"q","header":"h","options":[{"label":"x"}]}]}}', /\{ label, description \}/],
    ['{"type":"ask","id":7,"question":"merge?"}', /header, question, options/],
    ['{"type":"ask","id":7,"question":{"question":"q","header":"h","options":"yes/no"}}', /options must be a list/],
  ]
  for (const [line, why] of shapes) {
    const r = await send(line)
    assert.equal(r['type'], 'error', `${line} is refused`)
    assert.equal(r['id'], 7, `${line} is refused by id`)
    assert.match(String(r['message']), why)
  }
  const buffered = (await (await fetch(`${b.bridge.url}/api/messages?token=tok&sessionId=run-a`)).json()) as {
    messages: unknown[]
  }
  assert.deepEqual(buffered.messages, [], 'nothing malformed reached the glasses')

  // And the connection is still the session it was: a good frame works, and the list agrees.
  const ok = await send('{"type":"tell","id":8,"msg":{"type":"notification","title":"t","message":"still here"}}')
  assert.deepEqual(ok, { type: 'sent', id: 8, messageId: 1 })
  assert.deepEqual((await sessions(b)).map((s) => s.id), ['run-a'])
})

test('#286 a line that never ends is not a frame: the connection is destroyed, not grown without bound', async (t) => {
  const b = await broker(t)
  const socket = connect(b.socketPath)
  await new Promise<void>((resolve, reject) => socket.once('connect', resolve).once('error', reject))
  t.after(() => socket.destroy())
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
  socket.on('error', () => {})
  socket.write('x'.repeat(1_100_000))
  await within(closed, 2_000, 'the broker kept buffering')
})

test('#286 the socket is owner-only', async (t) => {
  // Anything that can connect can open a session on the glasses and answer what is asked on
  // it. The directory is per-user by default, but `CONCLAVE_EVEN_SOCKET` can point anywhere.
  const b = await broker(t)
  assert.equal((statSync(b.socketPath).mode & 0o777).toString(8), '600')
})

test('#286 the linger is sixty seconds unless CONCLAVE_EVEN_LINGER_MS says otherwise', () => {
  assert.equal(DEFAULT_LINGER_MS, 60_000)
  assert.equal(lingerMs({}), 60_000)
  assert.equal(lingerMs({ CONCLAVE_EVEN_LINGER_MS: '5000' }), 5_000)
  assert.equal(lingerMs({ CONCLAVE_EVEN_LINGER_MS: '0' }), 0, 'zero is a choice: exit with the last run')
  // A typo is the default, not a broker that never exits or exits at once.
  assert.equal(lingerMs({ CONCLAVE_EVEN_LINGER_MS: 'soon' }), 60_000)
  assert.equal(lingerMs({ CONCLAVE_EVEN_LINGER_MS: '-1' }), 60_000)
})

test('#290 a session stays thirty seconds unless CONCLAVE_EVEN_SESSION_LINGER_MS says otherwise', () => {
  assert.equal(DEFAULT_SESSION_LINGER_MS, 30_000)
  assert.equal(sessionLingerMs({}), 30_000)
  assert.equal(sessionLingerMs({ CONCLAVE_EVEN_SESSION_LINGER_MS: '5000' }), 5_000)
  assert.equal(sessionLingerMs({ CONCLAVE_EVEN_SESSION_LINGER_MS: '0' }), 0, 'zero is a choice: the session goes with the run')
  // A typo is the default, not a session that vanishes at once or never.
  assert.equal(sessionLingerMs({ CONCLAVE_EVEN_SESSION_LINGER_MS: 'soon' }), 30_000)
  assert.equal(sessionLingerMs({ CONCLAVE_EVEN_SESSION_LINGER_MS: '-1' }), 30_000)
  // Its own variable: the broker linger does not set it, and it does not set the broker linger.
  assert.equal(sessionLingerMs({ CONCLAVE_EVEN_LINGER_MS: '5000' }), 30_000)
  assert.equal(lingerMs({ CONCLAVE_EVEN_SESSION_LINGER_MS: '5000' }), 60_000)
})

test('#286 the socket path is deterministic per user, and the override wins', () => {
  const a = brokerSocketPath({})
  assert.equal(a, brokerSocketPath({}), 'the same answer twice: a run finds the broker by knowing the path')
  assert.match(a, /conclave-even-[^/]+\.sock$/)
  assert.equal(brokerSocketPath({ XDG_RUNTIME_DIR: '/run/user/1000' }), '/run/user/1000/' + a.split('/').pop())
  assert.equal(brokerSocketPath({ CONCLAVE_EVEN_SOCKET: '/x/y.sock' }), '/x/y.sock')
})

test('#286 a socket file left by a dead broker is taken over; a live one is refused', async (t) => {
  const path = join(tempDir(t, 'broker'), 'even.sock')
  const first = new EvenRealitiesBroker({ socketPath: path, port: 0, token: 'tok', lingerMs: 60_000 })
  await first.start()
  t.after(() => first.close())

  const second = new EvenRealitiesBroker({ socketPath: path, port: 0, token: 'tok', lingerMs: 60_000 })
  await assert.rejects(() => second.start(), (err: NodeJS.ErrnoException) => err.code === 'EADDRINUSE')
  assert.equal(await brokerAlive(path), true, 'the first is untouched by the refusal')

  // A broker that was killed leaves its file behind with nobody serving it. `close()` unlinks,
  // so the leftover is put back by hand.
  await first.close()
  writeFileSync(path, '')
  assert.equal(existsSync(path), true, 'precondition: a stale file')
  assert.equal(await brokerAlive(path), false)
  await second.start()
  t.after(() => second.close())
  assert.equal(await brokerAlive(path), true, 'the stale file was replaced')
})

test('#286 one connection is one session: a second id is refused, the same id refreshes', async (t) => {
  const b = await broker(t)
  const c = await EvenRealitiesBrokerClient.connect(b.socketPath)
  t.after(() => c.close())
  await assert.rejects(() => c.tell({ type: 'notification', title: 't', message: 'm' }), /tell before open/)
  await c.open('run-a', meta())
  await assert.rejects(() => c.open('run-b', meta()), /this connection is session run-a/)
  // A refresh of the same session moves what the list says, without reopening: the bridge
  // asks `describe` on every listing, and this is what `describe` reads.
  await c.open('run-a', meta({ timestamp: '2026-09-11T13:00:00.000Z' }))
  assert.deepEqual((await sessions(b)).map((s) => [s.id, s.timestamp]), [['run-a', '2026-09-11T13:00:00.000Z']])
})
