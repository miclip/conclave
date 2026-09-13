/**
 * One bridge, many PROCESSES. #286.
 *
 * Before this, a run held the bridge itself, and an in-process hub shared it between the
 * runs of ONE process -- which is where sharing stopped: two `conclave session` commands in
 * two terminals are two processes, the second met a bound port, and the hub's own note said
 * sharing across them "means a broker that outlives every run". This is that broker, and the
 * hub is gone. It owns the one `EvenRealitiesBridge` on the machine and serves it over a Unix
 * socket; a run connects, opens its session, asks or tells, and disconnects.
 *
 * NOT `../broker.ts`. That file is the notification broker -- the thing that matches an
 * answer to the question that offered its options. This one brokers the DEVICE between
 * processes and has nothing to say about what an answer means; it hands `{ answer }` back to
 * the connection whose question it was, and the notification broker in that process does
 * the rest. The name is the issue's, kept because it is what the operator will read.
 *
 * ## What the evidence removed (#286)
 *
 * The broker discovers nothing and names nothing. A run WRITES its registration -- id, goal,
 * cwd, last activity -- in the `open` frame, and the broker serves exactly that. Routing is
 * correlation: an answer for session X goes to the connection that opened X, because that
 * is where the question came from. There is no lookup a second run could collide with.
 *
 * Liveness is the socket. A connection that drops takes its session with it, so a run that
 * crashed is gone from `/api/sessions` the moment the kernel notices, and a stale entry --
 * conclave's own `state` vs `alive` split -- has no way to form.
 *
 * ## The wire
 *
 * Newline-delimited JSON, one frame per line, both ways. A request carries an `id` the reply
 * echoes, so a client can have a `tell` and an `ask` in flight together.
 *
 *   -> { type: 'open', sessionId, meta }     <- { type: 'opened', url, token }
 *   -> { type: 'tell', id, msg }             <- { type: 'sent', id, messageId }
 *   -> { type: 'ask', id, question }         <- { type: 'answer', id, answer }
 *   -> { type: 'poll', id }                  <- { type: 'answers', id, answers }
 *   -> { type: 'status', id }                <- { type: 'status', id, pid, url, token, ... }
 *   -> { type: 'stop', id }                  <- { type: 'stopping', id }, then EOF
 *                                            <- { type: 'error', id?, message }
 *
 * One connection is one session, and closing it closes the session -- there is no `close`
 * frame, because the socket is the liveness and a frame could be forgotten where a FIN
 * cannot. `open` sent again on the same connection with the same id refreshes `meta`, which
 * is how a run's timestamp moves while it is attached. `poll` is here because the transport's
 * veto path (`takeUnsolicited`) needs it.
 *
 * `status` and `stop` are the lifecycle, and they are the only frames a connection may send
 * WITHOUT opening a session: `conclave notify broker status|stop` is an operator asking after
 * the broker, not a run. A connection that only asks is not a run either -- it neither holds
 * the linger nor arms it -- and `status` is how the CLI rediscovers the facts it printed at
 * start (pid, socket, device address, token) from the one place they are true.
 *
 * ## Why it lingers, and why for sixty seconds
 *
 * The broker outlives the run that started it, and the question is by how much. Zero would
 * make it pointless: `conclave notify ask` lives exactly as long as its question, and a
 * broker that died with it would be re-bound by the next invocation a second later, dropping
 * the device's connection in between -- which is the "working answer looks like a failure"
 * of #285, now once per run. Forever would be a daemon the operator never asked for, holding
 * a port they may want back, and #286 is explicit that nothing here starts a long-lived
 * process behind anyone's back.
 *
 * Sixty seconds bridges the normal case -- consecutive invocations from a run, or from two
 * runs finishing and starting -- while bounding how long an unattended broker holds the port
 * after the last run is gone. It is a judgement, so it is a number an operator can move:
 * `CONCLAVE_EVEN_LINGER_MS`.
 */

import { chmodSync, unlinkSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import { EvenRealitiesBridge, type BridgeAnswer, type BridgeMessage, type BridgeOptions, type SessionMetadata } from './client.ts'

/** How long the broker stays up with no run attached, unless `CONCLAVE_EVEN_LINGER_MS` says otherwise. */
export const DEFAULT_LINGER_MS = 60_000

export const LINGER_ENV = 'CONCLAVE_EVEN_LINGER_MS'

/**
 * The least a broker waits for its FIRST run. The linger proper is measured from the last
 * disconnect, and an operator may set it to zero -- exit with the last run -- but the timer
 * armed at `start()` guards a different case, a broker nobody ever dialled, and at zero it
 * fired before the run that started the broker could connect (found by mutation: two tests
 * lost that race). A second is long enough for a `connect()` on a local socket by any margin
 * and short enough that an abandoned broker is still gone before anyone notices it.
 */
export const START_GRACE_MS = 1_000

/** The socket to serve or dial, when the per-user default is not wanted. */
export const SOCKET_ENV = 'CONCLAVE_EVEN_SOCKET'

/**
 * The linger, from the environment or the default. Anything that is not a non-negative
 * number is the default: a typo must not turn into a broker that exits at once or never.
 */
export function lingerMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[LINGER_ENV]
  if (raw === undefined || raw.trim() === '') return DEFAULT_LINGER_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LINGER_MS
}

/**
 * Where the broker is, for everything on this machine running as this user.
 *
 * Deterministic on purpose: a run finds the broker by KNOWING the path, not by searching
 * for it. Per user, because a Unix socket is a file and a shared `/tmp` would have one user's
 * runs dialling another's device. `XDG_RUNTIME_DIR` is the right place where it exists
 * (Linux, per-user, cleared at logout); `tmpdir()` elsewhere, which on macOS is per-user
 * already. The uid is in the name either way, so the answer is the same shape everywhere.
 */
export function brokerSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const given = env[SOCKET_ENV]
  if (given !== undefined && given.trim() !== '') return given.trim()
  const dir = env['XDG_RUNTIME_DIR']?.trim() || tmpdir()
  const who = process.getuid?.() ?? userInfo().username
  return join(dir, `conclave-even-${who}.sock`)
}

export interface BrokerOptions extends BridgeOptions {
  socketPath?: string
  lingerMs?: number
}

type Question = Parameters<EvenRealitiesBridge['ask']>[1]

/** Frames a client may send. Anything else is answered with an `error`. */
type Request =
  | { type: 'open'; sessionId: string; meta: SessionMetadata }
  | { type: 'tell'; id: number; msg: BridgeMessage }
  | { type: 'ask'; id: number; question: Question }
  | { type: 'poll'; id: number }
  | { type: 'status'; id: number }
  | { type: 'stop'; id: number }

/** What a broker says about itself: everything the CLI prints at start, and the runs attached now. */
export interface BrokerStatus {
  pid: number
  socketPath: string
  url: string
  token: string
  /** ISO. When the broker bound; a status older than a run means the run did not start it. */
  startedAt: string
  lingerMs: number
  sessions: string[]
}

/** Frames the broker sends back. */
type Reply =
  | { type: 'opened'; url: string; token: string }
  | { type: 'sent'; id: number; messageId: number }
  | { type: 'answer'; id: number; answer: string }
  | { type: 'answers'; id: number; answers: BridgeAnswer[] }
  | ({ type: 'status'; id: number } & BrokerStatus)
  | { type: 'stopping'; id: number }
  | { type: 'error'; id?: number; message: string }

/** What the broker holds per connection: the session it opened, and the metadata it last sent. */
interface Attached {
  sessionId: string
  meta: SessionMetadata
}

export class EvenRealitiesBroker {
  readonly bridge: EvenRealitiesBridge
  readonly socketPath: string
  readonly #lingerMs: number
  #server: Server | undefined
  #linger: NodeJS.Timeout | undefined
  readonly #connections = new Set<Socket>()
  /**
   * Session id -> the one connection that opened it. Not a routing table -- an answer finds
   * its run through the promise `ask` holds -- but the check that refuses a second claim.
   */
  readonly #owners = new Map<string, Socket>()
  /**
   * Settles when the broker has shut down, by `close()` or by lingering out. A caller that
   * runs the broker as a process awaits this to know when to exit.
   */
  readonly closed: Promise<void>
  #resolveClosed!: () => void
  #startedAt = ''

  constructor(opts: BrokerOptions = {}) {
    const { socketPath, lingerMs: linger, ...bridge } = opts
    this.bridge = new EvenRealitiesBridge(bridge)
    this.socketPath = socketPath ?? brokerSocketPath()
    this.#lingerMs = linger ?? lingerMs()
    this.closed = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve
    })
  }

  /**
   * Bind the bridge and the socket. The bridge first: a run that reaches the socket must find
   * a device address behind it, and a socket with no bridge would accept an `open` it could
   * not serve.
   *
   * A socket file left by a broker that died is unlinked and reused -- nothing answers it, so
   * nothing is lost. One that answers is another broker, and this one refuses rather than
   * stealing it: the caller's move is to dial it.
   */
  async start(): Promise<void> {
    if (this.#server) throw new Error('the broker is already serving')
    await this.bridge.listen()
    const server = createServer((socket) => this.#attach(socket))
    try {
      await listenOn(server, this.socketPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || (await brokerAlive(this.socketPath))) {
        await this.bridge.close()
        throw err
      }
      unlinkSync(this.socketPath)
      await listenOn(server, this.socketPath)
    }
    // OWNER-ONLY. The socket is the device: anything that can connect can open a session on
    // the glasses and answer the questions on it. `tmpdir()` is per-user on macOS and
    // `XDG_RUNTIME_DIR` on Linux, but `CONCLAVE_EVEN_SOCKET` can point anywhere, and the mode
    // is what holds either way. Set after the bind because a Unix socket takes the umask at
    // bind and there is no atomic way to bind with a mode; the window is the microseconds
    // between the two calls.
    chmodSync(this.socketPath, 0o600)
    this.#server = server
    this.#startedAt = new Date().toISOString()
    this.#armLinger(Math.max(this.#lingerMs, START_GRACE_MS))
  }

  /** The sessions open on the bridge, in the order they attached. */
  sessions(): string[] {
    return this.bridge.sessions()
  }

  /** What `status` answers, from the live object rather than anything written down. */
  status(): BrokerStatus {
    return {
      pid: process.pid,
      socketPath: this.socketPath,
      url: this.bridge.url,
      token: this.bridge.token,
      startedAt: this.#startedAt,
      lingerMs: this.#lingerMs,
      sessions: this.sessions(),
    }
  }

  /** Every connection ended, every session closed, the bridge and the socket down. */
  async close(): Promise<void> {
    this.#disarmLinger()
    const server = this.#server
    this.#server = undefined
    // The bridge first, so a pending `ask` is settled `skip` and the answer frame is written
    // before the connection carrying it is ended.
    await this.bridge.close()
    for (const s of [...this.#connections]) s.end()
    // `server.close()` on a Unix socket unlinks the path itself (checked on this Node: the
    // file is gone when the callback fires), so nothing here does it twice.
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    this.#resolveClosed()
  }

  /**
   * Idle means no SESSION attached, whether or not one ever was. Re-armed when the last one
   * goes. Sessions, not connections: a probe like `brokerAlive` connects and hangs up without
   * opening anything, and counted as a run it re-armed a zero linger and shut the broker down
   * under the run it was probing for.
   */
  #armLinger(ms = this.#lingerMs): void {
    this.#disarmLinger()
    if (this.#owners.size > 0) return
    // NOT unref'd: this timer is what closes the servers that hold the loop open. Unref'd,
    // a broker whose last run left would keep the port until something else exited.
    this.#linger = setTimeout(() => void this.close(), ms)
  }

  #disarmLinger(): void {
    if (this.#linger) clearTimeout(this.#linger)
    this.#linger = undefined
  }

  #attach(socket: Socket): void {
    // CLOSING. `close()` takes the bridge down before the socket server, and a run that
    // connects in between would be opened onto a bridge with no port behind it -- handed an
    // address nothing answers, and a session that ends with the server a moment later. Turned
    // away without a frame instead: its `open` sees the connection close, and the transport
    // tries again against whatever is there then, which is nothing, and starts one.
    if (!this.#server) {
      // Destroyed, not ended: an `end()` here is a half-close the peer may never complete,
      // and `server.close()` waits for every connection to be fully closed before calling
      // back -- which held `close()` open on exactly the connection it was refusing.
      socket.destroy()
      return
    }
    this.#connections.add(socket)
    let attached: Attached | undefined
    const reply = (r: Reply): void => {
      if (!socket.destroyed && !socket.writableEnded) socket.write(`${JSON.stringify(r)}\n`)
    }
    // A run that hangs up, crashes, or is killed all look the same from here: the socket
    // closes, and its session goes with it. There is no other way to leave.
    socket.on('close', () => {
      this.#connections.delete(socket)
      if (!attached) return
      this.#owners.delete(attached.sessionId)
      this.bridge.closeSession(attached.sessionId)
      if (this.#server) this.#armLinger()
    })
    socket.on('error', () => socket.destroy())
    lines(socket, (line) => {
      // A bad frame is answered, in words, and the connection goes on: the run on the other
      // end is mid-question, and dropping it for a typo in a frame would settle that question
      // `skip`. The id is echoed when there is one, so a client waiting on it is released
      // rather than left hanging, and a frame with no usable id is an error with none.
      const id = requestId(line)
      try {
        attached = this.#serve(socket, attached, asRequest(line), reply)
      } catch (err) {
        reply({ type: 'error', ...(id === undefined ? {} : { id }), message: (err as Error).message })
      }
    })
  }

  /** One frame. Returns the connection's attachment, which `open` sets and nothing else changes. */
  #serve(socket: Socket, attached: Attached | undefined, req: Request, reply: (r: Reply) => void): Attached | undefined {
    if (req.type === 'open') {
      if (attached && attached.sessionId !== req.sessionId) {
        throw new Error(`this connection is session ${attached.sessionId}; open ${req.sessionId} on another`)
      }
      if (attached) {
        // The same run, saying something newer about itself. The bridge asks `describe` on
        // every listing, and `describe` reads this.
        attached.meta = req.meta
        reply({ type: 'opened', url: this.bridge.url, token: this.bridge.token })
        return attached
      }
      const owner = this.#owners.get(req.sessionId)
      if (owner && owner !== socket) {
        // Refused, not joined. The bridge's `openSession` joins an open id because within a
        // process two views of one run are one run; across the socket a second connection is
        // a second process claiming the same run, and closing either would close the session
        // out from under the other.
        throw new Error(`session ${req.sessionId} is already open from another connection`)
      }
      const now: Attached = { sessionId: req.sessionId, meta: req.meta }
      this.bridge.openSession(req.sessionId, () => now.meta)
      this.#owners.set(req.sessionId, socket)
      // A run is attached from here: the linger, or the start grace, stands down.
      this.#disarmLinger()
      reply({ type: 'opened', url: this.bridge.url, token: this.bridge.token })
      return now
    }
    if (req.type === 'status') {
      reply({ type: 'status', id: req.id, ...this.status() })
      return attached
    }
    if (req.type === 'stop') {
      // Acknowledged before the shutdown, so the asker can tell "stopped" from "was not
      // there". The close ends this connection along with every other.
      reply({ type: 'stopping', id: req.id })
      void this.close()
      return attached
    }
    if (!attached) throw new Error(`${req.type} before open: this connection has no session`)
    const { sessionId } = attached
    switch (req.type) {
      case 'tell':
        reply({ type: 'sent', id: req.id, messageId: this.bridge.send(sessionId, req.msg) })
        return attached
      case 'ask': {
        const { id } = req
        // ROUTED BY CONSTRUCTION. The bridge resolves this promise when `/question-response`
        // names `sessionId`, and this closure writes to the socket that asked. No table maps
        // an answer to a run; the run is whoever is holding the other end of this promise.
        void this.bridge.ask(sessionId, req.question).then(
          (a) => reply({ type: 'answer', id, answer: a.answer }),
          (err: Error) => reply({ type: 'error', id, message: err.message }),
        )
        return attached
      }
      case 'poll':
        reply({ type: 'answers', id: req.id, answers: this.bridge.takeUnsolicited(sessionId) })
        return attached
    }
  }
}

/**
 * Whether something is listening at `path`. `ECONNREFUSED` (and `ENOENT`) mean a file with
 * nobody behind it, which is the one case `start()` may take over.
 */
export function brokerAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => resolve(false))
  })
}

function listenOn(server: Server, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err)
    server.once('error', onError)
    server.listen(path, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

/**
 * A line this long with no newline in it is not a frame. A question is a few hundred bytes;
 * the bound is so a peer that never sends a newline cannot grow the buffer without limit.
 */
const LINE_BYTES = 1_000_000

/**
 * Call `each` with every complete line a socket delivers. A partial line waits for its end;
 * one that passes `LINE_BYTES` without an end destroys the connection, as the bridge does
 * with an oversized POST body.
 */
function lines(socket: Socket, each: (line: string) => void): void {
  let buf = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buf += chunk
    let at: number
    while ((at = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, at).trim()
      buf = buf.slice(at + 1)
      if (line !== '') each(line)
    }
    if (buf.length > LINE_BYTES) socket.destroy()
  })
}

/** The `id` a line carries, if it is a frame with a finite one -- read before validation, so a refusal can name it. */
function requestId(line: string): number | undefined {
  try {
    const v: unknown = JSON.parse(line)
    return isRecord(v) && typeof v['id'] === 'number' && Number.isFinite(v['id']) ? v['id'] : undefined
  } catch {
    return undefined
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

/**
 * A line as a `Request`, or a throw saying what it is not.
 *
 * Every field the broker will hand to the bridge is checked here, because the bridge does
 * not: a `tell` with `msg: 42` would be buffered as-is and served on `/api/messages` to the
 * glasses, and a `user_question` with no `options` would be a frame the app cannot render.
 * The wire is trusted for nothing; the socket is owner-only, but an owner's own bug is the
 * likelier sender.
 */
function asRequest(line: string): Request {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    throw new Error(`not JSON: ${line.slice(0, 80)}`)
  }
  if (!isRecord(v)) throw new Error(`not a frame: ${line.slice(0, 80)}`)
  const type = v['type']
  if (type === 'open') {
    const sessionId = v['sessionId']
    if (!isString(sessionId) || sessionId === '') throw new Error('open needs a sessionId')
    const meta = v['meta']
    if (!isRecord(meta) || !isString(meta['title']) || !isString(meta['timestamp']) || !isString(meta['cwd'])) {
      throw new Error(`open needs the metadata of session ${sessionId}: title, timestamp, cwd`)
    }
    const status = meta['status']
    if (status !== null && status !== 'awaiting' && status !== 'busy' && status !== 'idle') {
      throw new Error(`open: status must be awaiting, busy, idle or null, not ${JSON.stringify(status)}`)
    }
    return { type, sessionId, meta: { title: meta['title'], timestamp: meta['timestamp'], cwd: meta['cwd'], status } }
  }
  const id = v['id']
  if (typeof id !== 'number' || !Number.isFinite(id)) throw new Error(`${String(type)} needs a numeric id`)
  if (type === 'tell') return { type, id, msg: asMessage(v['msg']) }
  if (type === 'ask') return { type, id, question: asQuestion(v['question']) }
  if (type === 'poll' || type === 'status' || type === 'stop') return { type, id }
  throw new Error(`unknown frame type ${JSON.stringify(type)}`)
}

function asOptions(v: unknown): { label: string; description: string }[] {
  if (!Array.isArray(v)) throw new Error('options must be a list')
  return v.map((o: unknown) => {
    if (!isRecord(o) || !isString(o['label']) || !isString(o['description'])) {
      throw new Error('an option is { label, description }')
    }
    return { label: o['label'], description: o['description'] }
  })
}

function asQuestion(v: unknown): Question {
  if (!isRecord(v) || !isString(v['header']) || !isString(v['question'])) {
    throw new Error('a question is { header, question, options }')
  }
  return { header: v['header'], question: v['question'], options: asOptions(v['options']) }
}

function asMessage(v: unknown): BridgeMessage {
  if (!isRecord(v)) throw new Error('msg must be a notification or a user_question')
  if (v['type'] === 'notification') {
    if (!isString(v['title']) || !isString(v['message'])) throw new Error('a notification is { title, message }')
    return { type: 'notification', title: v['title'], message: v['message'] }
  }
  if (v['type'] === 'user_question') {
    if (!Array.isArray(v['questions'])) throw new Error('a user_question carries a list of questions')
    return { type: 'user_question', questions: v['questions'].map(asQuestion) }
  }
  throw new Error(`msg must be a notification or a user_question, not ${JSON.stringify(v['type'])}`)
}

/**
 * A run's end of the socket. Thin: it speaks the frames above and nothing else, and the
 * `Transport` that will sit on it belongs to the wiring, not here.
 */
export class EvenRealitiesBrokerClient {
  readonly #socket: Socket
  #next = 1
  readonly #pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>()
  #onOpened: { resolve: (r: Reply) => void; reject: (e: Error) => void } | undefined
  #closed = false

  private constructor(socket: Socket) {
    this.#socket = socket
    lines(socket, (line) => this.#take(line))
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      this.#closed = true
      const gone = new Error('the broker connection closed')
      this.#onOpened?.reject(gone)
      this.#onOpened = undefined
      for (const p of this.#pending.values()) p.reject(gone)
      this.#pending.clear()
    })
  }

  /** Dial the broker. Rejects with `ECONNREFUSED`/`ENOENT` when nothing is serving `path`. */
  static connect(path: string = brokerSocketPath()): Promise<EvenRealitiesBrokerClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(path)
      socket.once('connect', () => resolve(new EvenRealitiesBrokerClient(socket)))
      socket.once('error', reject)
    })
  }

  get closed(): boolean {
    return this.#closed
  }

  /** Open, or refresh, this connection's session. Resolves with where the device should dial. */
  async open(sessionId: string, meta: SessionMetadata): Promise<{ url: string; token: string }> {
    const r = await new Promise<Reply>((resolve, reject) => {
      // Checked here as `#request` checks it: a connection the broker has already ended has
      // no `close` still to come, so a wait started now would never be released. (A mutation
      // run hung on exactly this.)
      if (this.#closed) {
        reject(new Error('the broker connection closed'))
        return
      }
      this.#onOpened = { resolve, reject }
      this.#send({ type: 'open', sessionId, meta })
    })
    if (r.type === 'error') throw new Error(r.message)
    if (r.type !== 'opened') throw new Error(`expected opened, got ${r.type}`)
    return { url: r.url, token: r.token }
  }

  async tell(msg: BridgeMessage): Promise<number> {
    const r = await this.#request((id) => ({ type: 'tell', id, msg }))
    if (r.type !== 'sent') throw new Error(`expected sent, got ${r.type}`)
    return r.messageId
  }

  async ask(question: Question): Promise<BridgeAnswer> {
    const r = await this.#request((id) => ({ type: 'ask', id, question }))
    if (r.type !== 'answer') throw new Error(`expected answer, got ${r.type}`)
    return { answer: r.answer }
  }

  async poll(): Promise<BridgeAnswer[]> {
    const r = await this.#request((id) => ({ type: 'poll', id }))
    if (r.type !== 'answers') throw new Error(`expected answers, got ${r.type}`)
    return r.answers
  }

  /** What the broker says about itself. Needs no session. */
  async status(): Promise<BrokerStatus> {
    const r = await this.#request((id) => ({ type: 'status', id }))
    if (r.type !== 'status') throw new Error(`expected status, got ${r.type}`)
    const { type: _type, id: _id, ...facts } = r
    return facts
  }

  /** Ask the broker to shut down. Resolves once it has acknowledged; the connection ends after. */
  async stop(): Promise<void> {
    const r = await this.#request((id) => ({ type: 'stop', id }))
    if (r.type !== 'stopping') throw new Error(`expected stopping, got ${r.type}`)
  }

  /** Hang up. The broker closes this session on seeing it. */
  close(): void {
    this.#socket.end()
  }

  #request(frame: (id: number) => Request): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      if (this.#closed) {
        reject(new Error('the broker connection closed'))
        return
      }
      const id = this.#next++
      this.#pending.set(id, { resolve, reject })
      this.#send(frame(id))
    }).then((r) => {
      if (r.type === 'error') throw new Error(r.message)
      return r
    })
  }

  #send(frame: Request): void {
    this.#socket.write(`${JSON.stringify(frame)}\n`)
  }

  #take(line: string): void {
    let r: Reply
    try {
      r = JSON.parse(line) as Reply
    } catch {
      return
    }
    if (r.type === 'opened' || r.id === undefined) {
      const waiting = this.#onOpened
      this.#onOpened = undefined
      waiting?.resolve(r)
      return
    }
    const p = this.#pending.get(r.id)
    if (!p) return
    this.#pending.delete(r.id)
    p.resolve(r)
  }
}
