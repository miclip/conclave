/**
 * The HTTP half, against a fake `fetch`.
 *
 * No server and no OpenCode: the point of injecting `fetch` is that the routes, the password and
 * the failure shapes are testable on a machine that has neither. What cannot be tested this way
 * — that OpenCode's routes behave as documented — was probed against a live server instead
 * (#217), and neither substitutes for the other.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { OpenCodeApiError, OpenCodeClient } from './client.ts'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function stub(reply: (call: Call) => { status?: number; body?: string }): { calls: Call[]; fetch: typeof globalThis.fetch } {
  const calls: Call[] = []
  const fetch = (async (url: unknown, init: Record<string, unknown> = {}) => {
    const call: Call = {
      url: String(url),
      method: String(init['method'] ?? 'GET'),
      headers: (init['headers'] ?? {}) as Record<string, string>,
      body: typeof init['body'] === 'string' ? JSON.parse(init['body'] as string) : undefined,
    }
    calls.push(call)
    const { status = 200, body = '' } = reply(call)
    return new Response(body, { status })
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}

const client = (fetch: typeof globalThis.fetch, password?: string) =>
  new OpenCodeClient({ baseUrl: 'http://127.0.0.1:4599/', ...(password ? { password } : {}), fetch })

test('a prompt is POSTed as parts, and returns before the turn does', async () => {
  // `prompt_async` is what makes `send` return a key immediately and the turn be awaited through
  // events — the same shape as awaiting a `Stop` hook. A synchronous route would block `send`
  // for the length of a turn with nothing observable meanwhile.
  const { calls, fetch } = stub(() => ({ status: 200 }))
  await client(fetch).promptAsync('ses_a', 'do the thing')
  assert.equal(calls[0]?.url, 'http://127.0.0.1:4599/session/ses_a/prompt_async')
  assert.deepEqual(calls[0]?.body, { parts: [{ type: 'text', text: 'do the thing' }] })
})

test('#221 a model travels with the prompt, as the object the API wants', async () => {
  // Probed against a running 1.18.27 server: `"model":"anthropic/claude-sonnet-4-5"` answers
  // `400 Expected object | null`; the two-field object answers 204. `opencode models` prints the
  // slash form and `--model` is written that way, so the split belongs here rather than in every
  // caller.
  const { calls, fetch } = stub(() => ({ status: 200 }))
  await client(fetch).promptAsync('ses_a', 'go', 'anthropic/claude-sonnet-4-5')
  assert.deepEqual((calls[0]?.body as Record<string, unknown>)['model'], {
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4-5',
  })
})

test('#221 a model id containing a slash keeps it', async () => {
  // `openrouter/anthropic/claude-3.5` is ONE provider and one model whose name has a slash in it.
  // Splitting on the last would name a provider that does not exist, and the failure would be a
  // 4xx from a server that was asked for something real.
  const { calls, fetch } = stub(() => ({ status: 200 }))
  await client(fetch).promptAsync('ses_a', 'go', 'openrouter/anthropic/claude-3.5')
  assert.deepEqual((calls[0]?.body as Record<string, unknown>)['model'], {
    providerID: 'openrouter',
    modelID: 'anthropic/claude-3.5',
  })
})

test('#221 no model asked for means none sent, rather than an empty one', async () => {
  // `null` is a legal value for that field, and an empty object is not the same request: it would
  // ask the server for a model whose provider is the empty string.
  const { calls, fetch } = stub(() => ({ status: 200 }))
  await client(fetch).promptAsync('ses_a', 'go')
  assert.ok(!('model' in (calls[0]?.body as Record<string, unknown>)), 'the key is absent, not empty')
})

test('a command is a POST, not something typed at a composer', async () => {
  // The whole of #215: a slash command for this agent is a route. Nothing is typed, so nothing
  // echoes, so none of the prompt-fidelity machinery (#174, #185, #207, #216) applies.
  const { calls, fetch } = stub(() => ({ status: 200 }))
  await client(fetch).command('ses_a', '/compact')
  assert.equal(calls[0]?.url, 'http://127.0.0.1:4599/session/ses_a/command')
  // `arguments` IS REQUIRED even when empty: without it the server answers 400 with
  // `Missing key at ["arguments"]`. Probed against a running 1.18.27 server after a 400 that a
  // schema nobody had read would have explained.
  assert.deepEqual(calls[0]?.body, { command: '/compact', arguments: '' })
})

test('a session id with a slash in it cannot escape its route', async () => {
  // Ids come from the server, but a route built by concatenation is one bad id from addressing
  // a different endpoint entirely.
  const { calls, fetch } = stub(() => ({ status: 200 }))
  await client(fetch).abort('ses/../danger')
  assert.equal(calls[0]?.url, 'http://127.0.0.1:4599/session/ses%2F..%2Fdanger/abort')
})

test('a base URL with a trailing slash does not produce a doubled one', async () => {
  const { calls, fetch } = stub(() => ({ status: 200 }))
  await client(fetch).abort('ses_a')
  assert.ok(!calls[0]?.url.includes('//session'), `route must not double the slash: ${calls[0]?.url}`)
})

test('the password travels when there is one, and nothing invented when there is not', async () => {
  // The server announces "OPENCODE_SERVER_PASSWORD is not set; server is unsecured" at startup.
  // An unsecured loopback server takes a prompt from anything on the machine, so a password is
  // carried whenever one exists — and never fabricated when it does not.
  // BASIC, and the username is checked. Probed against a running 1.18.27 server:
  // `opencode:<password>` answers 200; `anything:<password>`, `x:<password>` and an empty
  // username all answer 401. This was `Bearer` first, which 401s -- and the error was invisible
  // on 1.18.15, which did not enforce the password at all and answered regardless.
  const withPw = stub(() => ({ status: 200 }))
  await client(withPw.fetch, 's3cret').abort('ses_a')
  assert.equal(
    withPw.calls[0]?.headers['authorization'],
    `Basic ${Buffer.from('opencode:s3cret').toString('base64')}`,
    'the scheme and the username are both part of what the server checks',
  )

  const without = stub(() => ({ status: 200 }))
  await client(without.fetch).abort('ses_a')
  assert.equal(without.calls[0]?.headers['authorization'], undefined)
})

test('a server that is not there is UNREACHABLE, not a refusal', async () => {
  // Two different repairs, and collapsing them is what the run-per-turn adapter cannot avoid: a
  // spawn failure and a non-zero exit look alike from outside a process.
  const fetch = (async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:4599')
  }) as unknown as typeof globalThis.fetch
  await assert.rejects(
    () => client(fetch).createSession(),
    (e: unknown) => e instanceof OpenCodeApiError && e.kind === 'unreachable' && e.status === undefined,
  )
})

test('a server that says no is REFUSED, and carries the status', async () => {
  const { fetch } = stub(() => ({ status: 401, body: 'unauthorized' }))
  await assert.rejects(
    () => client(fetch).createSession(),
    (e: unknown) => e instanceof OpenCodeApiError && e.kind === 'refused' && e.status === 401,
  )
})

test('a created session with no id is refused rather than used', async () => {
  // A 200 whose body is not what this client believes the route returns. Using an undefined id
  // would address `/session/undefined/...` on every later call.
  const { fetch } = stub(() => ({ status: 200, body: '{"slug":"eager-moon"}' }))
  await assert.rejects(
    () => client(fetch).createSession(),
    (e: unknown) => e instanceof OpenCodeApiError && /no id/.test((e as Error).message),
  )
})

test('an empty 200 body is success, not a parse failure', async () => {
  // `abort` and `command` answer with nothing. Treating that as malformed would fail every
  // successful call to them.
  const { fetch } = stub(() => ({ status: 200, body: '' }))
  await client(fetch).abort('ses_a')
})
