/**
 * Starting a server, and the ways starting one fails.
 *
 * Against a fake `spawn`, so a machine without OpenCode runs these — and because the failures
 * that matter here are ones a real server is unlikely to produce on demand: exiting before it
 * listens, never announcing anything, announcing on stderr instead of stdout.
 */

import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { startOpenCodeServer } from './server.ts'

/** A child that says what a test tells it to, on the stream a test chooses. */
function fakeChild(): EventEmitter & Record<string, unknown> {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child['stdout'] = new EventEmitter()
  child['stderr'] = new EventEmitter()
  child['exitCode'] = null
  child['signalCode'] = null
  child['kill'] = () => true
  return child
}

const spawnReturning = (child: unknown, onSpawn?: (cmd: string, args: string[], opts: Record<string, unknown>) => void) =>
  ((cmd: string, args: string[], opts: Record<string, unknown>) => {
    onSpawn?.(cmd, args, opts)
    return child
  }) as unknown as NonNullable<Parameters<typeof startOpenCodeServer>[0]['spawnFn']>

test('the port is read back from what the server announces, not assumed', async () => {
  // `--port 0` because a fixed port collides with whatever else is on the machine — including
  // another conclave run, which would silently drive the first run's server.
  const child = fakeChild()
  let seenArgs: string[] = []
  const started = startOpenCodeServer({
    cwd: '/tmp',
    spawnFn: spawnReturning(child, (_c, args) => {
      seenArgs = args
    }),
  })
  ;(child['stdout'] as EventEmitter).emit('data', Buffer.from('opencode server listening on http://127.0.0.1:51234\n'))
  const server = await started
  assert.equal(server.baseUrl, 'http://127.0.0.1:51234')
  assert.deepEqual(seenArgs, ['serve', '--port', '0', '--hostname', '127.0.0.1'])
})

test('a password is always set, and is not a fixed one', async () => {
  // The server announces "OPENCODE_SERVER_PASSWORD is not set; server is unsecured" when it has
  // none, and an unsecured loopback server takes a prompt from anything else on the machine.
  // Nothing but the client needs this value, so there is no reason for it to be stable.
  const passwords = new Set<string>()
  for (let i = 0; i < 2; i++) {
    const child = fakeChild()
    let env: Record<string, string> = {}
    const started = startOpenCodeServer({
      cwd: '/tmp',
      spawnFn: spawnReturning(child, (_c, _a, opts) => {
        env = (opts['env'] ?? {}) as Record<string, string>
      }),
    })
    ;(child['stdout'] as EventEmitter).emit('data', Buffer.from('listening on http://127.0.0.1:1\n'))
    const s = await started
    assert.ok(env['OPENCODE_SERVER_PASSWORD'], 'the server must be started with a password')
    assert.equal(env['OPENCODE_SERVER_PASSWORD'], s.password, 'and the caller must be given the same one')
    passwords.add(s.password)
  }
  assert.equal(passwords.size, 2, 'a password generated once and reused would be a shared secret with no owner')
})

test('the announcement is read from stderr too, because that is where it appeared', async () => {
  // Observed on 1.18.15: the listening line arrives on stderr alongside the unsecured warning.
  // Reading only stdout would hang until the ready timeout on a server that started perfectly.
  const child = fakeChild()
  const started = startOpenCodeServer({ cwd: '/tmp', spawnFn: spawnReturning(child) })
  ;(child['stderr'] as EventEmitter).emit('data', Buffer.from('opencode server listening on http://127.0.0.1:4599\n'))
  assert.equal((await started).baseUrl, 'http://127.0.0.1:4599')
})

test('a server that exits before listening says so, and carries what it printed', async () => {
  // "timed out" would be the whole diagnosis otherwise. A server that failed to start usually
  // said why, and discarding that leaves the operator with nothing to act on.
  const child = fakeChild()
  const started = startOpenCodeServer({ cwd: '/tmp', spawnFn: spawnReturning(child) })
  ;(child['stderr'] as EventEmitter).emit('data', Buffer.from('EADDRINUSE: address already in use\n'))
  child.emit('exit', 1)
  await assert.rejects(started, (e: unknown) => /exited with 1/.test((e as Error).message) && /EADDRINUSE/.test((e as Error).message))
})

test('a server that never says anything fails with what it did not say', async () => {
  const child = fakeChild()
  const started = startOpenCodeServer({ cwd: '/tmp', spawnFn: spawnReturning(child), readyMs: 40 })
  await assert.rejects(started, (e: unknown) => /did not announce a port/.test((e as Error).message) && /\(nothing\)/.test((e as Error).message))
})
