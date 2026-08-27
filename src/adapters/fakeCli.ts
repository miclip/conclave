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
 * A composer that honours BRACKETED PASTE, for pasting into a stand-in that advertises it.
 *
 * Every one of these fakes writes `ESC[?2004h`, which is the marker `PtyProcess` reads as "a
 * real interactive raw-mode UI" -- and, since #174, the marker `InputQueue.submit()` gates its
 * paste framing on. A stand-in that advertises the capability has to implement it, or it is
 * not standing in for anything: text between `ESC[200~` and `ESC[201~` is inserted into the
 * composer LITERALLY, newlines inside it are characters rather than Enter, and the Enter that
 * arrives after the paste is the one submission.
 *
 * Typed text keeps the old behaviour, because that is also still real: without the framing a
 * newline IS Enter, which is the defect #174 is about.
 *
 * JavaScript source, spliced into the CJS stand-ins below. `onComposerSubmit(fn)` calls `fn`
 * once per submission with exactly what the composer held.
 */
export const COMPOSER_JS = `
function onComposerSubmit(handler) {
  let composer = ''
  let pending = ''
  let pasting = false
  // A terminator can straddle two reads, so never commit the last few bytes of a partial one.
  function holdBack() {
    const keep = Math.max(0, pending.length - 5)
    composer += pending.slice(0, keep)
    pending = pending.slice(keep)
  }
  process.stdin.on('data', function (d) {
    pending += d.toString()
    for (;;) {
      if (pasting) {
        const close = pending.indexOf('\\x1b[201~')
        if (close === -1) return holdBack()
        composer += pending.slice(0, close)
        pending = pending.slice(close + 6)
        pasting = false
        continue
      }
      // Whichever comes FIRST decides, and the ordering is load-bearing: a bare ESC sitting in
      // front of a paste opener is two separate events, and taking the opener first would
      // commit the ESC into the composer as text.
      const open = pending.indexOf('\\x1b[200~')
      const esc = pending.indexOf('\\x1b')
      const m = /[\\r\\n]/.exec(pending)
      const enter = m ? m.index : -1
      const at = Math.min.apply(null, [open, esc, enter].filter(function (i) { return i !== -1 }))
      if (at === Infinity) return holdBack()
      if (esc === at && esc !== open) {
        // A paste opener begins with ESC too, so an ESC near the end might still become one.
        if (esc > pending.length - 6) return holdBack()
        // A bare ESC CLEARS the composer -- that is what cancel() means, and what both CLIs do
        // with Escape. Buffering it as a character instead would make the NEXT prompt start
        // with a stray control byte, which the #174 comparison then reports as corruption the
        // transport never caused.
        //
        // ORCH_FAKE_DEAF drops the byte and changes nothing: a child that is deaf to the
        // cancellation. It does not clear, it does not stop, and it says nothing -- so from
        // outside, an interrupted turn and a turn still running the fragment are the same
        // picture. That is the case the #174 retry must refuse rather than type into.
        pending = pending.slice(esc + 1)
        if (!process.env.ORCH_FAKE_DEAF) composer = ''
        continue
      }
      if (open === at) {
        composer += pending.slice(0, open)
        pending = pending.slice(open + 6)
        pasting = true
        continue
      }
      composer += pending.slice(0, enter)
      pending = pending.slice(enter + 1)
      const prompt = composer
      composer = ''
      handler(prompt)
    }
  })
}
`

/**
 * Stands in for `claude` / `codex` on PATH. Extensionless and shebanged, so Node runs it
 * as CJS -- it therefore uses no import or require at all.
 *
 * ORCH_FAKE_STOP_MS makes it well-behaved instead: it sends Stop after that delay. That
 * is the control case, and it is what stops "always report timed_out" from passing.
 *
 * ORCH_FAKE_LOSE makes it a CORRUPTING child: it reports having taken a mangled version of
 * what it was typed, which is the #174 condition every downstream witness agrees with.
 * ORCH_FAKE_LOSE_TURNS bounds the corruption to the first N prompts, so a stand-in can be a
 * transport that glitched once rather than one that is broken for good. ORCH_FAKE_ESC_TURN
 * makes it a child that opens a turn when it is told to stop, which is the one condition under
 * which a corrupted prompt must NOT be re-sent. ORCH_FAKE_DEAF is the quieter version of the
 * same hazard: it ignores the ESC completely and reports nothing, so nothing the child produces
 * ever says the turn ended. ORCH_FAKE_RAW puts it in raw mode, as both real CLIs are, which is
 * what a test needs before it can send it more than MAX_CANON bytes.
 */
export const FAKE_CLI = `#!/usr/bin/env node
const url = process.env.ORCH_HOOK_URL
const agent = String(process.argv[1] || '').split('/').pop()
const stopAfter = Number(process.env.ORCH_FAKE_STOP_MS || 0)

// ORCH_FAKE_LOSE=front:N | tail:N | middle:N -- a child that accepted text which is not the
// text that was sent (#174). It reports what it TOOK, which is the whole point: every witness
// downstream then agrees on the wrong message, and only the sender can tell.
//
// ORCH_FAKE_LOSE_TURNS=N bounds that to the first N prompts, which is the difference between a
// transport that dropped bytes once and one that is broken. The adapters treat those two
// differently -- the first is retried, the second is refused -- so a stand-in that can only be
// permanently broken cannot exercise the recovery at all.
const lose = String(process.env.ORCH_FAKE_LOSE || '')
const loseTurns = Number(process.env.ORCH_FAKE_LOSE_TURNS || 0)
function asReceived(prompt, nth) {
  if (!lose) return prompt
  if (loseTurns > 0 && nth > loseTurns) return prompt
  const how = lose.split(':')[0]
  const n = Number(lose.split(':')[1] || 0)
  if (how === 'front') return prompt.slice(n)
  if (how === 'tail') return prompt.slice(0, Math.max(0, prompt.length - n))
  if (how === 'middle') {
    const at = Math.floor(prompt.length / 2)
    return prompt.slice(0, at) + prompt.slice(at + n)
  }
  return prompt
}

function post(event, extra) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-orch-agent': agent, 'x-orch-event': event },
    body: JSON.stringify(Object.assign({ hook_event_name: event, session_id: 'fake-session' }, extra)),
  }).catch(function () {})
}

// Bracketed paste: what PtyProcess reads as "a real interactive raw-mode UI", and what
// InputQueue.submit() frames its payloads with. COMPOSER_JS implements the other half.
process.stdout.write('\\x1b[?2004h')
${COMPOSER_JS}
let turns = 0
onComposerSubmit(function (prompt) {
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
  post('UserPromptSubmit', { prompt_id: id, turn_id: id, prompt: asReceived(prompt, turns) })
  // ORCH_FAKE_SPEAK: say ONE thing and then go quiet, which is a turn that stopped rather than
  // a child that never started. A PermissionRequest is used because it is the only child-sourced
  // event this stand-in can produce without writing a transcript.
  if (stopAfter > 0 && !process.env.ORCH_FAKE_DEAF) {
    setTimeout(function () {
      post('Stop', { prompt_id: id, turn_id: id, last_assistant_message: 'done' })
    }, stopAfter)
  }
  // Otherwise: nothing, ever. This is the hang the watchdog exists for.
})

// ORCH_FAKE_ESC_TURN: a child that does NOT stop when it is told to. On a bare ESC it opens a
// turn of its own instead -- which is what a resumed session, a queued prompt, or a human at
// the same terminal looks like from outside. The #174 recovery has to refuse to type into
// that: a re-send here is spliced into a running turn rather than replacing the malformed one.
// ORCH_FAKE_RAW: put the stand-in in RAW MODE, which is what both real CLIs do and what this
// one otherwise does not. It matters for exactly two things, and both are transport questions:
//
//   - WHEN a byte lands. In canonical mode the line discipline holds input until a newline, so
//     a bare ESC is not seen until the next prompt is typed -- a child that reacts to a
//     cancellation only after the re-send cannot stand in for one that ignored it.
//   - HOW MUCH lands. The canonical buffer is MAX_CANON (1024 B on darwin) and a bracketed
//     paste contains no newline at all, so anything past it is discarded before the child gets
//     a look: a 4096 B message loses its closing ESC[201~, nothing is ever submitted, and the
//     stand-in has a truncation behaviour no real CLI has. Measuring conclave against that
//     measures the fixture.
//
// Off by default: the suites that send small payloads are unaffected either way, and flipping
// a shared fixture for all of them is a larger change than the two tests that need it.
if (process.env.ORCH_FAKE_RAW || process.env.ORCH_FAKE_ESC_TURN) {
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
}

if (process.env.ORCH_FAKE_ESC_TURN) {
  var escTurns = 0
  process.stdin.on('data', function (d) {
    var s = d.toString()
    for (var i = 0; i < s.length; i++) {
      // A bare ESC, not the ESC that opens a paste marker or any other CSI sequence.
      if (s.charAt(i) === '\\x1b' && s.charAt(i + 1) !== '[') {
        escTurns += 1
        var escId = 'fake-esc-turn-' + escTurns
        post('UserPromptSubmit', { prompt_id: escId, turn_id: escId, prompt: 'a turn nobody asked for' })
        return
      }
    }
  })
}

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
