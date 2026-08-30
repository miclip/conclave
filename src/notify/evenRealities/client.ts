/**
 * The Even Realities Terminal Mode wire protocol, as a server conclave can be.
 *
 * ## Why a server rather than a client
 *
 * `even-terminal` runs an HTTP + SSE server on the operator's own machine and the glasses
 * connect to it over Tailscale, pointed at an address the operator types. So the way to put
 * conclave's questions in front of the glasses is to SPEAK THAT PROTOCOL, not to call theirs:
 * theirs drives its own Claude through `@anthropic-ai/claude-agent-sdk`, which is not the run
 * we want answered.
 *
 * ## No conclave imports, deliberately
 *
 * The expensive part of this file is knowing the wire format; the `Transport` wrapper beside it
 * is a few dozen lines. Keeping the protocol free of conclave types means the knowledge stays
 * usable from anything that can open a socket, and a format change lands here rather than in
 * something conclave depends on.
 *
 * ## The shape, read from @evenrealities/even-terminal 0.8.1
 *
 *   GET  /api/events?sessionId=&needReplay=  Server-Sent Events. `id: N\ndata: {json}\n\n`,
 *                                            `:ok` on open, `:heartbeat` every 15s.
 *   POST /api/question-response              `{ sessionId, answer }`
 *   POST /api/permission-response            `{ sessionId, decision }`
 *   GET  /api/sessions | /api/status | /api/messages
 *
 * Auth is a bearer token, accepted as `Authorization: Bearer <t>` or `?token=<t>`, which is
 * what lets an SSE connection carry it -- EventSource cannot set headers.
 *
 * Two message types matter here, and they are the two this exists to send:
 *
 *   { type: 'notification', title, message }
 *   { type: 'user_question', questions: [{ question, header, options: [{ label, description }] }] }
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'

export interface BridgeOptions {
  /** Their default is 3456. Ours differs so both can run at once. */
  port?: number
  /** Bearer token. Generated when absent, and printed by the caller for pairing. */
  token?: string
  /** What the glasses call this conversation. One session is all conclave needs. */
  sessionId?: string
  /** Bind address. Loopback by default: a tailnet address is a deliberate act. */
  host?: string
}

/** Anything the protocol can carry. Shapes above; the app ignores what it does not know. */
export type BridgeMessage =
  | { type: 'notification'; title: string; message: string }
  | {
      type: 'user_question'
      questions: { question: string; header: string; options: { label: string; description: string }[] }[]
    }

/** What came back from the glasses. `answer` is the option label, or free text, or `skip`. */
export interface BridgeAnswer {
  answer: string
}

const MAX_BUFFERED = 500

export class EvenRealitiesBridge {
  readonly token: string
  readonly sessionId: string
  readonly #host: string
  readonly #port: number
  #server: Server | undefined
  /** Live SSE responses. A message with no client is buffered, not lost. */
  readonly #clients = new Set<ServerResponse>()
  /** Replayed to a client that asks for it, the way their own server does. */
  readonly #buffered: { id: number; msg: BridgeMessage }[] = []
  #nextId = 1
  /** At most one question is outstanding: `/question-response` carries no question id. */
  #pending: ((a: BridgeAnswer) => void) | undefined
  /**
   * Answers that arrived with nothing waiting for them.
   *
   * A veto on a `decided` notification lands here: the decision was already taken, so nothing
   * was awaiting a reply, and dropping the tap would make the override on screen a lie.
   */
  readonly #unsolicited: BridgeAnswer[] = []

  constructor(opts: BridgeOptions = {}) {
    this.token = opts.token ?? randomBytes(16).toString('hex')
    this.sessionId = opts.sessionId ?? 'conclave'
    this.#host = opts.host ?? '127.0.0.1'
    this.#port = opts.port ?? 3457
  }

  /** The address to type into the glasses app, once listening. */
  get url(): string {
    const a = this.#server?.address()
    const port = a !== null && typeof a === 'object' ? a.port : this.#port
    return `http://${this.#host}:${port}`
  }

  async listen(): Promise<void> {
    const server = createServer((req, res) => this.#route(req, res))
    this.#server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.#port, this.#host, () => resolve())
    })
  }

  async close(): Promise<void> {
    for (const c of this.#clients) c.end()
    this.#clients.clear()
    // A pending question is answered `skip` rather than left hanging: a caller awaiting it
    // through a shutdown would otherwise never resolve, and "nobody answered" is the truth.
    this.#pending?.({ answer: 'skip' })
    this.#pending = undefined
    const server = this.#server
    this.#server = undefined
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Push a message to every connected client, and buffer it for one that connects later. */
  send(msg: BridgeMessage): number {
    const id = this.#nextId++
    this.#buffered.push({ id, msg })
    if (this.#buffered.length > MAX_BUFFERED) this.#buffered.shift()
    const data = JSON.stringify(msg)
    for (const res of [...this.#clients]) {
      try {
        res.write(`id: ${id}\ndata: ${data}\n\n`)
      } catch {
        this.#clients.delete(res)
      }
    }
    return id
  }

  /**
   * Ask, and wait for `/question-response`.
   *
   * Rejects a second concurrent question rather than queueing it: their endpoint carries no
   * question id, so two outstanding questions cannot be told apart and the second answer would
   * be attributed to whichever the server happened to be holding.
   */
  async ask(q: { header: string; question: string; options: { label: string; description: string }[] }): Promise<BridgeAnswer> {
    if (this.#pending) throw new Error('a question is already outstanding on this bridge')
    this.send({ type: 'user_question', questions: [q] })
    return new Promise<BridgeAnswer>((resolve) => {
      this.#pending = resolve
    })
  }

  /** Take the late answers, clearing them. Never waits. */
  takeUnsolicited(): BridgeAnswer[] {
    return this.#unsolicited.splice(0, this.#unsolicited.length)
  }

  #authorised(req: IncomingMessage, url: URL): boolean {
    const header = req.headers.authorization
    const provided = header?.startsWith('Bearer ') ? header.slice(7) : (url.searchParams.get('token') ?? undefined)
    return provided === this.token
  }

  #route(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    // Their server sets permissive CORS; the app is a WebView and needs it.
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type')
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }
    if (!this.#authorised(req, url)) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      this.#stream(url, res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/question-response') {
      this.#answer(req, res)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ sessions: [{ sessionId: this.sessionId, provider: 'conclave' }] }),
      )
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ sessionId: this.sessionId, running: this.#pending !== undefined }),
      )
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/messages') {
      const after = Number(url.searchParams.get('after') ?? '0')
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify(this.#buffered.filter((m) => m.id > after).map((m) => ({ id: m.id, ...m.msg }))),
      )
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Not found' }))
  }

  #stream(url: URL, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // Their server sets this; a proxy that buffered an event stream would defeat it.
      'x-accel-buffering': 'no',
    })
    res.write(':ok\n\n')
    if (url.searchParams.get('needReplay') === 'true') {
      for (const e of this.#buffered) res.write(`id: ${e.id}\ndata: ${JSON.stringify(e.msg)}\n\n`)
    }
    this.#clients.add(res)
    const beat = setInterval(() => {
      try {
        res.write(':heartbeat\n\n')
      } catch {
        clearInterval(beat)
        this.#clients.delete(res)
      }
    }, 15_000)
    // Unref'd: a heartbeat must not be the reason a process cannot exit.
    beat.unref?.()
    res.on('close', () => {
      clearInterval(beat)
      this.#clients.delete(res)
    })
  }

  #answer(req: IncomingMessage, res: ServerResponse): void {
    let body = ''
    req.on('data', (c) => {
      body += String(c)
      // A body this large is not an answer. Bounded so a malformed client cannot grow it.
      if (body.length > 1_000_000) req.destroy()
    })
    req.on('end', () => {
      let answer = 'skip'
      try {
        const parsed = JSON.parse(body) as { answer?: unknown }
        if (typeof parsed.answer === 'string') answer = parsed.answer
      } catch {
        // Left as `skip`. An unparseable body is not an answer, and inventing one from it is
        // the failure this whole area is about.
      }
      const pending = this.#pending
      this.#pending = undefined
      if (pending) pending({ answer })
      else this.#unsolicited.push({ answer })
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
    })
  }
}
