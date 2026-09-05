/**
 * What a deadline MEANS, decided against the child's own transcript (#36).
 *
 * A clock cannot tell two very different children apart. One is stuck mid-work; the other
 * finished normally and its `Stop` hook never arrived. Both produce the same event -- silence --
 * and both used to produce the same verdict, `timed_out`, on which the run then did the same
 * thing. That is one label over two populations that want opposite handling: the first must not
 * be sent to (#117), and the second is simply done and holding the run up for nothing (#107).
 *
 * The transcript separates them, and it was already parsed and already polled. A turn the child
 * finished carries `stop_reason=end_turn`; a turn it is still working on does not.
 * `#reconcileFromTranscript` knew how to read that and ran only on exit and on close, so a run
 * learned the truth about a lost `Stop` once the session was already over.
 *
 * So these drive the real adapter and write the transcript by hand -- the one thing a stand-in
 * CLI cannot be made to get wrong on purpose -- and check every answer:
 *
 *   the transcript proves completion    the verdict is superseded, and the session is sendable
 *   the transcript shows work ongoing   the verdict stands, and a send is refused
 *   the transcript cannot be read       the verdict stands, and a send is refused
 *   the transcript is read too SLOWLY   the verdict stands, and a send is refused, EVEN AFTER
 *                                       the read lands with proof of completion in it
 *   input is externally owned           the deadline verdict is degraded, and the recovery
 *                                       still works, because ownership weakens attribution of
 *                                       an unseen ending and not a record the child wrote
 *
 * The two failure cases are separate on purpose and neither stands in for the other. Unreadable
 * is an answer that never arrives; too-slow is an answer that arrives after nobody is listening,
 * and it is the more dangerous of the two precisely because it CONTAINS the proof -- a bound
 * that only stopped the caller waiting, and let the late answer act anyway, would close the
 * transport and supersede a verdict at a moment chosen by the filesystem.
 *
 * "No evidence" must not mean "finished", because an unreadable transcript and a wedged child
 * have causes in common -- so the case where the check fails is exactly the case where guessing
 * completion would hurt.
 *
 * Real adapters over a fake child: see `fakeCli.ts`.
 */

import { strict as assert } from 'node:assert'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type { AgentEvent, AgentSession, TurnEndEvent } from '../contract/session.ts'
import { ClaudePtyHookAdapter } from './claude.ts'
import { installFakeClis } from './fakeCli.ts'
import { containAdapterRunDirs, tempDir } from '../testkit/tempDir.ts'

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
const ADAPTER_TMP_ROOT = containAdapterRunDirs()

const { dir: RUN } = installFakeClis()

/**
 * Short enough that the deadline lands promptly, long enough to survive a hook round trip.
 *
 * The silence clock rather than the absolute one, because that is what a real hang trips first
 * and because the absolute one must stay far out of reach: a turn ended by the wrong clock would
 * still be `timed_out` and the test would pass for a reason it never checked.
 */
const IDLE_MS = 1_500
const ABSOLUTE_MS = 120_000

const userRecord = (content: string): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content } })

/** An assistant record that ENDS the turn: `stop_reason=end_turn` is what `parseClaude` reads. */
const finishedRecord = (text: string): string =>
  JSON.stringify({
    type: 'assistant',
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] },
  })

/** An assistant record mid-flight: narration and a tool call, and no stop_reason. */
const workingRecord = (text: string): string =>
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
  })

/** Collect events until `done`, or give up. Returns what it saw either way. */
async function collect(
  session: AgentSession,
  done: (e: AgentEvent[]) => boolean,
  timeoutMs: number,
): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = []
  const deadline = Date.now() + timeoutMs
  const it = session.events()[Symbol.asyncIterator]()
  while (Date.now() < deadline) {
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

const endsOf = (e: AgentEvent[]): TurnEndEvent[] => e.filter((x) => x.type === 'turn_end') as TurnEndEvent[]

/**
 * Start a claude session whose child announces `transcript`, with the deadline clocks above.
 *
 * The env var is read by the stand-in CLI when it is spawned, so each test gets its own file and
 * nothing it writes can reach another test's session.
 */
async function sessionOver(
  transcript: string,
  inputOwnership: 'mediated' | 'external' = 'mediated',
): Promise<AgentSession> {
  const previous = process.env['ORCH_FAKE_TRANSCRIPT']
  process.env['ORCH_FAKE_TRANSCRIPT'] = transcript
  try {
    return await ClaudePtyHookAdapter.start({
      cwd: RUN,
      role: 'implementer',
      inputOwnership,
      watchdogMs: ABSOLUTE_MS,
      idleMs: IDLE_MS,
      readyTimeoutMs: 20_000,
    })
  } finally {
    if (previous === undefined) delete process.env['ORCH_FAKE_TRANSCRIPT']
    else process.env['ORCH_FAKE_TRANSCRIPT'] = previous
  }
}

function scratch(t: TestContext, name: string): string {
  return join(tempDir(t, 'orch-deadline'), name)
}

test('claude: a deadline on a turn the transcript shows FINISHED is superseded by completed', async (t) => {
  // The lost-`Stop` population, which is #107's nine pauses in one afternoon: a child that did
  // the work, wrote it down, and whose hook never arrived. Before this the run held that seat up
  // and asked a human about a turn that had been over for minutes.
  const transcript = scratch(t, 'finished.jsonl')
  // Written before the session starts, so the ordinary tailer has no NEW content to emit while
  // the turn runs. That keeps the silence clock free of touches, which is what makes the
  // deadline land on schedule -- and it means every event this test reads comes from the
  // deadline path rather than from ordinary narration.
  writeFileSync(transcript, [userRecord('hang please'), finishedRecord('all done, actually')].join('\n') + '\n')
  const session = await sessionOver(transcript)
  try {
    await session.send('hang please', { kind: 'orchestrator' })
    const events = await collect(
      session,
      (e) => endsOf(e).some((x) => x.verdict.outcome === 'completed'),
      20_000,
    )

    const ends = endsOf(events)
    const first = ends[0]
    assert.ok(first, `the deadline must fire first: ${JSON.stringify(events.map((e) => e.type))}`)
    assert.equal(first.verdict.outcome, 'timed_out', 'the clock reports what it sees, which is silence')
    assert.equal(first.transportOpen, true, 'and says the child was never seen to stop')

    // Withdrawn by number, through the ordinary late-signal path -- the same road a late `Stop`
    // takes, because it is the same fact arriving by a different route.
    const revision = events.find((e) => e.type === 'revision' && e.replaces.includes(first.seq)) as
      | Extract<AgentEvent, { type: 'revision' }>
      | undefined
    assert.ok(revision, `the deadline verdict must be withdrawn: ${JSON.stringify(events.map((e) => e.type))}`)
    assert.equal(revision.reason, 'late_signal')

    const last = ends.at(-1)!
    assert.equal(last.verdict.outcome, 'completed', 'the transcript proved the turn ended')
    assert.notEqual(last.transportOpen, true, 'and the child is no longer executing anything')

    // The whole point of the exercise: the seat is usable again, with no cancel and no rotation.
    const key = await session.send('now the next thing', { kind: 'orchestrator' })
    assert.ok(String(key).length > 0, 'a turn proven finished must leave the session sendable')
  } finally {
    await session.close()
  }
})

test('claude: a deadline on a turn the transcript shows IN PROGRESS stands, and refuses a send', async (t) => {
  // The other population, and #117's whole subject. The child is mid-work: narration and a tool
  // call on the record, no `stop_reason`. Nothing has observed it stop, so nothing may be typed
  // at it -- neither CLI accepts input mid-turn, and what lands there is spliced into the turn.
  const transcript = scratch(t, 'working.jsonl')
  writeFileSync(transcript, [userRecord('hang please'), workingRecord('still working on it')].join('\n') + '\n')
  const session = await sessionOver(transcript)
  try {
    await session.send('hang please', { kind: 'orchestrator' })
    const events = await collect(session, (e) => endsOf(e).length > 0, 20_000)

    const ends = endsOf(events)
    assert.equal(ends.length, 1, 'one verdict, and nothing that supersedes it')
    assert.equal(ends[0]!.verdict.outcome, 'timed_out')
    assert.equal(ends[0]!.transportOpen, true, 'the child may still be running, and the event says so')

    // Give the re-check every chance to have run and got it wrong.
    await new Promise((r) => setTimeout(r, 1_000))
    assert.equal(
      endsOf(await collect(session, () => true, 200)).length,
      0,
      'no second verdict may arrive: the transcript never proved this turn ended',
    )

    await assert.rejects(
      session.send('are you there', { kind: 'orchestrator' }),
      /turn is already open/,
      'a turn with no evidence of ending must not be sent into',
    )
  } finally {
    await session.close()
  }
})

test('claude: a transcript that cannot be read leaves the deadline exactly as it was', async (t) => {
  // The deliberate default, and the uncomfortable one. Reading a directory throws, which stands
  // in for the ways the check can produce NO ANSWER AT ALL: no transcript announced, a file that
  // is gone, or a record set too ambiguous to credit this turn.
  //
  // Not for a read that is too slow. That one is a different failure -- an answer that arrives
  // after the bound, carrying proof -- and it has its own test below, because a fix that
  // satisfies this case can still get that one wrong.
  //
  // All of these keep `timed_out` and keep the transport open. Treating "cannot tell" as
  // "finished" would reopen #117 on precisely the runs where the evidence is hardest to get --
  // and that is not a coincidence, since an unreadable transcript and a wedged child have causes
  // in common.
  const unreadable = tempDir(t, 'orch-deadline-dir')
  const session = await sessionOver(unreadable)
  try {
    await session.send('hang please', { kind: 'orchestrator' })
    const events = await collect(session, (e) => endsOf(e).length > 0, 20_000)

    const ends = endsOf(events)
    assert.equal(ends.length, 1)
    assert.equal(ends[0]!.verdict.outcome, 'timed_out', 'an unreadable transcript proves nothing')
    assert.equal(ends[0]!.transportOpen, true)
    assert.ok(
      !events.some((e) => e.type === 'revision' && e.reason === 'late_signal'),
      'and nothing may be withdrawn on the strength of a read that failed',
    )
    await assert.rejects(session.send('are you there', { kind: 'orchestrator' }), /turn is already open/)
  } finally {
    await session.close()
  }
})

test('claude: EXTERNAL input ownership still recovers a turn the transcript proves finished', async (t) => {
  // The ownership branch, on the Claude adapter this time. `#reconsiderDeadline` runs from the
  // watchdog callback, and under external ownership that callback's verdict is
  // `unknown_abnormal_end (uncertain)` rather than `timed_out`: the deadline rule degrades its
  // own claim, because a keystroke nobody saw could have ended the turn and it will not pretend
  // otherwise. Gating the re-check on `timed_out` alone skipped it on exactly these sessions --
  // a human sitting at the same terminal -- so a lost `Stop` held the seat for the whole run.
  //
  // The degradation is about ATTRIBUTING AN UNSEEN ENDING. It says nothing about what the child
  // wrote in its own file: `stop_reason=end_turn` is positive proof the turn finished, and who
  // else could type at the terminal does not weaken it. Both adapters carry the same gate, so
  // both carry this test.
  const transcript = scratch(t, 'finished-external.jsonl')
  writeFileSync(
    transcript,
    [userRecord('hang please'), finishedRecord('finished while you were away')].join('\n') + '\n',
  )
  const session = await sessionOver(transcript, 'external')
  try {
    assert.equal(session.guarantees.inputOwnership, 'external', 'precondition: the seat is externally owned')

    await session.send('hang please', { kind: 'orchestrator' })
    const events = await collect(
      session,
      (e) => endsOf(e).some((x) => x.verdict.outcome === 'completed'),
      20_000,
    )

    const ends = endsOf(events)
    const first = ends[0]
    assert.ok(first, `the deadline must fire first: ${JSON.stringify(events.map((e) => e.type))}`)
    assert.equal(
      first.verdict.outcome,
      'unknown_abnormal_end',
      'the ownership-degraded verdict is what the clock mints here, and it is what must be re-checked',
    )
    assert.equal(first.verdict.confidence, 'uncertain')
    assert.equal(first.transportOpen, true)

    const revision = events.find((e) => e.type === 'revision' && e.replaces.includes(first.seq)) as
      | Extract<AgentEvent, { type: 'revision' }>
      | undefined
    assert.ok(
      revision,
      `the degraded verdict must be withdrawn too: ${JSON.stringify(events.map((e) => e.type))}`,
    )
    assert.equal(revision.reason, 'late_signal')

    const last = ends.at(-1)!
    assert.equal(last.verdict.outcome, 'completed', 'positive transcript proof survives external ownership')
    assert.notEqual(last.transportOpen, true)

    const key = await session.send('now the next thing', { kind: 'orchestrator' })
    assert.ok(String(key).length > 0, 'and the seat is usable again, exactly as under mediated input')
  } finally {
    await session.close()
  }
})

test('claude: a re-check that lands AFTER its bound proves nothing, even holding proof of completion', async (t) => {
  // The case the bound exists for, driven end to end rather than argued from a unit test.
  //
  // The transcript here is the SAME one the first test in this file recovers from: it proves the
  // turn finished. The only difference is when the read lands. `TranscriptSessionView.snapshot()`
  // is gated after it has obtained that terminal snapshot and held past
  // `DEADLINE_TRANSCRIPT_MS`, which is exactly the shape of a transcript on a network mount or
  // one large enough that parsing it is measurable.
  //
  // What must happen when it is finally released is NOTHING observable. No `late_signal`, no
  // second `turn_end`, no closed transport, and a send still refused. The deadline concluded it
  // had no answer; an answer arriving afterwards would contradict that conclusion at a moment
  // chosen by the filesystem, and the run would declare a seat sendable long after it declared
  // the opposite with nothing in the stream to explain the order.
  //
  // A `Promise.race` bound alone passes every assertion up to the release and fails after it:
  // the loser keeps running with all its side effects intact. That is why abandonment is a token
  // the job checks rather than a race the caller wins.
  //
  // The prototype is patched rather than a seam being added to the adapter. A production-only
  // hook for slowness would be a code path no run ever takes, and the thing under test is the
  // real `#reconcileFromTranscript` against a real slow read -- so the slowness goes where the
  // slowness would be. Restored in `finally`, before the session is closed, because `close()`
  // reconciles too and would otherwise wait on a gate nobody is going to open.
  const { TranscriptSessionView } = await import('../transcript/reconcile.ts')
  const original = TranscriptSessionView.prototype.snapshot

  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  let held = 0
  let armed = false

  TranscriptSessionView.prototype.snapshot = async function (this: InstanceType<typeof TranscriptSessionView>) {
    const snap = await original.call(this)
    // Hold ONE read, and only the one this test is about.
    //
    // `armed` matters: `send()` takes its own snapshot first, to record how many turns the
    // transcript held BEFORE the prompt was typed (`#transcriptTurns`, the submit-landed
    // check). Gating that one wedges the send itself and the deadline never even arms -- which
    // is a hang, not a failing assertion, and it looks nothing like the bug under test. So the
    // gate opens for business only once the send has returned.
    //
    // `held === 0` matters too: holding every read afterwards would stall the ordinary tailer
    // and the close path as well. The claim here is about a re-check that succeeded TOO LATE,
    // not about a view that stopped working.
    //
    // The predicate is load-bearing rather than decorative. Holding a snapshot with no terminal
    // record would prove nothing -- an abandoned read that had no answer anyway is not a test
    // of anything -- so the read that gets held is required to be one carrying proof.
    if (armed && held === 0 && snap.turns.some((t) => t.state === 'completed')) {
      held++
      await gate
    }
    return snap
  }

  const transcript = scratch(t, 'slow.jsonl')
  writeFileSync(transcript, [userRecord('hang please'), finishedRecord('all done, actually')].join('\n') + '\n')
  let session: AgentSession | undefined
  try {
    session = await sessionOver(transcript)
    await session.send('hang please', { kind: 'orchestrator' })
    // The send's own baseline read is behind us; the next one carrying proof is the deadline's.
    armed = true
    const events = await collect(session, (e) => endsOf(e).length > 0, 20_000)

    const ends = endsOf(events)
    assert.equal(ends.length, 1, 'the clock fires once and nothing has superseded it yet')
    assert.equal(ends[0]!.verdict.outcome, 'timed_out')
    assert.equal(ends[0]!.transportOpen, true, 'the child was never seen to stop')

    // Past the bound. The re-check is still inside its read; the caller has already given up.
    await new Promise((r) => setTimeout(r, 2_500))
    assert.equal(held, 1, 'precondition: the re-check really did reach a terminal snapshot and was held there')

    // Now let it land, carrying the proof. This is the moment the whole test exists for.
    release()
    const after = await collect(session, () => false, 2_000)

    assert.deepEqual(
      endsOf(after).map((e) => e.verdict.outcome),
      [],
      'an abandoned re-check may not emit a second verdict, however good its evidence',
    )
    assert.ok(
      !after.some((e) => e.type === 'revision' && e.reason === 'late_signal'),
      `and may not withdraw the one that stands: ${JSON.stringify(after.map((e) => e.type))}`,
    )
    await assert.rejects(
      session.send('are you there', { kind: 'orchestrator' }),
      /turn is already open/,
      'the transport must still be open: nothing the run acted on ever observed the child stop',
    )
  } finally {
    // Order matters. Release first so nothing is waiting on the gate, restore the prototype so
    // no later test in this file inherits the patch, and only then close -- `close()` reconciles
    // from the transcript on its way out.
    release()
    TranscriptSessionView.prototype.snapshot = original
    await session?.close()
  }
})
