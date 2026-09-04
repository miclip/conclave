/**
 * OpenCodeApiAdapter against a real `opencode serve`, through the registry.
 *
 * Built with `registry.createParticipant` rather than by calling the adapter, for the reason
 * `codex.live.test.ts` gives: the registry is where launch args are resolved, the model is lifted
 * out of them and the model name is judged against `opencode models`. An adapter constructed
 * directly would skip all three, which is exactly the seam #221 was a defect in.
 *
 *   ORCH_LIVE_OPENCODE=1 node --test src/adapters/opencodeApi/opencodeApi.live.test.ts
 *
 * The unit tests prove the model is put in the prompt body in the shape a probe said the API
 * wants. Only this proves the server AGREES -- a wrong shape is a 400 the fake would never make.
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import type { AgentEvent, TurnEndEvent } from '../../contract/session.ts'
import { defaultRegistry } from '../../registry/builtin.ts'
import type { OpenCodeApiAdapter } from './adapter.ts'

const CWD = process.cwd()
const skip =
  process.env.ORCH_LIVE_OPENCODE === '1'
    ? false
    : 'set ORCH_LIVE_OPENCODE=1 (spawns a real opencode server, uses quota)'

/** A model this install actually offers, so a refusal means the SHAPE was wrong, not the name. */
function installedModel(): string {
  const out = execFileSync('opencode', ['models'], { encoding: 'utf8', timeout: 60_000 })
  const first = out
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.includes('/'))
  assert.ok(first, `opencode models named nothing usable: ${out.slice(0, 200)}`)
  return first
}

async function seat(args: string[]): Promise<OpenCodeApiAdapter> {
  const session = await defaultRegistry().createParticipant(
    { id: 'implementer', agent: 'opencode', role: 'implementer', args },
    { cwd: CWD },
  )
  return session as OpenCodeApiAdapter
}

test('#221 a model set in launch args is accepted by the real server', { skip }, async (t) => {
  // The whole probe-derived claim, checked against the thing it was probed from. `prompt_async`
  // refuses a `model` string with 400; if `splitModel` were wrong in any other way the turn would
  // fail here rather than in a fake that echoes whatever it is sent.
  const model = installedModel()
  const adapter = await seat(['--model', model, '--not-a-real-flag'])
  t.after(async () => {
    await adapter.close('graceful')
  })

  const notice = (adapter.startupNotices ?? []).join('\n')
  assert.ok(notice.includes('--not-a-real-flag'), `the undeliverable arg is named: ${notice}`)
  assert.ok(!notice.includes(model), `the model is NOT reported as dropped, it is used: ${notice}`)

  const seen: AgentEvent[] = []
  const reading = (async () => {
    for await (const e of adapter.events()) seen.push(e)
  })()

  // A COMPUTED answer, for the reason the other live tests give: a literal from the prompt is
  // satisfied by an echo, and this transport echoes the prompt back as part of the message.
  await adapter.send('Reply with only the number that is 6 multiplied by 7. No other words.', { kind: 'orchestrator' })

  const deadline = Date.now() + 180_000
  while (Date.now() < deadline && !seen.some((e) => e.type === 'turn_end')) {
    await new Promise((r) => setTimeout(r, 500))
  }

  const end = seen.find((e) => e.type === 'turn_end') as TurnEndEvent | undefined
  assert.ok(end, `the turn ended within 180s; saw ${JSON.stringify(seen.map((e) => e.type))}`)
  assert.equal(end.verdict.outcome, 'completed', `the server accepted the model: ${JSON.stringify(end.verdict)}`)

  const text = seen
    .filter((e): e is Extract<AgentEvent, { type: 'message' }> => e.type === 'message')
    .map((e) => e.text)
    .join(' ')
  assert.match(text, /42/, `the model answered, so it really ran: ${text.slice(0, 400)}`)

  await adapter.close('graceful')
  await reading
})
