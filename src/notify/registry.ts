/**
 * Resolving a transport by name.
 *
 * A map rather than dynamic import: the set of transports is small, they are all in this
 * repository, and a name that does not resolve should say what the names ARE. A registry that
 * scanned a directory would answer "not found" for a typo and for a missing adapter alike.
 *
 * An adapter is added here in one line. That is the whole extension point -- deliberately, so
 * "how do I add a transport" has one answer rather than a convention to discover.
 */

import { EvenRealitiesTransport } from './evenRealities/transport.ts'
import { FakeTransport } from './fake.ts'
import type { Inbound, Transport } from './types.ts'

/**
 * The scripted reply for `fake`, as JSON, for driving the CLI in a test or a demo.
 *
 * Test plumbing, named as such rather than hidden: without it `fake` can be told things but
 * cannot answer, so every CLI path that waits would be untestable. A real transport reads its
 * replies from a socket and ignores this entirely.
 */
export const FAKE_REPLY_ENV = 'CONCLAVE_FAKE_REPLY'

function fake(): Transport {
  const t = new FakeTransport()
  const scripted = process.env[FAKE_REPLY_ENV]
  if (scripted !== undefined && scripted !== '') {
    try {
      t.reply = JSON.parse(scripted) as Inbound
    } catch {
      // Left unset, so `ask` reports that nothing could be received rather than inventing an
      // answer out of a malformed one. An answer nobody gave is the one thing this must not
      // produce.
    }
  }
  return t
}

/**
 * `even-realities` serves the Terminal Mode protocol rather than calling it: the glasses connect
 * to an address the operator types, so conclave being that address is what puts its questions in
 * front of them. `EVEN_PORT` and `EVEN_TOKEN` are how the operator points the app at it.
 */
function evenRealities(): Transport {
  const port = Number(process.env['CONCLAVE_EVEN_PORT'] ?? '3457')
  const token = process.env['CONCLAVE_EVEN_TOKEN']
  return new EvenRealitiesTransport({ port, ...(token ? { token } : {}) })
}

const BUILT_IN: Record<string, () => Transport> = { fake, 'even-realities': evenRealities }

export function transportNames(): string[] {
  return Object.keys(BUILT_IN).sort()
}

export function resolveTransport(name: string): Transport | undefined {
  return BUILT_IN[name]?.()
}
