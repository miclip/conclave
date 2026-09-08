/**
 * What the three adapters DO with a contained listener failure. #263.
 *
 * `receiverListenerThrow.test.ts` proves the receiver contains the throw and hands it on. This
 * file proves the other half, which is the half an operator actually experiences: that each
 * adapter's `listener_error` wiring is really there, that it turns the fault into an ordinary
 * non-fatal `error` event on `events()` carrying the diagnosis verbatim, and that the session
 * is still worth talking to afterwards.
 *
 * WHY THE LISTENER IS INSTRUMENTED. Nothing in any `#onHook` throws synchronously today, so
 * there is no payload that drives a real adapter into the fault -- which is exactly why the
 * crash in #263 was found in production rather than in a test. Asserting on the source text
 * instead would pin the characters and not the behaviour, and would pass just as happily if
 * the handler were dead code. So `HookReceiver.prototype.on` is wrapped for the duration of
 * each test: the adapter's OWN `delivery` callback is registered and runs in full, doing its
 * real work, and only then does the wrapper throw the production correlation diagnosis. What
 * is under test is everything downstream of that throw, all of it real -- the receiver's
 * containment, the adapter's registration, its conversion, and its event stream.
 *
 * The throw is armed once. A second delivery must go through untouched, because "the session
 * survives" means the next hook still works and not merely that the process is still up.
 *
 *   node --test src/adapters/listenerFailureSurfaces.test.ts
 */

import { strict as assert } from 'node:assert'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AgentEvent } from '../contract/session.ts'
import type { HookDelivery } from '../hooks/journal.ts'
import { HookReceiver } from '../hooks/receiver.ts'
import { containAdapterRunDirs, tempDir } from '../testkit/tempDir.ts'
import { ClaudePtyHookAdapter } from './claude.ts'
import { CodexPtyHookAdapter } from './codex.ts'
import { KimiPrintAdapter } from './kimi.ts'
import { installFakeClis } from './fakeCli.ts'
import { CorruptedPromptError, describePromptMismatch } from './promptFidelity.ts'

/** Every run directory the adapters booted here make for themselves, contained (#211). */
containAdapterRunDirs()

const { dir: RUN } = installFakeClis()

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const KIMI_STDOUT = join(REPO, 'spikes/kimi/fixtures/edit-turn.ndjson')
const KIMI_STDERR = join(REPO, 'spikes/kimi/fixtures/edit-turn.stderr.txt')

/** The advisor envelope that was in flight when the harness block landed. */
const SENT = `[FROM THE ADVISOR (advisor) — a peer AI model, not the operator]

Add the failing regression test and report what it fails on.`

/** What the child took instead. */
const TOOK =
  `<system-reminder>Codebase and user instructions are shown below. Be sure to adhere ` +
  `to these instructions.</system-reminder>`

/**
 * The real diagnosis from the real detector, built here rather than copied, so what these
 * tests require to survive is exactly what production writes.
 */
const MISMATCH = describePromptMismatch(SENT, TOOK)

/**
 * Wrap `HookReceiver.prototype.on` so the next receiver constructed gets a `delivery` listener
 * that does the adapter's work and then throws the correlation fault, once.
 *
 * `on` is inherited from `EventEmitter`, so the wrapper becomes an own property of
 * `HookReceiver.prototype` and undoing it is a delete rather than an assignment -- putting
 * `EventEmitter`'s method back as an own property would leave the shadow in place and quietly
 * outlive the test.
 */
function armThrowOnFirstDelivery() {
  const proto = HookReceiver.prototype as unknown as Record<string, unknown>
  const hadOwn = Object.prototype.hasOwnProperty.call(proto, 'on')
  const realOn = proto['on'] as (this: HookReceiver, event: string, fn: (...a: never[]) => void) => HookReceiver

  const state = { receiver: undefined as HookReceiver | undefined, deliveries: 0, threw: 0 }

  proto['on'] = function (this: HookReceiver, event: string, listener: (...a: never[]) => void) {
    state.receiver = this
    if (event !== 'delivery') return realOn.call(this, event, listener)
    return realOn.call(this, event, ((d: HookDelivery) => {
      // The adapter's own handler, in full and unaltered. If it were skipped the session would
      // be broken by the instrument rather than by the fault, and "still usable" would mean
      // nothing.
      ;(listener as unknown as (x: HookDelivery) => void)(d)
      state.deliveries += 1
      if (state.threw === 0) {
        state.threw = 1
        throw new CorruptedPromptError(MISMATCH!, 'turn-1')
      }
    }) as unknown as (...a: never[]) => void)
  } as unknown as typeof proto.on

  return {
    state,
    restore(): void {
      if (hadOwn) proto['on'] = realOn
      else delete proto['on']
    },
  }
}

/** The events an adapter emitted that are this fault being reported. */
function faultsIn(seen: AgentEvent[]) {
  return seen.filter((e) => e.type === 'error' && e.message.includes(MISMATCH!.message))
}

/** The real timer, so a test that freezes the adapter's clock could still wait in real time. */
const realSetTimeout = globalThis.setTimeout

/**
 * Wait for something to show up in the collected stream.
 *
 * One consumer of `events()` per session and everything read into an array, because these are
 * single-consumer queues: a second `for await` alongside the first would take events away from
 * it, and the test would be racing itself for its own evidence.
 */
async function waitFor(
  what: string,
  seen: AgentEvent[],
  ready: (seen: AgentEvent[]) => boolean,
  ms = 30_000,
): Promise<void> {
  const deadline = Date.now() + ms
  while (!ready(seen)) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${ms}ms waiting for ${what}; saw ` +
          JSON.stringify(seen.map((e) => e.type)),
      )
    }
    await new Promise((r) => realSetTimeout(r, 10))
  }
}

/**
 * The assertion every adapter owes: exactly one non-fatal error, carrying the diagnosis
 * unaltered.
 *
 * Filtered rather than counted against the whole stream, because these adapters legitimately
 * emit other non-fatal errors -- a replayed delivery, a degraded hook mode -- and a test that
 * demanded a quiet stream would be pinning unrelated behaviour.
 */
function assertSurfacedOnce(who: string, seen: AgentEvent[]): void {
  const faults = faultsIn(seen)
  assert.equal(
    faults.length,
    1,
    `${who}: the contained fault must reach events() exactly once; saw ` +
      `${JSON.stringify(seen.filter((e) => e.type === 'error').map((e) => e.message.slice(0, 120)))}`,
  )
  const fault = faults[0]!
  assert.equal(fault.type, 'error')
  assert.equal(
    fault.fatal,
    false,
    `${who}: the whole point is that this is survivable; a fatal error says the opposite`,
  )
  assert.ok(
    fault.message.includes(MISMATCH!.message),
    `${who}: the diagnosis must be carried verbatim, not summarised; got ${fault.message}`,
  )
}

test('the fixture is still the correlation fault', () => {
  assert.ok(MISMATCH, 'the detector must still call this a mismatch')
  assert.equal(
    MISMATCH.shape,
    'unrelated',
    'and still the harness-block correlation fault; another shape is a different fault and ' +
      'would make every assertion below mean something else',
  )
})

test('claude surfaces a contained delivery-listener failure and keeps working', async (t) => {
  const arm = armThrowOnFirstDelivery()
  t.after(() => arm.restore())

  // The stand-in posts `SessionStart` at startup, so the throw rides the boot delivery -- the
  // adapter has created its view and marked itself ready before the wrapper raises.
  const session = await ClaudePtyHookAdapter.start({
    cwd: RUN,
    role: 'implementer',
    watchdogMs: 600_000,
    readyTimeoutMs: 20_000,
  })

  const seen: AgentEvent[] = []
  const reading = (async () => {
    for await (const e of session.events()) seen.push(e)
  })()

  try {
    assert.equal(arm.state.threw, 1, 'the instrument must actually have thrown')
    assert.ok(arm.state.deliveries >= 1, 'and the adapter’s own handler must have run')

    // Still usable is the claim, and a send is the strongest form of it: it needs the pty, the
    // composer AND a further hook delivery through the receiver that just contained a throw.
    const key = await session.send('Say only OK.', { kind: 'orchestrator' })
    assert.ok(key, 'a send after the contained fault must still open a turn')
    assert.ok(arm.state.deliveries >= 2, 'so a later delivery went through untouched')

    await waitFor('the contained fault to reach events()', seen, (s) => faultsIn(s).length > 0)
    assertSurfacedOnce('claude', seen)
  } finally {
    await session.close()
    await reading.catch(() => {})
  }
})

test('codex surfaces a contained delivery-listener failure and keeps working', async (t) => {
  const arm = armThrowOnFirstDelivery()
  t.after(() => arm.restore())

  const session = await CodexPtyHookAdapter.start({
    cwd: RUN,
    role: 'implementer',
    watchdogMs: 600_000,
    readyTimeoutMs: 20_000,
  })

  const seen: AgentEvent[] = []
  const reading = (async () => {
    for await (const e of session.events()) seen.push(e)
  })()

  try {
    assert.equal(arm.state.threw, 1, 'the instrument must actually have thrown')
    assert.ok(arm.state.deliveries >= 1, 'and the adapter’s own handler must have run')

    const key = await session.send('Say only OK.', { kind: 'orchestrator' })
    assert.ok(key, 'a send after the contained fault must still open a turn')
    assert.ok(arm.state.deliveries >= 2, 'so a later delivery went through untouched')

    await waitFor('the contained fault to reach events()', seen, (s) => faultsIn(s).length > 0)
    assertSurfacedOnce('codex', seen)
  } finally {
    await session.close()
    await reading.catch(() => {})
  }
})

/** The recorded Kimi turn its own suite replays: a think block, two tools, a closing message. */
function kimiStub(t: TestContext): string {
  const dir = tempDir(t, 'kimi-listener-stub')
  const command = join(dir, 'kimi-stub')
  writeFileSync(
    command,
    `#!/bin/sh\ncat ${JSON.stringify(KIMI_STDOUT)}\ncat ${JSON.stringify(KIMI_STDERR)} >&2\nexit 0\n`,
  )
  chmodSync(command, 0o755)
  return command
}

test('kimi surfaces a contained delivery-listener failure and keeps working', async (t) => {
  const arm = armThrowOnFirstDelivery()
  t.after(() => arm.restore())

  const session = await KimiPrintAdapter.start({
    cwd: REPO,
    role: 'implementer',
    command: kimiStub(t),
  })

  const seen: AgentEvent[] = []
  const reading = (async () => {
    for await (const e of session.events()) seen.push(e)
  })()

  try {
    // Kimi's child is a `--print` process, so nothing fires a hook at startup: the delivery is
    // posted here, over the real HTTP path, to the receiver the adapter really started. The
    // URL is the receiver's own -- the only thing borrowed from the instrument is a handle on
    // the instance.
    const receiver = arm.state.receiver
    assert.ok(receiver, 'the adapter must have started a receiver to register a listener on')

    const res = await fetch(receiver.url, {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'kimi-probe' }),
      headers: {
        'content-type': 'application/json',
        'x-orch-agent': 'kimi',
        'x-orch-delivery-id': 'listener-fault',
      },
    })
    assert.equal(res.status, 200, 'the delivery is journalled and acknowledged either way')
    await res.arrayBuffer()

    assert.equal(arm.state.threw, 1, 'the instrument must actually have thrown')
    // The adapter's own handler ran to completion BEFORE the throw, and this is the proof:
    // adopting the session id off a `SessionStart` is the work `#onHook` does with one.
    assert.equal(session.sessionId, 'kimi-probe', 'the real listener body finished its work')

    await waitFor('the contained fault to reach events()', seen, (s) => faultsIn(s).length > 0)
    assertSurfacedOnce('kimi', seen)

    // Still usable, in the only terms this adapter has: a turn runs and the child's record is
    // read to a verdict.
    await session.send('go', { kind: 'orchestrator' })
    await waitFor('a turn to end', seen, (s) => s.some((e) => e.type === 'turn_end'))
    const end = seen.find((e) => e.type === 'turn_end')!
    assert.equal(end.verdict.outcome, 'completed', 'a turn after the contained fault still lands')
  } finally {
    await session.close()
    await reading.catch(() => {})
  }
})
