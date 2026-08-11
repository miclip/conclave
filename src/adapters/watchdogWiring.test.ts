/**
 * The deadline, through the real adapters rather than through TurnWatchdog alone.
 *
 * `outcomes/watchdog.test.ts` proves the clock classifies a silent turn as `timed_out`.
 * It cannot prove either adapter ever starts one -- and "nobody calls it" was the whole
 * bug. A watchdog with no caller passes every unit test it has.
 *
 * So these drive `ClaudePtyHookAdapter` and `CodexPtyHookAdapter` themselves: real PTY,
 * real HookReceiver, real hook decoding, real `#onHook` -> `arm()` -> timer -> `#apply`
 * -> `events()`. The only thing that is not real is the agent CLI, which is a stand-in on
 * PATH that announces a session, acknowledges a prompt, and then deliberately never sends
 * Stop. A hang is the one condition that cannot be provoked in a well-behaved CLI, and
 * paying real quota to wait out a real one is not a test anybody would run.
 *
 * These are NOT gated behind ORCH_LIVE: no agent binary is spawned and no quota is used.
 *
 * The last two drive the other half of #82: WHY a turn hung. A first turn that produced nothing
 * whatsoever is a child that never started work, and the model it was launched with is the first
 * thing to suspect -- so ORCH_FAKE_SPEAK makes the same fake CLI produce one event before going
 * quiet, and the two verdicts are compared. Without the speaking case, "always blames the model"
 * would pass.
 *
 * Delete the `arm()` call in either adapter, or break its callback, and the corresponding
 * hang test fails by never receiving a `turn_end`.
 */

import { strict as assert } from 'node:assert'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AgentEvent, TurnEndEvent } from '../contract/session.ts'
import { ClaudePtyHookAdapter } from './claude.ts'
import { CodexPtyHookAdapter } from './codex.ts'

/**
 * Stands in for `claude` / `codex` on PATH. Extensionless and shebanged, so Node runs it
 * as CJS -- it therefore uses no import or require at all.
 *
 * ORCH_FAKE_STOP_MS makes it well-behaved instead: it sends Stop after that delay. That
 * is the control case, and it is what stops "always report timed_out" from passing.
 */
const FAKE_CLI = `#!/usr/bin/env node
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

const WATCHDOG_MS = 400

/**
 * The deadline for the tests where the child must SPEAK before it goes quiet.
 *
 * 400ms is fine for a child that says nothing -- there is nothing to race. It is not fine
 * when the test's precondition is an event that arrives through the hook, because every hook
 * event spawns a process, and two spawns against a 400ms deadline is a race that macOS wins
 * and a loaded Linux runner loses. That is exactly how this file went red on main while
 * passing on the PR.
 *
 * Not a raised wait budget hiding contention -- `session.tty.test.ts` records why that is the
 * wrong fix. This is the deadline of the thing under test, and the test needs the speech
 * delivered before it. The margin is against process spawn latency, not against load.
 */
const SPOKE_WATCHDOG_MS = 5_000

/** Collect events until `done`, or give up. Returns what it saw either way. */
async function collect(
  session: { events(): AsyncIterable<AgentEvent> },
  done: (e: AgentEvent[]) => boolean,
  timeoutMs: number,
): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = []
  const deadline = Date.now() + timeoutMs
  const it = session.events()[Symbol.asyncIterator]()
  while (Date.now() < deadline) {
    // The losing timer is cleared each round; left pending it holds the test process open
    // for the full budget after the assertions have already passed.
    let timer: NodeJS.Timeout | undefined
    const next = await Promise.race([
      it.next(),
      new Promise<'timeout'>((r) => {
        timer = setTimeout(() => r('timeout'), Math.max(0, deadline - Date.now()))
      }),
    ]).finally(() => clearTimeout(timer))
    if (next === 'timeout' || next.done) break
    seen.push(next.value)
    if (done(seen)) break
  }
  return seen
}

const endOf = (e: AgentEvent[]): TurnEndEvent | undefined =>
  e.find((x) => x.type === 'turn_end') as TurnEndEvent | undefined

test('claude: a turn that hangs is reported timed_out by the adapter, unprompted', async () => {
  const session = await ClaudePtyHookAdapter.start({
    cwd: RUN,
    role: 'implementer',
    watchdogMs: WATCHDOG_MS,
    readyTimeoutMs: 20_000,
  })
  try {
    await session.send('hang please', { kind: 'orchestrator' })

    // Nothing further is sent, and the fake CLI never speaks again. Only a clock the
    // adapter started itself can end this turn.
    const events = await collect(session, (e) => endOf(e) !== undefined, 10_000)
    const end = endOf(events)

    assert.ok(end, 'the adapter must end a hung turn on its own; it never did before this fix')
    assert.equal(end.verdict.outcome, 'timed_out')
    assert.equal(end.synthesized, true, 'nothing from the child said this')
    assert.ok(
      end.verdict.provenance.some((p) => p.source === 'watchdog'),
      'provenance must name the clock as the source',
    )

    const snap = await session.snapshot()
    const turn = snap.turns.find((t) => String(t.key) === String(end.turnKey))
    assert.equal(turn?.state, 'timed_out', 'snapshot() must agree with what events() said')
  } finally {
    await session.close()
  }
})

test('codex: a turn that hangs is reported timed_out by the adapter, unprompted', async () => {
  const session = await CodexPtyHookAdapter.start({
    cwd: RUN,
    role: 'implementer',
    watchdogMs: WATCHDOG_MS,
    readyTimeoutMs: 20_000,
  })
  try {
    await session.send('hang please', { kind: 'orchestrator' })

    const events = await collect(session, (e) => endOf(e) !== undefined, 10_000)
    const end = endOf(events)

    assert.ok(end, 'the adapter must end a hung turn on its own; it never did before this fix')
    assert.equal(end.verdict.outcome, 'timed_out')
    assert.equal(end.synthesized, true, 'nothing from the child said this')
    assert.ok(
      end.verdict.provenance.some((p) => p.source === 'watchdog'),
      'provenance must name the clock as the source',
    )

    const snap = await session.snapshot()
    const turn = snap.turns.find((t) => String(t.key) === String(end.turnKey))
    assert.equal(turn?.state, 'timed_out', 'snapshot() must agree with what events() said')
  } finally {
    await session.close()
  }
})

test('claude: a turn that answers inside the deadline is completed, not timed_out', async () => {
  // The control. Without it, an adapter that reported `timed_out` for every turn would
  // satisfy the two tests above.
  process.env['ORCH_FAKE_STOP_MS'] = '50'
  const session = await ClaudePtyHookAdapter.start({
    cwd: RUN,
    role: 'implementer',
    watchdogMs: WATCHDOG_MS,
    readyTimeoutMs: 20_000,
  })
  try {
    await session.send('answer promptly', { kind: 'orchestrator' })

    const events = await collect(session, (e) => endOf(e) !== undefined, 10_000)
    const end = endOf(events)

    assert.equal(end?.verdict.outcome, 'completed')
    assert.equal(end?.synthesized, false, 'Stop proved this; the adapter did not infer it')

    // And the deadline must stay quiet afterwards rather than overwriting the completion.
    const after = await collect(session, () => false, WATCHDOG_MS * 3)
    assert.deepEqual(
      after.filter((e) => e.type === 'turn_end' || e.type === 'revision'),
      [],
      'a completed turn must not be revised by its own watchdog',
    )
  } finally {
    delete process.env['ORCH_FAKE_STOP_MS']
    await session.close()
  }
})

test('the transcript tailer emits content, never lifecycle', async () => {
  // The view derives turn_start/turn_end from the transcript, and those are the hooks' job:
  // `Stop` PROVES completion, a parsed stop_reason merely suggests it. Emitting both put
  // two lifecycle events in one stream — and `Relay#exchange` waits for the FIRST turn_end
  // after a send, so a transcript-derived one could end an exchange before the
  // authoritative verdict existed.
  //
  // Asserted against the source rather than a live session: the filter is one branch, and
  // spawning a real CLI to prove a `continue` statement would be a worse test, not a
  // better one.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const root = join(import.meta.dirname, '..', '..')
  for (const adapter of ['src/adapters/claude.ts', 'src/adapters/codex.ts']) {
    const src = readFileSync(join(root, adapter), 'utf8')
    const poller = src.slice(src.indexOf('async #pollTranscript'), src.indexOf('#startTailing'))
    assert.ok(
      /if \(e\.type === 'turn_start' \|\| e\.type === 'turn_end'\) continue/.test(poller),
      `${adapter} must not re-emit lifecycle events from the transcript`,
    )
  }
})

/** The `orchestrator` caveat #82 adds to a deadline verdict, or undefined when it is absent. */
const launchCaveat = (end: TurnEndEvent | undefined): string | undefined =>
  end?.verdict.provenance.find((p) => p.source === 'orchestrator' && p.caveat === true && /first turn/.test(p.detail))
    ?.detail

test('claude: a first turn that produced NOTHING names the model it was launched with', async () => {
  // The reported failure, in miniature: a model the child will not run, a turn that emits
  // nothing at all, and a watchdog that until now said only `timed_out (uncertain)`.
  const session = await ClaudePtyHookAdapter.start({
    cwd: RUN,
    role: 'implementer',
    args: ['--model', 'opus-5'],
    watchdogMs: WATCHDOG_MS,
    readyTimeoutMs: 20_000,
  })
  try {
    await session.send('hang please', { kind: 'orchestrator' })
    const end = endOf(await collect(session, (e) => endOf(e) !== undefined, 10_000))
    assert.equal(end?.verdict.outcome, 'timed_out')
    const caveat = launchCaveat(end)
    assert.ok(caveat, `the verdict must say the turn produced nothing: ${JSON.stringify(end?.verdict.provenance)}`)
    assert.match(caveat!, /opus-5/, 'the model is named, because it is the thing to check')
    assert.match(caveat!, /candidate/, 'and named as a candidate: nothing here proves it')
    // The deadline evidence is unchanged. This is an addition to the chain, not a replacement:
    // the clock that fired is still the most decisive thing in it.
    assert.ok(end!.verdict.provenance.some((p) => p.source === 'watchdog'))
  } finally {
    await session.close()
  }
})

test('claude: a turn that spoke and then went quiet is not blamed on its model', async () => {
  // The distinction the issue asks for, and the control that stops the test above passing for
  // the wrong reason. Same CLI, same deadline, same model -- one event of difference.
  process.env['ORCH_FAKE_SPEAK'] = '1'
  const session = await ClaudePtyHookAdapter.start({
    cwd: RUN,
    role: 'implementer',
    args: ['--model', 'opus-5'],
    watchdogMs: SPOKE_WATCHDOG_MS,
    readyTimeoutMs: 20_000,
  })
  try {
    await session.send('speak then hang', { kind: 'orchestrator' })
    const events = await collect(session, (e) => endOf(e) !== undefined, 10_000)
    assert.ok(
      events.some((e) => e.type === 'permission_requested'),
      'the fake CLI must actually have spoken, or this proves nothing',
    )
    const end = endOf(events)
    assert.equal(end?.verdict.outcome, 'timed_out', 'it still times out; only the diagnosis differs')
    assert.equal(launchCaveat(end), undefined, 'a turn that emitted and stopped must not blame the launch')
  } finally {
    delete process.env['ORCH_FAKE_SPEAK']
    await session.close()
  }
})

test('codex: a first turn that produced NOTHING names the model it was launched with', async () => {
  const session = await CodexPtyHookAdapter.start({
    cwd: RUN,
    role: 'implementer',
    // Codex takes its model through `-c model=X` rather than a flag of its own, which is the
    // spelling `modelFromArgs` has to read for this seat to be diagnosable at all.
    args: ['-c', 'model=gpt-5-imaginary'],
    watchdogMs: WATCHDOG_MS,
    readyTimeoutMs: 20_000,
  })
  try {
    await session.send('hang please', { kind: 'orchestrator' })
    const end = endOf(await collect(session, (e) => endOf(e) !== undefined, 10_000))
    assert.equal(end?.verdict.outcome, 'timed_out')
    assert.match(launchCaveat(end) ?? '', /gpt-5-imaginary/)
  } finally {
    await session.close()
  }
})
