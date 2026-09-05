/**
 * One send at a time, per session, proven through the real adapters.
 *
 * Both adapters kept the caller's promise in a SINGLE slot -- `#pendingPrompt` -- and neither
 * checked whether it was already occupied. Two races came out of that, and both are silent:
 *
 *   a second send before the first is acknowledged   The second assignment orphans the first
 *     caller's promise. Nothing resolves it, so that caller waits out the hook timeout and
 *     reports "no UserPromptSubmit hook after send" -- a hook failure -- for a prompt the child
 *     accepted normally. The diagnosis names the hooks and `--settle`, and both are healthy.
 *
 *   a send while a turn is still open   Neither CLI accepts input mid-turn. The text is typed
 *     into a composer that is not taking input, so it is not queued behind the turn; it is
 *     spliced into it or dropped, and #117 records that this ends the run.
 *
 * Neither is reachable through the relay, which waits (`#awaitSendable`) -- and that is exactly
 * why they survived. `AgentSession` is a contract other callers hold too, the console among
 * them, and a guarantee that lives in one caller is not a guarantee of the session.
 *
 * The refusals also carry a load the watchdog puts on them: `#emit` refreshes the deadline of
 * THE open turn by the key it armed, which is only well defined while at most one turn is open.
 * That was a blanket `touchAll()` until these guards existed.
 *
 * What "open" means is the second half, and the first version of this guard got it wrong. It
 * asked `#liveTurns()`, which is defined by `tracker.settled` -- so a watchdog verdict, which is
 * this process concluding a turn is hung, was read as the CHILD having stopped. It is not
 * evidence of that at all: a `timed_out` turn may still be running, and it is the likeliest turn
 * in the session to be. The adapters now track transport openness separately -- opened by
 * `UserPromptSubmit`, closed by a `Stop`, a `SessionEnd`, the child exiting, or a completed
 * `cancel()` -- and both guards ask that instead.
 *
 * Real adapters over a fake child: see `fakeCli.ts`.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { AgentEvent, AgentSession } from '../contract/session.ts'
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

const { dir: RUN } = installFakeClis()

/**
 * Long enough that no clock fires during a test.
 *
 * These tests are about what `send()` refuses, and a deadline landing in the middle would
 * settle the open turn and quietly turn the second case into the first. Nothing here waits on
 * a deadline, so a large number costs nothing.
 */
const NO_DEADLINE_MS = 120_000

type Adapter = 'claude' | 'codex'

function start(agent: Adapter, clocks: { watchdogMs?: number; idleMs?: number } = {}): Promise<AgentSession> {
  const opts = {
    cwd: RUN,
    role: 'implementer' as const,
    watchdogMs: clocks.watchdogMs ?? NO_DEADLINE_MS,
    idleMs: clocks.idleMs ?? NO_DEADLINE_MS,
    readyTimeoutMs: 20_000,
  }
  return agent === 'claude' ? ClaudePtyHookAdapter.start(opts) : CodexPtyHookAdapter.start(opts)
}

/** Collect events until `done`, or give up. Returns what it saw either way. */
async function collect(
  session: AgentSession,
  done: (e: AgentEvent[]) => boolean,
  timeoutMs: number,
): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = []
  const deadline = Date.now() + timeoutMs
  const it = session.events()[Symbol.asyncIterator]()
  while (Date.now() < deadline) {
    let timer: NodeJS.Timeout | undefined
    const next = await Promise.race([
      it.next(),
      new Promise<'timeout'>((r) => {
        timer = setTimeout(() => r('timeout'), Math.max(0, deadline - Date.now()))
      }),
    ]).finally(() => clearTimeout(timer))
    if (next === 'timeout' || next.done) break
    seen.push(next.value)
    if (done(seen)) break
  }
  return seen
}

for (const agent of ['claude', 'codex'] as const) {
  test(`${agent}: a second send is refused while the first is unacknowledged`, async () => {
    const session = await start(agent)
    try {
      // NOT awaited. `#pendingPrompt` is claimed synchronously inside `send()` -- the promise
      // executor runs before the first `await` -- so this is the race exactly, without a sleep
      // and without depending on how fast the fake child acknowledges anything.
      const first = session.send('the first prompt', { kind: 'orchestrator' })
      await assert.rejects(
        session.send('the second prompt', { kind: 'orchestrator' }),
        /already in flight/,
        'a second send must be refused rather than overwriting the first caller’s promise',
      )
      // And the first one is unharmed: it still gets its turn key, which is the half that used
      // to be lost. Before the guard the winner was the SECOND send and the first waited out a
      // 30-60s hook timeout to be told the hooks were broken.
      const key = await first
      assert.ok(String(key).length > 0, 'the first send must still be acknowledged normally')
    } finally {
      await session.close()
    }
  })

  test(`${agent}: a send is refused while a turn is still open`, async () => {
    const session = await start(agent)
    try {
      // The fake CLI acknowledges the prompt and then never sends Stop, so this turn stays open
      // for the rest of the test -- the state a mid-turn send lands in.
      await session.send('hang please', { kind: 'orchestrator' })
      await collect(session, (e) => e.some((x) => x.type === 'turn_start'), 10_000)

      await assert.rejects(
        session.send('and another thing', { kind: 'orchestrator' }),
        /turn is already open/,
        'a send must not be typed into a turn that is still running',
      )
      // The refusal names the turn, because "which one" is the first thing the operator reading
      // this in a log will ask.
      await assert.rejects(session.send('again', { kind: 'orchestrator' }), /\(turn .+\)/)
    } finally {
      await session.close()
    }
  })

  test(`${agent}: a send after the turn ends is accepted, so the guard is not a wedge`, async () => {
    // The control, and the reason it matters more than the two above: a refusal that never
    // lifts is worse than the races it prevents. It would take one failed send to make a seat
    // unusable for the rest of the run, and nothing in a relay log would say why.
    process.env['ORCH_FAKE_STOP_MS'] = '150'
    const session = await start(agent)
    try {
      await session.send('do a thing', { kind: 'orchestrator' })
      const events = await collect(session, (e) => e.some((x) => x.type === 'turn_end'), 10_000)
      assert.ok(
        events.some((e) => e.type === 'turn_end'),
        'precondition: the first turn must have ended before the second send is attempted',
      )

      const key = await session.send('do another thing', { kind: 'orchestrator' })
      assert.ok(String(key).length > 0, 'a settled turn must leave the session sendable again')
    } finally {
      delete process.env['ORCH_FAKE_STOP_MS']
      await session.close()
    }
  })
}

for (const agent of ['claude', 'codex'] as const) {
  test(`${agent}: a send is refused after the watchdog fires, because a verdict is not a stop`, async () => {
    // The case the first version of this guard let through. The fake CLI acknowledges the
    // prompt and then never sends Stop, so the watchdog concludes `timed_out` -- and that
    // settles the tracker, which is what `#liveTurns()` was reading. Nothing about the child
    // changed: no Stop, no exit, no cancellation, and on a real CLI it may well still be
    // editing files. A send here is typed into a composer that is not accepting input.
    const session = await start(agent, { watchdogMs: 800, idleMs: 800 })
    try {
      await session.send('hang please', { kind: 'orchestrator' })
      const events = await collect(session, (e) => e.some((x) => x.type === 'turn_end'), 15_000)

      const end = events.find((e) => e.type === 'turn_end')
      assert.ok(end, 'precondition: the watchdog must have produced a verdict')
      assert.equal(end.verdict.outcome, 'timed_out')
      assert.equal(end.synthesized, true, 'precondition: nothing from the child said this')
      assert.ok(
        !events.some((e) => e.type === 'revision' && e.reason === 'late_signal'),
        'precondition: no late Stop arrived, so nothing observed the child stop',
      )

      await assert.rejects(
        session.send('are you there', { kind: 'orchestrator' }),
        /turn is already open/,
        'a deadline expiring is this process giving up, not the child stopping',
      )
    } finally {
      await session.close()
    }
  })

  test(`${agent}: a completed cancel reopens a timed-out session to sends`, async () => {
    // The escape, and the reason the rule above is not a wedge. A turn whose Stop is lost stays
    // open until something observes the child stop, and ESC is the one thing an orchestrator can
    // do about that. `Relay#awaitSendable` already reaches for exactly this call when a seat is
    // busy past its bound, so the recovery path is one the run already knows how to take.
    const session = await start(agent, { watchdogMs: 800, idleMs: 800 })
    try {
      await session.send('hang please', { kind: 'orchestrator' })
      await collect(session, (e) => e.some((x) => x.type === 'turn_end'), 15_000)
      await assert.rejects(session.send('too early', { kind: 'orchestrator' }), /turn is already open/)

      await session.cancel()

      const key = await session.send('after the cancel', { kind: 'orchestrator' })
      assert.ok(String(key).length > 0, 'a cancelled session must be sendable again')
    } finally {
      await session.close()
    }
  })
}
