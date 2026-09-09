/**
 * The operator's checkpoint: a pause scheduled before the condition exists (`operator_checkpoint`).
 *
 *   node --test src/relay/checkpoint.test.ts
 *
 * Every other `PauseReason` is raised by something going wrong, or by an operator reacting to a
 * run already in front of them. This one is armed in ADVANCE -- at `Relay.start`, or through
 * `RunHandle.armMilestone` while the run is going -- and fires when the advisor judges that the
 * thing the operator named has happened and says so in ordinary reply prose.
 *
 * ## What is actually at risk here, and what these files therefore test
 *
 * A checkpoint is worth nothing unless it FAILS CLOSED. The failure that matters is not a pause
 * that does not fire; it is a run that ENDS before the checkpoint could fire, because that run's
 * record is indistinguishable from one whose milestone was reached and released. An operator who
 * armed a checkpoint and got back a completed run has no way to tell "you saw it and let it go"
 * from "it never stopped". So three of these tests are about what does NOT happen:
 *
 *   - `DONE` does not end an armed run. It is refused, recorded, and the advisor is re-asked.
 *   - A malformed signal dispatches nothing. It is not read as an instruction and not read as a
 *     report; the advisor is told the form and asked again, with the checkpoint still armed.
 *   - An UNARMED run reads `MILESTONE:` as the ordinary prose it is. The word means nothing on a
 *     run where nobody armed anything, and inventing a meaning for it would make every advisor
 *     that ever wrote the word stop a run the operator never asked to stop.
 *
 * And the release is a test of its own, because one shot is the other half of the contract: a
 * checkpoint that stayed armed through its own resume would stop the run again at the next
 * signal, or refuse a `DONE` for the rest of the session.
 *
 * ## The relays here arm rotation, and that is not incidental
 *
 * `relayOf` configures `--checks`, exactly as `resolution.test.ts` does, so the pause these
 * produce is the one an ordinary armed run produces -- menu included. A checkpoint says nothing
 * about the implementer's health, and the menu is a list of what would DO something rather than
 * of what the pause recommends.
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { AgentSession } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { tempDir } from '../testkit/tempDir.ts'
import { readMilestone } from './dispatch.ts'
import { Relay, type RelayOptions } from './relay.ts'
import type { RunHandle } from './run.ts'

function repo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-checkpoint')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'work.ts'), 'export const answer = 42\n')
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

function registryOf(queues: Record<string, AgentSession[]>): AgentRegistry {
  const r = new AgentRegistry()
  for (const [agent, sessions] of Object.entries(queues)) {
    const remaining = [...sessions]
    r.register({
      id: agent,
      displayName: agent,
      capabilities: {
        agent,
        readinessSignal: 'unknown',
        turnKeySource: 'prompt_id',
        outcomes: {
          completed: 'observed',
          cancelled: 'reasoned_but_unverified',
          permission_refused: 'reasoned_but_unverified',
          process_exited: 'reasoned_but_unverified',
          timed_out: 'reasoned_but_unverified',
          transport_lost: 'reasoned_but_unverified',
          unknown_abnormal_end: 'reasoned_but_unverified',
        },
      },
      deadlines: NO_DEADLINE_CLOCKS,
      launch: { command: agent, baseArgs: [] },
      async create() {
        const next = remaining.shift()
        if (!next) throw new Error(`no session left for ${agent}`)
        return next
      },
    })
  }
  return r
}

async function relayOf(
  cwd: string,
  advisor: FakeRotationSession,
  impl: FakeRotationSession,
  over: Partial<RelayOptions> = {},
): Promise<Relay> {
  return Relay.start({
    registry: registryOf({ codex: [advisor], claude: [impl] }),
    cwd,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 8,
    rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000 },
    ...over,
  })
}

// ---------------------------------------------------------------------------
// The reader, on its own. No relay, no arming — this answers what a reply SAYS.
// ---------------------------------------------------------------------------

test('a well-formed signal reports the milestone, carrying what the advisor said about it', () => {
  assert.deepEqual(readMilestone('MILESTONE: the parser lands and its tests pass'), {
    ok: true,
    detail: 'the parser lands and its tests pass',
  })
  // Trimmed at both ends, and multi-line bodies survive: the detail is the advisor's sentence and
  // a reply is allowed to be more than one line of it.
  assert.deepEqual(readMilestone('  MILESTONE:   the parser lands\nand the tests pass  '), {
    ok: true,
    detail: 'the parser lands\nand the tests pass',
  })
})

test('a reply that is not a signal at all is not one, and is left to be read as prose', () => {
  // `undefined`, not a refusal. The distinction is the whole of what lets an unarmed run dispatch
  // these as instructions and an armed one refuse only the replies that were TRYING to signal.
  assert.equal(readMilestone('Add the parser tests for the new syntax.'), undefined)
  assert.equal(readMilestone('DONE'), undefined)
  assert.equal(readMilestone(''), undefined)
  // Mid-reply, which is not the whole-reply form. `DONE` and `ESCALATE` are anchored the same way
  // and for the same reason: a keyword that could fire from the middle of an instruction would
  // let an advisor stop a run by describing one.
  assert.equal(readMilestone('Do the thing.\nMILESTONE: not really'), undefined)
})

test('a signal that began and did not finish is REFUSED, never fallen through to prose', () => {
  // The fail-closed case, and the one that matters most. A reply the advisor wrote as "we have
  // arrived" must never reach a seat as work: of the three possible outcomes -- report, refusal,
  // dispatch -- dispatch is the only silent one.
  for (const reply of ['MILESTONE', 'MILESTONE:', 'MILESTONE:   ', 'Milestone two needs the parser first']) {
    const read = readMilestone(reply)
    assert.equal(read?.ok, false, `${JSON.stringify(reply)} must be refused rather than dispatched`)
    assert.match(read?.ok === false ? read.why : '', /a colon/)
  }
})

test('the keyword is matched case-insensitively, exactly as DONE and ESCALATE are', () => {
  assert.deepEqual(readMilestone('milestone: the parser lands'), { ok: true, detail: 'the parser lands' })
})

// ---------------------------------------------------------------------------
// Arming, against a real relay.
// ---------------------------------------------------------------------------

test('a checkpoint armed at start reaches the advisor briefing and pauses on its signal', async (t) => {
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', ['MILESTONE: the parser lands.', 'DONE'])
  const impl = new FakeRotationSession('impl', 'claude', ['ack'])
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())

  const run = relay.start('Build the parser.', { checkpoint: 'the parser lands and its tests pass' })
  const pause = await run.untilPause()
  assert.ok(pause)

  // The BRIEFING, which is the only prompt an advisor reads before it has anything else to do.
  // A checkpoint armed at `start` and not briefed is a rule the advisor cannot follow, and the
  // first thing it would do is reply DONE and be refused for a reason it was never told.
  assert.match(advisor.received[0]!, /THE OPERATOR HAS SET A CHECKPOINT ON THIS RUN/)
  assert.match(advisor.received[0]!, /the parser lands and its tests pass/)
  assert.match(advisor.received[0]!, /DONE DOES NOT END THIS RUN/)

  assert.equal(pause.reason, 'operator_checkpoint')
  // The ADVISOR's sentence in `detail`, not the operator's. The operator already knows what they
  // armed; what they stopped to read is what the participant judged had happened.
  assert.equal(pause.detail, 'the parser lands.')
  assert.deepEqual(pause.resolution, {
    reason: 'operator_checkpoint',
    authority: 'operator',
    scope: { kind: 'conclave' },
  })
  // The operator's own words are on the EVIDENCE, where the pause says what it rests on, so a
  // reader can see the checkpoint and the report side by side and judge whether they match.
  assert.ok(
    pause.evidence.some((e) => e.includes('the operator armed this checkpoint in advance: the parser lands and its tests pass')),
    `the pause must say what was armed: ${JSON.stringify(pause.evidence)}`,
  )
  assert.equal(run.state, 'paused')
  // NOTHING WAS DISPATCHED. The implementer took its briefing turn and nothing since: a signal
  // that reached a seat as an instruction is the silent failure this whole path is shaped around.
  assert.equal(impl.received.length, 1, `the implementer must have had only its briefing: ${impl.received.length} turns`)

  await run.abort()
})

test('a checkpoint armed mid-run takes effect, and the advisor is told about it', async (t) => {
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'Write the parser.',
    'MILESTONE: the parser lands.',
    'DONE',
  ])
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Wrote it.'])
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())

  // Armed once the advisor's briefing has demonstrably GONE, which is the only way to test the
  // mid-run path deterministically: `start` returns before `#loop` has composed anything, so a
  // milestone armed on the next line would still reach the briefing -- correct behaviour, and not
  // the behaviour under test here. `onSend` fires after the prompt is built and handed over, and
  // the advisor's first send is its briefing.
  let run: RunHandle | undefined
  advisor.onSend = () => {
    if (advisor.received.length === 1) run!.armCheckpoint('  the parser lands  ')
  }
  run = relay.start('Build the parser.')
  const pause = await run.untilPause()
  assert.ok(pause)

  // NOT in the briefing -- that prompt had already gone when the checkpoint was armed, and
  // claiming otherwise would be the test asserting something the code cannot do.
  assert.doesNotMatch(advisor.received[0]!, /CHECKPOINT/)
  // It reaches the advisor through the orchestrator's own notice channel instead, on the next
  // prompt that carries mechanical facts -- the one routing the implementer's report back.
  assert.ok(
    advisor.received.some((m, i) => i > 0 && /THE OPERATOR HAS SET A CHECKPOINT ON THIS RUN/.test(m)),
    `the advisor must be told about a checkpoint armed after its briefing: ${JSON.stringify(advisor.received)}`,
  )
  assert.equal(pause.reason, 'operator_checkpoint')
  // Trimmed on the way in, so the pause and the notice carry the milestone rather than the
  // operator's whitespace.
  assert.ok(pause.evidence.some((e) => e.endsWith('in advance: the parser lands')))
  await run.abort()
})

test('an empty milestone is refused at both arming sites rather than stored', async (t) => {
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do the thing.', 'DONE'])
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())

  // The detail is the whole of what the advisor is briefed to watch for and what the pause is
  // raised carrying. An empty one would stop the run at a milestone nobody could state -- and it
  // would do so having briefed the advisor with a blank line.
  assert.throws(() => relay.start('Build it.', { checkpoint: '   ' }), /needs a milestone stated/)
  const run = relay.start('Build it.')
  assert.throws(() => run.armCheckpoint(''), /needs a milestone stated/)
  await run.abort()
})

// ---------------------------------------------------------------------------
// Failing closed. The three things that must NOT happen.
// ---------------------------------------------------------------------------

test('DONE does not end an armed run: it is refused, and the advisor is re-asked', async (t) => {
  const dir = repo(t)
  // DONE first, which is the case an operator arming a checkpoint is protecting themselves
  // against: an advisor that believes the goal is met before the operator has looked.
  const advisor = new FakeRotationSession('advisor', 'codex', ['DONE', 'MILESTONE: the parser lands.', 'DONE'])
  const impl = new FakeRotationSession('impl', 'claude', ['ack'])
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())

  const run = relay.start('Build the parser.', { checkpoint: 'the parser lands' })
  const pause = await run.untilPause()
  assert.ok(pause)

  // THE RUN DID NOT END on the DONE. It reached the checkpoint instead, on the turn after, which
  // is the whole of what arming one buys: a run that ended on the first reply would have produced
  // a record indistinguishable from one whose milestone was reached and released.
  assert.equal(pause.reason, 'operator_checkpoint')
  assert.equal(run.state, 'paused')

  // And the advisor was TOLD, in terms it can act on. An advisor that does not know its DONE was
  // refused writes DONE again, which spends the turn budget rather than the checkpoint.
  const refusal = advisor.received.find((m) => /DONE does not end this run yet/.test(m))
  assert.ok(refusal, `the advisor must be told why its DONE was refused: ${JSON.stringify(advisor.received)}`)
  assert.match(refusal, /the parser lands/)
  assert.match(refusal, /MILESTONE:/)

  // The refusal is in the routing log as well, because the operator reading afterwards is
  // entitled to see that the advisor tried to end the run and was not allowed to.
  assert.ok(
    relay.log.some((m) => m.kind === 'note' && /checkpoint is still armed/.test(m.text)),
    `the log must record the refused DONE: ${JSON.stringify(relay.log.filter((m) => m.kind === 'note').map((m) => m.text))}`,
  )
  await run.abort()
})

test('a malformed signal dispatches nothing, and the checkpoint stays armed', async (t) => {
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', [
    // Began the signal and did not finish it. Neither a report nor an instruction, and the one
    // thing it must never become is the second.
    'MILESTONE the parser lands',
    'MILESTONE: the parser lands, properly this time.',
    'DONE',
  ])
  const impl = new FakeRotationSession('impl', 'claude', ['ack'])
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())

  const run = relay.start('Build the parser.', { checkpoint: 'the parser lands' })
  const pause = await run.untilPause()
  assert.ok(pause)

  // NOTHING REACHED THE SEAT. The implementer has had its briefing and nothing else, so the
  // malformed signal was not dispatched as an instruction on its way to being ignored.
  assert.equal(impl.received.length, 1, `the implementer must have had only its briefing: ${impl.received.length} turns`)
  // The run did not end either, and did not pause on the malformed turn: it was re-asked, and the
  // pause it eventually raised is the one the SECOND, well-formed signal produced.
  assert.equal(pause.reason, 'operator_checkpoint')
  assert.equal(pause.detail, 'the parser lands, properly this time.')

  const reask = advisor.received.find((m) => /The checkpoint is still armed/.test(m))
  assert.ok(reask, `the advisor must be re-asked with the form: ${JSON.stringify(advisor.received)}`)
  assert.match(reask, /a colon/)
  assert.match(reask, /the parser lands/)
  await run.abort()
})

test('an UNARMED run reads MILESTONE as the ordinary prose it is, and dispatches it', async (t) => {
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', ['MILESTONE: check the parser tests.', 'DONE'])
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Checked them.'])
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())

  // No checkpoint. The word means nothing here, and giving it a meaning would let any advisor
  // that ever wrote it stop a run its operator never asked to stop.
  const run = relay.start('Build the parser.')
  const outcome = await run.result()

  assert.equal(outcome.reason, 'done', `an unarmed run must finish normally: ${outcome.detail}`)
  // Dispatched, whole and unedited, exactly as any other unaddressed reply is.
  assert.ok(
    impl.received.some((m) => m.includes('MILESTONE: check the parser tests.')),
    `the reply must reach the implementer as an instruction: ${JSON.stringify(impl.received)}`,
  )
  // And nothing paused. `untilPause` after the end resolves `undefined`, so the assertion that
  // says this is the outcome above plus the absence of a pause on the handle.
  assert.equal(run.pause, undefined)
})

// ---------------------------------------------------------------------------
// One shot: what the release does.
// ---------------------------------------------------------------------------

test('continuing past the checkpoint spends it: the run carries on and the next DONE ends it', async (t) => {
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'MILESTONE: the parser lands.',
    // After the release, an ordinary instruction, then an ordinary DONE. Neither may be treated
    // as though a checkpoint were still armed.
    'Now write the tests.',
    'DONE',
  ])
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Wrote them.'])
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())

  const run = relay.start('Build the parser.', { checkpoint: 'the parser lands' })
  const first = await run.untilPause()
  assert.ok(first)
  assert.equal(first.reason, 'operator_checkpoint')

  await run.continue()
  const outcome = await run.result()

  // THE RUN ENDED ON ITS OWN DONE, which is the disarm proved from the outside. A checkpoint
  // left armed through its own resume would have refused this DONE and gone round again until
  // the turn budget ran out -- reported as `budget`, not `done`.
  assert.equal(outcome.reason, 'done', `the run must end on its own DONE once released: ${outcome.detail}`)
  // Exactly one pause: released once, and never stopped again. A checkpoint that re-armed itself
  // would show up here as a second one.
  assert.equal(run.pause, undefined)
  // The instruction after the release was dispatched normally.
  assert.ok(
    impl.received.some((m) => m.includes('Now write the tests.')),
    `work must continue after the release: ${JSON.stringify(impl.received)}`,
  )
  // And the advisor was told the checkpoint was spent, so it does not go on withholding DONE.
  assert.ok(
    advisor.received.some((m) => /there is no checkpoint armed\s+now/.test(m)),
    `the advisor must be told the checkpoint is spent: ${JSON.stringify(advisor.received)}`,
  )
})

test('normal instructions run to the milestone, and the checkpoint waits for them', async (t) => {
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'Write the lexer.',
    'Now write the parser.',
    'MILESTONE: the parser lands.',
    'DONE',
  ])
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Wrote the lexer.', 'Wrote the parser.'])
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())

  const run = relay.start('Build the parser.', { checkpoint: 'the parser lands' })
  const pause = await run.untilPause()
  assert.ok(pause)

  // An armed checkpoint stops nothing until it is signalled. Two ordinary instructions were
  // dispatched and reported first -- a checkpoint that halted the run early would be an
  // `operator_requested` pause wearing a different name.
  assert.equal(pause.reason, 'operator_checkpoint')
  assert.equal(impl.received.length, 3, `briefing plus two instructions: ${JSON.stringify(impl.received)}`)
  assert.ok(impl.received[1]!.includes('Write the lexer.'))
  assert.ok(impl.received[2]!.includes('Now write the parser.'))
  await run.abort()
})

test('a milestone signal is not counted as an assignment attempt by the targeting instrument', async (t) => {
  const dir = repo(t)
  // TWO implementer seats, because the instrument only applies at N>1 -- a one-seat run says
  // nothing about targeting anywhere, so the gate this exercises is invisible on every other test
  // in this file.
  const advisor = new FakeRotationSession('advisor', 'codex', [
    '@seat implementer: Write the lexer.',
    'MILESTONE: the lexer lands.',
    'DONE',
  ])
  const one = new FakeRotationSession('impl', 'claude', ['ack', 'Wrote it.'])
  const two = new FakeRotationSession('impl-2', 'claude', ['ack'])
  const relay = await Relay.start({
    registry: registryOf({ codex: [advisor], claude: [one, two] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    implementers: [
      { id: 'implementer', agent: 'claude', role: 'implementer' },
      { id: 'implementer-2', agent: 'claude', role: 'implementer' },
    ],
    maxAdvisorTurns: 6,
  })
  t.after(() => relay.stop())

  const run = relay.start('Build the lexer.', { checkpoint: 'the lexer lands' })
  const pause = await run.untilPause()
  assert.ok(pause)
  assert.equal(pause.reason, 'operator_checkpoint')

  // READ AFTER THE TURN IS OVER, and that placement is the whole test.
  //
  // A first version asserted here, at the pause -- and it could not fail. `#finaliseTargeting`
  // runs in the `finally` at the foot of the advisor turn, and while the run is suspended inside
  // `#halt` that block has not executed: the milestone turn has no record yet whether or not the
  // gate exists. It was a green assertion about a moment that has nothing to say, which a
  // mutation of the gate proved by leaving it green.
  //
  // So the run is released and allowed to finish first. `advisorTurn` 2 is the milestone turn;
  // if it were counted as an assignment attempt its record would be appended when that turn
  // unwinds, which is after the continue and not before it.
  await run.continue()
  const outcome = await run.result()
  assert.equal(outcome.reason, 'done', `the run must finish once released: ${outcome.detail}`)

  // EXACTLY ONE record: the turn that assigned work. The milestone turn assigned nothing and was
  // never asked to name a seat, exactly as a DONE or an ESCALATE is -- and counting it would put
  // an unaddressed turn in the denominator the instrument scores the briefing on, saying the
  // advisor failed to use `@seat` on a turn it was not using `@seat` for.
  const records = relay.targetingWatch.records
  assert.equal(
    records.length,
    1,
    `only the assignment turn is an attempt: ${JSON.stringify(records.map((r) => ({ turn: r.turn, addressed: r.addressed })))}`,
  )
  assert.equal(records[0]!.turn, 1)
  assert.equal(records[0]!.addressed, true)
})

// ---------------------------------------------------------------------------
// Three facts, not two: armed, signalled, continued.
// ---------------------------------------------------------------------------

test('the signal is recorded as the ADVISOR\'s, separately from the operator accepting it', async (t) => {
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', ['MILESTONE: the parser lands.', 'DONE'])
  const impl = new FakeRotationSession('impl', 'claude', ['ack'])
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())

  const run = relay.start('Build the parser.', { checkpoint: 'the parser lands' })
  const pause = await run.untilPause()
  assert.ok(pause)

  // AT THE PAUSE the advisor has reported and the operator has not answered. Those are two
  // different facts and the record has to hold both: folding them together is what made an
  // abort here indistinguishable from a run whose milestone was never reported at all.
  const signalled = relay.checkpoint
  assert.equal(signalled?.state, 'signalled')
  assert.ok(typeof signalled?.signalledAt === 'number', 'the signal is stamped when it arrives')
  assert.equal(signalled?.continuedAt, undefined, 'and nothing says the operator accepted yet')
  // The pause names WHICH checkpoint it is about, as data rather than as prose in `evidence`.
  assert.deepEqual(pause.checkpoint, { generation: 1, milestone: 'the parser lands' })

  await run.continue()
  const outcome = await run.result()
  assert.equal(outcome.reason, 'done')
  const continued = relay.checkpoint
  assert.equal(continued?.state, 'continued')
  assert.ok(typeof continued?.continuedAt === 'number', 'the continuation is stamped too')
  // AND THE SIGNAL SURVIVES IT. A record that dropped `signalledAt` on acceptance could not
  // afterwards say the advisor was the one that judged the milestone reached.
  assert.equal(continued?.signalledAt, signalled?.signalledAt)
})

test('an abort after the signal keeps the signal, and the run makes no not-reached claim', async (t) => {
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', ['MILESTONE: the parser lands.', 'DONE'])
  const impl = new FakeRotationSession('impl', 'claude', ['ack'])
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())

  const run = relay.start('Build the parser.', { checkpoint: 'the parser lands' })
  assert.ok(await run.untilPause())
  const outcome = await run.abort('I will take it from here')

  // The two readings this distinction exists to keep apart. "The milestone never arrived" and
  // "the milestone arrived and you chose to stop there" are opposite accounts of the same run,
  // and the second is the ORDINARY use of a checkpoint -- so claiming the first here would
  // misreport the common case rather than an edge one.
  assert.doesNotMatch(
    outcome.detail ?? '',
    /NOT reached/,
    `a signalled milestone was reached: ${JSON.stringify(outcome)}`,
  )
  assert.equal(relay.checkpoint?.state, 'signalled', 'an abort accepts nothing, and un-signals nothing')
  assert.ok(typeof relay.checkpoint?.signalledAt === 'number')
})

test('a run that ends with nothing signalled is the only one that claims the checkpoint was missed', async (t) => {
  const dir = repo(t)
  // Never signalled: the advisor works until the turn budget is gone.
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do a thing.', 'Do another.', 'Do a third.'])
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.', 'Did it.', 'Did it.'])
  const relay = await relayOf(dir, advisor, impl, { maxAdvisorTurns: 2 })
  t.after(() => relay.stop())

  const run = relay.start('Build the parser.', { checkpoint: 'the parser lands' })
  const outcome = await run.result()
  assert.match(outcome.detail ?? '', /checkpoint was NOT reached/)
  assert.equal(relay.checkpoint?.state, 'armed')
})

// ---------------------------------------------------------------------------
// Identity: a continuation resolves the checkpoint that raised its pause, and no other.
// ---------------------------------------------------------------------------

test('arming B while A is paused, then continuing A, leaves B armed and refuses DONE', async (t) => {
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'MILESTONE: the parser lands.',
    // After the operator continues past A, the advisor tries to finish. B is armed and has
    // never been signalled, so this DONE must be refused rather than ending the run.
    'DONE',
    'MILESTONE: the tests pass.',
    'DONE',
  ])
  const impl = new FakeRotationSession('impl', 'claude', ['ack'])
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())

  const run = relay.start('Build the parser.', { checkpoint: 'the parser lands' })
  const first = await run.untilPause()
  assert.ok(first)
  assert.deepEqual(first.checkpoint, { generation: 1, milestone: 'the parser lands' })

  // ARMED WHILE A IS IN FRONT OF THE OPERATOR, which is an ordinary thing to do: they are
  // looking at the tree and have decided where they want to stop next.
  const replaced = run.armCheckpoint('the tests pass')
  assert.equal(replaced, 'the parser lands', 'B displaces A, and says so')
  assert.deepEqual(
    { generation: relay.checkpoint?.generation, state: relay.checkpoint?.state, signalledAt: relay.checkpoint?.signalledAt },
    { generation: 2, state: 'armed', signalledAt: undefined },
    'B is a NEW checkpoint: its own generation, armed, and carrying none of A\'s history',
  )

  // The continuation answers A. Its generation is read off the pause, so it cannot resolve B.
  await run.continue()
  const second = await run.untilPause()
  assert.ok(second, 'the run must stop again at B rather than ending on the DONE in between')
  assert.equal(second.reason, 'operator_checkpoint')
  assert.deepEqual(second.checkpoint, { generation: 2, milestone: 'the tests pass' })

  // THE DONE IN BETWEEN WAS REFUSED. Without the generation the continue would have stamped B
  // as continued, its gate would have dropped, and the run would have ended at a checkpoint the
  // operator had just set and never seen.
  assert.ok(
    advisor.received.some((m) => /DONE does not end this run yet/.test(m)),
    `the DONE after the release must have been refused: ${JSON.stringify(advisor.received)}`,
  )
  // And the log says what happened to A, which is where this run's history lives.
  assert.ok(
    relay.log.some((m) => m.kind === 'note' && m.text.includes('replaced the armed checkpoint "the parser lands"')),
    'the replacement is recorded',
  )
  await run.abort()
})

test('a continuation whose checkpoint was replaced resolves nothing, and says so', async (t) => {
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', ['MILESTONE: the parser lands.', 'DONE', 'DONE'])
  const impl = new FakeRotationSession('impl', 'claude', ['ack'])
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())

  const run = relay.start('Build the parser.', { checkpoint: 'the parser lands' })
  assert.ok(await run.untilPause())
  run.armCheckpoint('the tests pass')
  await run.continue()
  await run.untilPause()

  // The routing log is where A's fate is recorded: the top-level block is the LIVE checkpoint
  // and it is B, so a reader who needs to know what became of A reads the log rather than
  // finding A's signal attributed to B.
  assert.ok(
    relay.log.some(
      (m) => m.kind === 'note' && /continued past checkpoint 1, which had already been replaced/.test(m.text),
    ),
    `the log must say the continuation resolved a displaced checkpoint: ${JSON.stringify(
      relay.log.filter((m) => m.kind === 'note').map((m) => m.text),
    )}`,
  )
  await run.abort()
})

// ---------------------------------------------------------------------------
// A checkpoint belongs to ONE run.
// ---------------------------------------------------------------------------

test('a second run does not inherit the first run\'s spent checkpoint', async (t) => {
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', ['MILESTONE: the parser lands.', 'DONE'])
  const impl = new FakeRotationSession('impl', 'claude', ['ack'])
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())

  const first = relay.start('Build the parser.', { checkpoint: 'the parser lands' })
  assert.ok(await first.untilPause())
  await first.continue()
  assert.equal((await first.result()).reason, 'done')
  assert.equal(relay.checkpoint?.state, 'continued')

  // A relay outlives its runs. A second run given no checkpoint must have NONE -- not the
  // previous run's spent record, which would make its status document claim a checkpoint that
  // was set on different work.
  const second = relay.start('Now the tests.')
  assert.equal(relay.checkpoint, undefined, 'a run with no checkpoint has no checkpoint')
  await second.abort()
})

test('a second run does not inherit a checkpoint an abort left armed', async (t) => {
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do a thing.', 'DONE'])
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())

  const first = relay.start('Build the parser.', { checkpoint: 'the parser lands' })
  await first.abort('changed my mind')
  assert.equal(relay.checkpoint?.state, 'armed', 'the first run ended with its checkpoint unreached')

  // THE WORSE OF THE TWO INHERITANCES, and the reason both are tested. A spent checkpoint
  // carried forward is a wrong status line; an ARMED one carried forward changes behaviour --
  // the second run's DONE would be refused for a milestone nobody set on it, and it would end
  // on its turn budget instead of on its work.
  const second = relay.start('Now the tests.')
  assert.equal(relay.checkpoint, undefined)
  await second.abort()
})

test('arming replaces rather than queues, and the record says which was dropped', async (t) => {
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', ['MILESTONE: the tests pass.', 'DONE'])
  const impl = new FakeRotationSession('impl', 'claude', ['ack'])
  const relay = await relayOf(dir, advisor, impl)
  t.after(() => relay.stop())

  const run = relay.start('Build the parser.', { checkpoint: 'the parser lands' })
  // Two checkpoints would need an order, and a single `MILESTONE:` reply names neither -- the
  // signal reports that the armed one is reached, it does not say which.
  run.armCheckpoint('the tests pass')
  const pause = await run.untilPause()
  assert.ok(pause)

  assert.ok(
    pause.evidence.some((e) => e.endsWith('in advance: the tests pass')),
    `the live checkpoint must be the second one: ${JSON.stringify(pause.evidence)}`,
  )
  assert.ok(
    relay.log.some((m) => m.kind === 'note' && m.text.includes('replaced the armed checkpoint "the parser lands"')),
    'the log must name the checkpoint that was dropped',
  )
  await run.abort()
})
