/**
 * Receiver authentication (issue #46).
 *
 * The receiver's deliveries are what turn into `completed (proven)`, so the question
 * these tests answer is narrow and load-bearing: can a local process that knows only the
 * port manufacture that evidence? Knowing the port is easy -- `lsof -i` will do it -- so
 * the port must not be the credential.
 *
 *   node --test src/hooks/receiver.test.ts
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { HookReceiver } from './receiver.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'orch-receiver-auth-'))

/** The same URL with the token segment removed -- what a port scanner can construct. */
function withoutToken(url: string): string {
  const u = new URL(url)
  return `${u.origin}/hook`
}

function tokenOf(url: string): string {
  const token = new URL(url).pathname.split('/').pop()
  assert.ok(token && token.length >= 32, `expected a token in the path, got ${url}`)
  return token
}

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...filesUnder(full))
    else out.push(full)
  }
  return out
}

test('a POST without the token is refused before anything is parsed or journalled', async (t) => {
  const path = join(SCRATCH, 'unauth', 'hooks.ndjson')
  const receiver = new HookReceiver(path)
  const url = await receiver.start()
  t.after(() => receiver.stop())

  const seen: string[] = []
  receiver.on('delivery', (d) => seen.push(d.deliveryId))
  receiver.on('duplicate', (d) => seen.push(d.deliveryId))

  const res = await fetch(withoutToken(url), {
    method: 'POST',
    // A forgery worth catching: a well-formed Stop for a turn that never completed.
    body: JSON.stringify({ hook_event_name: 'Stop', session_id: 'forged', prompt_id: 'p1' }),
    headers: {
      'content-type': 'application/json',
      'x-orch-agent': 'claude',
      'x-orch-delivery-id': 'forged-id',
      'x-orch-hook-pid': '7',
    },
  })

  assert.equal(res.status, 403, 'an unauthenticated delivery must not be acknowledged')
  await res.arrayBuffer()

  // "Rejected" has to mean it left no trace. A forger who cannot be believed but can
  // still write to the journal has kept most of what they came for.
  assert.deepEqual(seen, [], 'no delivery or duplicate event may be emitted')
  assert.equal(receiver.journal.has('forged-id'), false)
  assert.equal(receiver.journal.size, 0)
  assert.equal(existsSync(path), false, 'the journal file must not even be created')
})

test('a near-miss token is refused too', async (t) => {
  const receiver = new HookReceiver(join(SCRATCH, 'nearmiss', 'hooks.ndjson'))
  const url = await receiver.start()
  t.after(() => receiver.stop())

  // Right length, right shape, one character off: the check is equality, not a prefix.
  const wrong = url.slice(0, -1) + (url.endsWith('A') ? 'B' : 'A')
  const res = await fetch(wrong, {
    method: 'POST',
    body: JSON.stringify({ hook_event_name: 'Stop' }),
    headers: { 'content-type': 'application/json', 'x-orch-delivery-id': 'near' },
  })
  assert.equal(res.status, 403)
  await res.arrayBuffer()
  assert.equal(receiver.journal.size, 0)
})

test('two receivers do not share a token', async (t) => {
  const a = new HookReceiver(join(SCRATCH, 'tok-a', 'hooks.ndjson'))
  const b = new HookReceiver(join(SCRATCH, 'tok-b', 'hooks.ndjson'))
  const [urlA, urlB] = await Promise.all([a.start(), b.start()])
  t.after(() => Promise.all([a.stop(), b.stop()]))

  assert.notEqual(tokenOf(urlA), tokenOf(urlB), 'the token is per instance, not per build')

  // Holding one session's URL must not admit you to another's evidence.
  const crossed = new URL(urlA)
  crossed.port = new URL(urlB).port
  const res = await fetch(crossed, {
    method: 'POST',
    body: JSON.stringify({ hook_event_name: 'Stop' }),
    headers: { 'content-type': 'application/json', 'x-orch-delivery-id': 'crossed' },
  })
  assert.equal(res.status, 403)
  await res.arrayBuffer()
  assert.equal(b.journal.size, 0)
})

test('the URL returned by start() still works unchanged', async (t) => {
  const path = join(SCRATCH, 'authed', 'hooks.ndjson')
  const receiver = new HookReceiver(path)
  const url = await receiver.start()
  t.after(() => receiver.stop())

  const fresh: string[] = []
  receiver.on('delivery', (d) => fresh.push(d.deliveryId))

  // Byte-for-byte what the hook client sends: it fetches ORCH_HOOK_URL as given and
  // knows nothing about a token, so authentication must ride entirely in the URL.
  const res = await fetch(url, {
    method: 'POST',
    body: JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', prompt_id: 'p1' }),
    headers: {
      'content-type': 'application/json',
      'x-orch-agent': 'claude',
      'x-orch-delivery-id': 'real-id',
      'x-orch-hook-pid': '7',
      'x-orch-fired-at': '1.5',
    },
  })

  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, deliveryId: 'real-id', duplicate: false })
  assert.deepEqual(fresh, ['real-id'])
  assert.ok(readFileSync(path, 'utf8').includes('real-id'), 'still durable before the ack')
})

test('the token reaches no file, including the journal it authenticates', async (t) => {
  const dir = join(SCRATCH, 'leak')
  const receiver = new HookReceiver(join(dir, 'hooks.ndjson'))
  const url = await receiver.start()
  t.after(() => receiver.stop())

  const token = tokenOf(url)
  await fetch(url, {
    method: 'POST',
    body: JSON.stringify({ hook_event_name: 'Stop', session_id: 'leak-check' }),
    headers: { 'content-type': 'application/json', 'x-orch-delivery-id': 'leak-id' },
  }).then((r) => r.arrayBuffer())

  // The claim in receiver.ts is that the token lives in memory and in the child's
  // environment and nowhere else. A secret that is written down can be read by the
  // process this is meant to exclude, and can go stale against what the server holds --
  // which is exactly the fail-open shape the issue was transferred from.
  const written = filesUnder(SCRATCH)
  assert.ok(written.length > 0, 'the sweep must actually be looking at files')
  for (const file of written) {
    assert.ok(
      !readFileSync(file, 'utf8').includes(token),
      `the token was written to ${file}`,
    )
  }
})
