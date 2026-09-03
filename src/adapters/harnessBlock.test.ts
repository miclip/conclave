/**
 * A harness block is not the echo of our send. #185.
 *
 * Claude Code delivers its own blocks into the child -- `<task-notification>` when a background
 * task completes, `<system-reminder>` for injected context. Each one is a real prompt the child
 * really works on, so it raises a real `UserPromptSubmit` and opens a real turn.
 *
 * The adapter correlated whatever `UserPromptSubmit` arrived next against the send it was
 * waiting on. When a background task finished mid-send, the block's echo arrived first, the
 * fidelity check compared the advisor's envelope against it, found they shared nothing, and
 * refused the send. Two unattended overnight runs died that way -- the seat's committed work
 * survived, the remaining queue did not.
 *
 * The block is neither the operator's message nor the seat's reply. It is the harness talking
 * to the child, and matching one against an open send is the bug.
 *
 * #185 said this needed a live seat and a background task completing at the right moment. It
 * does not: the ordering is the whole mechanism, so a stand-in that posts the block's echo
 * BEFORE the real one reproduces it exactly and for free.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import type { AgentEvent, TurnStartEvent } from '../contract/session.ts'
import { ClaudePtyHookAdapter } from './claude.ts'
import { installFakeClis } from './fakeCli.ts'
import { isHarnessBlock } from './promptFidelity.ts'
import { suiteTempDir } from '../testkit/tempDir.ts'

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
const ADAPTER_TMP_ROOT = suiteTempDir('adapter-run-root')
process.env['TMPDIR'] = ADAPTER_TMP_ROOT

const { dir: RUN } = installFakeClis()
process.env['ORCH_FAKE_HARNESS_BLOCK'] = '1'

/** The shape of a real advisor envelope, which is what was in flight in both incidents. */
const ADVISOR = `[FROM THE ADVISOR (advisor) — a peer AI model, not the operator]

Read src/relay/relay.ts and report what #assign does when the seat has no worktree. Do not
change anything yet; I want the reading before the edit.`

test('#185 a task-notification arriving mid-send is not mistaken for the echo of that send', async () => {
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
    // The send must SUCCEED. Before the fix this rejects with CorruptedPromptError, naming the
    // task-notification as what "arrived" -- a transport fault that never happened.
    let timer: NodeJS.Timeout | undefined
    const outcome = await Promise.race([
      session.send(ADVISOR, { kind: 'peer_relay' }).then(
        () => 'sent' as const,
        (e: unknown) => `rejected: ${e instanceof Error ? e.constructor.name + ': ' + e.message.slice(0, 160) : String(e)}`,
      ),
      new Promise<string>((r) => {
        timer = setTimeout(() => r('NEVER SETTLED within 45s'), 45_000)
      }),
    ]).finally(() => clearTimeout(timer))
    assert.equal(outcome, 'sent', `the send must succeed; instead: ${outcome}`)

    const starts = seen.filter((e) => e.type === 'turn_start') as TurnStartEvent[]

    // The block still opens its own turn. The child really is working on it, and saying
    // otherwise would put a lie in the transcript -- the fix is about what the block is
    // CORRELATED with, not about hiding it.
    assert.ok(
      starts.some((s) => s.prompt.startsWith('<task-notification>')),
      `the harness block must still be reported as its own turn: ${JSON.stringify(starts.map((s) => s.prompt.slice(0, 40)))}`,
    )

    // And our prompt is the one the send resolved against.
    assert.ok(
      starts.some((s) => s.prompt.startsWith('[FROM THE ADVISOR')),
      'the advisor prompt must have reached the child as its own turn',
    )
  } finally {
    await session.close('abandoned')
    await reading
  }
})

test('#185 only a block that IS a harness message is exempt, not one that mentions one', () => {
  assert.ok(isHarnessBlock('<task-notification>\n<task-id>x</task-id>\n</task-notification>'))
  assert.ok(isHarnessBlock('<system-reminder>the user changed a file</system-reminder>'))
  // Leading whitespace is still the harness talking; the tag is what identifies it.
  assert.ok(isHarnessBlock('\n  <task-notification>x</task-notification>'))

  // The exemption is the reason NOT to run the fidelity check, so anything that widens it
  // widens a hole in #174. A message that quotes a notification is still a message somebody
  // sent, and a corrupted copy of it must still be caught.
  assert.equal(
    isHarnessBlock('Please look at this: <task-notification>...</task-notification> and explain it'),
    false,
    'a prompt that MENTIONS a block is not a block, and must still be checked against what was sent',
  )
  assert.equal(isHarnessBlock('[FROM THE ADVISOR (advisor)] read relay.ts'), false)
  assert.equal(isHarnessBlock(''), false)
})
