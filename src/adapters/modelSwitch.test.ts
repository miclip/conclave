/**
 * A seat reconfigured mid-run says so, because the run report cannot (#202).
 *
 * The report states the launch model as fact and #200's command policy refuses `/model` from the
 * advisor on exactly that ground: a mid-run switch does not update the report, it falsifies it.
 * That refusal covers the advisor and not the two doors it cannot reach -- a human typing into
 * the seat's own pane, and the seat switching itself.
 *
 * Claude Code dispatches `PreModelSwitch` and `PostModelSwitch` and the adapter registered
 * neither. Verified against the installed bundle (2.1.261) as quoted literals, then against a
 * live seat: typing `/model opus` into a session on sonnet delivered both, carrying
 * `from_model: "claude-sonnet-5"`, `to_model: "claude-opus-5"`, `requested_model: "opus"` and
 * `source: "command"`. Asking for the model already in force dispatches nothing.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { AgentEvent } from '../contract/session.ts'
import { ClaudePtyHookAdapter, HOOK_EVENTS } from './claude.ts'
import { installFakeClis } from './fakeCli.ts'
import { containAdapterRunDirs } from '../testkit/tempDir.ts'

containAdapterRunDirs()

const { dir: RUN } = installFakeClis()

async function seat(): Promise<{ adapter: ClaudePtyHookAdapter; seen: AgentEvent[] }> {
  const adapter = await ClaudePtyHookAdapter.start({
    cwd: RUN,
    role: 'advisor',
    readyTimeoutMs: 20_000,
  })
  const seen: AgentEvent[] = []
  void (async () => {
    for await (const e of adapter.events()) seen.push(e)
  })()
  return { adapter, seen }
}

test('#202 a mid-run model switch is reported against the record it falsifies', async () => {
  process.env['ORCH_FAKE_MODEL_SWITCH'] = 'claude-opus-5>claude-sonnet-5'
  const { adapter, seen } = await seat()
  try {
    await adapter.send('do something', { kind: 'orchestrator' })
    await new Promise((r) => setTimeout(r, 400))

    assert.deepEqual(
      adapter.reconfigured.map((r) => `${r.from}->${r.to}`),
      ['claude-opus-5->claude-sonnet-5'],
      'the switch is recorded beside the launch record it contradicts',
    )
    const err = seen.find((e) => e.type === 'error')
    assert.ok(err, `the operator is told: ${JSON.stringify(seen.map((e) => e.type))}`)
    assert.equal('fatal' in err ? err.fatal : undefined, false, 'the seat is fine; the RECORD is what is wrong')
    assert.match('message' in err ? err.message : '', /no longer running the model the run report names/)
    assert.match('message' in err ? err.message : '', /claude-opus-5 -> claude-sonnet-5/)
  } finally {
    delete process.env['ORCH_FAKE_MODEL_SWITCH']
    await adapter.close()
  }
})

test('#202 a seat nobody reconfigured says nothing', async () => {
  // The quiet default. A run that switched no models must produce no such event, or the signal
  // stops meaning anything.
  const { adapter, seen } = await seat()
  try {
    await adapter.send('do something', { kind: 'orchestrator' })
    await new Promise((r) => setTimeout(r, 400))
    assert.deepEqual(adapter.reconfigured, [])
    assert.equal(seen.find((e) => e.type === 'error'), undefined)
  } finally {
    await adapter.close()
  }
})

test('#202 a switch to the model already in force is not a switch', async () => {
  // Guarding a payload shape rather than an observed case: the live CLI dispatches nothing when
  // asked for the model it is already on, verified by asking twice. If that ever changes, a
  // report should not gain a line saying a seat moved from a model to itself.
  process.env['ORCH_FAKE_MODEL_SWITCH'] = 'claude-opus-5>claude-opus-5'
  const { adapter, seen } = await seat()
  try {
    await adapter.send('do something', { kind: 'orchestrator' })
    await new Promise((r) => setTimeout(r, 400))
    assert.deepEqual(adapter.reconfigured, [])
    assert.equal(seen.find((e) => e.type === 'error'), undefined)
  } finally {
    delete process.env['ORCH_FAKE_MODEL_SWITCH']
    await adapter.close()
  }
})

test('#202 the switch events are registered, because the stand-in posts them either way', () => {
  // WHAT THE TESTS ABOVE CANNOT SEE. The fake CLI posts to the hook receiver directly, so they
  // pass whether or not the adapter ever asked Claude Code to send these. In production
  // registration is the whole thing: an unregistered event is never dispatched, the handler
  // never runs, and a seat is reconfigured in silence exactly as #202 describes.
  //
  // A mutation removing all three from `HOOK_EVENTS` left every other test in this file green.
  for (const event of ['PreModelSwitch', 'PostModelSwitch', 'ConfigChange']) {
    assert.ok(HOOK_EVENTS.includes(event), `${event} must be registered or it is never dispatched`)
  }
})
