/**
 * The send-landed check, against the incident it was written for (#120).
 *
 *   node --test src/adapters/claudeSendLanded.test.ts
 *
 * `send()` verifies that the text it typed became a PROMPT, because `#input.submit()`
 * resolving only means this process wrote bytes to a pty. The check used to ask whether the
 * child's transcript had grown by a turn since the send. That is a weaker claim than it looks,
 * and in the condition the check exists for it is the wrong one.
 *
 * The condition is a prior turn that ended UNCERTAIN and is in fact still generating. Neither
 * CLI accepts input mid-turn, so the new prompt is swallowed -- and the turn already running
 * goes on writing to the transcript while that happens. A turn-count check sees the growth and
 * reports the send as landed: no repair is attempted, no hook ever arrives, and the run is told
 * the child accepted text it never saw.
 *
 * The growth is not hypothetical. Counted over this machine's own Claude Code transcripts, 86
 * of 183 string-content `user` records in one real session -- 47% -- were not prompts anybody
 * typed: `<task-notification>`, `<command-name>`, `<local-command-stdout>`, `Caveat:`. Every
 * one of them is a new turn to `parseClaude`, and any one of them landing inside the six-second
 * verification window satisfied the old check on its own.
 *
 * So the check now matches the PROMPT TEXT. The same count found zero string-content `user`
 * records with leading or trailing whitespace, which is what makes exact equality the right
 * comparison rather than a fuzzy one: Claude Code stores the typed text verbatim.
 *
 * The fake CLI below is the incident: it swallows what is typed at it while its transcript
 * advances anyway, and lands the prompt only when told to. No agent binary is spawned and no
 * quota is used.
 */

import { strict as assert } from 'node:assert'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { ClaudePtyHookAdapter } from './claude.ts'
import { COMPOSER_JS } from './fakeCli.ts'
import { suiteTempDir, tempDir } from '../testkit/tempDir.ts'

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

/**
 * Stands in for `claude` on PATH: a child mid-turn, swallowing input, transcript still moving.
 *
 * Extensionless and shebanged, so Node runs it as CJS. It seeds a prior turn that never ends --
 * a `tool_use` stop reason and no `end_turn` -- and then, for every prompt it SWALLOWS, appends
 * a `<task-notification>` record of the kind a real session accumulates while it works. That
 * record is a new turn to the parser and is not the prompt, which is the whole false positive
 * in one line.
 *
 * `ORCH_FAKE_LAND_AT=n` makes the nth submit land for real: the prompt goes into the transcript
 * verbatim and `UserPromptSubmit` is posted. `0` never lands.
 */
const FAKE_CLI = `#!/usr/bin/env node
const fs = require('fs')
const url = process.env.ORCH_HOOK_URL
const transcript = process.env.ORCH_FAKE_TRANSCRIPT
const submitLog = process.env.ORCH_FAKE_SUBMIT_LOG
const landAt = Number(process.env.ORCH_FAKE_LAND_AT || 0)

function post(event, extra) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-orch-agent': 'claude', 'x-orch-event': event },
    body: JSON.stringify(Object.assign({ hook_event_name: event, session_id: 'fake-session' }, extra)),
  }).catch(function () {})
}

function append(record) {
  fs.appendFileSync(transcript, JSON.stringify(record) + '\\n')
}

// The prior turn, still generating: a tool call outstanding and no end_turn behind it.
append({ type: 'user', sessionId: 'fake-session', message: { role: 'user', content: 'the earlier instruction' } })
append({
  type: 'assistant',
  message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 600' } }] },
})

// Bracketed paste: what PtyProcess reads as "a real interactive raw-mode UI", and what
// InputQueue.submit() frames its payloads with. COMPOSER_JS implements the other half --
// without it this stand-in would record the framing as part of the prompt and the exact-match
// check below would fail for a reason that has nothing to do with a swallowed send.
process.stdout.write('\\x1b[?2004h')
${COMPOSER_JS}
let submits = 0
onComposerSubmit(function (prompt) {
  // A bare Enter at an empty composer does nothing at all, which is exactly what the first
  // repair is betting on when the composer might have held the text.
  if (!prompt.trim()) return
  submits += 1
  fs.appendFileSync(submitLog, JSON.stringify(prompt) + '\\n')
  if (landAt > 0 && submits >= landAt) {
    const id = 'fake-turn-' + submits
    append({ type: 'user', sessionId: 'fake-session', message: { role: 'user', content: prompt } })
    post('UserPromptSubmit', { prompt_id: id, turn_id: id, prompt: prompt })
  } else {
    // Swallowed. The keystrokes never became a prompt -- and the transcript grows anyway,
    // because the turn already running is what is writing to it.
    append({
      type: 'user',
      sessionId: 'fake-session',
      message: { role: 'user', content: '<task-notification>\\n<task-id>bg-' + submits + '</task-id>\\n</task-notification>' },
    })
  }
})

post('SessionStart', { transcript_path: transcript })
setInterval(function () {}, 1 << 30)
`

const RUN = suiteTempDir('orch-send-landed')
writeFileSync(join(RUN, 'claude'), FAKE_CLI)
chmodSync(join(RUN, 'claude'), 0o755)

// This file runs in its own process under `node --test`, so shadowing the real CLI on PATH
// cannot leak into any other suite.
process.env['PATH'] = `${RUN}:${process.env['PATH'] ?? ''}`

/** The text under test. Single-line, because the fake CLI splits its stdin on newlines. */
const MESSAGE = 'apply the change we agreed on'

/**
 * One session per test, with its own transcript and its own record of what was typed at it.
 *
 * `watchdogMs` is far above anything these tests wait for: a deadline firing mid-send would
 * end the turn under the assertions and prove something else entirely.
 */
async function session(
  t: TestContext,
  landAt: number,
): Promise<{
  claude: ClaudePtyHookAdapter
  submitted: () => string[]
  turns: () => number
  injected: () => number
}> {
  const dir = tempDir(t, 'orch-send-landed-run')
  const transcript = join(dir, 'transcript.jsonl')
  const submitLog = join(dir, 'submits.log')
  writeFileSync(transcript, '')
  writeFileSync(submitLog, '')
  process.env['ORCH_FAKE_TRANSCRIPT'] = transcript
  process.env['ORCH_FAKE_SUBMIT_LOG'] = submitLog
  process.env['ORCH_FAKE_LAND_AT'] = String(landAt)
  const claude = await ClaudePtyHookAdapter.start({
    cwd: dir,
    role: 'implementer',
    watchdogMs: 300_000,
    readyTimeoutMs: 30_000,
  })
  const lines = (path: string): string[] => readFileSync(path, 'utf8').split('\n').filter(Boolean)
  const records = (): Record<string, any>[] => lines(transcript).map((l) => JSON.parse(l) as Record<string, any>)
  const prompts = (): string[] =>
    records()
      .filter((r) => r['type'] === 'user' && typeof r['message']?.content === 'string')
      .map((r) => String(r['message'].content))
  return {
    claude,
    submitted: () => lines(submitLog).map((l) => JSON.parse(l) as string),
    // Turns as `parseClaude` counts them: a string-content `user` record and nothing else.
    turns: () => prompts().length,
    // The turns that are NOT this prompt -- the growth the old check mistook for an arrival.
    injected: () => prompts().filter((c) => c !== MESSAGE && c !== 'the earlier instruction').length,
  }
}

/** What the adapter says it did, in order. The repair steps stamp their own reasons. */
const repairs = (claude: ClaudePtyHookAdapter): string[] =>
  claude.inputLog.filter((a) => a.kind === 'submit').map((a) => a.detail ?? '')

/**
 * The repair runs, and it runs because the transcript grew WITHOUT this prompt in it.
 *
 * Under the old turn-count check the first verification passes on the `<task-notification>`
 * the swallowed submit produced, `send()` never repairs anything, and it returns nothing until
 * the 30s hook timeout -- reported as a hook failure, which is what #120 cost two runs to.
 *
 * Two independent witnesses to the re-submit: what the adapter recorded typing, and what the
 * child recorded receiving. The first alone would prove only that this process wrote bytes,
 * which is the exact claim `send()` exists to stop trusting.
 */
test('a swallowed send is repaired even while the transcript is advancing without it', { timeout: 120_000 }, async (t) => {
  // Land on the second submit: the re-type, after the bare Enter has come back empty-handed.
  const { claude, submitted, turns, injected } = await session(t, 2)
  try {
    const before = turns()
    const key = await claude.send(MESSAGE, { kind: 'orchestrator' })
    assert.ok(String(key).length > 0, 'the repaired send must return the turn the hook keyed')

    assert.deepEqual(
      submitted(),
      [MESSAGE, MESSAGE],
      'the child must have received the text twice: one swallowed send and one full re-submit',
    )
    assert.deepEqual(
      repairs(claude),
      [MESSAGE.slice(0, 120), 'bare Enter: prompt had not reached the transcript', 're-typed: composer was empty after bare Enter'],
      'and the adapter must have escalated in that order, weakest repair first',
    )

    // The precondition, asserted rather than assumed: the transcript DID advance while the
    // prompt was being swallowed, and it advanced with turns that are not this prompt. Without
    // this the test would pass against the old check too, and prove nothing.
    assert.ok(injected() >= 1, 'a swallowed submit must have produced a turn that is not the prompt')
    assert.ok(turns() > before, 'the transcript must have grown across the send')
  } finally {
    await claude.close()
  }
})

/**
 * And when the prompt never lands, the diagnosis is the one that names the real cause.
 *
 * The distinction is the whole point of the check: a hook that did not fire and text that was
 * never accepted have different remedies, and the old message sent an operator to `--settle`
 * and `conclave config check` -- the two things demonstrably working.
 */
test('a send that never becomes a prompt is reported as swallowed input, not as a hook failure', { timeout: 120_000 }, async (t) => {
  const { claude, submitted, injected } = await session(t, 0)
  try {
    await assert.rejects(
      () => claude.send(MESSAGE, { kind: 'orchestrator' }),
      (e: Error) => {
        assert.match(e.message, /never became a prompt/)
        assert.match(e.message, /swallowed input rather than a hook failure/)
        assert.match(e.message, /`conclave config check` and `--settle` will not help/)
        // The half an operator acts on: there is nothing to recover, so nothing to look for.
        assert.match(e.message, /The turn was not started, so no work was lost\./)
        assert.ok(!/the prompt IS in the child's transcript/.test(e.message), 'that is the other failure')
        return true
      },
    )
    assert.deepEqual(
      submitted(),
      [MESSAGE, MESSAGE],
      'both repairs must have been attempted before the run is told the send failed',
    )
    assert.deepEqual(
      repairs(claude),
      [MESSAGE.slice(0, 120), 'bare Enter: prompt had not reached the transcript', 're-typed: composer was empty after bare Enter'],
      'three submits and no fourth: the run gives up rather than typing at the child forever',
    )
    assert.ok(injected() >= 2, 'the transcript advanced on both swallowed submits, and still did not count')
  } finally {
    await claude.close()
  }
})
