/**
 * The step-4 checkpoint, against a real Claude Code session.
 *
 *   start -> ready -> send -> completed
 *   send  -> cancel -> cancelled
 *   hook loss -> transcript reconciliation recovers the completion
 *
 * These spawn real sessions and consume real quota, so they are opt-in:
 *
 *   ORCH_LIVE=1 node --test src/adapters/claude.live.test.ts
 *
 * Prompts ask for a COMPUTED token. Waiting for a literal that appears in the prompt is
 * satisfied instantly by the TUI echoing our own typing -- that mistake produced two
 * false passes during the spikes, once in step 1 and once in step 3.
 */

import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { ClaudePtyHookAdapter } from './claude.ts'
import type { AgentEvent, TurnEndEvent } from '../contract/session.ts'

const LIVE = process.env.ORCH_LIVE === '1'
const CWD = process.cwd()
const skip = LIVE ? false : 'set ORCH_LIVE=1 to run (spawns real sessions, uses quota)'

/** Collect events until `done` says so, or the timeout expires. */
async function collect(
  session: ClaudePtyHookAdapter,
  done: (events: AgentEvent[]) => boolean,
  timeoutMs: number,
): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = []
  const deadline = Date.now() + timeoutMs
  const it = session.events()[Symbol.asyncIterator]()
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const next = await Promise.race([
      it.next(),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), remaining)),
    ])
    if (next === 'timeout') break
    if (next.done) break
    seen.push(next.value)
    if (done(seen)) break
  }
  return seen
}

const endOf = (events: AgentEvent[]): TurnEndEvent | undefined =>
  events.find((e) => e.type === 'turn_end') as TurnEndEvent | undefined

test('start -> ready -> send -> completed', { skip }, async (t) => {
  const session = await ClaudePtyHookAdapter.start({ cwd: CWD, role: 'implementer' })
  t.after(() => session.close('graceful'))

  // Readiness and the ability to accept input are separate capabilities.
  assert.equal(session.isReady, true, 'SessionStart should have arrived')
  assert.equal(session.acceptsInput, true, 'the composer should be live')
  assert.ok(session.sessionId.length > 0, 'SessionStart should carry a session id')

  const collecting = collect(session, (e) => e.some((x) => x.type === 'turn_end'), 180_000)
  const key = await session.send(
    'Reply with exactly LIVE-N and nothing else, where N is 41 plus 1. No tools.',
    { kind: 'orchestrator' },
  )
  assert.ok(key, 'send() should resolve to a turn key from UserPromptSubmit')

  const events = await collecting
  const start = events.find((e) => e.type === 'turn_start')
  assert.ok(start, 'expected a turn_start')
  assert.equal(start.turnKey, key)

  const end = endOf(events)
  assert.ok(end, 'expected a turn_end')
  assert.equal(end.verdict.outcome, 'completed')
  assert.equal(end.verdict.confidence, 'proven', 'Stop is what proves completion')
  assert.equal(end.synthesized, false, 'the child announced this one')
  assert.ok(end.verdict.provenance.some((p) => p.source === 'hook' && p.detail === 'Stop'))

  const snap = await session.snapshot()
  assert.ok(snap.turns.length >= 1)
  assert.equal(snap.turns[0]!.state, 'completed')
  assert.equal(snap.guarantees.cancellationAttributable, true)
})

test('send -> cancel -> cancelled, and it is only ever assumed', { skip }, async (t) => {
  const session = await ClaudePtyHookAdapter.start({ cwd: CWD, role: 'implementer' })
  t.after(() => session.close('graceful'))

  const collecting = collect(session, (e) => e.some((x) => x.type === 'turn_end'), 180_000)
  const key = await session.send(
    'Count slowly from 1 to 500, one number per line. Do not stop early.',
    { kind: 'orchestrator' },
  )
  // Let it genuinely start working before interrupting.
  await new Promise((r) => setTimeout(r, 6000))
  const cancelled = await session.cancel()
  assert.equal(cancelled, key)

  const events = await collecting
  const end = endOf(events)
  assert.ok(end, 'expected a turn_end for the cancelled turn')
  assert.equal(end.verdict.outcome, 'cancelled')
  // Nothing in Claude Code records a cancellation -- not a hook, not the transcript.
  // The only evidence is our own input log, so the grade must stay `assumed`.
  assert.equal(end.verdict.confidence, 'assumed')
  assert.equal(end.synthesized, true)
  assert.ok(
    end.verdict.provenance.some((p) => p.source === 'orchestrator' && p.detail.includes('ESC')),
    'the verdict must cite the input record it rests on',
  )

  const cancelAction = session.inputLog.find((a) => a.kind === 'cancel')
  assert.ok(cancelAction, 'the input queue must record the semantic action, not just bytes')
  assert.equal(cancelAction.origin, 'orchestrator')
})

test('hook loss: a lost Stop is recovered from the transcript, not called a death', { skip }, async (t) => {
  const session = await ClaudePtyHookAdapter.start({ cwd: CWD, role: 'implementer' })
  t.after(() => session.close('graceful'))

  const started = collect(session, (e) => e.some((x) => x.type === 'turn_start'), 60_000)
  await session.send(
    'Reply with exactly LOSS-N and nothing else, where N is 20 plus 2. No tools.',
    { kind: 'orchestrator' },
  )
  await started

  // Kill the receiver the moment the turn is underway. The Stop hook will fire, fail to
  // deliver, and exit non-zero -- which spike 2 showed the UI surfaces but does not
  // block on. The delivery is gone for good; there is no upstream retry.
  await session.receiver.stop()

  // Wait for the answer on the PTY, which is transport evidence only.
  const answered = await session.pty.waitForOutput((all) => all.includes('LOSS-22'), 180_000)
  assert.ok(answered, 'the turn should still complete despite the receiver being down')
  await session.pty.waitQuiet(1500, 30_000)

  const journalled = session.receiver.journal.read()
  assert.ok(
    !journalled.some((d) => d.event === 'Stop'),
    'the Stop delivery must genuinely have been lost for this test to mean anything',
  )

  // Reconciliation happens on close. The turn must come back as completed with an
  // explicit caveat -- NOT as process_exited, which is what a naive shutdown would
  // conclude from "live turn + dead process".
  const finishing = collect(session, (e) => e.some((x) => x.type === 'turn_end'), 60_000)
  await session.close('graceful')
  const events = await finishing

  const end = endOf(events)
  assert.ok(end, 'expected a synthesized turn_end at close')
  assert.equal(end.verdict.outcome, 'completed')
  assert.notEqual(end.verdict.outcome, 'process_exited')
  assert.equal(end.synthesized, true, 'nothing announced this; we reconstructed it')
  assert.ok(
    end.verdict.provenance.some((p) => p.caveat && p.detail.includes('Stop hook never arrived')),
    'recovery must be visible in the provenance, not silently equivalent to a real Stop',
  )
})

test('abandoning the transport asserts nothing about the turn', { skip }, async (t) => {
  const session = await ClaudePtyHookAdapter.start({ cwd: CWD, role: 'implementer' })
  t.after(() => session.pty.terminate())

  const collecting = collect(session, (e) => e.some((x) => x.type === 'turn_end'), 120_000)
  await session.send('Count slowly from 1 to 500, one number per line.', { kind: 'orchestrator' })
  await new Promise((r) => setTimeout(r, 4000))

  await session.close('abandoned')
  const events = await collecting
  const end = endOf(events)
  assert.ok(end)
  assert.equal(end.verdict.outcome, 'transport_lost')
  assert.equal(end.verdict.confidence, 'uncertain')
  assert.ok(
    end.verdict.provenance.some((p) => p.caveat && p.detail.includes('may still be running')),
    'abandonment must not imply the child died',
  )
})

test('the hook client exists where the adapter registers it', () => {
  const client = new URL('../hooks/client.ts', import.meta.url).pathname
  assert.ok(existsSync(client), `hook client missing at ${client}`)
})

test('a participant constructed through the registry behaves identically', { skip }, async (t) => {
  // Proves the data-driven path actually works end to end. If participants can only be
  // built by calling the adapter directly, configuration cannot select agents later
  // without editing call sites.
  const { defaultRegistry } = await import('../registry/builtin.ts')
  const registry = defaultRegistry()

  const session = (await registry.createParticipant(
    { id: 'impl', agent: 'claude', role: 'implementer' },
    { cwd: CWD },
  )) as ClaudePtyHookAdapter
  t.after(() => session.close('graceful'))

  assert.equal(session.isReady, true)
  assert.equal(session.guarantees.inputOwnership, 'mediated')

  const collecting = collect(session, (e) => e.some((x) => x.type === 'turn_end'), 180_000)
  await session.send('Reply with exactly REG-N and nothing else, where N is 41 plus 1. No tools.', {
    kind: 'orchestrator',
  })
  const end = endOf(await collecting)
  assert.ok(end)
  assert.equal(end.verdict.outcome, 'completed')
  assert.equal(end.verdict.confidence, 'proven')

  const snap = await session.snapshot()
  assert.equal(snap.role, 'implementer', 'the role assignment must reach the snapshot')
})
