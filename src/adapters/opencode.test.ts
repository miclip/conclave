/**
 * The OpenCode adapter, driven against a recorded run.
 *
 * `spikes/opencode/fixtures/edit-turn.ndjson` is the verbatim stdout of a real
 * `opencode run --format json` on 1.18.15: three steps, a `read`, an `edit` that changed a
 * file, and a terminal `step_finish reason=stop`. Replaying it through a stub binary
 * exercises the whole path -- spawn, line parsing, event emission, verdict -- rather than
 * testing a parser in isolation, which would prove nothing about the part that has actually
 * broken in the other adapters.
 *
 * The stub also lets these tests run with no OpenCode installed and no account, which
 * matters: the live behaviour cost real money and an API key to establish, and a suite that
 * needs either is a suite that stops being run.
 *
 *   node --test src/adapters/opencode.test.ts
 */

import { strict as assert } from 'node:assert'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { AgentEvent, TurnEndEvent } from '../contract/session.ts'
import { OpenCodeRunAdapter, parseRecord } from './opencode.ts'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const FIXTURE = join(REPO, 'spikes/opencode/fixtures/edit-turn.ndjson')

/**
 * A stand-in for the `opencode` binary that emits `body` and exits with `code`.
 *
 * It also records the argv it was given, because the argument composition is load-bearing
 * and invisible from the adapter's own state: forgetting `--session` on the second turn
 * gives every turn a fresh context while looking, from outside, exactly like a working
 * session.
 */
function stub(body: string, code = 0): { command: string; argvLog: string } {
  const dir = mkdtempSync(join(tmpdir(), 'oc-stub-'))
  const argvLog = join(dir, 'argv.log')
  const payload = join(dir, 'payload.ndjson')
  writeFileSync(payload, body)
  const command = join(dir, 'opencode-stub')
  writeFileSync(
    command,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}\ncat ${JSON.stringify(payload)}\nexit ${code}\n`,
  )
  chmodSync(command, 0o755)
  return { command, argvLog }
}

/**
 * Drain events up to and including the next `turn_end`.
 *
 * One turn per call, deliberately. `AsyncQueue` is single-consumer, so a helper that
 * counted turn_ends cumulatively would block forever on the second call waiting for a
 * count already consumed by the first -- which is exactly what it did.
 */
async function nextTurn(session: OpenCodeRunAdapter): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = []
  for await (const e of session.events()) {
    seen.push(e)
    if (e.type === 'turn_end') break
  }
  return seen
}

test('a recorded turn produces an observed completion, not an inferred one', async () => {
  const { command } = stub(readFileSync(FIXTURE, 'utf8'))
  const session = await OpenCodeRunAdapter.start({ cwd: REPO, role: 'implementer', command })

  await session.send('Edit calc.py so add() returns a + b.', { kind: 'orchestrator' })
  const events = await nextTurn(session)

  const end = events.find((e) => e.type === 'turn_end') as TurnEndEvent
  assert.equal(end.verdict.outcome, 'completed')
  // The whole point of this adapter: the child announced it. A `completed` that had to be
  // synthesized would be no better than what the pty adapters already do.
  assert.equal(end.synthesized, false, 'completion was announced, not inferred')
  assert.equal(end.verdict.confidence, 'proven')
  assert.match(end.verdict.provenance[0]!.detail, /step_finish reason=stop/)

  await session.close()
})

test('tool calls are recorded once each, when they settle', async () => {
  const { command } = stub(readFileSync(FIXTURE, 'utf8'))
  const session = await OpenCodeRunAdapter.start({ cwd: REPO, role: 'implementer', command })
  await session.send('go', { kind: 'orchestrator' })
  await nextTurn(session)

  const snap = await session.snapshot()
  const tools = snap.turns[0]!.toolCalls
  // The recorded run called `read` then `edit`. A transition-counting implementation would
  // report each several times over, since a tool is reported at pending, running and
  // completed.
  assert.deepEqual(
    tools.map((t) => t.tool),
    ['read', 'edit'],
  )
  assert.ok(tools.every((t) => !t.failed))
  assert.match(tools[1]!.args!, /oldString/, 'tool input is retained as evidence')

  await session.close()
})

test('narration and the closing report are separated at the source', async () => {
  const { command } = stub(readFileSync(FIXTURE, 'utf8'))
  const session = await OpenCodeRunAdapter.start({ cwd: REPO, role: 'implementer', command })
  await session.send('go', { kind: 'orchestrator' })
  await nextTurn(session)

  const turn = (await session.snapshot()).turns[0]!
  // The two pty adapters disagreed silently about this field for a long time, each only
  // ever compared against itself. Here the closing block is the report and the full
  // narration is separate, so an advisor is never handed a stated intention as a result.
  assert.equal(turn.report, 'Done.')
  assert.ok(turn.assistantText!.endsWith('Done.'))

  await session.close()
})

test('the session id is learned, then used to resume', async () => {
  const body = readFileSync(FIXTURE, 'utf8')
  const { command, argvLog } = stub(body)
  const session = await OpenCodeRunAdapter.start({ cwd: REPO, role: 'implementer', command })

  await session.send('first', { kind: 'orchestrator' })
  await nextTurn(session)
  const learned = session.sessionId
  assert.match(learned, /^ses_/, 'the id comes from the records, not from us')

  await session.send('second', { kind: 'orchestrator' })
  await nextTurn(session)

  const argv = readFileSync(argvLog, 'utf8').trim().split('\n')
  assert.ok(!argv[0]!.includes('--session'), 'the first turn has no session to resume')
  assert.ok(
    argv[1]!.includes(`--session ${learned}`),
    'without --session every turn is a fresh context that still looks like a conversation',
  )
  await session.close()
})

test('a prompt that looks like a flag is not parsed as one', async () => {
  // `message..` is variadic and positional. The relay CLI already had to learn this the
  // expensive way -- `relay --help` once started two billed sessions -- and the same shape
  // of bug is reachable here through any prompt beginning with a dash.
  const { command, argvLog } = stub(readFileSync(FIXTURE, 'utf8'))
  const session = await OpenCodeRunAdapter.start({ cwd: REPO, role: 'implementer', command })
  await session.send('--help me understand this repository', { kind: 'orchestrator' })
  await nextTurn(session)

  const argv = readFileSync(argvLog, 'utf8')
  assert.match(argv, /-- --help me understand/, 'the prompt must follow a -- terminator')
  await session.close()
})

test('exit 0 without a stop record is NOT a completion', async () => {
  // Established live: a run can exit 0 having silently failed an auxiliary paid model call.
  // Treating exit status as evidence of a finished turn is precisely the error the
  // announced stop signal exists to avoid.
  // Filtered on parsed content rather than on the text: the fixture is raw OpenCode
  // output with no spaces in its JSON, and a substring match written from a pretty-printed
  // copy silently removed nothing at all.
  const truncated = readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((l) => parseRecord(l)?.part?.reason !== 'stop')
    .join('\n')
  const { command } = stub(truncated, 0)
  const session = await OpenCodeRunAdapter.start({ cwd: REPO, role: 'implementer', command })
  await session.send('go', { kind: 'orchestrator' })
  const events = await nextTurn(session)

  const end = events.find((e) => e.type === 'turn_end') as TurnEndEvent
  assert.equal(end.verdict.outcome, 'unknown_abnormal_end')
  assert.equal(end.synthesized, true, 'nothing announced this, so it is ours')
  assert.equal(end.verdict.confidence, 'assumed')
  await session.close()
})

test('per-step token accounting survives to the caller', async () => {
  const { command } = stub(readFileSync(FIXTURE, 'utf8'))
  const session = await OpenCodeRunAdapter.start({ cwd: REPO, role: 'implementer', command })
  const key = await session.send('go', { kind: 'orchestrator' })
  await nextTurn(session)

  // Neither pty adapter can report this. It is the direct measurement the rotation
  // experiments have had to infer -- see spikes/experiments/04-complaint-as-signal.md,
  // where peak context had to be reconstructed rather than read.
  const tokens = session.tokensFor(key)!
  assert.ok(tokens.total > 0)
  assert.ok(tokens.cacheRead > 0, 'cache reads are reported separately from fresh input')
  assert.ok(session.snapshotHashFor(key), 'a content hash per turn, for attribution')

  await session.close()
})

test('permission decisions are refused rather than silently accepted', async () => {
  const { command } = stub(readFileSync(FIXTURE, 'utf8'))
  const session = await OpenCodeRunAdapter.start({ cwd: REPO, role: 'implementer', command })
  // `run` has no dialog. Resolving quietly would let the relay believe it had decided
  // something that was never asked, and then wait for a turn that already decided itself.
  await assert.rejects(() => session.decidePermission('allow'), /settled by configuration/)
  await session.close()
})

test('a quiesced session cannot be given work', async () => {
  const { command } = stub(readFileSync(FIXTURE, 'utf8'))
  const session = await OpenCodeRunAdapter.start({ cwd: REPO, role: 'implementer', command })

  await session.quiesce()
  // Exact rather than promissory: between turns there is no child, so this is a statement
  // about capability and not about restraint.
  await assert.rejects(() => session.send('go', { kind: 'orchestrator' }), /quiesced/)

  await assert.rejects(() => session.unquiesce().then(() => session.beginRotation()), /quiesced/)
  await session.quiesce()
  await session.beginRotation()
  assert.equal(session.state, 'rotating')
  await session.close()
})

test('unknown record types are ignored, not fatal', () => {
  // An undocumented stdout format on a tool that ships often. Throwing on an unfamiliar
  // `type` would turn a harmless new event into a broken participant.
  assert.equal(parseRecord('{"type":"something_new_in_1_19","part":{}}')!.type, 'something_new_in_1_19')
  assert.equal(parseRecord('not json'), undefined)
  assert.equal(parseRecord(''), undefined)
  assert.equal(parseRecord('{"no":"type field"}'), undefined)
})

test('a binary that is not on PATH is a verdict, not a crash', async () => {
  // `spawn opencode ENOENT` emits an asynchronous 'error' event rather than throwing, so it
  // is not caught by anything that catches throws. Unhandled, it took the whole process down
  // with a stack trace: no verdict, no summary, no routing log -- the failure #32 was filed
  // about, reached by a path #32's fix does not cover.
  const session = await OpenCodeRunAdapter.start({
    cwd: REPO,
    role: 'implementer',
    command: '/nonexistent/definitely-not-here',
  })
  await session.send('go', { kind: 'orchestrator' })
  const end = (await nextTurn(session)).find((e) => e.type === 'turn_end') as TurnEndEvent

  // Not `unknown_abnormal_end`: we know exactly what happened, so it is not graded alongside
  // the genuinely ambiguous endings.
  assert.equal(end.verdict.outcome, 'transport_lost')
  assert.equal(end.verdict.confidence, 'proven')
  assert.match(end.verdict.provenance[0]!.detail, /not on PATH/)
  await session.close()
})
