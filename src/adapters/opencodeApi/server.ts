/**
 * Starting an OpenCode server and knowing when it is ready.
 *
 * The run-per-turn adapter already spawns `opencode` once per turn, so spawning it ONCE for a
 * whole run is strictly less process churn, not more. That is the argument for starting our own
 * rather than requiring the operator to have one: the binary is already a dependency of this
 * seat, and a seat that will not start without a manual step is a seat that does not work.
 *
 * `--port 0` and read the port back. A fixed port collides with whatever else is on the machine
 * -- including another conclave run, which is the case most likely to happen and least likely to
 * be noticed, since the second run would silently drive the first run's server.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'

/** How long to wait for the server to announce its port before giving up. */
export const SERVER_READY_MS = 20_000

/** What `opencode serve` prints when it is listening, and where the port is. */
const LISTENING = /listening on (https?:\/\/\S+)/i

export interface StartedServer {
  baseUrl: string
  password: string
  child: ChildProcess
  stop: () => Promise<void>
}

export interface StartServerOptions {
  cwd: string
  command?: string | undefined
  /**
   * Injected in tests; real callers get `child_process.spawn`.
   *
   * Typed as the ONE overload this file uses rather than `typeof spawn`. Node's `spawn` is a
   * union of several signatures, and a double satisfying all of them has to reproduce the whole
   * union -- which makes the test's stand-in harder to write than the thing it stands in for.
   */
  spawnFn?: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess
  readyMs?: number | undefined
}

/**
 * Spawn a headless server in `cwd` and resolve once it has said which port it took.
 *
 * A PASSWORD IS ALWAYS SET, and generated rather than configurable. The server says on startup:
 * "OPENCODE_SERVER_PASSWORD is not set; server is unsecured" -- and an unsecured loopback server
 * accepts a prompt from anything else on the machine, which on a developer's laptop is a large
 * set. Nothing needs to know this value except the client this call hands it to, so there is no
 * reason for it to be stable, shared, or read from anywhere.
 */
export async function startOpenCodeServer(opts: StartServerOptions): Promise<StartedServer> {
  const password = randomBytes(24).toString('base64url')
  const spawnFn = opts.spawnFn ?? (spawn as unknown as NonNullable<StartServerOptions['spawnFn']>)
  const child = spawnFn(opts.command ?? 'opencode', ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
    cwd: opts.cwd,
    // The port is announced on stdout or stderr depending on version, so both are read.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
  })

  const readyMs = opts.readyMs ?? SERVER_READY_MS
  let seen = ''
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      // The output so far is carried into the error: a server that failed to start usually said
      // why, and discarding it would leave "timed out" as the whole diagnosis.
      finish(new Error(`opencode serve did not announce a port within ${readyMs}ms. Output so far: ${seen.trim() || '(nothing)'}`))
    }, readyMs)
    timer.unref?.()

    const onChunk = (b: Buffer): void => {
      seen += b.toString('utf8')
      const m = LISTENING.exec(seen)
      if (m?.[1]) finish(undefined, m[1].replace(/\/+$/, ''))
    }
    const onExit = (code: number | null): void =>
      finish(new Error(`opencode serve exited with ${code ?? 'no code'} before listening. Output: ${seen.trim() || '(nothing)'}`))

    function finish(err?: Error, url?: string): void {
      clearTimeout(timer)
      child.stdout?.off('data', onChunk)
      child.stderr?.off('data', onChunk)
      child.off('exit', onExit)
      if (err) {
        child.kill('SIGTERM')
        reject(err)
      } else resolve(url as string)
    }

    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)
    child.on('exit', onExit)
    child.on('error', (e) => finish(e instanceof Error ? e : new Error(String(e))))
  })

  return {
    baseUrl,
    password,
    child,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      // Give it a moment to go on its own terms; a server holding sessions should be allowed to
      // close them rather than be taken out mid-write.
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL')
          r()
        }, 2_000)
        t.unref?.()
        child.once('exit', () => {
          clearTimeout(t)
          r()
        })
      })
    },
  }
}
