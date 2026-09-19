/**
 * The broker as a process: started on demand by the first run that needs it, found by every
 * run after, stopped by an operator or by its own linger. #286.
 *
 * ## What the issue asked to be decided, and what was decided
 *
 * "Nothing here should start a long-lived process behind the operator's back without that
 * being an explicit, visible thing." So a start is LOUD: the run that starts the broker prints
 * to stderr what it started -- pid, socket, the address the glasses dial, the token, and the
 * exact command that stops it -- and `conclave notify broker status` says the same things
 * later, read back from the live broker rather than from anything written down. There is no
 * pid file to go stale: the socket is the liveness, and a broker that is not answering it is
 * not running, whatever a file might say.
 *
 * "Whether the first run should keep serving" -- no. A run that bound the HTTP port itself
 * would have to hand it over when a second run arrived, and a handover that has to be correct
 * is more machinery than a process that outlives the run. A run NEVER binds the port; only
 * `serve` does, and `serve` is its own process.
 *
 * ## The start race
 *
 * Two runs, two terminals, one moment: both find no broker and both spawn one. The HTTP port
 * is the real mutex -- `EvenRealitiesBroker.start()` binds it before the socket -- so the
 * loser's `serve` fails with `EADDRINUSE` on the port, or on the socket a moment later, and
 * says so on its stdout before exiting. The loser's RUN then waits for the winner's socket to
 * answer (bounded, so a port held by something that is not a broker is reported rather than
 * waited on for ever) and connects to it. Neither notification fails for having lost.
 *
 * The spawner is injectable for exactly that path: the race cannot be made deterministic
 * across real processes, so the test drives `ensureBroker` with a spawner that reports
 * `EADDRINUSE` while a real broker comes up beside it.
 */

import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { join } from 'node:path'

import { nodeArgv } from '../../nodeArgv.ts'
import {
  brokerAlive,
  brokerSocketPath,
  EvenRealitiesBroker,
  legacyBrokerSocketPath,
  EvenRealitiesBrokerClient,
  lingerMs,
  sessionLingerMs,
  SOCKET_ENV,
  type BrokerStatus,
} from './broker.ts'

/** Everything a broker is configured with, read from the same variables the transport reads. */
export interface BrokerConfig {
  socketPath: string
  /**
   * Where a broker from before 0.5.53 would be, when `socketPath` is the default and so
   * may have moved out from under one (#307). Absent under `CONCLAVE_EVEN_SOCKET`: an
   * operator's own path did not move. Named in the `EADDRINUSE` failure, and nowhere else.
   */
  legacySocketPath?: string
  port: number
  token?: string
  host?: string
  lingerMs: number
  sessionLingerMs: number
}

export function brokerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  const token = env['CONCLAVE_EVEN_TOKEN']
  const host = env['CONCLAVE_EVEN_HOST']
  const overridden = (env[SOCKET_ENV]?.trim() ?? '') !== ''
  return {
    socketPath: brokerSocketPath(env),
    ...(overridden ? {} : { legacySocketPath: legacyBrokerSocketPath(env) }),
    port: Number(env['CONCLAVE_EVEN_PORT'] ?? '3456'),
    ...(token ? { token } : {}),
    ...(host ? { host } : {}),
    lingerMs: lingerMs(env),
    sessionLingerMs: sessionLingerMs(env),
  }
}

/**
 * Where a detached broker's stderr goes: the request log the bridge writes, one line per
 * request, which is how every question in this integration has been answered so far. Beside
 * the socket, so `status` can name it.
 */
export function brokerLogPath(socketPath: string): string {
  return `${socketPath.replace(/\.sock$/, '')}.log`
}

/** The one line `serve` prints to stdout, for whoever spawned it. */
export type ServeOutcome = { ready: BrokerStatus } | { error: string; code?: string }

/** Starts a `serve` process and resolves with the first line it printed. Injectable for the race test. */
export type Spawner = (config: BrokerConfig) => Promise<ServeOutcome>

/** The CLI, for spawning `serve`: this file's own package, not whatever `argv[1]` happens to be. */
const CLI = join(import.meta.dirname, '..', '..', '..', 'bin', 'conclave.ts')

/**
 * The real spawner: `conclave notify broker serve`, detached, stdout piped for the one line,
 * stderr to the log file, stdin closed. Unref'd once the line is read, so the run exits
 * without it and the broker lives on.
 */
export const spawnServe: Spawner = (config) =>
  new Promise((resolve) => {
    // 0600 EXPLICITLY, though the directory already guarantees it (#307). `ensurePrivateDir`
    // has verified the parent is ours and 0700 before this runs, so nobody else can reach this
    // file whatever its own mode is -- but a mode argument costs nothing, keeps the guarantee
    // true if that directory check is ever weakened, and is what a reader of THIS line expects
    // to see. It does not make the path unpredictable, which is what the scanner objects to;
    // the directory is what answers that, and the alert is dismissed on those grounds.
    const log = openSync(brokerLogPath(config.socketPath), 'a', 0o600)
    const child = spawn(process.execPath, nodeArgv(CLI, ['notify', 'broker', 'serve']), {
      detached: true,
      stdio: ['ignore', 'pipe', log],
      env: {
        ...process.env,
        CONCLAVE_EVEN_SOCKET: config.socketPath,
        CONCLAVE_EVEN_PORT: String(config.port),
        ...(config.token ? { CONCLAVE_EVEN_TOKEN: config.token } : {}),
        ...(config.host ? { CONCLAVE_EVEN_HOST: config.host } : {}),
        CONCLAVE_EVEN_LINGER_MS: String(config.lingerMs),
        // Explicit, like the rest: a config built from another env, or injected, must reach
        // the broker as it was built, not as this process's environment happens to say.
        CONCLAVE_EVEN_SESSION_LINGER_MS: String(config.sessionLingerMs),
      },
    })
    closeSync(log)
    const out = child.stdout!
    let buf = ''
    let settled = false
    const settle = (outcome: ServeOutcome): void => {
      if (settled) return
      settled = true
      out.destroy()
      child.unref()
      resolve(outcome)
    }
    out.setEncoding('utf8')
    out.on('data', (chunk: string) => {
      buf += chunk
      const at = buf.indexOf('\n')
      if (at === -1) return
      try {
        settle(JSON.parse(buf.slice(0, at)) as ServeOutcome)
      } catch {
        settle({ error: `the broker said something that was not a line of JSON: ${buf.slice(0, 200)}` })
      }
    })
    child.on('error', (err) => settle({ error: err.message }))
    child.on('exit', (code) => settle({ error: `the broker exited (${code}) before saying it was ready` }))
  })

/** `status` from the broker at `socketPath`, or `undefined` when nothing answers there. */
export async function brokerStatus(socketPath: string): Promise<BrokerStatus | undefined> {
  let client: EvenRealitiesBrokerClient
  try {
    client = await EvenRealitiesBrokerClient.connect(socketPath)
  } catch {
    return undefined
  }
  try {
    return await client.status()
  } catch {
    // Connected, but no answer: a broker closing turns a new connection away (its `#attach`
    // says why), and that is "nothing running" from here.
    return undefined
  } finally {
    client.close()
  }
}

/**
 * Stop the broker at `socketPath`. `true` once it has acknowledged and the socket has stopped
 * answering; `false` when there was nothing to stop.
 */
export async function stopBroker(socketPath: string): Promise<boolean> {
  let client: EvenRealitiesBrokerClient
  try {
    client = await EvenRealitiesBrokerClient.connect(socketPath)
  } catch {
    return false
  }
  await client.stop()
  client.close()
  const gone = await waitFor(async () => !(await brokerAlive(socketPath)), 5_000)
  if (!gone) throw new Error(`the broker at ${socketPath} acknowledged the stop but is still answering`)
  return true
}

/** How long a run waits for another process's broker to come up after losing the start race. */
const JOIN_TIMEOUT_MS = 5_000

/**
 * How long the socket must stay dead before "the holder is gone" is concluded. Dead once is
 * not that: the winner of the race binds the port and then the socket, and under load the
 * loser can look between the two. A broker that lingered out stays dead.
 */
const DEAD_GRACE_MS = 500

/**
 * Whether the address in `url` is one only this machine can dial: `127.0.0.0/8`, `::1`, or
 * `localhost`. `0.0.0.0` is NOT loopback -- it is every interface, and the glasses can reach
 * one of them -- and neither is a specific interface address. Something that does not parse
 * as a URL is not called loopback either; the notice then just says what it was given.
 */
export function isLoopbackUrl(url: string): boolean {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return false
  }
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

/**
 * The `device` line of a notice, and the qualification it needs when the address is one the
 * device cannot reach (#345). The bind is loopback by default and that default is right --
 * `registry.ts` argues it -- but this line is labelled as the address to type into the
 * glasses, and on the default it is an address they can never dial. Both notices print it
 * through here so they cannot disagree about when to say so.
 */
export function deviceLines(s: BrokerStatus): string[] {
  const lines = [`  device  ${s.url}   token ${s.token}`]
  if (isLoopbackUrl(s.url)) lines.push('          the glasses cannot reach this address; CONCLAVE_EVEN_HOST moves that')
  return lines
}

/**
 * The start notice: everything an operator needs to find the broker again or be rid of it.
 * On stderr, because a `tell` is silent on stdout by design and this must not change that.
 */
export function startNotice(s: BrokerStatus): string {
  return [
    `conclave: started the Even Realities broker (pid ${s.pid})`,
    `  socket  ${s.socketPath}`,
    `  log     ${brokerLogPath(s.socketPath)}`,
    ...deviceLines(s),
    `  it exits ${s.lingerMs / 1000}s after the last run disconnects; CONCLAVE_EVEN_LINGER_MS moves that`,
    `  a finished run stays listed ${s.sessionLingerMs / 1000}s; CONCLAVE_EVEN_SESSION_LINGER_MS moves that`,
    `  stop it now:  conclave notify broker stop`,
  ].join('\n')
}

/**
 * A broker, running: the one already at `config.socketPath`, or one started now. What was
 * started is announced through `io.stderr`, once, by the run that started it.
 */
export async function ensureBroker(
  config: BrokerConfig,
  io: { stderr: (text: string) => void; spawnServe?: Spawner; joinTimeoutMs?: number },
): Promise<BrokerStatus> {
  let outcome: ServeOutcome = { error: 'not attempted' }
  // TWICE, at most. The second attempt is for a socket that was held when the first looked
  // and is free now -- a broker that was lingering out -- and nothing else: a port held by
  // something that is not a broker fails the same way twice and is reported.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const running = await brokerStatus(config.socketPath)
    if (running) return running
    outcome = await (io.spawnServe ?? spawnServe)(config)
    if ('ready' in outcome) {
      io.stderr(startNotice(outcome.ready))
      return outcome.ready
    }
    if (outcome.code !== 'EADDRINUSE') break
    // LOST THE RACE, or something else has the port. The winner's socket answers within
    // milliseconds of its port bind, so a broker that is coming up is found here and joined.
    // A socket that is DEAD meanwhile -- nothing listening -- is a broker that went away, and
    // the next attempt starts one. A socket that neither answers nor dies within the window
    // is another program on the port, or a broker for another user, and is reported with the
    // serve process's own words rather than waited on for ever.
    const end = Date.now() + (io.joinTimeoutMs ?? JOIN_TIMEOUT_MS)
    let deadSince: number | undefined
    let gone = false
    while (Date.now() < end) {
      const s = await brokerStatus(config.socketPath)
      if (s) {
        io.stderr(`conclave: joined the Even Realities broker another run started (pid ${s.pid})`)
        return s
      }
      if (await brokerAlive(config.socketPath)) deadSince = undefined
      else if (deadSince === undefined) deadSince = Date.now()
      else if (Date.now() - deadSince >= DEAD_GRACE_MS) {
        gone = true
        break
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    if (!gone) break
  }
  // Said on stderr as well as thrown: the throw lands in the notify record as `undelivered`,
  // which a `tell` never prints, and a broker that could not start is not something to find
  // out about later from a log.
  // The 0.5.52 → 0.5.53 case: the socket moved (#307), so a broker from before is at the
  // old path, invisible to this run, and still holding the port. It exits on its own once its
  // linger runs out; the hint is for the operator who would rather not wait.
  const legacy =
    outcome.code === 'EADDRINUSE' && config.legacySocketPath
      ? `\n  a broker from before 0.5.53 may still hold the port; it normally exits 60s after its last run, or now with\n` +
        `  CONCLAVE_EVEN_SOCKET=${config.legacySocketPath} conclave notify broker stop\n` +
        `  and then retry`
      : ''
  const message =
    `could not start the Even Realities broker: ${outcome.error}\n` +
    `  socket ${config.socketPath}, port ${config.port} — conclave notify broker status; ` +
    `CONCLAVE_EVEN_PORT or CONCLAVE_EVEN_SOCKET to move it${legacy}`
  io.stderr(`conclave: ${message}`)
  throw new Error(message)
}

/**
 * `conclave notify broker serve`: the broker's own process. Prints one JSON line to stdout --
 * ready, with the facts, or an error with the code -- and then serves until the linger runs
 * out or a `stop` frame or a signal ends it. The exit code is the outcome.
 */
export async function serveBroker(
  config: BrokerConfig,
  io: { stdout: (line: string) => void; stderr: (line: string) => void },
): Promise<number> {
  const broker = new EvenRealitiesBroker(config)
  try {
    await broker.start()
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    io.stdout(JSON.stringify({ error: e.message, ...(e.code ? { code: e.code } : {}) } satisfies ServeOutcome))
    return 1
  }
  const status = broker.status()
  io.stdout(JSON.stringify({ ready: status } satisfies ServeOutcome))
  io.stderr(`[broker] serving ${status.url} for ${status.socketPath}, linger ${status.lingerMs}ms, session linger ${status.sessionLingerMs}ms`)
  const onSignal = (): void => void broker.close()
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)
  await broker.closed
  process.off('SIGTERM', onSignal)
  process.off('SIGINT', onSignal)
  io.stderr('[broker] stopped')
  return 0
}

async function waitFor(cond: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return cond()
}
