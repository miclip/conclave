/**
 * A slash command's echo is not the echo of our send. #207.
 *
 * `submitRaw` types a command into the same composer a prompt goes into, and Claude Code
 * dispatches its ordinary `UserPromptSubmit` hook for it -- documented as a possibility on
 * `submitRaw` and then confirmed the first time an advisor ever issued one live.
 *
 * The command is submitted BETWEEN turns, so the instruction that follows goes out behind it
 * and the command's echo can land while that send is in flight. The adapter correlated it
 * against the send, found a 130-byte command and a 902-byte envelope sharing no prefix and no
 * suffix, and threw `CorruptedPromptError` -- killing the process, on the one run that had ever
 * exercised the path.
 *
 * It is the #185 mechanism with a different intruder, and the intruder here is us rather than
 * the harness. The ordering is again the whole defect, so `ORCH_FAKE_DEFER_SLASH` holding the
 * command's echo until the next prompt reproduces it exactly and without a live seat.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import type { AgentEvent, TurnStartEvent } from '../contract/session.ts'
import { ClaudePtyHookAdapter } from './claude.ts'
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
const ADAPTER_TMP_ROOT = containAdapterRunDirs()

const { dir: RUN } = installFakeClis()
process.env['ORCH_FAKE_DEFER_SLASH'] = '1'

/** What the advisor actually asked for in the run that crashed, and what it was carrying. */
const COMMAND = '/goal Migrate every test temp-directory creation to the existing helper'
const ADVISOR = `[FROM THE ADVISOR (advisor) — a peer AI model, not the operator]

Migrate all test and fixture files to the helper, delegating disjoint batches if useful.
Report the changed files and a residual search when you are done.`

test('#207 a command’s echo arriving mid-send is not mistaken for the echo of that send', async () => {
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
    // Exactly the relay's order: the command between turns, then the instruction behind it.
    await session.submitRaw(COMMAND, 'advisor command via advisor')

    // Before the fix this rejects with CorruptedPromptError, naming the command as the thing
    // that "arrived" -- a transport fault that never happened, on a send that was never damaged.
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

    // The command still opens its own turn. The child really did take it, and saying otherwise
    // would put a lie in the transcript -- the fix is about what the echo is MATCHED against,
    // never about hiding it.
    const starts = seen.filter((e) => e.type === 'turn_start') as TurnStartEvent[]
    assert.ok(
      starts.some((e) => e.prompt.trim() === COMMAND),
      `the command must still open a turn of its own; saw ${JSON.stringify(starts.map((e) => e.prompt.slice(0, 40)))}`,
    )
    // And the instruction's turn is recorded against the INSTRUCTION, which is the half that
    // was wrong in the incident: the run's last turn_start carried the command's text.
    assert.ok(
      starts.some((e) => e.prompt.includes('Migrate all test and fixture files')),
      'the send must open a turn recorded against the instruction, not against the command',
    )
  } finally {
    await session.close('graceful')
    await reading
  }
})
