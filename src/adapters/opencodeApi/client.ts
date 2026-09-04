/**
 * The HTTP half of the OpenCode API transport: everything this adapter SAYS, as opposed to
 * everything it hears (`sse.ts`).
 *
 * Thin on purpose. It owns the routes, the password, and the shape of a failure — and nothing
 * about turns, verdicts or sessions-as-conclave-means-them. The adapter above it decides what a
 * failed call means for a seat; this decides only what "failed" is.
 */

import type { ServerEvent } from './sse.ts'
import { readServerEvents } from './sse.ts'

/**
 * Why a call did not do what was asked, in terms a caller can act on.
 *
 * `unreachable` and `refused` are different repairs and must not collapse: the first is a server
 * that is not there -- start it, or check the port -- and the second is a server that is there
 * and said no, which no amount of retrying fixes. The run-per-turn adapter cannot draw this
 * distinction at all; a spawn failure and a non-zero exit look alike from the outside.
 */
export class OpenCodeApiError extends Error {
  // Declared and assigned rather than taken as constructor parameter properties: `tsconfig` sets
  // `erasableSyntaxOnly`, because this repository is run through Node's type stripping rather
  // than compiled, and a parameter property is syntax that has to be emitted rather than erased.
  readonly kind: 'unreachable' | 'refused'
  readonly route: string
  readonly status: number | undefined

  constructor(kind: 'unreachable' | 'refused', route: string, status: number | undefined, message: string) {
    super(message)
    this.name = 'OpenCodeApiError'
    this.kind = kind
    this.route = route
    this.status = status
  }
}

export interface OpenCodeClientOptions {
  /** Base URL of a running server, e.g. `http://127.0.0.1:4599`. */
  baseUrl: string
  /**
   * `OPENCODE_SERVER_PASSWORD`, when the server was started with one.
   *
   * The server says on startup: "OPENCODE_SERVER_PASSWORD is not set; server is unsecured". An
   * unsecured server on a loopback port is a local HTTP endpoint that will take a prompt from
   * anything on the machine, so this is carried whenever there is one to carry.
   */
  password?: string | undefined
  /** Injected so tests need no network and no OpenCode. */
  fetch?: typeof globalThis.fetch
}

export class OpenCodeClient {
  readonly #baseUrl: string
  readonly #password: string | undefined
  readonly #fetch: typeof globalThis.fetch

  constructor(opts: OpenCodeClientOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.#password = opts.password
    this.#fetch = opts.fetch ?? globalThis.fetch
  }

  /** Create a session and return its id. */
  async createSession(): Promise<string> {
    const body = await this.#json<{ id?: unknown }>('POST', '/session', {})
    const id = body?.id
    if (typeof id !== 'string' || id === '') {
      throw new OpenCodeApiError('refused', '/session', undefined, 'the server created a session with no id')
    }
    return id
  }

  /**
   * Send a prompt. Returns as soon as the server has ACCEPTED it, not when the turn ends.
   *
   * That asymmetry is the point and it is what `AgentSession.send` wants: the turn is awaited
   * through the event stream, exactly as the pty adapters await a `Stop` hook. A synchronous
   * prompt route would make `send` block for the length of a turn and there would be nothing to
   * observe in the meantime.
   */
  async promptAsync(sessionId: string, text: string): Promise<void> {
    await this.#json('POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      parts: [{ type: 'text', text }],
    })
  }

  /** Run a command in the session — the route that makes slash commands a POST (#215). */
  async command(sessionId: string, command: string): Promise<void> {
    await this.#json('POST', `/session/${encodeURIComponent(sessionId)}/command`, { command })
  }

  /** Stop the turn in flight without killing anything. */
  async abort(sessionId: string): Promise<void> {
    await this.#json('POST', `/session/${encodeURIComponent(sessionId)}/abort`, {})
  }

  /** Subscribe to the server's event stream. Ends when the server closes it or `signal` aborts. */
  async *events(signal?: AbortSignal): AsyncGenerator<ServerEvent> {
    const route = '/event'
    let res: Response
    try {
      res = await this.#fetch(`${this.#baseUrl}${route}`, {
        headers: this.#headers({ accept: 'text/event-stream' }),
        ...(signal ? { signal } : {}),
      })
    } catch (e) {
      throw new OpenCodeApiError('unreachable', route, undefined, `${this.#baseUrl} is not answering: ${describe(e)}`)
    }
    if (!res.ok) throw new OpenCodeApiError('refused', route, res.status, `the server refused the event stream: ${res.status}`)
    if (!res.body) throw new OpenCodeApiError('refused', route, res.status, 'the event stream had no body')
    yield* readServerEvents(res.body as unknown as AsyncIterable<Uint8Array>)
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.#password === undefined ? {} : { authorization: basicAuth(this.#password) }),
      ...extra,
    }
  }

  async #json<T>(method: string, route: string, body: unknown): Promise<T | undefined> {
    let res: Response
    try {
      res = await this.#fetch(`${this.#baseUrl}${route}`, {
        method,
        headers: this.#headers(),
        body: JSON.stringify(body),
      })
    } catch (e) {
      // The server is not there. Distinct from a refusal, and the repair is different.
      throw new OpenCodeApiError('unreachable', route, undefined, `${this.#baseUrl} is not answering: ${describe(e)}`)
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new OpenCodeApiError('refused', route, res.status, `${method} ${route} -> ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
    }
    const text = await res.text().catch(() => '')
    if (text === '') return undefined
    try {
      return JSON.parse(text) as T
    } catch {
      // A 200 whose body is not JSON. Reported rather than swallowed: it means the route did
      // something other than what this client believes it does.
      throw new OpenCodeApiError('refused', route, res.status, `${route} answered with something that is not JSON`)
    }
  }
}

/**
 * The username OpenCode's Basic auth requires. NOT decoration -- it is checked.
 *
 * Probed against a running 1.18.27 server: `opencode:<password>` answers 200, while
 * `anything:<password>`, `x:<password>` and an EMPTY username all answer 401, as does
 * `opencode:<wrong>`. So both halves are verified and the username is not free.
 *
 * This was `Bearer <password>` first, written from the shape of most APIs rather than from this
 * one. It returns 401. The mistake was invisible on 1.18.15, which did not enforce the password
 * at all -- it printed "OPENCODE_SERVER_PASSWORD is not set; server is unsecured" and answered
 * anyway -- so a client with the wrong scheme worked until the server started checking.
 */
const BASIC_AUTH_USER = 'opencode'

const basicAuth = (password: string): string =>
  `Basic ${Buffer.from(`${BASIC_AUTH_USER}:${password}`).toString('base64')}`

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e))
