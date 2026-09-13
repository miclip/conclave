/**
 * The broker from the outside: real `conclave notify` processes, a real detached `serve`, and
 * the HTTP surface the glasses read. #286.
 *
 * Every test points `CONCLAVE_EVEN_SOCKET` into its own directory, so no per-user broker is
 * touched, and stops whatever it started, whatever happened.
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { tempDir } from '../../testkit/tempDir.ts'
import { SessionRecorder } from '../../workspace/sessionRecord.ts'

const CLI = join(import.meta.dirname, '..', '..', '..', 'bin', 'conclave.ts')

interface Site {
  dir: string
  env: NodeJS.ProcessEnv
  base: string
}

/** A git repo with a live run record per id, a free port, and a socket of its own. Stopped after. */
async function site(t: TestContext, runs: string[], extra: Record<string, string> = {}): Promise<Site> {
  // Registered BEFORE the directory exists, because `after` hooks run in the order they were
  // added and `tempDir` adds its own: the socket must be stopped before the directory holding
  // it is removed, or the stop finds nothing and the broker lives on to its linger.
  let stop: (() => void) | undefined
  t.after(() => stop?.())
  const dir = tempDir(t, 'broker-cli')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  for (const id of runs) {
    new SessionRecorder(dir, {
      id,
      pid: process.pid,
      cwd: dir,
      goal: `goal of ${id}`,
      front: 'session',
      operator: 'agent',
      state: 'running',
      startedAt: 1_700_000_000_000,
      messages: 0,
      participants: [],
      build: 'test-build',
    })
  }
  const port = await freePort()
  const env = {
    ...process.env,
    CONCLAVE_EVEN_PORT: String(port),
    CONCLAVE_EVEN_TOKEN: 'tok',
    CONCLAVE_EVEN_QUIET: '1',
    CONCLAVE_EVEN_SOCKET: join(dir, 'even.sock'),
    ...extra,
  }
  stop = () => spawnSync('node', [CLI, 'notify', 'broker', 'stop'], { cwd: dir, env })
  return { dir, env, base: `http://127.0.0.1:${port}` }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address()
      srv.close(() => resolve(a !== null && typeof a === 'object' ? a.port : 0))
    })
  })
}

interface Done {
  code: number
  out: string
  err: string
}

/** A `conclave notify ...` process, started now and awaited later. */
function notify(t: TestContext, s: Site, args: string[]): Promise<Done> {
  const child = spawn('node', [CLI, 'notify', ...args], { cwd: s.dir, env: s.env })
  t.after(() => child.kill())
  let out = ''
  let err = ''
  child.stdout.on('data', (c) => (out += String(c)))
  child.stderr.on('data', (c) => (err += String(c)))
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code: code ?? -1, out, err })))
}

function notifySync(s: Site, args: string[]): Done {
  const r = spawnSync('node', [CLI, 'notify', ...args], { cwd: s.dir, env: s.env, encoding: 'utf8' })
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr }
}

const ask = (id: string, headline: string) => [
  'ask',
  headline,
  '--options',
  'yes:Merge,no:Hold',
  '--transport',
  'even-realities',
  '--run',
  id,
]

interface Listed {
  id: string
  status: string | null
}

async function sessions(s: Site): Promise<Listed[]> {
  try {
    return ((await (await fetch(`${s.base}/api/sessions?token=tok`)).json()) as { sessions: Listed[] }).sessions
  } catch {
    return []
  }
}

async function until(cond: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return cond()
}

async function answer(s: Site, sessionId: string, text: string): Promise<number> {
  const r = await fetch(`${s.base}/api/question-response?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, answer: text }),
  })
  return r.status
}

function status(s: Site): { running: boolean; pid?: number; sessions?: string[]; url?: string; token?: string; socketPath?: string } {
  return JSON.parse(notifySync(s, ['broker', 'status', '--json']).out) as ReturnType<typeof status>
}

test('#286 two runs asking at once are listed together on one broker, and answered second-first', async (t) => {
  // THE RACE, FOR REAL: no broker is running, and two processes start at the same moment.
  // Both find nothing, both spawn a serve, one wins the port. Whatever happened, both are on
  // the winner, both are listed, and an answer that names a run reaches that run's process.
  const s = await site(t, ['run-a', 'run-b'])
  const a = notify(t, s, ask('run-a', 'merge fix-189?'))
  const b = notify(t, s, ask('run-b', 'rebase?'))

  assert.equal(
    await until(async () => {
      const l = await sessions(s)
      return l.length === 2 && l.every((x) => x.status === 'awaiting')
    }),
    true,
    'both outstanding on one list',
  )
  assert.deepEqual((await sessions(s)).map((x) => x.id).sort(), ['run-a', 'run-b'])

  assert.equal(await answer(s, 'run-b', 'Hold'), 200)
  const doneB = await b
  assert.equal(doneB.code, 0, doneB.err)
  assert.deepEqual(JSON.parse(doneB.out), { option: 'no', by: { id: 'even-realities', kind: 'human' } })
  assert.equal((await sessions(s)).find((x) => x.id === 'run-a')?.status, 'awaiting', 'run-a is still waiting')

  assert.equal(await answer(s, 'run-a', 'Merge'), 200)
  const doneA = await a
  assert.equal(doneA.code, 0, doneA.err)
  assert.deepEqual(JSON.parse(doneA.out), { option: 'yes', by: { id: 'even-realities', kind: 'human' } })

  // Exactly one of them started the broker, or one started it and the other joined it, or
  // one found it already up; none failed to start it. And there is one broker.
  const both = `${doneA.err}\n${doneB.err}`
  const starts = both.match(/started the Even Realities broker \(pid (\d+)\)/g) ?? []
  assert.equal(starts.length, 1, `one start, not ${starts.length}:\n${both}`)
  assert.doesNotMatch(both, /could not start/)
  // Which path the loser took is the machine's to decide; it is reported so a run of this
  // test says which one it exercised.
  t.diagnostic(/joined the Even Realities broker/.test(both) ? 'the loser lost the bind and joined' : 'the loser found the winner already up')
})

test('#286 the broker outlives the run whose question it answered', async (t) => {
  const s = await site(t, ['run-a'])
  const a = notify(t, s, ask('run-a', 'merge?'))
  await until(async () => (await sessions(s)).length === 1)
  const pid = status(s).pid

  assert.equal(await answer(s, 'run-a', 'Merge'), 200)
  const done = await a
  assert.equal(done.code, 0, done.err)
  assert.match(done.err, new RegExp(`started the Even Realities broker \\(pid ${pid}\\)`), 'this run started it')

  // The run is gone from the list -- its socket closed with it -- and the broker is not.
  assert.equal(await until(async () => (await sessions(s)).length === 0), true, 'the run left the list')
  const after = status(s)
  assert.equal(after.running, true, 'still serving, inside the linger')
  assert.equal(after.pid, pid, 'the same process')
  assert.deepEqual(after.sessions, [])
})

test('#285 the answer is on stdout before the run lets go of the device', async (t) => {
  // The grace delays the exit, never the answer. Read the answer off stdout the moment it
  // appears, and at that moment the run is still on the device's list -- its socket is being
  // held for the render -- and only afterwards does it leave.
  const s = await site(t, ['run-a'], { CONCLAVE_EVEN_CONFIRM_GRACE_MS: '2000' })
  const child = spawn('node', [CLI, 'notify', ...ask('run-a', 'merge?')], { cwd: s.dir, env: s.env })
  t.after(() => child.kill())
  let out = ''
  let err = ''
  child.stderr.on('data', (c) => (err += String(c)))
  const printed = new Promise<void>((resolve) => child.stdout.on('data', (c) => {
    out += String(c)
    if (out.includes('\n')) resolve()
  }))
  const exited = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)))
  assert.equal(await until(async () => (await sessions(s))[0]?.status === 'awaiting'), true, err)

  assert.equal(await answer(s, 'run-a', 'Merge'), 200)
  await printed
  const printedAt = Date.now()
  assert.deepEqual(JSON.parse(out), { option: 'yes', by: { id: 'even-realities', kind: 'human' } })
  // WITH THE CLOCK, not a glance: "still listed right after stdout" is true for a few
  // milliseconds even with no grace at all, because the broker has not yet seen the FIN. What
  // proves the answer came first and the socket was held after is WHEN the run leaves.
  assert.equal(await until(async () => (await sessions(s)).length === 0, 10_000), true, 'the run left the list')
  const goneAt = Date.now()
  assert.ok(goneAt - printedAt >= 1_500, `left ${goneAt - printedAt}ms after the answer was printed: the socket was not held`)
  assert.equal(await exited, 0, err)
})

test('#286 status reads the facts back from the live broker, and stop ends it', async (t) => {
  const s = await site(t, [])
  assert.equal(notifySync(s, ['broker', 'status']).code, 1, 'nothing running: exit 1')
  assert.deepEqual(status(s), { running: false, socketPath: s.env['CONCLAVE_EVEN_SOCKET'] })

  const started = notifySync(s, ['broker', 'start'])
  assert.equal(started.code, 0, started.err)
  const pid = Number(/\(pid (\d+)\)/.exec(started.err)?.[1])
  assert.ok(pid > 0, started.err)

  const st = status(s)
  assert.equal(st.running, true)
  assert.equal(st.pid, pid, 'the pid announced at start')
  assert.equal(st.socketPath, s.env['CONCLAVE_EVEN_SOCKET'])
  assert.equal(st.url, s.base)
  assert.equal(st.token, 'tok')
  const prose = notifySync(s, ['broker', 'status'])
  assert.equal(prose.code, 0)
  assert.match(prose.out, new RegExp(`pid ${pid}`))
  assert.ok(prose.out.includes(`device  ${s.base}   token tok`))
  assert.match(prose.out, /runs {4}none attached/)

  const again = notifySync(s, ['broker', 'start'])
  assert.equal(again.code, 0)
  assert.match(again.err, /already running \(pid \d+\)/, 'a second start starts nothing')

  const stopped = notifySync(s, ['broker', 'stop'])
  assert.equal(stopped.code, 0)
  assert.match(stopped.out, /has stopped/)
  assert.equal(status(s).running, false)
  assert.equal(await until(async () => !alive(pid), 5_000), true, 'the serve process exited')
  assert.deepEqual(await sessions(s), [], 'and the port is released')
  const nothing = notifySync(s, ['broker', 'stop'])
  assert.equal(nothing.code, 0)
  assert.match(nothing.out, /no Even Realities broker at/)
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
