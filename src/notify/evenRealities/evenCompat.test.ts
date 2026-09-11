/**
 * What conclave serves, checked against the protocol it is imitating (#276, #278).
 *
 * This transport SERVES the Terminal Mode protocol rather than calling it, and that protocol
 * belongs to somebody else: `@evenrealities/even-terminal`, which ships, versions and changes
 * independently of this repository. Two implementations of one surface drift silently and are
 * discovered in the field — which is the shape of #258 and #262, both found by an operator
 * rather than by a test.
 *
 * So the claim is pinned the way this codebase pins every claim about another program: against
 * the installed thing rather than restated from memory (`childenvClaims.test.ts`). It SKIPS when
 * the vendor package is absent, because a machine without it is not evidence of anything.
 */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { EvenRealitiesBridge, type SessionMetadata } from './client.ts'

/** The installed vendor package, or undefined when it is not on this machine. */
function vendorRoot(): string | undefined {
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 30_000 }).trim()
    const dir = join(root, '@evenrealities', 'even-terminal')
    return existsSync(dir) ? dir : undefined
  } catch {
    return undefined
  }
}

/** Every `/api/...` path the vendor's bundle mentions. */
function vendorRoutes(dir: string): Set<string> {
  const found = new Set<string>()
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) {
        if (name !== 'node_modules') walk(p)
        continue
      }
      if (!/\.(js|mjs|cjs)$/.test(name)) continue
      for (const m of readFileSync(p, 'utf8').matchAll(/\/api\/[a-z-]+/g)) found.add(m[0])
    }
  }
  walk(join(dir, 'dist'))
  return found
}

/** One vendor source file, read for the claim a test is about to check against it. */
function vendorFile(dir: string, rel: string): string {
  const p = join(dir, 'dist', rel)
  assert.ok(existsSync(p), `expected ${rel} in the vendor bundle; it moved, and every claim read from it needs re-reading`)
  return readFileSync(p, 'utf8')
}

/** What run-1 describes itself as. Mutable so a test can vary one field. */
const RUN_1: SessionMetadata = { title: 'fix the thing', timestamp: '2026-09-11T12:00:00.000Z', cwd: '/w', status: 'busy' }

/** A listening bridge with one run open, for reading what it serves. */
async function serving(describe: () => SessionMetadata | undefined = () => RUN_1): Promise<{ b: EvenRealitiesBridge; get: (path: string) => Promise<Response> }> {
  const b = new EvenRealitiesBridge({ port: 0, token: 'tok' })
  await b.listen()
  b.openSession('run-1', describe)
  const get = (path: string): Promise<Response> =>
    fetch(`${b.url}${path}${path.includes('?') ? '&' : '?'}token=tok`)
  return { b, get }
}

test('#276 every route conclave serves is one the installed even-terminal also serves', () => {
  // The direction that matters. Conclave serving something the vendor does not is conclave
  // inventing protocol, and a device built against the vendor will never call it.
  //
  // NOT the reverse: the vendor serves prompts, interrupts and metrics because it drives a
  // coding session. This is a notification surface and deliberately serves a subset — that
  // asymmetry is the design, and asserting equality would fail for the right shape.
  const dir = vendorRoot()
  if (!dir) return // vendor not installed; see the file comment

  const theirs = vendorRoutes(dir)
  assert.ok(theirs.size > 5, `expected a real route table from the vendor bundle, got ${theirs.size}`)

  const ours = [...EvenRealitiesBridge.SERVED].filter((r) => r !== '/api/events')
  const invented = ours.filter((r) => !theirs.has(r))
  assert.deepEqual(
    invented,
    [],
    `conclave serves ${invented.join(', ')}, which the installed even-terminal does not — ` +
      `either the vendor moved, or this transport invented protocol. Vendor has: ${[...theirs].sort().join(', ')}`,
  )
})

test('#276 the routes the vendor has and conclave lacks are recorded, so a gap is a decision', () => {
  // Not a failure — the subset is deliberate. But an UNEXAMINED subset is how a device ends up
  // calling something that 404s, which is exactly what happened: the app called `/api/info`
  // during pairing and conclave had no such route, so the failure looked like a bad token.
  //
  // This prints rather than asserts, so a widening vendor surface is visible in the suite
  // output without failing a build for somebody else's release.
  const dir = vendorRoot()
  if (!dir) return

  const theirs = vendorRoutes(dir)
  const missing = [...theirs].filter((r) => !EvenRealitiesBridge.SERVED.has(r)).sort()
  console.log(`    [observed] vendor routes conclave does not serve: ${missing.join(', ') || '(none)'}`)
  assert.ok(EvenRealitiesBridge.SERVED.has('/api/question-response'), 'the answer path must exist')
  assert.ok(EvenRealitiesBridge.SERVED.has('/api/status'), 'and the probe path a device pairs against')
})

test('#278 the provider conclave claims is one the vendor whitelist admits', () => {
  // `provider: "conclave"` was rejected by their middleware, which 400s anything outside
  // `SUPPORTED_PROVIDERS`; that is why the app never opened a session (#276). The claim is a
  // lie (`CLAIMED_PROVIDER` in `client.ts` says why) and this pins that it is at least a lie
  // the validator accepts. If the whitelist changes, this is where the lie stops working.
  const dir = vendorRoot()
  if (!dir) return

  const session = vendorFile(dir, 'session.js')
  const m = /SUPPORTED_PROVIDERS\s*=\s*\[([^\]]*)\]/.exec(session)
  assert.ok(m, 'expected SUPPORTED_PROVIDERS in dist/session.js')
  const allowed = [...m![1]!.matchAll(/"([a-z]+)"/g)].map((x) => x[1])
  assert.ok(allowed.length >= 1, `an empty whitelist is not one: ${m![0]}`)
  assert.ok(
    allowed.includes(EvenRealitiesBridge.CLAIMED_PROVIDER),
    `conclave claims provider ${EvenRealitiesBridge.CLAIMED_PROVIDER}; the vendor admits ${allowed.join(', ')}`,
  )
  // And the middleware that enforces it is still there. A whitelist nobody enforces would let
  // the honest value through, and this lie could be retired.
  const core = vendorFile(dir, 'routes/core.js')
  assert.match(core, /Unsupported provider/, 'the 400 that rejected "conclave" is still in core.js')
})

/**
 * The vendor's session list item, read from the object literal in `listClaudeSessions`.
 *
 * `dist/claude/provider.js` -- not `dist/providers/`, which does not exist and whose absence
 * was once taken to mean the shape was unreadable. It is readable, and it is THE authority on
 * what a list item carries: every key here is protocol, and any key not here is invented.
 */
function vendorListItem(dir: string): { keys: string[]; literal: string } {
  const provider = vendorFile(dir, 'claude/provider.js')
  const m = /return infos\.map\(\(info\) => \(\{([\s\S]*?)\}\)\)/.exec(provider)
  assert.ok(m, 'expected the session list item literal in claude/provider.js')
  const literal = m![1]!
  return { keys: [...literal.matchAll(/^\s*(\w+):/gm)].map((x) => x[1]!).sort(), literal }
}

test('#278 a session list item has exactly the vendor\'s keys, keyed the way core.js reads it', async (t) => {
  const dir = vendorRoot()
  if (!dir) return
  const { b, get } = await serving()
  t.after(() => b.close())

  // THE KEY THE APP READS. `core.js` does `provider.getSessionStatus(s.id)` over the list and
  // writes the result to `status`; an item keyed `sessionId` instead has no id as far as the
  // app is concerned (#278).
  const core = vendorFile(dir, 'routes/core.js')
  const read = /sessions\[i\]\.(\w+) = await provider\.getSessionStatus\(s\.(\w+)\)/.exec(core)
  assert.ok(read, 'expected core.js to fill a status key from a key it reads off each list item')
  const statusKey = read![1]!
  const idKey = read![2]!

  const { keys } = vendorListItem(dir)
  assert.ok(keys.includes(idKey) && keys.includes(statusKey), `the keys core.js uses are in the literal: ${keys.join(',')}`)

  // EVERY key the vendor sends, and NO key it does not. `openedAt` was served once; it is not
  // in the literal, and this is the assertion that would have refused it.
  const { sessions } = (await (await get('/api/sessions')).json()) as { sessions: Record<string, unknown>[] }
  assert.equal(sessions.length, 1)
  assert.deepEqual(Object.keys(sessions[0]!).sort(), keys, `conclave's item has ${Object.keys(sessions[0]!).sort().join(',')}; the vendor's has ${keys.join(',')}`)
  assert.equal(sessions[0]![idKey], 'run-1', `${idKey} is the run`)
  assert.equal(sessions[0]!['provider'], EvenRealitiesBridge.CLAIMED_PROVIDER)
})

test('#278 each field of a list item means what the vendor\'s expression for it means', async (t) => {
  // The literal, expression by expression. A field with the vendor's NAME and a different
  // meaning is worse than none: the app sorts and labels by these, confidently.
  const dir = vendorRoot()
  if (!dir) return
  const { literal } = vendorListItem(dir)
  const expr = (key: string): string => {
    const m = new RegExp(`^\\s*${key}:\\s*(.*?),?\\s*$`, 'm').exec(literal)
    assert.ok(m, `expected \`${key}:\` in the vendor literal`)
    return m![1]!
  }

  // `title` is a string cut to a length. The length is theirs; the bridge cuts to it.
  const cut = /\.slice\(0,\s*(\d+)\)/.exec(expr('title'))
  assert.ok(cut, `expected title to be sliced: ${expr('title')}`)
  const chars = Number(cut![1])
  assert.equal(EvenRealitiesBridge.TITLE_CHARS, chars, 'the bridge cuts titles to the vendor\'s length')
  const long = await serving(() => ({ ...RUN_1, title: 'z'.repeat(chars * 2) }))
  t.after(() => long.b.close())
  const cutItem = ((await (await long.get('/api/sessions')).json()) as { sessions: { title: string }[] }).sessions[0]!
  assert.equal(cutItem.title.length, chars)

  // `timestamp` is `new Date(info.lastModified).toISOString()`: the transcript's mtime, which
  // moves only when something is appended -- LAST ACTIVITY, not liveness. `runMetadata.ts`
  // sources it from the newest event and never from the heartbeat, for that reason.
  assert.match(expr('timestamp'), /new Date\(info\.lastModified\)\.toISOString\(\)/)
  const { b, get } = await serving()
  t.after(() => b.close())
  const item = ((await (await get('/api/sessions')).json()) as { sessions: Record<string, unknown>[] }).sessions[0]!
  assert.match(String(item['timestamp']), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'an ISO string, as toISOString gives')

  // `cwd` is the session's working directory, a string.
  assert.match(expr('cwd'), /info\.cwd/)
  assert.equal(typeof item['cwd'], 'string')

  // `provider` is the literal string the whitelist admits.
  assert.equal(expr('provider'), `"${EvenRealitiesBridge.CLAIMED_PROVIDER}"`)

  // `status` starts `null` and is filled in separately by `getSessionStatus`. So `null` is a
  // value the app is built to see, and a run whose state is not known serves it rather than
  // a guess.
  assert.equal(expr('status'), 'null')
  const unknown = await serving(() => ({ ...RUN_1, status: null }))
  t.after(() => unknown.b.close())
  const nullItem = ((await (await unknown.get('/api/sessions')).json()) as { sessions: { status: unknown }[] }).sessions[0]!
  assert.equal(nullItem.status, null)
})

test('#278 the refusals are worded as the vendor words them, per route', async (t) => {
  // An app built against their strings gets their strings. `events.js` and `core.js` word the
  // missing-session case differently from each other, and both are served as written.
  const dir = vendorRoot()
  if (!dir) return
  const { b, get } = await serving()
  t.after(() => b.close())

  const events = vendorFile(dir, 'routes/events.js')
  const core = vendorFile(dir, 'routes/core.js')
  const quoted = (src: string, re: RegExp): string => {
    const m = re.exec(src)
    assert.ok(m, `expected ${re} in the vendor source`)
    return m![1]!
  }
  const eventsMissing = quoted(events, /status\(400\)\.json\(\{ error: "([^"]+)" \}\)/)
  const coreMissing = quoted(core, /status\(400\)\.json\(\{ error: "(Missing 'sessionId')" \}\)/)
  const coreUnknown = quoted(core, /status\(404\)\.json\(\{ error: "([^"]+)" \}\)/)

  assert.deepEqual(await (await get('/api/events')).json(), { error: eventsMissing })
  for (const path of ['/api/status', '/api/messages']) {
    assert.deepEqual(await (await get(path)).json(), { error: coreMissing }, path)
  }
  assert.deepEqual(await (await get('/api/status?sessionId=run-9')).json(), { error: coreUnknown })
  const posted = await fetch(`${b.url}/api/question-response?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answer: 'x' }),
  })
  assert.deepEqual(await posted.json(), { error: coreMissing })
})

test('#278 the per-session buffer is as deep as the vendor keeps, and status answers with their keys', async (t) => {
  const dir = vendorRoot()
  if (!dir) return
  const { b, get } = await serving()
  t.after(() => b.close())

  const events = vendorFile(dir, 'routes/events.js')
  const depth = /MAX_MESSAGES_PER_SESSION\s*=\s*(\d+)/.exec(events)
  assert.ok(depth, 'expected MAX_MESSAGES_PER_SESSION in events.js')
  const theirs = Number(depth![1])
  for (let i = 0; i < theirs + 1; i++) b.send('run-1', { type: 'notification', title: 'n', message: String(i) })
  const { messages } = (await (await get('/api/messages?sessionId=run-1')).json()) as { messages: { id: number }[] }
  assert.equal(messages.length, theirs, `the vendor keeps ${theirs} per session; so does conclave`)

  // `/status` and `/messages` answer with the keys `core.js` puts in its `res.json({...})`.
  const core = vendorFile(dir, 'routes/core.js')
  const keysOf = (route: string): string[] => {
    const block = new RegExp(`router\\.get\\("${route}"[\\s\\S]*?res\\.json\\(\\{([\\s\\S]*?)\\}\\);`).exec(core)
    assert.ok(block, `expected the ${route} handler's res.json in core.js`)
    return [...block![1]!.matchAll(/^\s*(\w+)[,:]/gm)].map((x) => x[1]!).sort()
  }
  const status = (await (await get('/api/status?sessionId=run-1')).json()) as Record<string, unknown>
  assert.deepEqual(Object.keys(status).sort(), keysOf('/status'))
  const listing = (await (await get('/api/messages?sessionId=run-1')).json()) as Record<string, unknown>
  assert.deepEqual(Object.keys(listing).sort(), keysOf('/messages'))
})
