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
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { AgentEvent, TurnEndEvent } from '../contract/session.ts'
import { KimiPrintAdapter, parseRecord, sessionIdFrom, textOf } from './kimi.ts'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const FIXTURE = join(REPO, 'spikes/kimi/fixtures/edit-turn.ndjson')
const STDERR = join(REPO, 'spikes/kimi/fixtures/edit-turn.stderr.txt')

function stub(stdout: string, stderr = '', code = 0): { command: string; argvLog: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-stub-'))
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

test('a recorded turn completes, but the confidence says it was inferred', async () => {
  const { out, err } = both()
  const { command } = stub(out, err)
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

test('tool calls are recorded from the assistant message, not the tool result', async () => {
  const { out, err } = both()
  const { command } = stub(out, err)
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

test('reasoning is not mistaken for the report', async () => {
  const { out, err } = both()
  const { command } = stub(out, err)
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

test('the session id comes from stderr, and is used to resume', async () => {
  const { out, err } = both()
  const { command, argvLog } = stub(out, err)
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

test('a prompt is passed as a flag value, so a leading dash is safe', async () => {
  const { out, err } = both()
  const { command, argvLog } = stub(out, err)
  const s = await KimiPrintAdapter.start({ cwd: REPO, role: 'implementer', command })
  await s.send('--help me understand this repository', { kind: 'orchestrator' })
  await nextTurn(s)
  assert.match(readFileSync(argvLog, 'utf8'), /--prompt --help me understand/)
  await s.close()
})

test('--afk is always passed, or an unattended turn can stop on a question', async () => {
  const { out, err } = both()
  const { command, argvLog } = stub(out, err)
  const s = await KimiPrintAdapter.start({ cwd: REPO, role: 'implementer', command })
  await s.send('go', { kind: 'orchestrator' })
  await nextTurn(s)
  // AskUserQuestion in an unattended run is a turn that never ends. There is nobody to
  // answer it and no dialog for the relay to answer it through.
  assert.match(readFileSync(argvLog, 'utf8'), /--afk/)
  await s.close()
})

test('a turn whose last message still had tool calls is not a completion', async () => {
  // Truncated mid-flight: the model was still working when the stream stopped. Exit 0 alone
  // must not be read as success -- the same error the OpenCode adapter refuses to make.
  const truncated = readFileSync(FIXTURE, 'utf8').split('\n').slice(0, 2).join('\n')
  const { command } = stub(truncated, '', 0)
  const s = await KimiPrintAdapter.start({ cwd: REPO, role: 'implementer', command })
  await s.send('go', { kind: 'orchestrator' })
  const end = (await nextTurn(s)).find((e) => e.type === 'turn_end') as TurnEndEvent

  assert.equal(end.verdict.outcome, 'unknown_abnormal_end')
  assert.equal(end.verdict.confidence, 'assumed')
  await s.close()
})

test('permission decisions are refused rather than silently accepted', async () => {
  const { out, err } = both()
  const { command } = stub(out, err)
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

/** Emits nothing on either stream and never exits, so only the watchdog can end the turn. */
function hangingStub(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-hang-'))
  const command = join(dir, 'kimi-hang')
  writeFileSync(command, '#!/bin/sh\nsleep 30\n')
  chmodSync(command, 0o755)
  return command
}

/** Writes `err` to stderr, says nothing on stdout, and hangs. */
function hangingStubOnStderr(err: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-hang-err-'))
  const errPath = join(dir, 'err.txt')
  writeFileSync(errPath, err)
  const command = join(dir, 'kimi-hang-err')
  writeFileSync(command, `#!/bin/sh\ncat ${JSON.stringify(errPath)} >&2\nsleep 30\n`)
  chmodSync(command, 0o755)
  return command
}

test('stderr is output too: a child that printed an error and hung is not blamed on its model', async () => {
  // On this adapter stderr is where a provider or config failure appears AT ALL -- the structured
  // stream carries the conversation and nothing else -- so a gate that counted only records and
  // hooks would name the model on precisely the turn the child had explained itself.
  const session = await KimiPrintAdapter.start({
    cwd: REPO,
    role: 'implementer',
    command: hangingStubOnStderr('error: no such model on this provider\n'),
    watchdogMs: 600,
  })
  await session.send('go', { kind: 'orchestrator' })
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
  await session.close()
})

/** Emits `body` and then never exits, so only the watchdog can end the turn. */
function hangingStubEmitting(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-hang-say-'))
  const out = join(dir, 'out.ndjson')
  writeFileSync(out, body)
  const command = join(dir, 'kimi-hang-say')
  writeFileSync(command, `#!/bin/sh\ncat ${JSON.stringify(out)}\nsleep 30\n`)
  chmodSync(command, 0o755)
  return command
}

test('a record carrying no content still suppresses the launch diagnosis (#82)', async () => {
  // The repair. `textBlocks` and `toolCalls` are CONTENT, and this adapter leaves both empty for
  // records that plainly came from the child: a `role: "tool"` result is deliberately never
  // re-emitted, and an assistant message with no text and no calls is the completion signal
  // itself. Reading emptiness off them called both of those "produced nothing at all".
  for (const [why, body] of [
    ['a tool result', '{"role":"tool","tool_call_id":"call_1","content":"ok"}\n'],
    ['an assistant message with nothing in it', '{"role":"assistant","content":[]}\n'],
  ] as const) {
    const session = await KimiPrintAdapter.start({
      cwd: REPO,
      role: 'implementer',
      command: hangingStubEmitting(body),
      watchdogMs: 600,
    })
    await session.send('go', { kind: 'orchestrator' })
    const events = await nextTurn(session)
    // The gap this closes, pinned: neither record produces a content event, so `textBlocks` and
    // `toolCalls` are empty on a child that plainly spoke -- which is exactly what the old check
    // read, and why it called this silence.
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
    await session.close()
  }
})

test('a first run that produced no messages at all points at the launch (#82)', async () => {
  // Kimi normally takes its model from the generated config file rather than the argv, so the
  // usual reading of this is "the argv named no model" -- which is still the sentence that sends
  // an operator to the launch instead of leaving `timed_out` standing on its own.
  const session = await KimiPrintAdapter.start({
    cwd: REPO,
    role: 'implementer',
    command: hangingStub(),
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
