/**
 * A stand-in OpenCode server, for tests that need the adapter to talk to something.
 *
 * SHARED rather than duplicated, because two tests need it for different reasons: the adapter's
 * own tests drive turn lifecycle and timing through it, and `executables.test.ts` needs a real
 * child to prove that `launch.command` is the command actually spawned. A second copy would drift
 * from the first, and the point of both is fidelity to one protocol.
 *
 * Deliberately not a mock of `fetch`. What is worth testing here is timing -- a stream that dies
 * mid-turn, a cancel that races a boundary -- and a stub answers instantly and in order, which is
 * the one thing a network never does.
 */

import { createServer, type Server } from 'node:http'

export interface FakeOpenCode {
  server: Server
  port: Promise<number>
  /** Push an event to every subscriber of `/event`. */
  push: (event: unknown) => void
  /** End the event stream, as a server going away does. */
  endStream: () => void
  /** Every request seen, as `METHOD /path`. */
  posted: string[]
  close: () => Promise<void>
}

export function fakeOpenCode(sessionId = 'ses_fake'): FakeOpenCode {
  const clients: Array<{ write: (s: string) => void; end: () => void }> = []
  const posted: string[] = []
  const server = createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0] ?? ''
    posted.push(`${req.method} ${url}`)
    if (url === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      clients.push({ write: (s) => res.write(s), end: () => res.end() })
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (url === '/session' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: sessionId }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('')
    })
  })
  const port = new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
  return {
    server,
    port,
    push: (event) => clients.forEach((c) => c.write(`data: ${JSON.stringify(event)}\n\n`)),
    endStream: () => clients.forEach((c) => c.end()),
    posted,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
