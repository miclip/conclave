/**
 * What conclave serves, checked against the protocol it is imitating (#276).
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

import { EvenRealitiesBridge } from './client.ts'

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
