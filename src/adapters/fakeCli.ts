import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A stand-in for `claude` / `codex` on PATH, for tests that need a REAL adapter over a fake
 * child.
 *
 * Not gated behind ORCH_LIVE: no agent binary is spawned and no quota is used. The adapters
 * themselves are entirely real -- pty, HookReceiver, hook decoding, transcript tailing -- and
 * only the child is a stand-in, because the conditions worth testing here (a hang, a swallowed
 * send, a rewritten transcript) are exactly the ones a well-behaved CLI will not produce, and
 * waiting out a real one costs quota to learn nothing.
 *
 * Lives outside a `.test.ts` file because more than one suite needs it and the alternative is
 * two copies of a shell script drifting apart. `src/rotation/fakeSession.ts` is the same idea
 * one layer up.
 */

/**
 * Stands in for `claude` / `codex` on PATH. Extensionless and shebanged, so Node runs it
 * as CJS -- it therefore uses no import or require at all.
 *
 * ORCH_FAKE_STOP_MS makes it well-behaved instead: it sends Stop after that delay. That
 * is the control case, and it is what stops "always report timed_out" from passing.
 */
export const FAKE_CLI = `#!/usr/bin/env node
const url = process.env.ORCH_HOOK_URL
const agent = String(process.argv[1] || '').split('/').pop()
const stopAfter = Number(process.env.ORCH_FAKE_STOP_MS || 0)

function post(event, extra) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-orch-agent': agent, 'x-orch-event': event },
    body: JSON.stringify(Object.assign({ hook_event_name: event, session_id: 'fake-session' }, extra)),
  }).catch(function () {})
}

// Bracketed paste: what PtyProcess reads as "a real interactive raw-mode UI".
process.stdout.write('\\x1b[?2004h')

let buf = ''
let turns = 0
process.stdin.on('data', function (d) {
  buf += d.toString()
  const m = /[\\r\\n]/.exec(buf)
  if (!m) return
  const prompt = buf.slice(0, m.index)
  buf = buf.slice(m.index + 1)
  if (!prompt.trim()) return
  turns += 1
  const id = 'fake-turn-' + turns
  // ORCH_FAKE_SPEAK posts BEFORE the submit on purpose. Hooks are independent POSTs that
  // nobody orders, and a loaded Linux runner delivered them this way round while macOS did
  // not -- which made the adapter drop the evidence that the child had spoken. Forcing the
  // order here keeps that reproducible instead of leaving it to the machine.
  if (process.env.ORCH_FAKE_SPEAK) {
    post('PermissionRequest', { prompt_id: id, turn_id: id, tool_name: 'Bash', tool_input: { command: 'ls' } })
  }
  post('UserPromptSubmit', { prompt_id: id, turn_id: id, prompt })
  // ORCH_FAKE_SPEAK: say ONE thing and then go quiet, which is a turn that stopped rather than
  // a child that never started. A PermissionRequest is used because it is the only child-sourced
  // event this stand-in can produce without writing a transcript.
  if (stopAfter > 0) {
    setTimeout(function () {
      post('Stop', { prompt_id: id, turn_id: id, last_assistant_message: 'done' })
    }, stopAfter)
  }
  // Otherwise: nothing, ever. This is the hang the watchdog exists for.
})

post('SessionStart', { transcript_path: process.env.ORCH_FAKE_TRANSCRIPT })
setInterval(function () {}, 1 << 30)
`

const RUN = mkdtempSync(join(tmpdir(), 'orch-fake-cli-'))
const TRANSCRIPT = join(RUN, 'fake-transcript.jsonl')

for (const name of ['claude', 'codex']) {
  writeFileSync(join(RUN, name), FAKE_CLI)
  chmodSync(join(RUN, name), 0o755)
}
writeFileSync(TRANSCRIPT, '')

// This file runs in its own process under `node --test`, so shadowing the real CLIs on
// PATH cannot leak into any other suite.
process.env['PATH'] = `${RUN}:${process.env['PATH'] ?? ''}`
process.env['ORCH_FAKE_TRANSCRIPT'] = TRANSCRIPT


/**
 * Write the stand-ins somewhere, put that directory first on PATH, and point them at a
 * transcript file.
 *
 * Per PROCESS, not per test: each test file runs in its own process under `node --test`, so
 * shadowing the real CLIs cannot leak into another suite. Call it once at module scope.
 *
 * `transcript` starts empty and is the file the fake CLI announces in its `SessionStart`, so
 * the adapter tails it -- which is how a test gets to decide what the child's transcript says.
 */
export function installFakeClis(): { dir: string; transcript: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orch-fake-cli-'))
  const transcript = join(dir, 'fake-transcript.jsonl')

  for (const name of ['claude', 'codex']) {
    writeFileSync(join(dir, name), FAKE_CLI)
    chmodSync(join(dir, name), 0o755)
  }
  writeFileSync(transcript, '')

  process.env['PATH'] = `${dir}:${process.env['PATH'] ?? ''}`
  process.env['ORCH_FAKE_TRANSCRIPT'] = transcript
  return { dir, transcript }
}
