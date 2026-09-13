/**
 * The `conclave notify` surface: what the operating agent calls to reach a human.
 *
 *   node --test src/notify/cli.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'
import { SessionRecorder } from '../workspace/sessionRecord.ts'
import { FAKE_REPLY_ENV, resolveTransport, transportNames } from './registry.ts'

const CLI = join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts')

function repo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-notify-cli')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

/** A live run's record in `dir`, written by the real writer: what `--run` has to name (#278). */
function record(dir: string, id: string, goal: string): SessionRecorder {
  return new SessionRecorder(dir, {
    id,
    pid: process.pid,
    cwd: dir,
    goal,
    front: 'session',
    operator: 'agent',
    state: 'running',
    startedAt: 1_700_000_000_000,
    messages: 0,
    participants: [],
    build: 'test-build',
  })
}

function run(args: string[], cwd: string, reply?: string): { code: number; out: string } {
  const r = spawnSync('node', [CLI, 'notify', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...(reply === undefined ? {} : { [FAKE_REPLY_ENV]: reply }) },
  })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}

test('#184 a name that is not a transport says what the names are', (t) => {
  // A registry that answered only "not found" would give the same message for a typo and for
  // an adapter nobody has written yet.
  const r = run(['tell', 'x', '--transport', 'glasses'], repo(t))
  assert.equal(r.code, 2)
  assert.match(r.out, /no transport named glasses/)
  for (const n of transportNames()) assert.ok(r.out.includes(n), `it must list ${n}`)
})

test('#184 a tap comes back as an option, and speech comes back as text', (t) => {
  // The distinction the whole inbound design rests on. An action is an id that was offered; an
  // utterance is text the CALLER interprets, because the caller is the operating agent and has
  // the context. Nothing here parses English into a conclave command.
  const dir = repo(t)

  const tapped = run(
    ['ask', 'Merge?', '--options', 'yes:Merge,no:Hold'],
    dir,
    '{"option":"yes","from":{"id":"mic","kind":"human"}}',
  )
  assert.equal(tapped.code, 0)
  assert.deepEqual(JSON.parse(tapped.out), { option: 'yes', by: { id: 'mic', kind: 'human' } })

  const spoken = run(
    ['ask', 'Merge?', '--options', 'yes:Merge'],
    dir,
    '{"text":"hold off until the advisor finishes","from":{"id":"mic","kind":"human"}}',
  )
  assert.equal(spoken.code, 0)
  const answer = JSON.parse(spoken.out) as { option?: string; text?: string }
  assert.equal(answer.option, undefined, 'speech must not become an action')
  assert.equal(answer.text, 'hold off until the advisor finishes')
})

test('#184 a question that carried no answer exits non-zero', (t) => {
  // The caller asked and did not get an answer. The decision it was asking about has not gone
  // away, so success would be a lie an unattended caller acts on.
  const r = run(['ask', 'Merge?', '--options', 'yes:Merge'], repo(t))
  assert.equal(r.code, 1)
  assert.match(r.out, /carried no answer/)
})

test('#184 a tell never waits, says nothing, and is not recorded as unanswered', (t) => {
  // Silent on success by design: a notification that printed would become output the caller has
  // to read, and the caller is an agent with a transcript to spend.
  const dir = repo(t)
  const told = run(['tell', 'run started'], dir)
  assert.equal(told.code, 0)
  assert.equal(told.out.trim(), '', 'a delivered notification says nothing')

  const log = run(['log'], dir)
  assert.match(log.out, /delivered/, 'and the log calls it delivered')
  assert.doesNotMatch(log.out, /unanswered/, 'nothing asked it anything, so it is not unanswered')
})

test('#184 the log distinguishes answered, unanswered and undelivered', (t) => {
  const dir = repo(t)
  run(['ask', 'Answered?', '--options', 'y:Yes'], dir, '{"option":"y","from":{"id":"mic","kind":"human"}}')
  run(['ask', 'Unanswered?', '--options', 'y:Yes'], dir)

  const json = JSON.parse(run(['log', '--json'], dir).out) as { headline: string; answer?: unknown; undelivered?: string }[]
  assert.equal(json.length, 2)
  assert.ok(json[0]?.answer, 'the answered one carries its answer')
  assert.match(json[1]?.undelivered ?? '', /no reply configured/, 'the other says why not')
})

test('#184 a malformed scripted reply produces no answer rather than an invented one', (t) => {
  // An answer nobody gave is the one output this must never produce.
  const r = run(['ask', 'Merge?', '--options', 'y:Yes'], repo(t), 'not json at all')
  assert.equal(r.code, 1)
  assert.match(r.out, /carried no answer/)
})

test('#184 the fake transport is resolvable by name, and is the reference adapter', () => {
  const t = resolveTransport('fake')
  assert.ok(t, 'fake must resolve')
  assert.equal(t.name, 'fake')
  assert.equal(t.limits.canReceive, true)
  assert.equal(resolveTransport('nope'), undefined)
})

/** A port nothing is on, chosen by the OS and released, so the CLI can bind it a moment later. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address()
      const port = a !== null && typeof a === 'object' ? a.port : 0
      srv.close(() => resolve(port))
    })
  })
}

test('#278 --run is the session the glasses see, and the friendly name is only its title', async (t) => {
  // End to end through the real transport: the app lists sessions, opens the one whose `id` it
  // read, and answers under that id. Before #278 the list had one hardcoded entry keyed
  // `sessionId`, which the app never read, and any answer at all settled the one question.
  // The stop hook first: `after` hooks run in the order added, and the directory's own cleanup
  // must not remove the socket before the broker behind it has been told to stop.
  let stop: (() => void) | undefined
  t.after(() => stop?.())
  const dir = repo(t)
  const rec = record(dir, 'run-278', 'g'.repeat(100))
  rec.event({ type: 'message', at: 1_700_000_050_000 } as never)
  const port = await freePort()
  // THE RUN DOES NOT BIND THE PORT (#286): its first send starts the broker, a process of its
  // own, and speaks to it over this socket. Pointed at the test's directory so no per-user
  // broker is touched, and stopped after, whatever happened.
  const env = {
    ...process.env,
    CONCLAVE_EVEN_PORT: String(port),
    CONCLAVE_EVEN_TOKEN: 'tok',
    CONCLAVE_EVEN_QUIET: '1',
    CONCLAVE_EVEN_SOCKET: join(dir, 'even.sock'),
    CONCLAVE_NOTIFY_NAME: 'glasses-name',
  }
  stop = () => spawnSync('node', [CLI, 'notify', 'broker', 'stop'], { cwd: dir, env })
  const child = spawn(
    'node',
    [CLI, 'notify', 'ask', 'Merge?', '--options', 'yes:Merge,no:Hold', '--transport', 'even-realities', '--run', 'run-278'],
    { cwd: dir, env },
  )
  let out = ''
  let err = ''
  child.stdout.on('data', (c) => (out += String(c)))
  child.stderr.on('data', (c) => (err += String(c)))
  const exited = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)))
  t.after(() => child.kill())

  const base = `http://127.0.0.1:${port}`
  // The broker comes up when `ask` sends, and the run's session lands a moment after its
  // port answers; poll the list the app polls until the run is on it. Waited on either way --
  // a refused connection or an empty list -- because under the broker those are two windows,
  // not one, and a loop that only slept on the first spun through the second in a blink.
  let sessions: Record<string, unknown>[] = []
  const deadline = Date.now() + 15_000
  while (sessions.length === 0 && Date.now() < deadline) {
    try {
      sessions = ((await (await fetch(`${base}/api/sessions?token=tok`)).json()) as { sessions: typeof sessions }).sessions
    } catch {
      // Not up yet.
    }
    if (sessions.length === 0) await new Promise((r) => setTimeout(r, 50))
  }
  // The run id is the session, and the rest of the item is the run's record: the goal as the
  // title, cut to the vendor's 64; the newest event as the timestamp; the working directory.
  assert.deepEqual(sessions, [
    {
      id: 'run-278',
      title: 'g'.repeat(64),
      timestamp: new Date(1_700_000_050_000).toISOString(),
      cwd: dir,
      provider: 'claude',
      status: 'awaiting',
    },
  ])
  assert.equal(JSON.stringify(sessions).includes('glasses-name'), false, 'the name is a label on messages, not the session')

  // The name is NOT an id. An answer routed by it is refused, and settles nothing.
  const byName = await fetch(`${base}/api/question-response?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'glasses-name', answer: 'Merge' }),
  })
  assert.equal(byName.status, 404)

  const byRun = await fetch(`${base}/api/question-response?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'run-278', answer: 'Merge' }),
  })
  assert.equal(byRun.status, 200)
  assert.equal(await exited, 0, err)
  assert.deepEqual(JSON.parse(out), { option: 'yes', by: { id: 'even-realities', kind: 'human' } })
  // The start was announced, on stderr, by the run that did it -- with what it started.
  assert.match(err, /started the Even Realities broker \(pid \d+\)/)
  assert.match(err, /conclave notify broker stop/)

  const log = JSON.parse(run(['log', '--json'], dir).out) as { runId?: string; transport: string }[]
  assert.equal(log[0]?.runId, 'run-278', 'and the record names the same run')
  assert.equal(log[0]?.transport, 'even-realities')
})

test('#278 even-realities without a run is refused with exit 2, and other transports are not', (t) => {
  // A session on the glasses is a run. Nothing is minted to stand in for one: a session the
  // app could open that `conclave sessions` could not find would be an id nobody can act on.
  const dir = repo(t)
  const env = { CONCLAVE_EVEN_PORT: '0', CONCLAVE_EVEN_TOKEN: 'tok', CONCLAVE_EVEN_QUIET: '1' }
  const refused = (args: string[]): { code: number; out: string } => {
    const r = spawnSync('node', [CLI, 'notify', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } })
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
  }
  for (const args of [
    ['tell', 'hi', '--transport', 'even-realities'],
    ['ask', 'go?', '--options', 'y:Yes', '--transport', 'even-realities'],
    ['vetoes', '--transport', 'even-realities'],
    ['tell', 'hi', '--transport', 'even-realities', '--run', ''],
  ]) {
    const r = refused(args)
    assert.equal(r.code, 2, `${args.join(' ')}: exit 2`)
    assert.match(r.out, /even-realities needs the run it speaks for: pass --run <id>/, args.join(' '))
    assert.doesNotMatch(r.out, /no transport named/, 'a transport that exists is not reported as missing')
  }
  // A run this project has no record of is refused too, in words that say where to look.
  const unknown = refused(['tell', 'hi', '--transport', 'even-realities', '--run', 'nope'])
  assert.equal(unknown.code, 2)
  assert.match(unknown.out, /no readable record for run nope in this project — see conclave sessions/)
  // The same commands on `fake` need no run and are unchanged.
  assert.equal(refused(['tell', 'hi', '--transport', 'fake']).code, 0)
  assert.equal(refused(['vetoes', '--transport', 'fake']).code, 0)
  assert.equal(run(['log'], dir).out.includes('hi'), true, 'and the fake tell was recorded')
})
