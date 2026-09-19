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
 * the vendor package is absent, because a machine without it is not evidence of anything -- and
 * it says so, naming where it looked, because a skip nobody can see is a pass (#281).
 *
 * And it says which vendor it checked against. Pinning against the installed thing catches
 * drift only from the version that happens to be installed; nothing here makes that version
 * current, and a green suite meant "still matches 0.8.1" for as long as 0.10.4 had been out
 * (#346). `VERIFIED_VENDOR_VERSION` records what the claims below were last read from, and the
 * first test opens by naming the gap when the installed copy is something else.
 */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'

import { EvenRealitiesBridge, type SessionMetadata } from './client.ts'

/**
 * Where the vendor package is looked for: `CONCLAVE_EVEN_VENDOR` when set, else `npm root -g`.
 *
 * Which `npm` is first on PATH differs between an interactive shell and a script on the same
 * machine (#281), so `npm root -g` alone decides silently whether this file checks anything.
 * An explicit root is honoured first -- DEFINED, not truthy, so an empty value is a wrong root
 * rather than a fall-through -- and one that does not hold the package is a FAILURE, because
 * whoever set it meant for the pin to run.
 */
function vendorLookup(): { root: string; dir: string; explicit: boolean } | { root: undefined; dir: undefined; explicit: false } {
  const explicit = process.env['CONCLAVE_EVEN_VENDOR']
  if (explicit !== undefined) return { root: explicit, dir: join(explicit, '@evenrealities', 'even-terminal'), explicit: true }
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 30_000 }).trim()
    return { root, dir: join(root, '@evenrealities', 'even-terminal'), explicit: false }
  } catch {
    return { root: undefined, dir: undefined, explicit: false }
  }
}

/**
 * A test that runs against the installed vendor package, or skips OUT LOUD when there is none.
 *
 * The skip names the root that was resolved and the directory looked for under it, so the
 * suite output says which `npm` answered and where the package was expected -- the two facts
 * #281 was missing.
 */
function vendored(name: string, fn: (dir: string, t: TestContext) => void | Promise<void>): void {
  test(name, (t) => {
    const { root, dir, explicit } = vendorLookup()
    if (dir !== undefined && existsSync(dir)) return fn(dir, t)
    if (explicit) assert.fail(`CONCLAVE_EVEN_VENDOR=${root} but ${dir} does not exist`)
    const where = root === undefined ? '`npm root -g` failed' : `root ${root}, looked for ${dir}`
    return t.skip(`vendor not installed: ${where}; set CONCLAVE_EVEN_VENDOR=<global node_modules> to point at it`)
  })
}

/**
 * The vendor version every claim in this file was last verified against (#346).
 *
 * Bump it when the claims have been re-read from a newer bundle and the suite ends green under
 * `CONCLAVE_EVEN_VENDOR` pointed at that bundle -- not when a newer version is published, which
 * this file does not check: no network call, so the record can only be compared with what is
 * installed, and "installed but older than this" is the drift it can name.
 *
 * A mismatch is a NOTICE, not a failure, and that is a tradeoff rather than a soft option. To
 * fail, the record would have to name the version installed on the machine the suite must pass
 * on today (0.8.1), so that whoever upgrades sees red; then the record says nothing about what
 * the code was actually verified against, and it is red for exactly the person who did the
 * right thing. Recording the verified version and failing instead would fail every machine that
 * has not upgraded -- the same suite that is required green here. So the record names the
 * verified version, and a machine behind it is told, once and by name, that its green is
 * evidence about an older vendor than the code was written to. The notice opens the first test
 * in the file rather than having one of its own, so the suite stays the twelve tests it is
 * counted as; it is emitted before that test's first assertion, so a failing route check does
 * not swallow it.
 */
const VERIFIED_VENDOR_VERSION = '0.10.4'

/**
 * One diagnostic naming the installed vendor version against the recorded one (#346).
 *
 * The installed copy's own `package.json`, not `npm view`: the record is compared with what the
 * claims are about to be read from, and nothing else is reachable without the network.
 */
function noteVendorVersion(dir: string, t: TestContext): void {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }
  assert.equal(typeof pkg.version, 'string', `expected a version in ${join(dir, 'package.json')}`)
  const installed = pkg.version as string
  if (installed === VERIFIED_VENDOR_VERSION) {
    t.diagnostic(`checked against @evenrealities/even-terminal ${installed}, the recorded verified version`)
    return
  }
  t.diagnostic(
    `VENDOR DRIFT: installed @evenrealities/even-terminal is ${installed}; this file was verified against ` +
      `${VERIFIED_VENDOR_VERSION}. Every green in this file is evidence about ${installed}, not ${VERIFIED_VENDOR_VERSION}. ` +
      `Re-verify against the current vendor (CONCLAVE_EVEN_VENDOR=<its node_modules>) and update VERIFIED_VENDOR_VERSION.`,
  )
}

/**
 * Every route the vendor REGISTERS, as `<mount><path>`, with the methods it registers it under.
 *
 * Read from the registrations themselves -- `router.get("/sessions/:id/history", ...)` under
 * `dist/routes/` -- and from the mount in `dist/index.js` that puts every router under one
 * prefix (`app.use("/api", auth, coreRouter)`). An earlier version scanned the bundle for the
 * text `/api/[a-z-]+`, which found the eleven routes whose full path happens to be spelled out
 * somewhere and missed the rest: `/api/events` (registered as `/events`, so the subset test had
 * to exempt it by hand) and every route with a parameter or a second segment (#284). Reading
 * the registration is reading what Express will actually answer to.
 */
function vendorRoutes(dir: string): Map<string, Set<string>> {
  const index = vendorFile(dir, 'index.js')
  const mounts = new Set([...index.matchAll(/app\.use\("(\/[^"]*)",[^)]*Router\)/g)].map((m) => m[1]!))
  assert.equal(mounts.size, 1, `expected every router mounted under one prefix in index.js, got ${[...mounts].join(', ') || 'none'}`)
  const mount = [...mounts][0]!

  const found = new Map<string, Set<string>>()
  const routes = join(dir, 'dist', 'routes')
  assert.ok(existsSync(routes) && statSync(routes).isDirectory(), 'expected dist/routes in the vendor bundle')
  for (const name of readdirSync(routes)) {
    if (!/\.(js|mjs|cjs)$/.test(name)) continue
    const src = readFileSync(join(routes, name), 'utf8')
    for (const m of src.matchAll(/\brouter\.(get|post|put|patch|delete|all)\(\s*"(\/[^"]*)"/g)) {
      const path = `${mount}${m[2]!}`
      const methods = found.get(path) ?? new Set<string>()
      methods.add(m[1]!.toUpperCase())
      found.set(path, methods)
    }
  }
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

test('#346 the key extractor sees shorthand, which is how the pin went blind', () => {
  // NOT `vendored`. This is a fixture, on purpose: the bug it guards was that the extractor read
  // whichever spelling the INSTALLED bundle happened to use, so a test that only ever runs
  // against the installed bundle is the thing that failed. 0.8.1 writes every key `name: value`
  // and would pass a colon-only extractor forever.
  const named = `
            id: info.sessionId,
            title: (info.customTitle || "").slice(0, 64),
            cwd: info.cwd || "",
            provider: "claude",
            status: null,
  `
  assert.deepEqual(listItemKeys(named), ['cwd', 'id', 'provider', 'status', 'title'])

  // The 0.10.4 spelling. A colon-only extractor returns this list without `provider`, which is
  // exactly how conclave sending a field the vendor DOES send read as conclave inventing one.
  const shorthand = named.replace('provider: "claude",', 'provider,')
  assert.deepEqual(listItemKeys(shorthand), ['cwd', 'id', 'provider', 'status', 'title'], 'a shorthand key is a key')
  assert.deepEqual(listItemKeys(shorthand), listItemKeys(named), 'the two spellings describe the same item')

  // And it must not invent keys out of a multi-line value's continuation lines, which is the
  // failure mode of loosening this too far.
  const wrapped = `
            id: info.sessionId,
            timestamp: new Date(info.lastModified).toISOString(),
            provider,
  `
  assert.deepEqual(listItemKeys(wrapped), ['id', 'provider', 'timestamp'])
})

vendored('#276 every route conclave serves is one the installed even-terminal also serves', (dir, t) => {
  // First in the file, so first: which vendor the rest of this run is evidence about (#346).
  noteVendorVersion(dir, t)

  // The direction that matters. Conclave serving something the vendor does not is conclave
  // inventing protocol, and a device built against the vendor will never call it.
  //
  // NOT the reverse: the vendor serves interrupts and metrics because it drives a coding
  // session, and its `/prompt` starts one. This is a notification surface and deliberately
  // serves a subset (its `/prompt` only answers, #280) — that asymmetry is the design, and
  // asserting equality would fail for the right shape.

  const theirs = vendorRoutes(dir)
  assert.ok(theirs.size > 5, `expected a real route table from the vendor bundle, got ${theirs.size}`)

  // Every route, `/api/events` included: it is registered in `events.js` as `/events` under the
  // same mount, and is read from there now rather than exempted.
  const invented = [...EvenRealitiesBridge.SERVED].filter((r) => !theirs.has(r))
  assert.deepEqual(
    invented,
    [],
    `conclave serves ${invented.join(', ')}, which the installed even-terminal does not — ` +
      `either the vendor moved, or this transport invented protocol. Vendor has: ${[...theirs.keys()].sort().join(', ')}`,
  )
})

vendored('#276 the routes the vendor has and conclave lacks are recorded, so a gap is a decision', (dir) => {
  // Not a failure — the subset is deliberate. But an UNEXAMINED subset is how a device ends up
  // calling something that 404s, which is exactly what happened: the app called `/api/info`
  // during pairing and conclave had no such route, so the failure looked like a bad token.
  //
  // This prints rather than asserts, so a widening vendor surface is visible in the suite
  // output without failing a build for somebody else's release.

  const theirs = vendorRoutes(dir)
  const missing = [...theirs.keys()].filter((r) => !EvenRealitiesBridge.SERVED.has(r)).sort()
  console.log(`    [observed] vendor routes conclave does not serve: ${missing.join(', ') || '(none)'}`)
  assert.ok(EvenRealitiesBridge.SERVED.has('/api/question-response'), 'the answer path must exist')
  assert.ok(EvenRealitiesBridge.SERVED.has('/api/status'), 'and the probe path a device pairs against')
})

vendored('#278 the provider conclave claims is one the vendor whitelist admits', (dir) => {
  // `provider: "conclave"` was rejected by their middleware, which 400s anything outside
  // `SUPPORTED_PROVIDERS`; that is why the app never opened a session (#276). The claim is a
  // lie (`CLAIMED_PROVIDER` in `client.ts` says why) and this pins that it is at least a lie
  // the validator accepts. If the whitelist changes, this is where the lie stops working.

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
  // BOTH SPELLINGS OF A KEY. `/^\s*(\w+):/` alone reads only `key: value`, and 0.10.4 writes
  // `provider,` -- ES6 shorthand for a variable of that name. The colon-only extractor did not
  // see it, reported the vendor's item as one key short, and turned conclave sending a field the
  // vendor DOES send into two failures that read like vendor drift (#346).
  //
  // That is this pin's own blind spot, and worse in the other direction: a key the vendor ADDS in
  // shorthand is invisible here, so conclave could omit a field the app requires while this file
  // reports the item matches. `listItemKeys` is exercised on a fixture below so the rule holds
  // whatever the installed vendor happens to be written like.
  return { keys: listItemKeys(literal), literal }
}

/**
 * The property names of an object literal, named or shorthand.
 *
 * One property per line, which is what the vendor's compiled bundle emits. A line is a key when
 * it is an identifier followed by `:`, or an identifier alone before the line's comma -- the two
 * ways `{ provider }` and `{ provider: "claude" }` are written.
 */
export function listItemKeys(literal: string): string[] {
  return [...literal.matchAll(/^\s*(\w+)\s*(?::|,\s*$)/gm)].map((x) => x[1]!).sort()
}

vendored('#278 a session list item has exactly the vendor\'s keys, keyed the way core.js reads it', async (dir, t) => {
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

vendored('#278 each field of a list item means what the vendor\'s expression for it means', async (dir, t) => {
  // The literal, expression by expression. A field with the vendor's NAME and a different
  // meaning is worse than none: the app sorts and labels by these, confidently.
  const { literal, keys } = vendorListItem(dir)
  // `undefined` for a key the vendor writes as SHORTHAND: there is no expression to read,
  // because the value is whatever the variable of that name holds at runtime. Distinct from a
  // key that is absent, which still fails -- the caller asks for keys it has already proved are
  // in the literal.
  const expr = (key: string): string | undefined => {
    const m = new RegExp(`^\\s*${key}:\\s*(.*?),?\\s*$`, 'm').exec(literal)
    if (m) return m[1]!
    assert.ok(keys.includes(key), `expected \`${key}\` in the vendor literal`)
    return undefined
  }
  const exprOf = (key: string): string => {
    const e = expr(key)
    assert.ok(e !== undefined, `expected \`${key}:\` in the vendor literal`)
    return e!
  }

  // `title` is a string cut to a length. The length is theirs; the bridge cuts to it.
  const cut = /\.slice\(0,\s*(\d+)\)/.exec(exprOf('title'))
  assert.ok(cut, `expected title to be sliced: ${exprOf('title')}`)
  const chars = Number(cut![1])
  assert.equal(EvenRealitiesBridge.TITLE_CHARS, chars, 'the bridge cuts titles to the vendor\'s length')
  const long = await serving(() => ({ ...RUN_1, title: 'z'.repeat(chars * 2) }))
  t.after(() => long.b.close())
  const cutItem = ((await (await long.get('/api/sessions')).json()) as { sessions: { title: string }[] }).sessions[0]!
  assert.equal(cutItem.title.length, chars)

  // `timestamp` is `new Date(info.lastModified).toISOString()`: the transcript's mtime, which
  // moves only when something is appended -- LAST ACTIVITY, not liveness. `runMetadata.ts`
  // sources it from the newest event and never from the heartbeat, for that reason.
  assert.match(exprOf('timestamp'), /new Date\(info\.lastModified\)\.toISOString\(\)/)
  const { b, get } = await serving()
  t.after(() => b.close())
  const item = ((await (await get('/api/sessions')).json()) as { sessions: Record<string, unknown>[] }).sessions[0]!
  assert.match(String(item['timestamp']), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'an ISO string, as toISOString gives')

  // `cwd` is the session's working directory, a string.
  assert.match(exprOf('cwd'), /info\.cwd/)
  assert.equal(typeof item['cwd'], 'string')

  // `provider` is a key the vendor sends in BOTH versions, spelled two ways: 0.8.1 wrote
  // `provider: "claude"`, a hardcoded string; 0.10.4 writes `provider,`, shorthand for the
  // variable `createClaudeSdkProvider(emit, provider, ...)` was called with. So on the newer
  // bundle there is no expression to compare against, and comparing against the OLDER bundle's
  // quoted literal would have pinned a coincidence -- the string happened to equal what conclave
  // claims, and stopped being a string at all.
  //
  // What stays true and checkable is that the vendor sends the key. That conclave's value is an
  // admitted one is the whitelist's own test, which does not read this literal.
  const providerExpr = expr('provider')
  if (providerExpr !== undefined) {
    assert.equal(providerExpr, `"${EvenRealitiesBridge.CLAIMED_PROVIDER}"`, 'a bundle that hardcodes it must hardcode what conclave claims')
  }

  // `status` starts `null` and is filled in separately by `getSessionStatus`. So `null` is a
  // value the app is built to see, and a run whose state is not known serves it rather than
  // a guess.
  assert.equal(exprOf('status'), 'null')
  const unknown = await serving(() => ({ ...RUN_1, status: null }))
  t.after(() => unknown.b.close())
  const nullItem = ((await (await unknown.get('/api/sessions')).json()) as { sessions: { status: unknown }[] }).sessions[0]!
  assert.equal(nullItem.status, null)
})

vendored('#278 the refusals are worded as the vendor words them, per route', async (dir, t) => {
  // An app built against their strings gets their strings. `events.js` and `core.js` word the
  // missing-session case differently from each other, and both are served as written.
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

vendored('#278 the per-session buffer is as deep as the vendor keeps, and status answers with their keys', async (dir, t) => {
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

vendored('#280 /prompt refuses missing text with the vendor\'s body, first, and accepts with the vendor\'s 202 keys', async (dir, t) => {
  // The narrow prompt path serves the vendor's contract at both ends -- the 400 an app gets for
  // a body with no `text`, and the 202 it reads `sessionId` and `provider` back from -- and
  // both are read from `core.js` here rather than restated. What is deliberately NOT the
  // vendor's is in between: theirs starts a session for the text; this answers a question or
  // refuses, and `client.test.ts` pins that.
  const { b, get } = await serving()
  t.after(() => b.close())

  const core = vendorFile(dir, 'routes/core.js')
  const handler = /router\.post\("\/prompt",[\s\S]*?\n\}\);/.exec(core)
  assert.ok(handler, 'expected the /prompt handler in core.js')
  const src = handler![0]

  // THE 400, and its ORDER: theirs tests `text` before it touches a provider or a session, so a
  // body with neither hears about text. Read from the source, not assumed.
  const refusal = /if \(!text \|\| typeof text !== "string"\) \{[\s\S]*?res\.status\(400\)\.json\((\{ error: "[^"]+" \})\)/.exec(src)
  assert.ok(refusal, 'expected the missing-text refusal in the /prompt handler')
  const body400 = JSON.parse(refusal![1]!.replace(/(\w+):/, '"$1":')) as { error: string }
  assert.ok(src.indexOf(refusal![0]) < src.indexOf('.prompt('), 'text is validated before the session is touched')
  const post = (payload: unknown): Promise<Response> =>
    fetch(`${b.url}/api/prompt?token=tok`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  const noText = await post({ sessionId: 'run-9' })
  assert.equal(noText.status, 400)
  assert.deepEqual(await noText.json(), body400, 'the vendor\'s body, and before the unknown session was looked at')

  // THE 202, key for key. `result.sessionId` and `result.provider` are the vendor's provider
  // answering; here the id is the one named and the provider is the claimed one.
  const accepted = /res\.status\(202\)\.json\(\{([^}]*)\}\)/.exec(src)
  assert.ok(accepted, 'expected the 202 in the /prompt handler')
  const keys202 = accepted![1]!.split(',').map((kv) => kv.split(':')[0]!.trim()).sort()
  const asked = b.ask('run-1', { header: 'Approval', question: 'go?', options: [{ label: 'Yes', description: '' }] })
  await new Promise((r) => setTimeout(r, 50))
  const ok = await post({ sessionId: 'run-1', text: 'go on' })
  assert.equal(ok.status, 202)
  const reply = (await ok.json()) as Record<string, unknown>
  assert.deepEqual(Object.keys(reply).sort(), keys202)
  assert.equal(reply['sessionId'], 'run-1')
  assert.equal(reply['provider'], EvenRealitiesBridge.CLAIMED_PROVIDER)
  assert.deepEqual(await asked, { answer: 'go on' })
  assert.equal((await get('/api/status?sessionId=run-1')).status, 200)
})

vendored('#285 the confirmation is a `notification` the vendor sends, with exactly the vendor\'s keys', async (dir, t) => {
  // The echo that closes an `ask` (#285) is the one frame this transport sends that the header
  // of `client.ts` merely ASSERTS the app understands. So the shape is read here from where the
  // vendor's own session sends it -- every `type: "notification"` literal in `claude/session.js`
  // -- and the frame on conclave's wire is held to the same key set. A key the vendor never
  // sends is protocol the app was not built against; a key the vendor sends and conclave omits
  // is a frame the app may not render.
  const session = vendorFile(dir, 'claude/session.js')
  const literals = [...session.matchAll(/this\.send\(\{\s*type: "notification",([\s\S]*?)\}\)/g)]
  assert.ok(literals.length > 0, 'expected the vendor to send a `notification` somewhere; the type is gone, and so is the confirmation\'s footing')
  const theirs = literals.map((m) =>
    ['type', ...[...m[1]!.matchAll(/^\s*(\w+)\s*[:,]/gm)].map((k) => k[1]!)].sort(),
  )
  for (const keys of theirs) assert.deepEqual(keys, theirs[0], 'every vendor site sends the same shape')

  const { b } = await serving()
  t.after(() => b.close())
  const ac = new AbortController()
  t.after(() => ac.abort())
  const stream = await fetch(`${b.url}/api/events?sessionId=run-1&token=tok`, { signal: ac.signal })
  const reader = stream.body!.getReader()
  const frames: Record<string, unknown>[] = []
  const reading = (async () => {
    let buf = ''
    while (frames.length < 2) {
      const { value, done } = await reader.read()
      if (done) break
      buf += new TextDecoder().decode(value)
      const parts = buf.split('\n\n')
      buf = parts.pop() ?? ''
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data: '))
        if (line) frames.push(JSON.parse(line.slice(6)) as Record<string, unknown>)
      }
    }
  })()
  await new Promise((r) => setTimeout(r, 100))
  const asked = b.ask('run-1', { header: 'Approval', question: 'go?', options: [{ label: 'Yes', description: '' }] })
  await new Promise((r) => setTimeout(r, 50))
  await fetch(`${b.url}/api/question-response?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'run-1', answer: 'Yes' }),
  })
  assert.deepEqual(await asked, { answer: 'Yes' })
  await reading

  const echo = frames[1]
  assert.ok(echo, 'expected the confirmation as the second frame on the stream')
  assert.equal(echo['type'], 'notification')
  assert.deepEqual(Object.keys(echo).sort(), theirs[0], 'the confirmation carries the vendor\'s keys and no other')
  assert.equal(typeof echo['title'], 'string')
  assert.equal(echo['message'], 'Yes', 'the message is what was received')
})

/**
 * The vendor's history route and the provider method it calls, as text (#284).
 *
 * `router.get("/sessions/:id/history", ...)` in `routes/core.js` clamps the limit and wraps the
 * provider; `getHistory` in `claude/provider.js` shapes the entry and takes the tail. Both are
 * read here so each claim in `client.ts` about them is checked against the expression it
 * restates, the way the list item is (`vendorListItem`).
 */
function vendorHistory(dir: string): { route: string; provider: string } {
  const core = vendorFile(dir, 'routes/core.js')
  // Any method: which one it is registered under is the route test's claim, not this helper's.
  const routeMatch = /router\.\w+\("\/sessions\/:id\/history",[\s\S]*?\n\}\);/.exec(core)
  assert.ok(routeMatch, 'expected the history route handler in routes/core.js')
  const provider = vendorFile(dir, 'claude/provider.js')
  const providerMatch = /async function getHistory\([\s\S]*?\n {4}\}/.exec(provider)
  assert.ok(providerMatch, 'expected `getHistory` in claude/provider.js')
  return { route: routeMatch![0], provider: providerMatch![0] }
}

vendored('#284 the history route is theirs: GET, and the limit clamped the way their two expressions clamp it', async (dir, t) => {
  // The route the app calls on opening a session (#284). `client.ts` restates two of the
  // vendor's expressions -- the route's default-and-cap, the provider's cap-and-tail -- and
  // every number in them is read from the bundle here, not from the restatement.
  const methods = vendorRoutes(dir).get('/api/sessions/:id/history')
  assert.deepEqual(methods && [...methods], ['GET'], 'registered once, as a GET')
  assert.ok(EvenRealitiesBridge.SERVED.has('/api/sessions/:id/history'))

  const { route, provider } = vendorHistory(dir)
  // The route: `Math.min(parseInt(req.query.limit) || D, C)`. D is what a missing, junk or
  // zero limit becomes; C is the ceiling. They are the same number, and it is the bridge's.
  const clamp = /const limit = Math\.min\(parseInt\(req\.query\.limit\) \|\| (\d+), (\d+)\)/.exec(route)
  assert.ok(clamp, `expected the limit clamp in the route: ${route}`)
  const [fallback, ceiling] = [Number(clamp![1]), Number(clamp![2])]
  assert.equal(fallback, ceiling, 'the vendor defaults to its own ceiling')
  assert.equal(EvenRealitiesBridge.HISTORY_ITEMS, ceiling, 'the bridge caps where the route caps')

  // The provider: `MAX_HISTORY_ITEMS = N`, then `Math.min(limit, MAX_HISTORY_ITEMS)` and a
  // NEGATIVE slice of that -- the tail, oldest first. `client.ts` applies the same two steps.
  const max = /const MAX_HISTORY_ITEMS = (\d+);/.exec(vendorFile(dir, 'claude/provider.js'))
  assert.ok(max, 'expected MAX_HISTORY_ITEMS in claude/provider.js')
  assert.equal(Number(max![1]), ceiling, 'the provider caps where the route caps')
  const tail = /let (\w+) = Math\.min\(limit, MAX_HISTORY_ITEMS\);\s*return \w+\.slice\(-\1\);/.exec(provider)
  assert.ok(tail, `expected the capped tail slice in getHistory: ${provider}`)

  // Tied to the wire: more than the cap buffered, and the last `ceiling` come back in order.
  const { b, get } = await serving()
  t.after(() => b.close())
  for (let i = 1; i <= ceiling + 3; i++) b.send('run-1', { type: 'notification', title: 'conclave', message: `n${i}` })
  const texts = async (path: string): Promise<string[]> =>
    ((await (await get(path)).json()) as { history: { text: string }[] }).history.map((e) => e.text)
  const last = (k: number) => Array.from({ length: k }, (_, i) => `n${ceiling + 3 - k + 1 + i}`)
  assert.deepEqual(await texts('/api/sessions/run-1/history'), last(ceiling), 'missing: the ceiling, oldest first')
  assert.deepEqual(await texts('/api/sessions/run-1/history?limit=junk'), last(ceiling), 'junk: parseInt is NaN, so the default')
  assert.deepEqual(await texts('/api/sessions/run-1/history?limit=0'), last(ceiling), 'zero: falsy, so the default')
  assert.deepEqual(await texts(`/api/sessions/run-1/history?limit=${ceiling * 10}`), last(ceiling), 'over: the ceiling')
  assert.deepEqual(await texts('/api/sessions/run-1/history?limit=2'), last(2), 'under: honoured, from the tail')
})

vendored('#284 a history entry has exactly the vendor\'s keys, and the envelope is `res.json` with no status', async (dir, t) => {
  // The entry literal is `acc.push({ role: msg.type, text: content.text })` -- the keys the
  // app reads scrollback from. The envelope is `res.json({ history })` on success and
  // `res.json({ history: [], error: err.message })` on a throw: NEITHER sets a status, so a
  // history the app can show and one it cannot are both 200, and only the keys differ.
  const { route, provider } = vendorHistory(dir)
  const entry = /acc\.push\(\{([^}]*)\}\)/.exec(provider)
  assert.ok(entry, `expected the entry literal in getHistory: ${provider}`)
  const keys = [...entry![1]!.matchAll(/(\w+):/g)].map((m) => m[1]!).sort()
  assert.deepEqual(keys, ['role', 'text'], 'the vendor\'s entry, as read; if this moved, so must historyEntry')

  const success = /res\.json\(\{ history \}\)/.exec(route)
  const failure = /res\.json\(\{ history: \[\], error: err\.message \}\)/.exec(route)
  assert.ok(success && failure, `expected both res.json envelopes in the route: ${route}`)
  assert.doesNotMatch(route, /res\.status\(/, 'no status on either path: both are 200')

  const { b, get } = await serving()
  t.after(() => b.close())
  b.send('run-1', { type: 'notification', title: 'Approval', message: 'merge?' })
  b.send('run-1', { type: 'user_question', questions: [{ question: 'go?', header: 'Q', options: [] }] })
  const r = await get('/api/sessions/run-1/history')
  assert.equal(r.status, 200)
  const body = (await r.json()) as Record<string, unknown>
  assert.deepEqual(Object.keys(body), ['history'], 'the success envelope, key for key')
  const history = body['history'] as Record<string, unknown>[]
  assert.equal(history.length, 2)
  for (const e of history) assert.deepEqual(Object.keys(e).sort(), keys, 'every entry carries the vendor\'s keys and no other')
  for (const e of history) assert.ok(['user', 'assistant'].includes(String(e['role'])), 'role is a transcript role, as `msg.type` is')
})

vendored('#284 an unknown session is `200 { history: [] }`: proved on the installed provider, then held on ours', async (dir, t) => {
  // `/api/messages` chose empty-over-404 because theirs does; #284 asked that this route be
  // checked rather than have that decision copied across. So it is checked ON THE VENDOR'S
  // CODE: the installed Claude provider is imported and asked for the history of an id no
  // transcript has -- a fresh UUID, and an id spelled the way conclave spells them -- and
  // both come back `[]` without throwing. Nothing thrown means the route's `res.json({
  // history })` runs, not the `error` envelope, so the wire is `200 { history: [] }`.
  //
  // The import is the real module: it resolves the Agent SDK from the vendor's own
  // node_modules and reads `~/.claude/projects` looking for the id. Neither id can be there.
  const mod = (await import(pathToFileURL(join(dir, 'dist', 'claude', 'provider.js')).href)) as {
    createClaudeProvider: (emit: () => void) => { getHistory: (id: string, limit: number) => Promise<unknown[]> }
  }
  const provider = mod.createClaudeProvider(() => {})
  assert.deepEqual(await provider.getHistory(randomUUID(), EvenRealitiesBridge.HISTORY_ITEMS), [], 'a UUID no transcript has')
  assert.deepEqual(await provider.getHistory('20260911-174920-39357', EvenRealitiesBridge.HISTORY_ITEMS), [], 'a conclave-shaped id')

  const { b, get } = await serving()
  t.after(() => b.close())
  const r = await get(`/api/sessions/${randomUUID()}/history`)
  assert.equal(r.status, 200, 'not 404: theirs does not know the id either, and answers 200')
  assert.deepEqual(await r.json(), { history: [] }, 'the success envelope, empty, with no `error`')
})
