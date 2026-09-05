/**
 * The Kimi adapter, driven against a recorded run.
 *
 * `spikes/kimi/fixtures/edit-turn.ndjson` is the verbatim stdout of a real
 * `kimi --print --output-format stream-json` on 1.49.0 against a Moonshot provider: a think
 * block, a ReadFile, a StrReplaceFile that changed a file, and a closing assistant message.
 * `edit-turn.stderr.txt` is the matching stderr, which is where the session id lives.
 *
 * A stub binary replays both, so the suite needs no Kimi installed, no account and no key.
 *
 *   node --test src/adapters/kimi.test.ts
 */

import { strict as assert } from 'node:assert'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { AgentEvent, TurnEndEvent } from '../contract/session.ts'
import { KimiPrintAdapter, parseRecord, sessionIdFrom, textOf } from './kimi.ts'
import { containAdapterRunDirs, tempDir } from '../testkit/tempDir.ts'

/**
 * The run directories the adapters this file boots make for themselves, contained (#211).
 *
 * `claude`, `codex` and `kimi` each `mkdtemp` under `os.tmpdir()` at boot. #203 gives that back
 * on close; this covers what close cannot -- a boot that throws first, and the run that keeps its
 * directory because its attempts journal was named to the operator.
 */
containAdapterRunDirs()

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const FIXTURE = join(REPO, 'spikes/kimi/fixtures/edit-turn.ndjson')

/**
 * The real `setTimeout`, captured at module load.
 *
 * The two tests whose precondition is that the child SPOKE freeze the adapter's clock with
 * `t.mock.timers`, so the deadline can be advanced deliberately rather than waited out. That
 * replaces the global, and they still have to wait in real time for a real process -- which is
 * the one thing the frozen clock must not be used for.
 */
const realSetTimeout = globalThis.setTimeout
const realSleep = (ms: number): Promise<void> => new Promise((r) => realSetTimeout(() => r(), ms))

/**
 * Wait until the stub has written its bytes, then let the adapter read them.
 *
 * Two halves answering different questions. The marker answers "has the child written yet",
 * which is the part that blows out under load -- fork, exec, shell startup, a `cat`. The yields
 * answer "has the parent read what is sitting in the pipe": `setImmediate` runs in the check
 * phase, so each turn traverses poll, where pipe data is delivered.
 *
 * It does NOT prove the adapter counted anything -- `turn.heard` is private and `snapshot()`
 * does not expose it. Same limitation, and same reasoning, as the OpenCode copy of this; see
 * `docs/NOTES.md`.
 */
async function heardWhatWasWritten(wrote: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!existsSync(wrote)) {
    if (Date.now() > deadline) throw new Error(`stub never finished writing: ${wrote}`)
    await realSleep(2)
  }
  for (let turn = 0; turn < 50; turn++) {
    await new Promise((r) => setImmediate(r))
    if (turn % 10 === 9) await realSleep(1)
  }
}
const STDERR = join(REPO, 'spikes/kimi/fixtures/edit-turn.stderr.txt')

function stub(t: TestContext, stdout: string, stderr = '', code = 0): { command: string; argvLog: string } {
  const dir = tempDir(t, 'kimi-stub')
  const argvLog = join(dir, 'argv.log')
  const out = join(dir, 'out.ndjson')
  const err = join(dir, 'err.txt')
  writeFileSync(out, stdout)
  writeFileSync(err, stderr)
  const command = join(dir, 'kimi-stub')
  writeFileSync(
    command,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}\n` +
      `cat ${JSON.stringify(out)}\ncat ${JSON.stringify(err)} >&2\nexit ${code}\n`,
  )
  chmodSync(command, 0o755)
  return { command, argvLog }
}

async function nextTurn(session: KimiPrintAdapter): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = []
  for await (const e of session.events()) {
    seen.push(e)
    if (e.type === 'turn_end') break
  }
  return seen
}

const both = () => ({ out: readFileSync(FIXTURE, 'utf8'), err: readFileSync(STDERR, 'utf8') })

test('a recorded turn completes, but the confidence says it was inferred', async (t) => {
  const { out, err } = both()
  const { command } = stub(t, out, err)
  const s = await KimiPrintAdapter.start({ cwd: REPO, role: 'implementer', command })
  await s.send('Edit calc.py so add() returns a + b.', { kind: 'orchestrator' })
  const end = (await nextTurn(s)).find((e) => e.type === 'turn_end') as TurnEndEvent

  assert.equal(end.verdict.outcome, 'completed')
  // The distinction that matters against OpenCode, whose child ANNOUNCES its turn end.
  // Nothing here does: this is the shape of the last message plus a zero exit, and the
  // grade has to say so or the two adapters look equally trustworthy when they are not.
  assert.equal(end.verdict.confidence, 'inferred')
  assert.equal(end.synthesized, true, 'we concluded it; nothing declared it')
  assert.ok(
    end.verdict.provenance.some((p) => p.caveat && /Stop hook/.test(p.detail)),
    'the caveat naming the missing announced signal must survive to the caller',
  )
  await s.close()
})

test('tool calls are recorded from the assistant message, not the tool result', async (t) => {
  const { out, err } = both()
  const { command } = stub(t, out, err)
  const s = await KimiPrintAdapter.start({ cwd: REPO, role: 'implementer', command })
  await s.send('go', { kind: 'orchestrator' })
  await nextTurn(s)

  const tools = (await s.snapshot()).turns[0]!.toolCalls
  // Each call appears once. `role: 'tool'` records carry results for calls already recorded,
  // so counting those too would double every tool in the turn.
  assert.deepEqual(
    tools.map((t) => t.tool),
    ['ReadFile', 'StrReplaceFile'],
  )
  assert.match(tools[1]!.args!, /StrReplaceFile|old|new/, 'the arguments are retained verbatim')
  await s.close()
})

test('reasoning is not mistaken for the report', async (t) => {
  const { out, err } = both()
  const { command } = stub(t, out, err)
  const s = await KimiPrintAdapter.start({ cwd: REPO, role: 'implementer', command })
  await s.send('go', { kind: 'orchestrator' })
  await nextTurn(s)

  const turn = (await s.snapshot()).turns[0]!
  // `think` parts are the model reasoning aloud. Routing those to the other participant
  // would hand an advisor a stated intention as though it were a result -- the exact
  // failure the report/assistantText split exists to prevent.
  assert.match(turn.report!, /^Done\./)
  assert.doesNotMatch(turn.assistantText!, /no plan mode needed/, 'think blocks are excluded')
  await s.close()
})

test('the session id comes from stderr, and is used to resume', async (t) => {
  const { out, err } = both()
  const { command, argvLog } = stub(t, out, err)
  const s = await KimiPrintAdapter.start({ cwd: REPO, role: 'implementer', command })

  await s.send('first', { kind: 'orchestrator' })
  await nextTurn(s)
  // Kimi prints it as a human-facing resume instruction and nowhere else.
  assert.equal(s.sessionId, 'e5c1ee8d-5bc8-41c4-9acb-de94ccd28c9e')

  await s.send('second', { kind: 'orchestrator' })
  await nextTurn(s)
  const argv = readFileSync(argvLog, 'utf8').trim().split('\n')
  assert.ok(!argv[0]!.includes('-r '), 'nothing to resume on the first turn')
  assert.ok(
    argv[1]!.includes(`-r ${s.sessionId}`),
    'without -r each turn is a fresh context that still looks like a conversation',
  )
  await s.close()
})

test('a prompt is passed as a flag value, so a leading dash is safe', async (t) => {
  const { out, err } = both()
  const { command, argvLog } = stub(t, out, err)
  const s = await KimiPrintAdapter.start({ cwd: REPO, role: 'implementer', command })
  await s.send('--help me understand this repository', { kind: 'orchestrator' })
  await nextTurn(s)
  assert.match(readFileSync(argvLog, 'utf8'), /--prompt --help me understand/)
  await s.close()
})

test('--afk is always passed, or an unattended turn can stop on a question', async (t) => {
  const { out, err } = both()
  const { command, argvLog } = stub(t, out, err)
  const s = await KimiPrintAdapter.start({ cwd: REPO, role: 'implementer', command })
  await s.send('go', { kind: 'orchestrator' })
  await nextTurn(s)
  // AskUserQuestion in an unattended run is a turn that never ends. There is nobody to
  // answer it and no dialog for the relay to answer it through.
  assert.match(readFileSync(argvLog, 'utf8'), /--afk/)
  await s.close()
})

test('a turn whose last message still had tool calls is not a completion', async (t) => {
  // Truncated mid-flight: the model was still working when the stream stopped. Exit 0 alone
  // must not be read as success -- the same error the OpenCode adapter refuses to make.
  const truncated = readFileSync(FIXTURE, 'utf8').split('\n').slice(0, 2).join('\n')
  const { command } = stub(t, truncated, '', 0)
  const s = await KimiPrintAdapter.start({ cwd: REPO, role: 'implementer', command })
  await s.send('go', { kind: 'orchestrator' })
  const end = (await nextTurn(s)).find((e) => e.type === 'turn_end') as TurnEndEvent

  assert.equal(end.verdict.outcome, 'unknown_abnormal_end')
  assert.equal(end.verdict.confidence, 'assumed')
  await s.close()
})

test('permission decisions are refused rather than silently accepted', async (t) => {
  const { out, err } = both()
  const { command } = stub(t, out, err)
  const s = await KimiPrintAdapter.start({ cwd: REPO, role: 'implementer', command })
  await assert.rejects(() => s.decidePermission('allow'), /auto-approves/)
  await s.close()
})

test('parsing helpers are defensive about an undocumented format', () => {
  assert.equal(parseRecord('not json'), undefined)
  assert.equal(parseRecord('{"no":"role"}'), undefined)
  assert.equal(parseRecord('{"role":"assistant"}')!.role, 'assistant')
  // A tool result carries a bare string where an assistant message carries parts.
  assert.equal(textOf('plain string'), 'plain string')
  assert.equal(textOf([{ type: 'think', think: 'x' }]), '', 'think is not text')
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\n\nb')
  assert.equal(textOf(undefined), '')
  assert.equal(sessionIdFrom('nothing here'), undefined)
})

test('a binary that is not on PATH is a verdict, not a crash', async () => {
  const s = await KimiPrintAdapter.start({
    cwd: REPO,
    role: 'implementer',
    command: '/nonexistent/definitely-not-here',
  })
  await s.send('go', { kind: 'orchestrator' })
  const end = (await nextTurn(s)).find((e) => e.type === 'turn_end') as TurnEndEvent
  assert.equal(end.verdict.outcome, 'transport_lost')
  assert.match(end.verdict.provenance[0]!.detail, /not on PATH/)
  await s.close()
})

/**
 * Emits nothing on either stream and never exits, so only the watchdog can end the turn.
 *
 * `exec sleep`, not `sleep`: otherwise the shell stays alive as the parent and `sleep` is a
 * grandchild holding the inherited stdout pipe, so SIGTERM ends the shell and leaves the stream
 * open. That is a real adapter case with its own test; here it only makes every hang test wait
 * out the adapter's post-exit grace for nothing. Measured: with the plain `sleep`, six copies of
 * this file under load had all reported and still would not exit.
 */
function hangingStub(t: TestContext): string {
  const dir = tempDir(t, 'kimi-hang')
  const command = join(dir, 'kimi-hang')
  writeFileSync(command, '#!/bin/sh\nexec sleep 30\n')
  chmodSync(command, 0o755)
  return command
}

/**
 * Writes `err` to stderr, says nothing on stdout, and hangs.
 *
 * `wrote` is created after the write returns. It is content-neutral by construction -- a file on
 * disk, no bytes into the adapter, no record -- so a test can wait on it without changing what
 * the child is heard to have said.
 */
function hangingStubOnStderr(t: TestContext, err: string): { command: string; wrote: string } {
  const dir = tempDir(t, 'kimi-hang-err')
  const errPath = join(dir, 'err.txt')
  writeFileSync(errPath, err)
  const wrote = join(dir, 'wrote')
  const command = join(dir, 'kimi-hang-err')
  writeFileSync(
    command,
    `#!/bin/sh\ncat ${JSON.stringify(errPath)} >&2\n: > ${JSON.stringify(wrote)}\nexec sleep 30\n`,
  )
  chmodSync(command, 0o755)
  return { command, wrote }
}

test('stderr is output too: a child that printed an error and hung is not blamed on its model', async (t) => {
  // On this adapter stderr is where a provider or config failure appears AT ALL -- the structured
  // stream carries the conversation and nothing else -- so a gate that counted only records and
  // hooks would name the model on precisely the turn the child had explained itself.
  //
  // Frozen clock and a fixture barrier (#154). The precondition is that the stderr byte reached
  // the adapter before the deadline, and against a real 600ms timer that is a race with process
  // spawn: six copies of this file under load lost it in every run, which turns the assertion
  // below into its opposite, because a child that was never heard IS blamed on its model. The
  // deadline itself is unchanged -- it simply no longer has to win anything.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // Restored on the way out however this test ends. A mocked clock is a GLOBAL: if an
  // assertion throws before a manual reset, the frozen `setTimeout` leaks into whatever runs
  // next, and the next test that waits on a real deadline never wakes. Measured -- that is
  // exactly what a failing negative control did here, hanging the file until it was killed.
  t.after(() => t.mock.timers.reset())
  const stub = hangingStubOnStderr(t, 'error: no such model on this provider\n')
  const session = await KimiPrintAdapter.start({
    cwd: REPO,
    role: 'implementer',
    command: stub.command,
    watchdogMs: 600,
  })
  // `finally`, because this adapter holds a HookReceiver -- a listening server closed only by
  // `close()`. An assertion that throws past an unguarded close leaks it, and the test process
  // then never exits: measured, six copies of this file sat for ten minutes with every test
  // already reported. A failing test must fail, not hang.
  try {
    await session.send('go', { kind: 'orchestrator' })
    await heardWhatWasWritten(stub.wrote)
    t.mock.timers.tick(600)
    const events = await nextTurn(session)
    assert.deepEqual(events.filter((e) => e.type === 'message' || e.type === 'tool_use'), [])
    const end = events.find((e) => e.type === 'turn_end') as TurnEndEvent
    assert.equal(end.verdict.outcome, 'timed_out')
    assert.equal(
      end.verdict.provenance.find((p) => p.source === 'orchestrator' && /first run/.test(p.detail)),
      undefined,
      'the child spoke, so the launch is not named',
    )
    assert.ok(
      end.verdict.provenance.some((p) => /no such model on this provider/.test(p.detail)),
      `the child's own answer must survive into the verdict: ${JSON.stringify(end.verdict.provenance)}`,
    )
  } finally {
    await session.close()
  }
})

/** Emits `body` and then never exits, so only the watchdog can end the turn. Marker as above. */
function hangingStubEmitting(t: TestContext, body: string): { command: string; wrote: string } {
  const dir = tempDir(t, 'kimi-hang-say')
  const out = join(dir, 'out.ndjson')
  writeFileSync(out, body)
  const wrote = join(dir, 'wrote')
  const command = join(dir, 'kimi-hang-say')
  writeFileSync(
    command,
    `#!/bin/sh\ncat ${JSON.stringify(out)}\n: > ${JSON.stringify(wrote)}\nexec sleep 30\n`,
  )
  chmodSync(command, 0o755)
  return { command, wrote }
}

test('a record carrying no content still suppresses the launch diagnosis (#82)', async (t) => {
  // The repair. `textBlocks` and `toolCalls` are CONTENT, and this adapter leaves both empty for
  // records that plainly came from the child: a `role: "tool"` result is deliberately never
  // re-emitted, and an assistant message with no text and no calls is the completion signal
  // itself. Reading emptiness off them called both of those "produced nothing at all".
  //
  // Frozen clock and the same content-neutral fixture barrier as the stderr test above (#154):
  // the record has to reach the adapter before the deadline, and against a real timer that was
  // a race this machine lost under load in every run.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // Restored on the way out however this test ends. A mocked clock is a GLOBAL: if an
  // assertion throws before a manual reset, the frozen `setTimeout` leaks into whatever runs
  // next, and the next test that waits on a real deadline never wakes. Measured -- that is
  // exactly what a failing negative control did here, hanging the file until it was killed.
  t.after(() => t.mock.timers.reset())
  for (const [why, body] of [
    ['a tool result', '{"role":"tool","tool_call_id":"call_1","content":"ok"}\n'],
    ['an assistant message with nothing in it', '{"role":"assistant","content":[]}\n'],
  ] as const) {
    const stub = hangingStubEmitting(t, body)
    const session = await KimiPrintAdapter.start({
      cwd: REPO,
      role: 'implementer',
      command: stub.command,
      watchdogMs: 600,
    })
    // `finally`: see the stderr test above -- an unguarded close leaks this adapter's
    // HookReceiver on a failing assertion, and the process then hangs instead of failing.
    try {
      await session.send('go', { kind: 'orchestrator' })
      await heardWhatWasWritten(stub.wrote)
      t.mock.timers.tick(600)
      const events = await nextTurn(session)
      // The gap this closes, pinned: neither record produces a content event, so `textBlocks`
      // and `toolCalls` are empty on a child that plainly spoke -- which is exactly what the old
      // check read, and why it called this silence.
      assert.deepEqual(
        events.filter((e) => e.type === 'message' || e.type === 'tool_use'),
        [],
        `${why}: this record produces no content event, which is why the old check missed it`,
      )
      const end = events.find((e) => e.type === 'turn_end') as TurnEndEvent
      assert.equal(end.verdict.outcome, 'timed_out', `${why}: it still times out`)
      assert.equal(
        end.verdict.provenance.find((p) => p.source === 'orchestrator' && /first run/.test(p.detail)),
        undefined,
        `${why}: the child spoke, so the launch is not named`,
      )
    } finally {
      await session.close()
    }
  }
})

test('a first run that produced no messages at all points at the launch (#82)', async (t) => {
  // Kimi normally takes its model from the generated config file rather than the argv, so the
  // usual reading of this is "the argv named no model" -- which is still the sentence that sends
  // an operator to the launch instead of leaving `timed_out` standing on its own.
  const session = await KimiPrintAdapter.start({
    cwd: REPO,
    role: 'implementer',
    command: hangingStub(t),
    watchdogMs: 300,
  })
  await session.send('go', { kind: 'orchestrator' })
  const end = (await nextTurn(session)).find((e) => e.type === 'turn_end') as TurnEndEvent
  assert.equal(end.verdict.outcome, 'timed_out')
  const said = end.verdict.provenance.find((p) => p.source === 'orchestrator' && /first run/.test(p.detail))
  assert.ok(said, `the verdict must say the run produced nothing: ${JSON.stringify(end.verdict.provenance)}`)
  assert.match(said!.detail, /named no model/)
  assert.equal(said!.caveat, true)
  await session.close()
})

test('#48 the declared absence of a silence clock is OBSERVED, not read off the source', async (t) => {
  // The same claim as OpenCode's, and the same reason it matters: a seat with no silence clock
  // goes quiet forever and produces no verdict, so a reader trusting `supported: false` wrongly
  // waits for a timeout that arrives and is attributed to nothing.
  //
  // `DEFAULT_IDLE_MS` is twelve minutes, so this does not wait one out. It asserts the stronger
  // and faster thing: with an absolute bound set, the only deadline that fires is that one, at
  // that bound, in its own words. A silence clock would be a second timer, firing earlier, with
  // a different detail.
  const command = hangingStub(t)
  const s = await KimiPrintAdapter.start({ cwd: REPO, role: 'implementer', command, watchdogMs: 700 })
  try {
    const seen: AgentEvent[] = []
    const reading = (async () => {
      for await (const e of s.events()) {
        seen.push(e)
        if (e.type === 'turn_end') break
      }
    })()
    await s.send('go quiet', { kind: 'orchestrator' })

    await new Promise((r) => setTimeout(r, 350))
    assert.equal(
      seen.filter((e) => e.type === 'turn_end').length,
      0,
      'nothing may end a quiet turn before the absolute bound',
    )

    await reading
    const end = seen.find((e): e is TurnEndEvent => e.type === 'turn_end')
    assert.ok(end, 'the absolute clock must still fire')
    assert.equal(end.verdict.outcome, 'timed_out')
    assert.match(
      end.verdict.provenance.map((p) => p.detail).join(' '),
      /no terminal message within 700ms/,
      'the deadline that fired is the absolute one, named as such',
    )
  } finally {
    await s.close('abandoned').catch(() => undefined)
  }
})
