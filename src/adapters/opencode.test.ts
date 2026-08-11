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


test('a cancelled turn settles even when a grandchild holds the stream open', async () => {
  // A killed child does not guarantee its stream ends. Its own children inherit stdout, so an
  // orphaned grandchild -- a bash tool, anything the CLI spawned -- keeps the pipe open after
  // the parent is gone. Measured directly: SIGTERM produced `exit` immediately and `close`
  // never, so the read loop never ended and the turn never settled.
  //
  // That is not a stub artefact. These agents spawn bash tools constantly, and `#exchange`
  // waits without a timeout by design, trusting the adapter to settle -- so a cancel that
  // never settles hangs the run with no ceiling to stop it.
  const dir = mkdtempSync(join(tmpdir(), 'orphan-'))
  const command = join(dir, 'stub')
  // `sh` dies on SIGTERM; the sleep it started does not, and it holds stdout.
  writeFileSync(command, '#!/bin/sh\nsleep 30\nexit 0\n')
  chmodSync(command, 0o755)

  const session = await OpenCodeRunAdapter.start({ cwd: REPO, role: 'implementer', command })
  await session.send('go', { kind: 'orchestrator' })
  await new Promise((r) => setTimeout(r, 300))

  const cancelledAt = Date.now()
  await session.cancel()
  const end = (await nextTurn(session)).find((e) => e.type === 'turn_end') as TurnEndEvent
  const settledIn = Date.now() - cancelledAt

  assert.equal(end.verdict.outcome, 'cancelled')
  assert.equal(end.verdict.confidence, 'proven', 'we own the process; killing it IS the cancel')
  // The DURATION is the assertion that discriminates. Before the fix this still reached
  // `cancelled` -- after 30 seconds, when the orphaned sleep finally exited. Asserting only
  // the outcome passes on the broken code and proves nothing; a cancel that waits out the
  // longest-lived grandchild is the defect, and in a real session that is a bash tool.
  assert.ok(settledIn < 5_000, `cancel must settle promptly, took ${settledIn}ms`)
  await session.close()
})

test("close('graceful') lets an in-flight turn settle before the stream closes", async () => {
  // The contract for `graceful` is "we are finished with it; reconcile, THEN SIGTERM and
  // wait". The waiting half was missing: the child was killed and the event queue closed in
  // the same breath, so a turn still in flight settled into a CLOSED stream and its verdict
  // was dropped.
  //
  // `snapshot()` still had it, and the seam explicitly permits that divergence -- but a
  // consumer following events() never learned how the LAST turn ended, which is the one it
  // most needs. Found by trying to capture `process_exited` from a live session and getting
  // nothing on the stream.
  const dir = mkdtempSync(join(tmpdir(), 'graceful-'))
  const command = join(dir, 'stub')
  writeFileSync(command, '#!/bin/sh\nsleep 30\nexit 0\n')
  chmodSync(command, 0o755)

  const session = await OpenCodeRunAdapter.start({ cwd: REPO, role: 'implementer', command })
  await session.send('go', { kind: 'orchestrator' })

  const seen: AgentEvent[] = []
  const collecting = (async () => {
    for await (const e of session.events()) seen.push(e)
  })()

  await new Promise((r) => setTimeout(r, 300))
  await session.close('graceful')
  await collecting

  const end = seen.find((e) => e.type === 'turn_end') as TurnEndEvent | undefined
  assert.ok(end, 'the verdict must reach a consumer following events()')
  assert.equal(end!.verdict.outcome, 'process_exited')
  // And it agrees with the canonical side, which is the property the seam promises.
  assert.equal((await session.snapshot()).turns.at(-1)!.state, 'process_exited')
})

test('a provider failure the child announced reaches the verdict', async () => {
  // OpenCode announces a failed provider call as a record of its own and then exits
  // non-zero. The parser ignored that record, so the run was graded
  // `unknown_abnormal_end (assumed)` from the exit code alone -- true, and no help at all:
  // the reason was in the stream and was thrown away, leaving `exit code 1` and nowhere to
  // go. Seen for real as `CreditsError: No payment method`.
  const error = JSON.stringify({
    type: 'error',
    sessionID: 'ses_1',
    error: { name: 'APIError', data: { message: 'No payment method. Add one here: ...', statusCode: 401 } },
  })
  // A cascade, because one failing call usually produces several and the last is vaguer
  // than the first.
  const second = JSON.stringify({ type: 'error', error: { name: 'AbortError', data: { message: 'aborted' } } })
  const { command } = stub(`${error}\n${second}\n`, 1)

  const session = await OpenCodeRunAdapter.start({ cwd: REPO, role: 'implementer', command })
  const events: AgentEvent[] = []
  void (async () => {
    for await (const e of session.events()) events.push(e)
  })()
  await session.send('go', { kind: 'orchestrator' })
  await new Promise((r) => setTimeout(r, 600))

  const end = events.find((e): e is TurnEndEvent => e.type === 'turn_end')
  assert.ok(end, 'the turn must settle')
  assert.equal(end.verdict.outcome, 'unknown_abnormal_end')
  const said = end.verdict.provenance.map((p) => `${p.source}: ${p.detail}`).join(' | ')
  assert.match(said, /exit code 1/, 'the exit is still reported')
  assert.match(said, /No payment method/, 'and so is what the child said went wrong')
  assert.match(said, /HTTP 401/)
  // The first error wins; the vaguer follow-up must not displace it.
  assert.doesNotMatch(said, /AbortError/)
  await session.close('graceful')
})

/**
 * A stand-in that emits `body` on stdout and `err` on stderr, then never exits, so only the
 * watchdog can end the turn.
 *
 * Separate from `stub` above rather than a flag on it: everything else in this file is about a
 * child that finishes, and a `sleep` in the common helper would be a trap for the next test.
 */
function hangingStub(body: string, err = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'oc-hang-'))
  const payload = join(dir, 'payload.ndjson')
  const errPath = join(dir, 'err.txt')
  writeFileSync(payload, body)
  writeFileSync(errPath, err)
  const command = join(dir, 'opencode-hang')
  writeFileSync(
    command,
    `#!/bin/sh\ncat ${JSON.stringify(payload)}\ncat ${JSON.stringify(errPath)} >&2\nsleep 30\n`,
  )
  chmodSync(command, 0o755)
  return command
}

/** The `orchestrator` caveat #82 adds to a deadline verdict, or undefined when absent. */
const launchCaveat = (end: TurnEndEvent): string | undefined =>
  end.verdict.provenance.find((p) => p.source === 'orchestrator' && /first run/.test(p.detail))?.detail

test('a first run that produced no records at all names the model it was launched with', async () => {
  // #82's second half on a run-per-turn adapter. This one builds its `timed_out` by hand rather
  // than through `classify`, so the diagnosis had to be added here too -- and a rule that exists
  // in one of the two shapes of timeout verdict is a rule an operator cannot rely on.
  const session = await OpenCodeRunAdapter.start({
    cwd: REPO,
    role: 'implementer',
    command: hangingStub(''),
    args: ['-m', 'opencode/not-a-model'],
    watchdogMs: 300,
  })
  await session.send('go', { kind: 'orchestrator' })
  const end = (await nextTurn(session)).find((e) => e.type === 'turn_end') as TurnEndEvent
  assert.equal(end.verdict.outcome, 'timed_out')
  assert.match(launchCaveat(end) ?? '', /opencode\/not-a-model/)
  assert.equal(end.verdict.provenance.find((p) => /not-a-model/.test(p.detail))?.caveat, true)
  await session.close()
})

test('a record the child sent but this adapter records no CONTENT for still suppresses the diagnosis', async () => {
  // The repair. `steps`, `textBlocks` and `toolCalls` all stay empty for an `error` record and
  // for a type this adapter has no case for -- so reading emptiness off them called a child that
  // had already announced a provider failure "silent", and named its model as the suspect over
  // the top of the child's own answer. Both shapes, because they miss the content fields for
  // different reasons: one is handled and stored somewhere else, one is not handled at all.
  for (const [why, body] of [
    ['an announced error', '{"type":"error","error":{"name":"ProviderError","data":{"message":"upstream 502"}}}\n'],
    ['a record type this adapter does not know', '{"type":"some_future_record","part":{}}\n'],
  ] as const) {
    const session = await OpenCodeRunAdapter.start({
      cwd: REPO,
      role: 'implementer',
      command: hangingStub(body),
      args: ['-m', 'opencode/not-a-model'],
      watchdogMs: 600,
    })
    await session.send('go', { kind: 'orchestrator' })
    const events = await nextTurn(session)
    // The gap this closes, pinned: NO content event was emitted for either record, so the three
    // content fields the check used to read are empty on a child that plainly spoke. Without
    // this line the test would still pass if the adapter started emitting messages for errors.
    assert.deepEqual(
      events.filter((e) => e.type === 'message' || e.type === 'tool_use'),
      [],
      `${why}: this record produces no content event, which is why the old check missed it`,
    )
    const end = events.find((e) => e.type === 'turn_end') as TurnEndEvent
    assert.equal(end.verdict.outcome, 'timed_out', `${why}: it still times out`)
    assert.equal(launchCaveat(end), undefined, `${why}: the child spoke, so the launch is not named`)
    await session.close()
  }
})

test('stderr is output too: a child that printed an error and hung is not blamed on its model', async () => {
  // The acceptance condition is "no output whatsoever", which is a claim about BYTES rather than
  // about the structured stream. A child that names a provider failure on stderr and then hangs
  // has already answered, and speculating about its model on top of that answer buries the one
  // line an operator needed. The verdict must carry that line, too -- it used to be discarded on
  // the killed path, so a watchdog kill reported the clock and the signal and nothing else.
  const session = await OpenCodeRunAdapter.start({
    cwd: REPO,
    role: 'implementer',
    command: hangingStub('', 'error: provider returned 502 for opencode/not-a-model\n'),
    args: ['-m', 'opencode/not-a-model'],
    watchdogMs: 600,
  })
  await session.send('go', { kind: 'orchestrator' })
  const events = await nextTurn(session)
  // Nothing was parsed and no content event exists: the ONLY thing this child produced is the
  // stderr line, which is what makes this the case the record counter alone still gets wrong.
  assert.deepEqual(events.filter((e) => e.type === 'message' || e.type === 'tool_use'), [])
  const end = events.find((e) => e.type === 'turn_end') as TurnEndEvent
  assert.equal(end.verdict.outcome, 'timed_out')
  assert.equal(launchCaveat(end), undefined, 'the child spoke, so the launch is not named')
  assert.ok(
    end.verdict.provenance.some((p) => /provider returned 502/.test(p.detail)),
    `the child's own answer must survive into the verdict: ${JSON.stringify(end.verdict.provenance)}`,
  )
  await session.close()
})

test('a run that produced records and then stalled is not blamed on its model', async () => {
  // The control, and the distinction: identical deadline, identical model, one difference --
  // this child spoke before it stopped.
  const session = await OpenCodeRunAdapter.start({
    cwd: REPO,
    role: 'implementer',
    command: hangingStub(readFileSync(FIXTURE, 'utf8').split('\n').slice(0, 3).join('\n') + '\n'),
    args: ['-m', 'opencode/not-a-model'],
    watchdogMs: 600,
  })
  await session.send('go', { kind: 'orchestrator' })
  const events = await nextTurn(session)
  const end = events.find((e) => e.type === 'turn_end') as TurnEndEvent
  assert.equal(end.verdict.outcome, 'timed_out', 'it still times out; only the diagnosis differs')
  assert.equal(launchCaveat(end), undefined)
  await session.close()
})
