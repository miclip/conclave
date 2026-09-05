/**
 * `close('graceful')` over a LIVE turn, on the two pty adapters. #146.
 *
 * The stream is the only thing most consumers read. `Relay#exchangeTurn` waits for a `turn_end`
 * with no deadline of its own by design -- the adapter's watchdog owns that clock -- so a stream
 * that simply ENDS over a live turn leaves the last turn of a run with no reported outcome at
 * all. #143 taught the relay to cope with that (it records a roll-call and calls the turn
 * abandoned), but coping is not the same as being told, and the adapter is the only party that
 * knows what it stopped observing.
 *
 * `abandoned` already does the right thing: every live turn gets `observeObservationGap()`
 * before the transport is torn down. `graceful` did not. Its reconcile issues a verdict only for
 * a turn the TRANSCRIPT already shows finished, and a genuinely live turn is `in_progress` by
 * construction at that moment -- so it emitted nothing and the queue closed over it.
 *
 * The fix is deliberately the same mechanism, not a new one: the gap is recorded through the
 * tracker, so `events()` and `snapshot()` cannot disagree, and the classifier decides what the
 * verdict is. Nothing here synthesises a `turn_end` -- a verdict nobody observed is exactly what
 * #146 says must not be invented. What is asserted is that the adapter says SOMETHING terminal
 * about a turn it walked away from, and that the something is grounded in the gap.
 *
 * The watchdog is set far beyond the test's own lifetime on purpose. A short clock would supply
 * the missing `turn_end` by itself and the test would pass with the fix removed, which is the
 * failure mode this issue has already produced twice.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import type { AgentEvent, TurnEndEvent, TurnStartEvent } from '../contract/session.ts'
import { ClaudePtyHookAdapter } from './claude.ts'
import { CodexPtyHookAdapter } from './codex.ts'
import { installFakeClis } from './fakeCli.ts'
import { containAdapterRunDirs } from '../testkit/tempDir.ts'

/**
 * The run directories the adapters this file boots make for themselves, contained.
 *
 * `Claude.#boot` and `Codex.#boot` each `mkdtemp` a run directory under `os.tmpdir()` and
 * never remove it. That is PRODUCTION behaviour and issue #203's business, not this file's --
 * so rather than change it, the floor it lands on moves: `tmpdir()` re-reads `TMPDIR` on every
 * call, so pointing it at a directory the testkit issued puts every run directory booted here
 * inside something whose lifetime the helper already owns.
 *
 * Per FILE, and that is what makes it safe rather than a shared global: every test file runs
 * in its own process under `node --test`, so this reaches no other suite, and the tests in
 * this one stay isolated from each other exactly as before -- by `tempDir` handing each its
 * own uniquely named child of this root.
 */
containAdapterRunDirs()

// ORCH_FAKE_STOP_MS is left unset, so the stand-in acknowledges the prompt and then never
// reports the turn ending. That is the whole precondition: a turn that is live when we close.
const { dir: RUN } = installFakeClis()

/** Longer than this file can possibly run, so no clock can end a turn on the adapter's behalf. */
const NO_CLOCK_MS = 600_000

/**
 * Drain `events()` to its END on a single iterator, since the queue has one consumer.
 *
 * Returns the collector rather than the events: the caller has to be reading BEFORE it closes
 * the session, because the terminal verdict is emitted during `close()` and a consumer that
 * starts afterwards has already missed it.
 */
function drain(session: { events(): AsyncIterable<AgentEvent> }): {
  seen: AgentEvent[]
  ended: Promise<void>
} {
  const seen: AgentEvent[] = []
  const ended = (async () => {
    for await (const e of session.events()) seen.push(e)
  })()
  return { seen, ended }
}

/** Wait for the adapter to report the turn STARTING, so "live" is observed and not assumed. */
async function liveTurn(seen: AgentEvent[]): Promise<TurnStartEvent> {
  for (let i = 0; i < 400; i++) {
    const start = seen.find((e) => e.type === 'turn_start') as TurnStartEvent | undefined
    if (start) return start
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('the stand-in never reported a turn starting, so nothing here was live')
}

for (const [agent, start] of [
  ['claude', ClaudePtyHookAdapter.start.bind(ClaudePtyHookAdapter)],
  ['codex', CodexPtyHookAdapter.start.bind(CodexPtyHookAdapter)],
] as const) {
  test(`${agent}: close('graceful') over a live turn says how it ended, rather than ending the stream in silence`, async () => {
    const session = await start({
      cwd: RUN,
      role: 'implementer',
      watchdogMs: NO_CLOCK_MS,
      readyTimeoutMs: 20_000,
    })

    const { seen, ended } = drain(session)
    await session.send('work that never finishes', { kind: 'orchestrator' })
    const started = await liveTurn(seen)

    await session.close('graceful')
    await ended

    const end = seen.find(
      (e) => e.type === 'turn_end' && e.turnKey === started.turnKey,
    ) as TurnEndEvent | undefined

    assert.ok(
      end,
      'the stream ended over a live turn with no terminal event: a consumer following events() ' +
        'never learned how the last turn of the run ended, which is the one it most needs',
    )
    // Grounded in the gap rather than in a guess. The outcome itself is the classifier's to
    // choose -- what must not happen is a confident verdict for a turn nobody watched finish.
    assert.equal(end.verdict.outcome, 'process_exited', 'the child died; that is what ended the turn')
    assert.notEqual(
      end.verdict.confidence,
      'proven',
      'nobody watched this turn finish, so nothing about it is proven',
    )

    // The evidence is the exit `close()` awaited, not a guess made because the turn looked
    // stuck. Pinning the reason is what separates the two: `sigterm` can only have come from
    // the terminate, and a synthesised verdict would have nothing to put here.
    assert.ok(
      end.verdict.provenance.some((pr) => pr.source === 'process' && pr.detail === 'sigterm'),
      `the verdict must carry the exit it was drawn from: ${JSON.stringify(end.verdict.provenance)}`,
    )

    // `#onExit` reaches the same conclusion moments later. The tracker returns `undefined` for
    // an observation that does not change the verdict, so the consumer must see ONE ending --
    // not the same turn ending twice, which is what a second `#apply` would look like on the
    // stream.
    const ends = seen.filter((e) => e.type === 'turn_end' && e.turnKey === started.turnKey)
    assert.equal(ends.length, 1, 'the turn ended once, however many observers reached that conclusion')
  })
}
