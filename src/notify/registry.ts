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

import { basename } from 'node:path'

import { projectRootFor } from '../workspace/sessionRecord.ts'
import { sharedHub } from './evenRealities/hub.ts'
import { describeRun } from './evenRealities/runMetadata.ts'
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
 * The name the operator reads on the glasses, defaulting to what they already call the thing.
 *
 * The project directory, as tmux would name a session. A run id is unreadable on a HUD and an
 * unprompted notification carries no other context -- the operator was not looking at a
 * terminal and may have several projects going (#184).
 *
 * DISPLAY ONLY. It is never the session id: two runs in one directory share a name and must
 * not share a session, because a session is what an answer is routed by (#278).
 */
function friendlyName(): string {
  const given = process.env['CONCLAVE_NOTIFY_NAME']
  if (given !== undefined && given.trim() !== '') return given.trim()
  return basename(process.cwd()) || 'conclave'
}

/**
 * What a transport is resolved FOR. A session on the glasses is a run (#278), so the run's id
 * is part of resolving the transport, not a field on the message that the transport ignores.
 */
export interface ResolveOptions {
  /** The run this transport speaks for: `--run` on the CLI, and `runId` on the record. */
  runId?: string
}

/**
 * A transport that exists but cannot be resolved with what it was given.
 *
 * Distinct from `undefined`, which is a NAME that does not resolve and is answered with the
 * list of names. This is a name that does resolve, refusing the options: the message says what
 * was missing, and the CLI prints it and exits 2, the same code as any other unusable request.
 */
export class TransportRefused extends Error {}

/**
 * `even-realities` serves the Terminal Mode protocol rather than calling it: the glasses connect
 * to an address the operator types, so conclave being that address is what puts its questions in
 * front of them. `EVEN_PORT` and `EVEN_TOKEN` are how the operator points the app at it.
 */
function evenRealities(opts: ResolveOptions): Transport {
  const port = Number(process.env['CONCLAVE_EVEN_PORT'] ?? '3456')
  const token = process.env['CONCLAVE_EVEN_TOKEN']
  // THE DEVICE IS NOT ON LOOPBACK (#276). The bridge binds `127.0.0.1` unless told otherwise,
  // which is the right default for something that opens a port -- but the glasses reach this
  // across a network, so on the default nothing they can dial will ever answer. Observed with
  // the app pointed at a Tailscale name: the address resolved, the port refused.
  //
  // An env var rather than a new default, because widening the bind is an exposure decision and
  // belongs to whoever runs it. `CONCLAVE_EVEN_HOST=0.0.0.0` for any interface, or the machine's
  // own tailnet address to keep it off the LAN.
  const host = process.env['CONCLAVE_EVEN_HOST']
  // A VIEW of the process's one bridge, not a bridge of its own. The glasses are a device:
  // one pair, one address the operator typed, one connection. Building one per broker meant
  // the second concurrent run's `listen()` met a bound port -- and had it not, two runs
  // attached to one device would each have taken whichever answer arrived next (#184).
  //
  // A SESSION IS A RUN, so there is no session without one (#278). No synthetic id stands in:
  // a session the glasses can open must be a run the operator can find, and an id minted here
  // would be neither. `fake` needs no run and is untouched by this; it is this transport's rule.
  const runId = opts.runId?.trim()
  if (!runId) {
    throw new TransportRefused(
      'even-realities needs the run it speaks for: pass --run <id> (a session on the glasses is a run)',
    )
  }
  // AND THE RUN MUST BE READABLE. Its record is what the session list carries -- goal, working
  // directory, last activity -- and a run with no record here has nothing true to list. Refused
  // in those words rather than listed with blanks, which would be an entry the app can open and
  // an operator cannot recognise.
  const root = projectRootFor(process.cwd())
  const describe = (): ReturnType<typeof describeRun> => describeRun(root, runId)
  if (!describe()) {
    throw new TransportRefused(`no readable record for run ${runId} in this project — see conclave sessions`)
  }
  return sharedHub({ port, ...(token ? { token } : {}), ...(host ? { host } : {}) }).view(runId, friendlyName(), describe)
}

const BUILT_IN: Record<string, (opts: ResolveOptions) => Transport> = { fake, 'even-realities': evenRealities }

export function transportNames(): string[] {
  return Object.keys(BUILT_IN).sort()
}

export function resolveTransport(name: string, opts: ResolveOptions = {}): Transport | undefined {
  return BUILT_IN[name]?.(opts)
}
