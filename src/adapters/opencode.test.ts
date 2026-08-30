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
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
 import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { AgentEvent, TurnEndEvent } from '../contract/session.ts'
import { OpenCodeRunAdapter, parseRecord } from './opencode.ts'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const FIXTURE = join(REPO, 'spikes/opencode/fixtures/edit-turn.ndjson')

/**
 * The real `setTimeout`, captured at module load.
 *
 * Three tests below freeze the adapter's clock with `t.mock.timers` so a deadline can be
 * advanced deliberately instead of waited out. That replaces the global, and two of them still
 * need to wait in real time for a child process -- which is the one thing the frozen clock must
 * not be used for, since the whole point is that the deadline does not advance while it happens.
 */
const realSetTimeout = globalThis.setTimeout

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

test('a stream that ends on a tool call leaves no report, and says so rather than inventing one', async (t) => {
  // The shape observed live in session 20260822-075223-56541, the first run with an OpenCode
  // ADVISOR (#163). Three of its turns ended this way: the model's last act was a tool call,
  // `opencode` exited 0, and no `step-finish reason=stop` ever arrived. Turns whose last act
  // was an assistant message completed normally in the same run, so the discriminator is what
  // the model did last, not the adapter and not the exit code.
  //
  // Distinct from `exit 0 without a stop record is NOT a completion` above, which filters the
  // stop records out of a good fixture and therefore KEEPS the closing text. That is a stream
  // that spoke and lost its terminator. This one never spoke: no closing message exists, which
  // is why there is nothing to rebuild a report from -- the half that costs a run, and the half
  // a verdict-only assertion cannot see.
  //
  // Three subcases, one record apart each, because the differences between them are the whole
  // finding. Cutting after the tool leaves an ending nothing places. Cutting one line later --
  // after the `step_finish reason=tool-calls` the child itself emitted -- leaves an ending that
  // CAN be placed: the process stopped before a continuation the child had committed to. That
  // is not a cause. Nothing here says why the run stopped, and the verdict must not pretend
  // otherwise; what it buys is a record that says where. Cutting one line later again -- after
  // the promised `step_start` actually arrives -- takes it back, because the promise was kept
  // and there is no longer an announced next step for the exit to be before. All three are
  // synthesized. If the adapter grades the first two alike it loses the line that places one of
  // them; if it grades the third like the second it prints a claim that is simply false.
  const lines = readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim())
  const lastTool = lines.reduce((at, l, i) => (parseRecord(l)?.part?.type === 'tool' ? i : at), -1)
  assert.ok(lastTool >= 0, 'the fixture must contain a tool record for this test to truncate at')
  const afterTool = parseRecord(lines[lastTool + 1] ?? '')?.part
  assert.equal(
    afterTool?.type,
    'step-finish',
    'the fixture must follow its last tool with a step-finish for the second subcase to exist',
  )
  assert.equal(afterTool?.reason, 'tool-calls', 'and that step-finish must promise a further step')
  assert.equal(
    parseRecord(lines[lastTool + 2] ?? '')?.part?.type,
    'step-start',
    'and the promised step must actually arrive, for the third subcase to exist',
  )

  /** Replay the fixture truncated after line `cut`, and return everything up to `turn_end`. */
  const truncatedAt = async (cut: number): Promise<AgentEvent[]> => {
    const { command } = stub(lines.slice(0, cut + 1).join('\n'), 0)
    const session = await OpenCodeRunAdapter.start({ cwd: REPO, role: 'advisor', command })
    await session.send('go', { kind: 'orchestrator' })
    const events = await nextTurn(session)
    await session.close()
    return events
  }

  /**
   * The operator-facing half, identical in both subcases: a tool call was recorded, so the
   * child was heard and #82 must not name the model -- but no assistant message exists, so a
   * caller has no report and must be told that rather than handed silence dressed as a
   * completed turn.
   */
  const assertHeardButSilent = (events: AgentEvent[], end: TurnEndEvent): void => {
    const before = events.filter((e) => e.type !== 'turn_end')
    assert.ok(
      before.some((e) => e.type === 'tool_use'),
      'the child spoke -- a tool call is output, and the turn must not read as having produced nothing',
    )
    assert.equal(
      before.filter((e) => e.type === 'message').length,
      0,
      'no closing message: this is why there is nothing to rebuild a report from',
    )
    assert.equal(before.at(-1)?.type, 'tool_use', 'the last thing the child did was call a tool')
    // #82 blames the launch only when the child produced nothing at all. It produced a tool
    // call here, so a verdict that reaches for the model is talking over evidence it has.
    assert.equal(
      end.verdict.provenance.find((p) => /model/i.test(p.detail)),
      undefined,
      'the child was heard, so nothing in the record may point at the model it was launched with',
    )
  }

  await t.test('cut after the tool: nothing accounts for the ending', async () => {
    const events = await truncatedAt(lastTool)
    const end = events.find((e) => e.type === 'turn_end') as TurnEndEvent

    assert.equal(end.verdict.outcome, 'unknown_abnormal_end')
    assert.equal(end.verdict.confidence, 'assumed', 'exit 0 is not evidence the turn finished')
    assert.equal(end.synthesized, true, 'nothing announced this, so it is ours')

    // Read off the record rather than the outcome name: `assumed` has to be justified BY the
    // provenance, and a verdict that graded itself unknown while citing a claim from the child
    // would be citing evidence it is simultaneously saying it does not have.
    assert.equal(
      end.verdict.provenance.find((p) => p.source === 'announced'),
      undefined,
      'the child claimed nothing about this ending -- no hook may appear in the record',
    )
    assert.match(end.verdict.provenance[0]!.detail, /exit code 0, no step_finish reason=stop/)

    assertHeardButSilent(events, end)
  })

  await t.test('cut one record later: the child said a step was coming, then exited', async () => {
    const events = await truncatedAt(lastTool + 1)
    const end = events.find((e) => e.type === 'turn_end') as TurnEndEvent

    assert.equal(end.verdict.outcome, 'process_exited')
    assert.equal(end.verdict.confidence, 'proven', 'the child stated what came next; it never came')
    // Still ours. `reason=tool-calls` is a claim about the NEXT step, not about the turn, so
    // nothing here announced an ending -- promoting this to an announced completion because
    // the evidence got better would be the exact error the stop signal exists to prevent.
    assert.equal(end.synthesized, true, 'no turn end was announced -- only a further step was')

    assert.deepEqual(
      end.verdict.provenance.find((p) => p.source === 'announced'),
      { source: 'announced', detail: 'step_finish reason=tool-calls' },
      'the intermediate record the child emitted, kept verbatim as the reason this is proven',
    )
    assert.ok(
      end.verdict.provenance.some(
        (p) => p.source === 'process' && /exit code 0 before the announced next step/.test(p.detail),
      ),
      'and the exit, stated against the step it was owed rather than on its own',
    )
    assert.equal(
      end.verdict.provenance.find((p) => /reason=stop/.test(p.detail)),
      undefined,
      'the stop path is untouched: nothing here may read as a completion',
    )

    assertHeardButSilent(events, end)
  })

  await t.test('cut after the promised step arrives: the ending is unplaced again', async () => {
    // The guard on the clear. `stepOwed` latched for the rest of the turn would still pass the
    // subcase above while making this verdict say `exit code 0 before the announced next step`
    // about a run whose announced next step is right there in the stream. An operator reading
    // that would be reading a false statement, which is worse than the honest `assumed` -- so
    // the evidence going BACKWARDS one record later is the correct behaviour, not a gap.
    const events = await truncatedAt(lastTool + 2)
    const end = events.find((e) => e.type === 'turn_end') as TurnEndEvent

    assert.equal(end.verdict.outcome, 'unknown_abnormal_end')
    assert.equal(end.verdict.confidence, 'assumed', 'the promise was kept; nothing places this exit')
    assert.equal(end.synthesized, true, 'nothing announced this, so it is ours')

    assert.equal(
      end.verdict.provenance.find((p) => p.source === 'announced'),
      undefined,
      'the tool-calls claim was made good on, so it is no longer evidence about the ending',
    )
    assert.equal(
      end.verdict.provenance.find((p) => /announced next step/.test(p.detail)),
      undefined,
      'and the record must not say the exit preceded a step the stream shows arriving',
    )
    assert.match(end.verdict.provenance[0]!.detail, /exit code 0, no step_finish reason=stop/)

    assertHeardButSilent(events, end)
  })
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
  await session.send('go', { kind: 'orchestrator' })
  // Waited for, not slept through. This test sets no `watchdogMs`, so there is no deadline in
  // play at all and nothing here is about timing: it collected events into an array from a
  // detached loop and then gave the child a flat 600ms to spawn, print two records and exit 1.
  // That is a guess about how fast a machine is, and on a loaded one it is wrong -- six copies
  // of this file at load average ~9.5 failed `the turn must settle` in every run, on an adapter
  // that was working correctly and simply had not finished yet. `nextTurn` returns when the
  // turn ENDS, which is the event the assertions below are about.
  const events = await nextTurn(session)

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
 *
 * `exec sleep`, not `sleep`: without it the shell stays alive as the parent and `sleep` is a
 * grandchild holding the inherited stdout pipe, so SIGTERM ends the shell and leaves the stream
 * open -- the exact case the adapter's 250ms post-exit grace exists to survive. Replacing the
 * shell means one process owns the pipe, and killing it closes the stream directly. The
 * adapter's grace path is unchanged and still covered by a real child; this stub simply stops
 * making every hang test pay 250ms to prove something it is not about.
 */
function hangingStub(body: string, err = ''): { command: string; wrote: string } {
  const dir = mkdtempSync(join(tmpdir(), 'oc-hang-'))
  const payload = join(dir, 'payload.ndjson')
  const errPath = join(dir, 'err.txt')
  writeFileSync(payload, body)
  writeFileSync(errPath, err)
  const wrote = join(dir, 'wrote')
  const command = join(dir, 'opencode-hang')
  // The marker is created AFTER both writes return, and it is the only thing about this stub
  // that is not the child's own output -- a file on disk, carrying no bytes into the adapter
  // and producing no record, so a test can wait on it without altering what the adapter hears.
  writeFileSync(
    command,
    `#!/bin/sh\ncat ${JSON.stringify(payload)}\ncat ${JSON.stringify(errPath)} >&2\n` +
      `: > ${JSON.stringify(wrote)}\nexec sleep 30\n`,
  )
  chmodSync(command, 0o755)
  return { command, wrote }
}

/**
 * Wait until the stub has written its bytes, then let the adapter read them.
 *
 * Two halves, because they answer different questions. The marker answers "has the child
 * written yet", which is the part that blows out under load: it covers fork, exec, shell
 * startup and two `cat`s, and it is what a fixed deadline was really betting against. The
 * yields answer "has the parent read what is sitting in the pipe", which is a handful of
 * event-loop turns with the fd already readable -- `setImmediate` runs in the check phase, so
 * each turn traverses poll, where pipe data is delivered.
 *
 * `realSleep` is the pre-mock `setTimeout`, captured before `t.mock.timers.enable()` replaced
 * the global. The adapter's clock has to be frozen for the deadline to be advanced
 * deliberately, and this still has to wait in real time.
 *
 * What this does NOT do is prove the adapter counted anything: `turn.heard` is private and
 * `snapshot()` does not expose it, so unlike the `tool_use` proof in the stalled-run test
 * there is no observable to assert on. See the note in `docs/NOTES.md`.
 */
async function heardWhatWasWritten(wrote: string, realSleep: (ms: number) => Promise<void>): Promise<void> {
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
    // No barrier and no mocked clock: this stub writes nothing, so there is no precondition
    // to establish -- the assertion IS that nothing was heard.
    command: hangingStub('').command,
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

test('a record the child sent but this adapter records no CONTENT for still suppresses the diagnosis', async (t) => {
  // The repair. `steps`, `textBlocks` and `toolCalls` all stay empty for an `error` record and
  // for a type this adapter has no case for -- so reading emptiness off them called a child that
  // had already announced a provider failure "silent", and named its model as the suspect over
  // the top of the child's own answer. Both shapes, because they miss the content fields for
  // different reasons: one is handled and stored somewhere else, one is not handled at all.
  //
  // The clock is mocked and the fixture carries a barrier (#154). The precondition is that the
  // child's record reached the adapter before the deadline; against a real 600ms timer that was
  // a race with process spawn, and a loaded machine lost it 6 runs out of 6 -- turning this
  // assertion into its opposite, because a child that was never heard IS blamed on its model.
  // The barrier is content-neutral: a marker file the stub touches after its writes return,
  // which the adapter never sees.
  const realSleep = (ms: number): Promise<void> =>
    new Promise((r) => realSetTimeout(() => r(), ms))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // Restored on the way out however this test ends. A mocked clock is a GLOBAL: if an
  // assertion throws before a manual reset, the frozen `setTimeout` leaks into whatever runs
  // next, and the next test that waits on a real deadline never wakes. Measured -- that is
  // exactly what a failing negative control did here, hanging the file until it was killed.
  t.after(() => t.mock.timers.reset())
  for (const [why, body] of [
    ['an announced error', '{"type":"error","error":{"name":"ProviderError","data":{"message":"upstream 502"}}}\n'],
    ['a record type this adapter does not know', '{"type":"some_future_record","part":{}}\n'],
  ] as const) {
    const stub = hangingStub(body)
    const session = await OpenCodeRunAdapter.start({
      cwd: REPO,
      role: 'implementer',
      command: stub.command,
      args: ['-m', 'opencode/not-a-model'],
      watchdogMs: 600,
    })
    await session.send('go', { kind: 'orchestrator' })
    await heardWhatWasWritten(stub.wrote, realSleep)
    t.mock.timers.tick(600)
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

test('stderr is output too: a child that printed an error and hung is not blamed on its model', async (t) => {
  // The acceptance condition is "no output whatsoever", which is a claim about BYTES rather than
  // about the structured stream. A child that names a provider failure on stderr and then hangs
  // has already answered, and speculating about its model on top of that answer buries the one
  // line an operator needed. The verdict must carry that line, too -- it used to be discarded on
  // the killed path, so a watchdog kill reported the clock and the signal and nothing else.
  //
  // Mocked clock and the same content-neutral barrier as above (#154): the stderr byte has to
  // reach the adapter before the deadline, and against a real timer that was a race this
  // machine lost under load in every run.
  const realSleep = (ms: number): Promise<void> =>
    new Promise((r) => realSetTimeout(() => r(), ms))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // Restored on the way out however this test ends. A mocked clock is a GLOBAL: if an
  // assertion throws before a manual reset, the frozen `setTimeout` leaks into whatever runs
  // next, and the next test that waits on a real deadline never wakes. Measured -- that is
  // exactly what a failing negative control did here, hanging the file until it was killed.
  t.after(() => t.mock.timers.reset())
  const stub = hangingStub('', 'error: provider returned 502 for opencode/not-a-model\n')
  const session = await OpenCodeRunAdapter.start({
    cwd: REPO,
    role: 'implementer',
    command: stub.command,
    args: ['-m', 'opencode/not-a-model'],
    watchdogMs: 600,
  })
  await session.send('go', { kind: 'orchestrator' })
  await heardWhatWasWritten(stub.wrote, realSleep)
  t.mock.timers.tick(600)
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

test('a run that produced records and then stalled is not blamed on its model', async (t) => {
  // The control, and the distinction: identical deadline, identical model, one difference --
  // this child spoke before it stopped.
  //
  // The deadline is MOCKED rather than waited out. What this test asserts is an ORDER -- the
  // child's records were parsed before the clock fired -- and against a real timer that order
  // is a race between 600ms and a process spawn plus three lines of parsing, which a loaded
  // machine can lose. It did: this is one of the two flakes recorded in #154, and losing it
  // turns the assertion below into its opposite, because an unheard child IS blamed on its
  // model.
  //
  // So the clock does not run until the precondition is PROVEN. `tool_use` is that proof --
  // the fixture's second record parsed all the way through to an event -- and only then is
  // the deadline advanced, deliberately, by exactly its own length. 600ms is unchanged; the
  // fix is that the number no longer has to beat anything.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // Restored on the way out however this test ends. A mocked clock is a GLOBAL: if an
  // assertion throws before a manual reset, the frozen `setTimeout` leaks into whatever runs
  // next, and the next test that waits on a real deadline never wakes. Measured -- that is
  // exactly what a failing negative control did here, hanging the file until it was killed.
  t.after(() => t.mock.timers.reset())
  const session = await OpenCodeRunAdapter.start({
    cwd: REPO,
    role: 'implementer',
    command: hangingStub(readFileSync(FIXTURE, 'utf8').split('\n').slice(0, 3).join('\n') + '\n').command,
    args: ['-m', 'opencode/not-a-model'],
    watchdogMs: 600,
  })
  // One iterator across both phases: `AsyncQueue` is single-consumer, and a second `for await`
  // over `events()` would wait for events the first had already taken.
  const stream = session.events()[Symbol.asyncIterator]()
  const until = async (want: AgentEvent['type']): Promise<AgentEvent[]> => {
    const seen: AgentEvent[] = []
    for (let n = await stream.next(); !n.done; n = await stream.next()) {
      seen.push(n.value)
      if (n.value.type === want) break
    }
    return seen
  }

  await session.send('go', { kind: 'orchestrator' })
  // Nothing can end this turn while the only clock in the adapter is stopped, so this waits
  // for the child rather than racing it.
  const spoke = await until('tool_use')
  assert.ok(
    spoke.some((e) => e.type === 'tool_use'),
    'the recorded run must have been parsed, or the control proves nothing',
  )

  t.mock.timers.tick(600)

  const end = (await until('turn_end')).find((e) => e.type === 'turn_end') as TurnEndEvent
  assert.equal(end.verdict.outcome, 'timed_out', 'it still times out; only the diagnosis differs')
  assert.equal(launchCaveat(end), undefined)
  // Restored before `close()`, which has timers of its own and no reason to be tested here.
  await session.close()
})

/**
 * A child that emits its records, then IGNORES SIGTERM.
 *
 * The only way to reach `close('graceful')`'s three-second cap on purpose. `hangingStub`'s
 * `sleep` dies on SIGTERM and never gets there, so the cap and everything past it -- the
 * escalation, and the event that says a verdict was lost -- had no test at all (#146).
 */
function deafStub(body: string): { command: string; wrote: string } {
  const dir = mkdtempSync(join(tmpdir(), 'oc-deaf-'))
  const payload = join(dir, 'payload.ndjson')
  writeFileSync(payload, body)
  const wrote = join(dir, 'wrote')
  const command = join(dir, 'opencode-deaf')
  writeFileSync(
    command,
    `#!/bin/sh\ntrap '' TERM\ncat ${JSON.stringify(payload)}\n: > ${JSON.stringify(wrote)}\n` +
      `while :; do sleep 1; done\n`,
  )
  chmodSync(command, 0o755)
  return { command, wrote }
}

test('#146 a graceful close that gives up says so, and escalates', async () => {
  // Three defects in one path, and none of them had a test. On expiry the stream closed over a
  // live turn with no `turn_end` and no `error`, so a consumer following events() could not tell
  // a missing verdict from a pending one; and the child was left running after `close()`
  // returned with the session reporting `terminated`.
  const started = readFileSync(FIXTURE, 'utf8').split('\n').slice(0, 2).join('\n')
  const { command, wrote } = deafStub(`${started}\n`)
  const session = await OpenCodeRunAdapter.start({ cwd: REPO, role: 'implementer', command })

  const seen: AgentEvent[] = []
  const reading = (async () => {
    for await (const e of session.events()) seen.push(e)
  })()

  await session.send('do the thing', { kind: 'orchestrator' })
  // Wait for the child to have written, so the turn is genuinely in flight rather than racing
  // the spawn -- the same marker `hangingStub` uses, and for the same reason.
  for (let i = 0; i < 200 && !existsSync(wrote); i += 1) await new Promise((r) => setTimeout(r, 25))
  assert.ok(existsSync(wrote), 'the child must have started before the close is meaningful')

  await session.close('graceful')
  await reading

  const lost = seen.find((e) => e.type === 'error' && /no terminal verdict was observed/.test(e.message))
  assert.ok(lost, `the lost verdict must be announced: ${JSON.stringify(seen.map((e) => e.type))}`)
  assert.equal(lost.type === 'error' ? lost.fatal : true, false, 'the run may continue; only this turn is unknown')
  // And nothing claimed the turn ended, because nothing saw it end.
  assert.equal(seen.find((e) => e.type === 'turn_end'), undefined, 'no verdict may be invented')

  // ESCALATED. `contract/session.ts` says "always SIGTERM and wait before escalating", and this
  // path never did -- so a child that ignores SIGTERM outlived `close()` while the session
  // reported `terminated`. Checked by looking for the process, because a leak is not visible
  // from anything the adapter says about itself.
  await new Promise((r) => setTimeout(r, 200))
  const alive = spawnSync('pgrep', ['-f', command], { encoding: 'utf8' }).stdout.trim()
  assert.equal(alive, '', `the child must not outlive close(); still running as ${alive}`)
})

/**
 * A child that ignores SIGTERM, then finishes its turn shortly after.
 *
 * The only shape that reaches the leak. A turn already finished at close time returns before
 * either timer is created -- so a "fast close" test exercises no timer at all, which is what the
 * first version of the test below did and why removing `clearTimeout` did not fail it.
 */
function slowFinishStub(head: string, tail: string): { command: string; wrote: string } {
  const dir = mkdtempSync(join(tmpdir(), 'oc-slow-'))
  const headPath = join(dir, 'head.ndjson')
  const tailPath = join(dir, 'tail.ndjson')
  writeFileSync(headPath, head)
  writeFileSync(tailPath, tail)
  const wrote = join(dir, 'wrote')
  const command = join(dir, 'opencode-slow')
  writeFileSync(
    command,
    `#!/bin/sh\ntrap '' TERM\ncat ${JSON.stringify(headPath)}\n: > ${JSON.stringify(wrote)}\n` +
      `sleep 0.4\ncat ${JSON.stringify(tailPath)}\nexit 0\n`,
  )
  chmodSync(command, 0o755)
  return { command, wrote }
}

test('#146 a graceful close whose turn finishes does not hold the loop for the rest of the cap', async () => {
  // The `clearTimeout(cap)` the poll branch never did. Both timers are deliberately ref'd, so a
  // turn that completes 400ms into a three-second cap left 2.6 seconds of pending timer holding
  // the event loop open -- after the close had already returned.
  //
  // Measured in a child process, because that is where the symptom is: in-process the leak
  // delays nothing observable. What it delays is the process being ABLE TO EXIT.
  const records = readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean)
  const { command } = slowFinishStub(`${records.slice(0, 2).join('\n')}\n`, `${records.slice(2).join('\n')}\n`)
  const script = `
    import { OpenCodeRunAdapter } from ${JSON.stringify(join(REPO, 'src/adapters/opencode.ts'))}
    const s = await OpenCodeRunAdapter.start({ cwd: ${JSON.stringify(REPO)}, role: 'implementer', command: ${JSON.stringify(command)} })
    const seen = (async () => { for await (const e of s.events()) { /* drain */ } })()
    await s.send('go', { kind: 'orchestrator' })
    await new Promise((r) => setTimeout(r, 150))   // close while the turn is still open
    await s.close('graceful')
  `
  const file = join(mkdtempSync(join(tmpdir(), 'oc-timer-')), 'probe.mjs')
  writeFileSync(file, script)

  const began = Date.now()
  const { status } = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 20_000 })
  const took = Date.now() - began

  assert.equal(status, 0, 'the probe must run cleanly')
  // The turn finishes ~400ms in. With the cap left pending the process cannot exit until 3s;
  // with it cleared it exits as soon as the work is done. Two seconds separates those
  // unambiguously and is not a performance budget.
  assert.ok(took < 2_000, `a completed turn must not hold the loop for the rest of the cap; exited after ${took}ms`)
})

test('#52 a hookless adapter never claims a hook, and the claim is checked against the real adapter', async () => {
  // `provenance` says WHY a verdict is believed, and it is what an auditor reads when deciding
  // how much a `completed (proven)` is worth. OpenCode's headline property is that its terminal
  // signal is announced by the child on a documented output mode -- no hook registration, no
  // sidecar, no trust decision. Recording it as `hook:` erased exactly that, and sent a reader
  // looking in `.claude/settings.json` for a handler that will never be there.
  //
  // Driven through a real turn rather than asserted about the source text, so a future path that
  // records provenance somewhere new is covered by construction.
  const { command } = stub(readFileSync(FIXTURE, 'utf8'))
  const session = await OpenCodeRunAdapter.start({ cwd: REPO, role: 'implementer', command })
  await session.send('Edit calc.py so add() returns a + b.', { kind: 'orchestrator' })
  const events = await nextTurn(session)

  const sources = events
    .filter((e): e is TurnEndEvent => e.type === 'turn_end')
    .flatMap((e) => e.verdict.provenance.map((p) => p.source))
  assert.ok(sources.length > 0, 'the turn must carry provenance, or this asserts nothing')
  assert.equal(
    sources.filter((s) => s === 'hook').length,
    0,
    `an adapter that registers no hooks must not cite one: ${sources.join(', ')}`,
  )
  assert.ok(sources.includes('announced'), 'and it says what it actually is')
})

test('#48 the declared absence of a silence clock is OBSERVED, not read off the source', async () => {
  // `RUN_PER_TURN_DEADLINES` declares `silence: { supported: false }` for this adapter, and that
  // claim was argued from the code rather than exercised — the one set of assertions in this
  // project exempt from the grading `conformance/capabilities.ts` applies to everything else.
  //
  // It is load-bearing in a way that bites quietly: a seat with no silence clock goes quiet
  // FOREVER and produces no verdict. A reader trusting `supported: false` correctly waits for
  // nothing; a reader trusting it wrongly waits for a timeout that arrives and is attributed to
  // nothing.
  //
  // Observed rather than waited out. `DEFAULT_IDLE_MS` is twelve minutes, so the test is not
  // "no silence timeout in twelve minutes" but the stronger and faster claim: with an absolute
  // bound set, the ONLY deadline that fires is that one, at that bound, in its own words. A
  // silence clock would be a second timer with a different detail and an earlier deadline.
  const { command } = hangingStub('')
  const session = await OpenCodeRunAdapter.start({
    cwd: REPO,
    role: 'implementer',
    command,
    watchdogMs: 700,
  })
  try {
    const seen: AgentEvent[] = []
    const reading = (async () => {
      for await (const e of session.events()) {
        seen.push(e)
        if (e.type === 'turn_end') break
      }
    })()
    await session.send('go quiet', { kind: 'orchestrator' })

    // Well past anything a short idle clock would use, and well inside the absolute bound.
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
    // Its own words. A silence timeout would not say this, and this is the only timeout there is.
    assert.match(
      end.verdict.provenance.map((p) => p.detail).join(' '),
      /no terminal record within 700ms/,
      'the deadline that fired is the absolute one, named as such',
    )
  } finally {
    await session.close('abandoned').catch(() => undefined)
  }
})
