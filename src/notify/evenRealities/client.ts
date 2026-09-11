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
 * ## A session is a run (#278)
 *
 * `sessionId` is the routing key on every endpoint that matters -- `GET /events?sessionId=`,
 * `POST /question-response`, and `pushMessage(sessionId, msg)` inside their `routes/events.js`.
 * An earlier version of this file hardcoded one id for the whole machine and multiplexed every
 * run onto it, which is why the hub had to serialise questions: an answer named the session,
 * and the session named nothing. Now each run opens its own, the answer names the run, and one
 * outstanding question PER RUN is a guarantee the protocol gives rather than one we enforce.
 *
 * Their server keeps 500 messages per session with monotonic ids and replays them to a client
 * that connects with `needReplay=true`; so does this one. A question raised while the glasses
 * are off is held and replayed rather than lost.
 *
 * ## The shape, read from @evenrealities/even-terminal 0.8.1
 *
 *   GET  /api/events?sessionId=&needReplay=  Server-Sent Events. `id: N\ndata: {json}\n\n`,
 *                                            `:ok` on open, `:heartbeat` every 15s.
 *   POST /api/question-response              `{ sessionId, answer }`
 *   POST /api/permission-response            `{ sessionId, decision }`
 *   GET  /api/sessions                       `{ sessions: [{ id, title, timestamp, cwd, provider, status }] }`
 *   GET  /api/status?sessionId=              `{ state, sessionId, provider }`
 *   GET  /api/messages?sessionId=&after=     `{ messages, state, sessionId, provider }`
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
  /** Their default is 3456, and so is ours: the app dials it unless told otherwise. */
  port?: number
  /** Bearer token. Generated when absent, and printed by the caller for pairing. */
  token?: string
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

/**
 * What their `getStatus` reports for a session, read from `dist/claude/session.js`: `awaiting`
 * with an unanswered question, otherwise `busy` or `idle`. `idle` is also what `/messages` says
 * of a session it does not have, because that is what theirs says.
 */
export type SessionState = 'awaiting' | 'busy' | 'idle'

/**
 * What a run says about itself, for the session list. Supplied by whoever opens the session
 * and asked again on every `/sessions`, so activity after opening changes the answer.
 *
 * The fields are the vendor's list item, read from `listClaudeSessions` in
 * `dist/claude/provider.js` -- `title`, `timestamp`, `cwd`, `status` -- and nothing that is not
 * there. `openedAt` was served once and was exactly the invented field that rule exists to
 * catch: not in the literal, so not on the wire.
 */
export interface SessionMetadata {
  /** What the operator reads when choosing a run. Cut to the vendor's length on the way out. */
  title: string
  /**
   * LAST ACTIVITY, as an ISO string. Theirs is `new Date(info.lastModified).toISOString()` --
   * the mtime of a transcript that moves only when something is appended -- so the field means
   * "when did this last do something", and a heartbeat in it would sort every live run to the
   * top and make a run stuck for two hours read as though it just moved.
   */
  timestamp: string
  cwd: string
  /** What is genuinely known, else `null`: theirs lists `null` and fills it in afterwards. */
  status: SessionState | null
}

/** Their `title` is `.slice(0, 64)`; pinned against the bundle by `evenCompat.test.ts`. */
const TITLE_CHARS = 64

/**
 * THE PROVIDER IS A LIE, AND A DELIBERATE ONE.
 *
 * `SUPPORTED_PROVIDERS = ["claude", "codex"]` in their `dist/session.js`, enforced by middleware
 * in `dist/routes/core.js` that answers 400 to any other value. A conclave run is neither, and
 * an honest `provider: "conclave"` was tried first: the app polled `/api/sessions` eighteen times,
 * never opened a session and never opened the stream (#276), because an entry under a provider
 * it does not know is not a session it can open.
 *
 * `claude` is claimed because it is the one the app treats most plainly and because the
 * device-side consequences are unknown: the app may try provider-specific things with a
 * session it believes is a Claude one, and nothing on this side can observe that. If it does,
 * the failure will look like an app misbehaving, and this constant is the first place to look.
 */
const CLAIMED_PROVIDER = 'claude'

const MAX_BUFFERED = 500

/** The routes this server answers, named once so the refusal and the tests agree. */
const SERVED = new Set([
  '/api/events',
  '/api/question-response',
  '/api/sessions',
  '/api/status',
  '/api/messages',
])

/** One run, as the glasses see it. Everything routed by `sessionId` lives here and nowhere else. */
interface Session {
  readonly id: string
  /** Asked on every listing. Undefined means "could not read it now"; the last answer stands. */
  readonly describe: () => SessionMetadata | undefined
  /** The last thing `describe` said. Real data, possibly older; never invented. */
  meta: SessionMetadata
  /** Live SSE responses. A message with no client is buffered, not lost. */
  readonly clients: Set<ServerResponse>
  /** Replayed to a client that asks for it, the way their own server does. */
  readonly buffered: { id: number; msg: BridgeMessage }[]
  nextId: number
  /** At most one question is outstanding per session: `/question-response` carries no question id. */
  pending: ((a: BridgeAnswer) => void) | undefined
  /**
   * Answers that arrived with nothing waiting for them.
   *
   * A veto on a `decided` notification lands here: the decision was already taken, so nothing
   * was awaiting a reply, and dropping the tap would make the override on screen a lie.
   */
  readonly unsolicited: BridgeAnswer[]
}

export class EvenRealitiesBridge {
  readonly token: string
  readonly #host: string
  readonly #port: number
  #server: Server | undefined
  readonly #sessions = new Map<string, Session>()

  constructor(opts: BridgeOptions = {}) {
    this.token = opts.token ?? randomBytes(16).toString('hex')
    this.#host = opts.host ?? '127.0.0.1'
    this.#port = opts.port ?? 3456
  }

  /** The address to type into the glasses app, once listening. */
  get url(): string {
    const a = this.#server?.address()
    const port = a !== null && typeof a === 'object' ? a.port : this.#port
    return `http://${this.#host}:${port}`
  }

  /** Every route this server answers. The refusal quotes it and `evenCompat.test.ts` pins it. */
  static readonly SERVED = SERVED

  /** The provider every session claims to be. Pinned by `evenCompat.test.ts` against their whitelist. */
  static readonly CLAIMED_PROVIDER = CLAIMED_PROVIDER

  /** How much of a title the list carries. Pinned by `evenCompat.test.ts` against their `.slice`. */
  static readonly TITLE_CHARS = TITLE_CHARS

  async listen(): Promise<void> {
    // Refused rather than replaced: a second server would leak the first, still bound and still
    // holding the event loop open, with nothing left that could close it.
    if (this.#server) throw new Error('the bridge is already listening')
    const server = createServer((req, res) => this.#route(req, res))
    this.#server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.#port, this.#host, () => resolve())
    })
  }

  /** Close every session, then the server. */
  async close(): Promise<void> {
    for (const id of [...this.#sessions.keys()]) this.closeSession(id)
    const server = this.#server
    this.#server = undefined
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /**
   * Make a run visible to the glasses. Idempotent: opening an id that is open keeps what it
   * has, buffer included, so a second caller in the same process joins rather than resets.
   *
   * `describe` must answer NOW, or the session is not opened: a list item with no real run
   * behind it is the invented entry this surface refuses to serve.
   */
  openSession(id: string, describe: () => SessionMetadata | undefined): void {
    if (this.#sessions.has(id)) return
    const meta = describe()
    if (!meta) throw new Error(`no metadata for session ${id}: a session is a run, and this one cannot be read`)
    this.#sessions.set(id, {
      id,
      describe,
      meta,
      clients: new Set(),
      buffered: [],
      nextId: 1,
      pending: undefined,
      unsolicited: [],
    })
  }

  /**
   * Forget a run. Its stream ends and its buffer goes with it: a question replayed for a run
   * that has already ended would be answered into nothing.
   */
  closeSession(id: string): void {
    const s = this.#sessions.get(id)
    if (!s) return
    this.#sessions.delete(id)
    for (const c of s.clients) c.end()
    s.clients.clear()
    // A pending question is answered `skip` rather than left hanging: a caller awaiting it
    // through a shutdown would otherwise never resolve, and "nobody answered" is the truth.
    s.pending?.({ answer: 'skip' })
    s.pending = undefined
  }

  /** The runs currently open, in the order they opened. */
  sessions(): string[] {
    return [...this.#sessions.keys()]
  }

  /** Push a message to every client of one run, and buffer it for one that connects later. */
  send(sessionId: string, msg: BridgeMessage): number {
    const s = this.#must(sessionId)
    const id = s.nextId++
    s.buffered.push({ id, msg })
    if (s.buffered.length > MAX_BUFFERED) s.buffered.shift()
    const data = JSON.stringify(msg)
    for (const res of [...s.clients]) {
      try {
        res.write(`id: ${id}\ndata: ${data}\n\n`)
      } catch {
        s.clients.delete(res)
      }
    }
    return id
  }

  /**
   * Ask one run's operator, and wait for `/question-response` naming that run.
   *
   * Rejects a second concurrent question ON THE SAME RUN rather than queueing it: their endpoint
   * carries a session id and no question id, so two outstanding on one session cannot be told
   * apart and the second answer would go to whichever the server happened to be holding. Two
   * runs asking at once is fine, and is the point of #278.
   */
  async ask(
    sessionId: string,
    q: { header: string; question: string; options: { label: string; description: string }[] },
  ): Promise<BridgeAnswer> {
    const s = this.#must(sessionId)
    if (s.pending) throw new Error(`a question is already outstanding on session ${sessionId}`)
    this.send(sessionId, { type: 'user_question', questions: [q] })
    return new Promise<BridgeAnswer>((resolve) => {
      s.pending = resolve
    })
  }

  /** Take one run's late answers, clearing them. Never waits. */
  takeUnsolicited(sessionId: string): BridgeAnswer[] {
    const s = this.#must(sessionId)
    return s.unsolicited.splice(0, s.unsolicited.length)
  }

  #must(sessionId: string): Session {
    const s = this.#sessions.get(sessionId)
    if (!s) throw new Error(`no session ${sessionId} is open on this bridge`)
    return s
  }

  /** Re-ask the run, keeping the last answer when it cannot be read this time. */
  #refresh(s: Session): SessionMetadata {
    const now = s.describe()
    if (now) s.meta = now
    return s.meta
  }

  /**
   * A question outstanding on the bridge is `awaiting` whatever the run says; otherwise the
   * run's own word, which may be `null` when nothing is genuinely known.
   *
   * Takes the metadata rather than fetching it, so a caller that also serves the other fields
   * derives everything from ONE reading of the run: a status from a second reading could
   * disagree with the timestamp beside it.
   */
  #stateOf(s: Session, meta: SessionMetadata): SessionState | null {
    return s.pending ? 'awaiting' : meta.status
  }

  #authorised(req: IncomingMessage, url: URL): boolean {
    const header = req.headers.authorization
    const provided = header?.startsWith('Bearer ') ? header.slice(7) : (url.searchParams.get('token') ?? undefined)
    return provided === this.token
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  }

  /**
   * The session a request names, or the refusal their server would give.
   *
   * Both statuses and both messages are theirs (`dist/routes/core.js`): 400 `Missing
   * 'sessionId'` and 404 `Session not found`. An app built against those strings gets them.
   */
  #named(req: IncomingMessage, res: ServerResponse, path: string, sessionId: string | undefined): Session | undefined {
    if (!sessionId) {
      this.#log(req, 400, path)
      this.#json(res, 400, { error: "Missing 'sessionId'" })
      return undefined
    }
    const s = this.#sessions.get(sessionId)
    if (!s) {
      this.#log(req, 404, path)
      this.#json(res, 404, { error: 'Session not found' })
      return undefined
    }
    return s
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
      this.#json(res, 401, { error: 'Unauthorized' })
      return
    }
    const sessionId = url.searchParams.get('sessionId') ?? undefined

    if (req.method === 'GET' && url.pathname === '/api/events') {
      // Their `routes/events.js` words this one differently from `core.js`, and it is served
      // as they word it.
      if (!sessionId) {
        this.#log(req, 400, url.pathname)
        this.#json(res, 400, { error: "Missing 'sessionId' query parameter" })
        return
      }
      const s = this.#named(req, res, url.pathname, sessionId)
      if (!s) return
      this.#log(req, 200, url.pathname)
      this.#stream(s, url, res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/question-response') {
      this.#answer(req, res, url.pathname)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      this.#log(req, 200, url.pathname)
      // THE ITEM IS THE VENDOR'S, field for field, from `listClaudeSessions` in
      // `dist/claude/provider.js`: `{ id, title, timestamp, cwd, provider, status }`. `id` is
      // the key the app reads back -- `core.js` does `provider.getSessionStatus(s.id)` -- and an
      // earlier version served `sessionId` instead, which the app never looked at (#278).
      //
      // Every field is the run's own record, re-read here -- ONCE per item, so title, timestamp
      // and status are one snapshot -- so activity since the session opened changes the answer.
      // Nothing that is not in that literal is served: what the app does with a field the
      // vendor never sends is unverified, and an invented one is protocol the app was not
      // built against.
      this.#json(res, 200, {
        sessions: [...this.#sessions.values()].map((s) => {
          const meta = this.#refresh(s)
          return {
            id: s.id,
            title: meta.title.slice(0, TITLE_CHARS),
            timestamp: meta.timestamp,
            cwd: meta.cwd,
            provider: CLAIMED_PROVIDER,
            status: this.#stateOf(s, meta),
          }
        }),
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const s = this.#named(req, res, url.pathname, sessionId)
      if (!s) return
      this.#log(req, 200, url.pathname)
      this.#json(res, 200, { state: this.#stateOf(s, this.#refresh(s)), sessionId: s.id, provider: CLAIMED_PROVIDER })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/messages') {
      if (!sessionId) {
        this.#log(req, 400, url.pathname)
        this.#json(res, 400, { error: "Missing 'sessionId'" })
        return
      }
      this.#log(req, 200, url.pathname)
      const after = Number(url.searchParams.get('after') ?? '0')
      // An unknown session is EMPTY rather than 404 here, because that is what theirs does:
      // `getMessages` returns `[]` for a session it has no buffer for and the state reads `idle`.
      const s = this.#sessions.get(sessionId)
      this.#json(res, 200, {
        messages: s ? s.buffered.filter((m) => m.id > after).map((m) => ({ id: m.id, ...m.msg })) : [],
        state: s ? this.#stateOf(s, this.#refresh(s)) : 'idle',
        sessionId,
        provider: CLAIMED_PROVIDER,
      })
      return
    }
    // AN UNMATCHED ROUTE SAYS WHAT THIS SURFACE IS (#276). A bare 404 made every failure look
    // identical: a device on the wrong port, a device speaking a newer protocol, and a person
    // typing a message all produced the same silence, and the only way to tell them apart was
    // to run a logging server in conclave's place and ask the operator to try again.
    //
    // This is a NOTIFICATION surface, not a terminal. It asks a question and waits for the tap
    // that answers it. `even-terminal` accepts prompts because it drives a Claude session; this
    // does not, and a free-text message arriving here has nowhere to go -- so it is refused in
    // those words rather than dropped. `/api/prompt` is NOT implemented, and that is the decision
    // rather than a gap (#278): accepting prompts would make this a control surface, and
    // `broker.ts`'s allow-list and "an answer is not an instruction" exist to keep an outside
    // voice from becoming one.
    this.#log(req, 404, url.pathname)
    this.#json(res, 404, {
      error: 'Not found',
      served: [...SERVED].sort(),
      note:
        'conclave notify is a notification surface, not a terminal: it asks and waits for an ' +
        'answer to POST /api/question-response. It does not accept prompts — run even-terminal for that.',
    })
  }

  /**
   * One line per request, because the alternative is inferring from absence.
   *
   * `even-terminal` prints these and it is how every question in this integration was answered:
   * which address reached the port, which path, which status. Without it a request that never
   * arrives and one that arrives and is refused look the same from here.
   */
  #log(req: IncomingMessage, status: number, path: string): void {
    if (process.env['CONCLAVE_EVEN_QUIET'] === '1') return
    const from = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '?'
    process.stderr.write(`[even] ${from} ${status} ${req.method} ${path}\n`)
  }

  #stream(s: Session, url: URL, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // Their server sets this; a proxy that buffered an event stream would defeat it.
      'x-accel-buffering': 'no',
    })
    res.write(':ok\n\n')
    if (url.searchParams.get('needReplay') === 'true') {
      for (const e of s.buffered) res.write(`id: ${e.id}\ndata: ${JSON.stringify(e.msg)}\n\n`)
    }
    s.clients.add(res)
    const beat = setInterval(() => {
      try {
        res.write(':heartbeat\n\n')
      } catch {
        clearInterval(beat)
        s.clients.delete(res)
      }
    }, 15_000)
    // Unref'd: a heartbeat must not be the reason a process cannot exit.
    beat.unref?.()
    res.on('close', () => {
      clearInterval(beat)
      s.clients.delete(res)
    })
  }

  #answer(req: IncomingMessage, res: ServerResponse, path: string): void {
    let body = ''
    req.on('data', (c) => {
      body += String(c)
      // A body this large is not an answer. Bounded so a malformed client cannot grow it.
      if (body.length > 1_000_000) req.destroy()
    })
    req.on('end', () => {
      let sessionId: string | undefined
      let answer = 'skip'
      try {
        const parsed = JSON.parse(body) as { sessionId?: unknown; answer?: unknown }
        if (typeof parsed.sessionId === 'string') sessionId = parsed.sessionId
        if (typeof parsed.answer === 'string') answer = parsed.answer
      } catch {
        // Left as `skip` with no session. An unparseable body is not an answer, and inventing
        // one from it is the failure this whole area is about; with no session named it is
        // refused below, as theirs refuses it, and settles nothing.
      }
      const s = this.#named(req, res, path, sessionId)
      if (!s) return
      this.#log(req, 200, path)
      const pending = s.pending
      s.pending = undefined
      if (pending) pending({ answer })
      else s.unsolicited.push({ answer })
      this.#json(res, 200, { ok: true })
    })
  }
}
