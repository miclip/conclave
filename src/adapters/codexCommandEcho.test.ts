/**
 * A slash command's echo is not the echo of our send — on the OTHER pty adapter. #216.
 *
 * This is #207 again, and that is the point of the file existing separately. The Claude adapter
 * was fixed; the Codex adapter has the same `submitRaw`, the same `UserPromptSubmit` turn open,
 * and the same `describePromptMismatch` correlation — and had neither the raw-echo exemption
 * (#207) nor the harness-block one (#185). It was *less* protected than Claude had been before
 * the crash that motivated the fix.
 *
 * A fix reaching one copy of shared logic and not the other has now happened three times: #185,
 * #207, and this. The guard is duplicated here deliberately rather than trusted to stay in sync,
 * because "the other adapter does it too" is exactly the assumption that failed twice.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { AgentEvent, TurnStartEvent } from '../contract/session.ts'
import { CodexPtyHookAdapter } from './codex.ts'
import { installFakeClis } from './fakeCli.ts'

const { dir: RUN } = installFakeClis()
process.env['ORCH_FAKE_DEFER_SLASH'] = '1'

const COMMAND = '/review'
const ADVISOR = `[FROM THE ADVISOR (advisor) — a peer AI model, not the operator]

Look over what is in the tree and report what you find. Do not change anything yet.`

test('#216 a command’s echo arriving mid-send is not mistaken for the echo of that send', async () => {
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
    // The relay's order: the command between turns, the instruction behind it.
    await session.submitRaw(COMMAND, 'advisor command via advisor')

    let timer: NodeJS.Timeout | undefined
    const outcome = await Promise.race([
      session.send(ADVISOR, { kind: 'peer_relay' }).then(
        () => 'sent' as const,
        (e: unknown) => `rejected: ${e instanceof Error ? `${e.constructor.name}: ${e.message.slice(0, 160)}` : String(e)}`,
      ),
      new Promise<string>((r) => {
        timer = setTimeout(() => r('NEVER SETTLED within 45s'), 45_000)
      }),
    ]).finally(() => clearTimeout(timer))
    assert.equal(outcome, 'sent', `the send must succeed; instead: ${outcome}`)

    // The command still opens its own turn. The fix is about what the echo is MATCHED against,
    // never about hiding that the child took it.
    const starts = seen.filter((e) => e.type === 'turn_start') as TurnStartEvent[]
    assert.ok(
      starts.some((e) => e.prompt.trim() === COMMAND),
      `the command must still open a turn of its own; saw ${JSON.stringify(starts.map((e) => e.prompt.slice(0, 40)))}`,
    )
    assert.ok(
      starts.some((e) => e.prompt.includes('Look over what is in the tree')),
      'and the send must open a turn recorded against the instruction, not against the command',
    )
  } finally {
    await session.close('graceful')
    await reading
  }
})
