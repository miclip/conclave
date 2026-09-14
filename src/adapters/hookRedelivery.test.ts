/**
 * The same prompt hook delivered twice is one prompt. #300, #302.
 *
 *   node --test src/adapters/hookRedelivery.test.ts
 *
 * Both #300 runs show every implementer `UserPromptSubmit` arriving twice -- same `prompt_id`,
 * byte-identical text, 65-94 ms apart -- because the seat had two registrations of the same
 * hook and Claude Code runs both (#302). On an ordinary send the second delivery found the
 * pending claim already resolved, called itself `unsolicited`, and was charged as a turn. On a
 * `/goal` it found `#rawSubmissions` already consumed, compared the command against the
 * instruction in flight, and refused the send as corrupt; the recovery then waited on a `Stop`
 * the command's turn was never going to give it, and the run ended `transport_failed` on work
 * that had succeeded.
 *
 * `ORCH_FAKE_DOUBLE_HOOKS` is that shape, without a second registration: the stand-in posts
 * each prompt hook twice, chained, so the second always lands after the first has consumed
 * whatever was held for it. The #207 test next door covers the ORDER of a command's echo; this
 * covers its MULTIPLICITY, and the two are independent defects with one crash between them.
 *
 * INDEPENDENT OF THE FIX AT SOURCE, deliberately. The double registration itself is closed by
 * the stand-aside in `#boot` / `runHookClient` -- and that closure runs in whatever `conclave`
 * a project's PATH resolves, so a project still on an older release keeps posting twice until
 * it is upgraded. What this file exercises is the dedup that absorbs a double from ANY cause,
 * that window included: the stand-in reads no settings layer, runs no project hook and
 * resolves nothing on PATH, so `ORCH_PINNED_HOOKS` and the stand-aside play no part here. A
 * mutation that disables the dedup fails these tests with the stand-aside fully intact, which
 * is the proof that they are two mechanisms and not one with two names.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import type { AgentEvent, TurnStartEvent } from '../contract/session.ts'
import { ClaudePtyHookAdapter } from './claude.ts'
import { CodexPtyHookAdapter } from './codex.ts'
import { installFakeClis } from './fakeCli.ts'
import { containAdapterRunDirs } from '../testkit/tempDir.ts'

containAdapterRunDirs()

const { dir: RUN } = installFakeClis()
process.env['ORCH_FAKE_DOUBLE_HOOKS'] = '1'
// Turns end, so the session can take more than one send and the test reads settled state.
process.env['ORCH_FAKE_STOP_MS'] = '150'

/** What the advisor asked for in the second #300 run, and the instruction it sent behind it. */
const COMMAND = '/goal Do not stop until both full npm test runs finish; if both are green, commit and report'
const ADVISOR = `[FROM THE ADVISOR (advisor) — a peer AI model, not your user.]

Remain attached to the chained verification through its terminal results, then complete the
commit and final checks; do not send another interim report while the runs are merely progressing.`

const starts = (seen: AgentEvent[]) => seen.filter((e) => e.type === 'turn_start') as TurnStartEvent[]

/** Wait until the stream has settled: no new event for `quietMs`, or `limitMs` overall. */
async function settle(seen: AgentEvent[], quietMs = 400, limitMs = 10_000): Promise<void> {
  const until = Date.now() + limitMs
  let last = seen.length
  let quietSince = Date.now()
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50))
    if (seen.length !== last) {
      last = seen.length
      quietSince = Date.now()
    } else if (Date.now() - quietSince >= quietMs) return
  }
}

for (const [agent, start] of [
  ['claude', () => ClaudePtyHookAdapter.start({ cwd: RUN, role: 'implementer', watchdogMs: 600_000, readyTimeoutMs: 20_000 })],
  ['codex', () => CodexPtyHookAdapter.start({ cwd: RUN, role: 'implementer', watchdogMs: 600_000, readyTimeoutMs: 20_000 })],
] as const) {
  test(`#300 ${agent}: a command's echo delivered twice does not corrupt the send behind it, and opens one turn`, async () => {
    const session = await start()
    const seen: AgentEvent[] = []
    const reading = (async () => {
      for await (const e of session.events()) seen.push(e)
    })()

    try {
      // The relay's order in both incidents: the command between turns, the instruction 4 ms
      // behind it, and the command's two echoes landing while that send holds its claim.
      await session.submitRaw(COMMAND, 'advisor command via advisor')
      let timer: NodeJS.Timeout | undefined
      const outcome = await Promise.race([
        session.send(ADVISOR, { kind: 'peer_relay' }).then(
          () => 'sent' as const,
          (e: unknown) => `rejected: ${e instanceof Error ? `${e.constructor.name}: ${e.message.slice(0, 200)}` : String(e)}`,
        ),
        new Promise<string>((r) => {
          timer = setTimeout(() => r('NEVER SETTLED within 45s'), 45_000)
        }),
      ]).finally(() => clearTimeout(timer))
      assert.equal(outcome, 'sent', `the send must succeed; instead: ${outcome}`)
      await settle(seen)

      const opened = starts(seen)
      const commandTurns = opened.filter((e) => e.prompt.trim() === COMMAND)
      const instructionTurns = opened.filter((e) => e.prompt.includes('Remain attached to the chained verification'))
      assert.equal(commandTurns.length, 1, `the command opens exactly one turn; saw ${commandTurns.length}`)
      assert.equal(instructionTurns.length, 1, `the instruction opens exactly one turn; saw ${instructionTurns.length}`)
      // Neither is the seat acting on its own. Before the fix the second delivery of each was
      // emitted `unsolicited`, and the relay charged it to `--max-turns` as a turn of work (#208).
      assert.deepEqual(
        opened.map((e) => e.unsolicited ?? false),
        opened.map(() => false),
        `no turn_start may be unsolicited: ${JSON.stringify(opened.map((e) => [e.prompt.slice(0, 24), e.unsolicited]))}`,
      )
    } finally {
      await session.close('graceful')
      await reading
    }
  })

  test(`#302 ${agent}: an ordinary prompt delivered twice is one turn, not a real one plus an unsolicited one`, async () => {
    const session = await start()
    const seen: AgentEvent[] = []
    const reading = (async () => {
      for await (const e of session.events()) seen.push(e)
    })()

    try {
      const key = await session.send('Carry on with the failing test.', { kind: 'peer_relay' })
      await settle(seen)
      const opened = starts(seen)
      assert.deepEqual(
        opened.map((e) => [String(e.turnKey), e.unsolicited ?? false]),
        [[String(key), false]],
        'one send, one turn_start, carrying the key the send returned and no unsolicited mark',
      )
      // And one end for it: the second delivery must not have rebuilt the turn under the first
      // Stop, which is #255's silent half -- a fresh TurnState mid-turn, tools and clock reset.
      const ends = seen.filter((e) => e.type === 'turn_end')
      assert.equal(ends.length, 1, `one turn ends once; saw ${ends.length}`)
    } finally {
      await session.close('graceful')
      await reading
    }
  })
}
