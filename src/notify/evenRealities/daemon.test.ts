/**
 * Finding, starting and joining the broker from a run. #286.
 *
 * The start race is the part that cannot be made deterministic across real processes -- two
 * `conclave notify` commands in two terminals at one moment -- so it is driven here with an
 * injected spawner: `serve` reports `EADDRINUSE`, as the loser's does, while a real broker
 * comes up beside it as the winner's would. `brokerCli.test.ts` runs the real race as well.
 */

import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { tempDir } from '../../testkit/tempDir.ts'
import { EvenRealitiesBroker } from './broker.ts'
import { brokerConfigFromEnv, brokerLogPath, brokerStatus, deviceLines, ensureBroker, isLoopbackUrl, spawnServe, startNotice, stopBroker, type BrokerConfig } from './daemon.ts'

process.env['CONCLAVE_EVEN_QUIET'] = '1'

function config(t: TestContext): BrokerConfig {
  return { socketPath: join(tempDir(t, 'daemon'), 'even.sock'), port: 0, token: 'tok', lingerMs: 60_000, sessionLingerMs: 30_000 }
}

test('#286 a run that loses the start race joins the winner rather than failing', async (t) => {
  // The loser's `serve` meets the port already bound and says so; the loser's run then finds
  // the winner's socket, which answers within milliseconds of that bind. Neither notification
  // fails for having lost.
  const c = config(t)
  const winner = new EvenRealitiesBroker(c)
  t.after(() => winner.close())
  const said: string[] = []
  let spawned = 0
  const status = await ensureBroker(c, {
    stderr: (text) => said.push(text),
    spawnServe: async () => {
      // The winner binds while the loser's serve is failing: the socket is not there yet when
      // the loser looks, and is by the time it looks again.
      if (spawned++ === 0) setTimeout(() => void winner.start(), 150)
      return { error: 'listen EADDRINUSE: address already in use 127.0.0.1:3456', code: 'EADDRINUSE' }
    },
  })
  assert.equal(status.pid, process.pid, "the winner's status, read from the winner")
  assert.deepEqual(status.sessions, [])
  assert.match(said.join('\n'), /joined the Even Realities broker another run started \(pid \d+\)/)
  assert.doesNotMatch(said.join('\n'), /started the Even Realities broker/, 'the loser started nothing')
  // A socket dead for a moment is a winner between its port and its socket, not a broker
  // gone: the loser waited, and did not spawn a second serve into the same race.
  assert.equal(spawned, 1, 'one serve, not one per look at a socket that was about to answer')
})

test('#286 a broker that is closing reads as nothing running, not as an error', async (t) => {
  // A closing broker accepts and then drops the connection without a frame (its own test is
  // in `broker.test.ts`); played here by a bare server, so this proves only that `status` on
  // such a socket says "none" -- so the caller starts one -- rather than throwing.
  const c = config(t)
  const dropper = createServer((s) => s.destroy())
  await new Promise<void>((resolve) => dropper.listen(c.socketPath, resolve))
  t.after(() => dropper.close())
  assert.equal(await brokerStatus(c.socketPath), undefined)
})

test('#286 a broker that went away while its socket was held is not waited on: a fresh one is started', async (t) => {
  // The EADDRINUSE was a broker lingering out -- the socket was bound when the first serve
  // looked, and dead by the time anyone could join it. Dead for the grace, so not a winner
  // between its port and its socket; and then the second attempt is the start that succeeds.
  const c = config(t)
  const fresh = new EvenRealitiesBroker(c)
  t.after(() => fresh.close())
  let spawned = 0
  const said: string[] = []
  const t0 = Date.now()
  const status = await ensureBroker(c, {
    stderr: (text) => said.push(text),
    joinTimeoutMs: 10_000,
    spawnServe: async () => {
      spawned++
      if (spawned === 1) return { error: 'listen EADDRINUSE: address already in use ' + c.socketPath, code: 'EADDRINUSE' }
      await fresh.start()
      return { ready: fresh.status() }
    },
  })
  assert.equal(spawned, 2)
  assert.equal(status.url, fresh.bridge.url)
  assert.match(said.join('\n'), /started the Even Realities broker/, 'announced, as any start is')
  assert.ok(Date.now() - t0 < 5_000, `decided in ${Date.now() - t0}ms: the dead grace, not the join timeout`)
})

test('#286 a port held by something that is not a broker is reported, not waited on for ever', async (t) => {
  const c = config(t)
  const said: string[] = []
  await assert.rejects(
    () =>
      ensureBroker(c, {
        stderr: (text) => said.push(text),
        joinTimeoutMs: 300,
        spawnServe: async () => ({ error: 'listen EADDRINUSE: address already in use 127.0.0.1:3456', code: 'EADDRINUSE' }),
      }),
    /could not start the Even Realities broker: listen EADDRINUSE.*\n.*CONCLAVE_EVEN_PORT or CONCLAVE_EVEN_SOCKET to move it/,
  )
  assert.match(said.join('\n'), /could not start the Even Realities broker/, 'said on stderr, not only thrown')
})

test('#307 a port held on the default socket names the broker from before 0.5.53 that may hold it', async (t) => {
  // The socket moved into a per-user directory. A broker started by 0.5.52 is at the old
  // path, which this run does not look at, and it has the port until its linger runs out.
  const c = { ...config(t), legacySocketPath: '/run/user/1000/conclave-even-1000.sock' }
  const said: string[] = []
  await assert.rejects(
    () =>
      ensureBroker(c, {
        stderr: (text) => said.push(text),
        joinTimeoutMs: 300,
        spawnServe: async () => ({ error: 'listen EADDRINUSE: address already in use 127.0.0.1:3456', code: 'EADDRINUSE' }),
      }),
    /a broker from before 0\.5\.53 may still hold the port; it normally exits 60s after its last run, or now with\n {2}CONCLAVE_EVEN_SOCKET=\/run\/user\/1000\/conclave-even-1000\.sock conclave notify broker stop\n {2}and then retry$/,
  )
  assert.match(said.join('\n'), /conclave-even-1000\.sock conclave notify broker stop/, 'on stderr too')
})

test('#307 the hint is not given for an explicit socket, nor for a failure that is not the port', async (t) => {
  // An operator's own path did not move; and a serve that died for another reason is not a
  // port held by anyone.
  const spawn = async () => ({ error: 'listen EADDRINUSE: address already in use 127.0.0.1:3456', code: 'EADDRINUSE' })
  await assert.rejects(
    () => ensureBroker(config(t), { stderr: () => {}, joinTimeoutMs: 300, spawnServe: spawn }),
    (err: Error) => !/before 0\.5\.53|broker stop/.test(err.message) && /EADDRINUSE/.test(err.message),
  )
  const c = { ...config(t), legacySocketPath: '/run/user/1000/conclave-even-1000.sock' }
  await assert.rejects(
    () => ensureBroker(c, { stderr: () => {}, spawnServe: async () => ({ error: 'the broker exited (1) before saying it was ready' }) }),
    (err: Error) => !/before 0\.5\.53|broker stop/.test(err.message) && /exited \(1\)/.test(err.message),
  )
})

test('#286 a serve that fails for any other reason is reported in its own words at once', async (t) => {
  const c = config(t)
  const t0 = Date.now()
  await assert.rejects(
    () => ensureBroker(c, { stderr: () => {}, spawnServe: async () => ({ error: 'the broker exited (1) before saying it was ready' }) }),
    /could not start the Even Realities broker: the broker exited \(1\) before saying it was ready/,
  )
  assert.ok(Date.now() - t0 < 1_000, 'no join wait: nothing was going to come up')
})

test('#286 a broker already running is found, and nothing is started or announced', async (t) => {
  const c = config(t)
  const running = new EvenRealitiesBroker(c)
  await running.start()
  t.after(() => running.close())
  const said: string[] = []
  let spawned = 0
  const status = await ensureBroker(c, {
    stderr: (text) => said.push(text),
    spawnServe: async () => {
      spawned++
      return { error: 'should not have been asked' }
    },
  })
  assert.equal(spawned, 0)
  assert.deepEqual(said, [])
  assert.equal(status.url, running.bridge.url)
})

test('#286 a fresh start is announced with everything needed to find or stop the broker', async (t) => {
  const c = config(t)
  const started = new EvenRealitiesBroker(c)
  t.after(() => started.close())
  const said: string[] = []
  const status = await ensureBroker(c, {
    stderr: (text) => said.push(text),
    spawnServe: async () => {
      await started.start()
      return { ready: started.status() }
    },
  })
  const notice = said.join('\n')
  assert.equal(notice, startNotice(status))
  assert.match(notice, new RegExp(`started the Even Realities broker \\(pid ${process.pid}\\)`))
  assert.ok(notice.includes(`socket  ${c.socketPath}`))
  assert.ok(notice.includes(`log     ${brokerLogPath(c.socketPath)}`))
  assert.ok(notice.includes(`device  ${started.bridge.url}   token tok`))
  assert.match(notice, /it exits 60s after the last run disconnects; CONCLAVE_EVEN_LINGER_MS moves that/)
  assert.match(notice, /a finished run stays listed 30s; CONCLAVE_EVEN_SESSION_LINGER_MS moves that/)
  assert.match(notice, /stop it now:  conclave notify broker stop/)
  // #345: the default bind is loopback, and the line labelled `device` is one the device
  // cannot dial. Said directly under it, before anything else, naming the variable.
  const lines = notice.split('\n')
  const device = lines.findIndex((l) => l.startsWith('  device  '))
  assert.ok(device > 0)
  assert.equal(lines[device + 1], '          the glasses cannot reach this address; CONCLAVE_EVEN_HOST moves that')
})

test('#345 loopback is 127/8, ::1 and localhost; every interface and a specific one are not', () => {
  for (const url of ['http://127.0.0.1:3456', 'http://127.1.2.3:80', 'http://[::1]:3456', 'http://localhost:3456']) {
    assert.equal(isLoopbackUrl(url), true, url)
  }
  for (const url of ['http://0.0.0.0:3456', 'http://100.95.159.49:3456', 'http://[::]:3456', 'http://192.168.1.10:3456', 'http://1270.0.0.1:1', 'not a url']) {
    assert.equal(isLoopbackUrl(url), false, url)
  }
})

test('#345 the device lines carry the loopback warning only when the address is loopback', () => {
  const base = { pid: 1, startedAt: 'now', socketPath: '/s', token: 'tok', lingerMs: 1, sessionLingerMs: 1, sessions: [] }
  assert.deepEqual(deviceLines({ ...base, url: 'http://127.0.0.1:3456' }), [
    '  device  http://127.0.0.1:3456   token tok',
    '          the glasses cannot reach this address; CONCLAVE_EVEN_HOST moves that',
  ])
  assert.deepEqual(deviceLines({ ...base, url: 'http://0.0.0.0:3456' }), ['  device  http://0.0.0.0:3456   token tok'])
  assert.deepEqual(deviceLines({ ...base, url: 'http://100.95.159.49:3456' }), ['  device  http://100.95.159.49:3456   token tok'])
  assert.ok(!startNotice({ ...base, url: 'http://0.0.0.0:3456' }).includes('CONCLAVE_EVEN_HOST'))
  assert.ok(!startNotice({ ...base, url: 'http://100.95.159.49:3456' }).includes('CONCLAVE_EVEN_HOST'))
})

test('#290 the session linger reaches the serve process from the CONFIG, not from whatever this environment says', async (t) => {
  // The real spawner, with a config that disagrees with the environment: a serve that read
  // the ambient variable, or the default, would report 30000 here. Stopped through the
  // socket after, because the process is detached and unref'd and would otherwise live on.
  const c = { ...config(t), sessionLingerMs: 4_321 }
  t.after(() => stopBroker(c.socketPath))
  const saved = process.env['CONCLAVE_EVEN_SESSION_LINGER_MS']
  delete process.env['CONCLAVE_EVEN_SESSION_LINGER_MS']
  t.after(() => {
    if (saved !== undefined) process.env['CONCLAVE_EVEN_SESSION_LINGER_MS'] = saved
  })
  const outcome = await spawnServe(c)
  assert.ok('ready' in outcome, JSON.stringify(outcome))
  assert.equal(outcome.ready.sessionLingerMs, 4_321, 'announced as configured')
  assert.equal((await brokerStatus(c.socketPath))?.sessionLingerMs, 4_321, 'and running that way')
})

test('#286 status and stop speak to the live broker; with none there, they say so', async (t) => {
  const c = config(t)
  assert.equal(await brokerStatus(c.socketPath), undefined)
  assert.equal(await stopBroker(c.socketPath), false)
  const b = new EvenRealitiesBroker(c)
  await b.start()
  t.after(() => b.close())
  const s = await brokerStatus(c.socketPath)
  assert.deepEqual(s, b.status())
  assert.equal(await stopBroker(c.socketPath), true)
  assert.equal(await brokerStatus(c.socketPath), undefined, 'gone')
})

test('#286 the config is read from the same variables the transport always read', () => {
  assert.deepEqual(brokerConfigFromEnv({ CONCLAVE_EVEN_SOCKET: '/s.sock' }), {
    socketPath: '/s.sock',
    port: 3456,
    lingerMs: 60_000,
    sessionLingerMs: 30_000,
  })
  assert.deepEqual(
    brokerConfigFromEnv({
      CONCLAVE_EVEN_SOCKET: '/s.sock',
      CONCLAVE_EVEN_PORT: '4000',
      CONCLAVE_EVEN_TOKEN: 't',
      CONCLAVE_EVEN_HOST: '0.0.0.0',
      CONCLAVE_EVEN_LINGER_MS: '5',
      CONCLAVE_EVEN_SESSION_LINGER_MS: '7',
    }),
    { socketPath: '/s.sock', port: 4000, token: 't', host: '0.0.0.0', lingerMs: 5, sessionLingerMs: 7 },
  )
  assert.equal(brokerLogPath('/x/even.sock'), '/x/even.log')
})

test('#307 the config names the socket from before 0.5.53 only when the default is in use', (t) => {
  const runtime = tempDir(t, 'runtime')
  const uid = process.getuid!()
  const c = brokerConfigFromEnv({ XDG_RUNTIME_DIR: runtime })
  assert.equal(c.socketPath, join(runtime, `conclave-${uid}`, 'even.sock'))
  assert.equal(c.legacySocketPath, join(runtime, `conclave-even-${uid}.sock`))
  assert.ok(!existsSync(c.legacySocketPath!), 'named, not made')
  const own = brokerConfigFromEnv({ XDG_RUNTIME_DIR: runtime, CONCLAVE_EVEN_SOCKET: '/s.sock' })
  assert.ok(!('legacySocketPath' in own), 'an explicit socket did not move')
})
