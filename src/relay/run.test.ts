/**
 * The attended run: pause as a state, and the transitions out of it.
 *
 * The property these are about is that a pause **preserves the loop**. Restarting `run()`
 * from the goal was always available; what was missing was continuing from where the
 * session actually was. So the assertions are mostly about what the participants see next
 * — an implementer that gets advisor turn 3's instruction rather than turn 1's is the
 * whole difference.
 *
 *   node --test src/relay/run.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Verdict } from '../contract/outcome.ts'
import type { AgentSession } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import type { RelayEvent } from './observe.ts'
import { Relay, type RelayOptions } from './relay.ts'
import { RunHandle, type RunControl } from './run.ts'
import { resolutionFor } from './resolution.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-run-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'work.ts'), 'export const answer = 42\n')
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

const HANDOFF = `## BRIEF
Keep the work moving.

## STATE
Half done.

## DECISIONS
- none

## EVIDENCE
The implementer says the check passes.

## FILES
- work.ts

## DISAGREEMENT
- none

## NEXT
Carry on.`

const ACCEPTED = 'CHECK 1: exit 0\n\nRead work.ts and ran the check. It matches.'

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
      // An in-memory double: no child process, so no clock of either kind.
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
  implementers: FakeRotationSession[],
  over: Partial<RelayOptions> = {},
): Promise<Relay> {
  return Relay.start({
    registry: registryOf({ codex: [advisor], claude: implementers }),
    cwd,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 4,
    rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000 },
    ...over,
  })
}

test('a run with nothing to decide ends without ever pausing', async (t) => {
  const dir = repo()
  const relay = await relayOf(
    dir,
    new FakeRotationSession('advisor', 'codex', ['Do the thing.', 'DONE']),
    [new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])],
  )
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  assert.equal(await run.untilPause(), undefined, 'no pause; the run ended instead')
  assert.equal((await run.result()).reason, 'done')
  assert.equal(run.state, 'ended')
})

test('a rotation candidate pauses the loop and reports its evidence', async (t) => {
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do the thing.', 'DONE']), [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  impl.compact()

  const pause = await run.untilPause()
  assert.ok(pause)
  assert.equal(pause.reason, 'rotation_candidate')
  assert.equal(run.state, 'paused')
  // A pause the operator cannot interrogate is one they dismiss by reflex.
  assert.ok(pause.evidence.some((e) => e.includes('compaction generation rose 0 → 1')))
  assert.deepEqual(pause.options, ['continue', 'rotate', 'constrain', 'abort'])
  assert.equal(impl.state, 'running', 'nothing is spent while the human is deciding')
})

test('continuing resumes the loop where it was, rather than replaying the goal', async (t) => {
  // The whole point. Restarting run() was always available; continuing from the advisor turn the
  // session had actually reached was not.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did the first thing.', 'Did the second thing.', 'NONE'])
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do the first thing.', 'Do the second thing.', 'DONE'])
  const relay = await relayOf(dir, advisor, [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  impl.compact()
  await run.untilPause()
  await run.continue()

  assert.equal((await run.result()).reason, 'done')
  // Four sends: the briefing, one instruction per advisor turn, and the closing question the relay
  // asks when the advisor says DONE. A replay would have sent the briefing and the first
  // instruction twice.
  assert.equal(impl.received.length, 4)
  assert.match(impl.received[3]!, /is anything unresolved/)
  assert.ok(impl.received[1]!.includes('Do the first thing.'))
  assert.ok(impl.received[2]!.includes('Do the second thing.'))
  assert.equal(relay.log.filter((m) => m.kind === 'goal').length, 1)
})

test('rotating from a pause replaces the implementer and the loop carries on with it', async (t) => {
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude', ['ack', 'Did the first thing.'])
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED, 'Carried on.', 'NONE'])
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do the first thing.', HANDOFF, 'Do the second thing.', 'DONE'])
  const relay = await relayOf(dir, advisor, [old, fresh])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  old.compact()
  await run.untilPause()

  const result = await run.rotateImplementer()
  assert.equal(result.status, 'rotated')
  // Rotating and resuming are two decisions: the operator may want to read the handoff and
  // the acceptance report before letting the session go on.
  assert.equal(run.state, 'paused')
  assert.equal(old.state, 'terminated')

  await run.continue()
  assert.equal((await run.result()).reason, 'done')
  // `some`, not `at(-1)`: the last thing it receives is the closing question asked when the
  // advisor says DONE. What is being tested is that the REPLACEMENT, not the retired session,
  // was given the next instruction.
  assert.ok(
    fresh.received.some((m) => m.includes('Do the second thing.')),
    'the replacement got the NEXT instruction',
  )
})

test('a failed rotation leaves the run paused with the original still in service', async (t) => {
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude', ['ack', 'Did it.', 'Did it again.'])
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'no headings here', 'Do it again.', 'DONE'])
  const relay = await relayOf(dir, advisor, [old, new FakeRotationSession('fresh', 'claude', [ACCEPTED])])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  old.compact()
  await run.untilPause()

  const result = await run.rotateImplementer()
  assert.equal(result.status, 'rolled_back')
  assert.equal(old.state, 'running')
  assert.equal(run.state, 'paused', 'a failed rotation is not a decision; the human still has one')

  // And the session is still usable: the operator can simply carry on with the original.
  await run.continue()
  assert.equal((await run.result()).reason, 'done')
})

test('a constraint injected at a pause reaches the next turn at human rank', async (t) => {
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did the first thing.', 'Did the second.', 'NONE'])
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do the first thing.', 'Do the second thing.', 'DONE'])
  const relay = await relayOf(dir, advisor, [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  impl.compact()
  await run.untilPause()

  const m = run.injectConstraint('Touch nothing under src/adapters.', { only: 'implementer' })
  assert.equal(m.fromRank, 'human')
  await run.continue()
  await run.result()

  // `some`, not `at(-1)`: the LAST thing the implementer receives is now the closing question
  // the relay asks when the advisor says DONE. What matters is that the human's constraint
  // reached it at all, and at human rank.
  assert.ok(impl.received.some((m) => m.includes('FROM THE HUMAN')))
  assert.ok(impl.received.some((m) => m.includes('src/adapters')))
})

test('aborting from a pause ends the run and does not take another turn', async (t) => {
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.', 'should never be sent'])
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'More.', 'DONE']), [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  impl.compact()
  await run.untilPause()

  const sentBefore = impl.received.length
  const outcome = await run.abort('operator ended the task')
  assert.equal(outcome.reason, 'stopped')
  assert.equal(outcome.detail, 'operator ended the task')
  assert.equal(run.state, 'ended')
  assert.equal(impl.received.length, sentBefore, 'no further work was requested')
})

test('an advisor escalation is a pause, and continuing asks it again rather than replaying it', async (t) => {
  // Replaying `ESCALATE: ...` as an instruction would send the implementer a message with
  // no action in it, and the advisor would have no way to know the human had answered.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'ESCALATE: I do not know whether this is in scope.',
    'Do the thing.',
    'DONE',
  ])
  const relay = await relayOf(dir, advisor, [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const pause = await run.untilPause()
  assert.equal(pause!.reason, 'advisor_escalated')
  assert.ok(pause!.detail.includes('in scope'))

  run.injectConstraint('It is in scope. Carry on.', { only: 'advisor' })
  await run.continue()

  assert.equal((await run.result()).reason, 'done')
  assert.ok(!impl.received.some((m) => m.includes('ESCALATE')), 'escalation text must not reach the implementer')
  assert.ok(advisor.received.some((m) => m.includes('It is in scope.')), 'the human answer must reach the advisor')
})

test('an implementer UNANSWERED marker pauses the run with the question and what was done', async (t) => {
  // A FLAG: qualifies the result; an UNANSWERED: line asks a question that would change the
  // build if the implementer answered it itself. The loop stops before the advisor reasons
  // from an instruction that has not actually settled the scope.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', [
    'ack',
    'Read the existing routes.\n' +
      'UNANSWERED: Should the new endpoint be under /api/v1 or /api/v2?',
    'Done.',
    'NONE',
  ])
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'Read the routes and report what you find.',
    'Use /api/v1 for the endpoint.',
    'DONE',
  ])
  const relay = await relayOf(dir, advisor, [impl])
  t.after(() => relay.stop())

  const run = relay.start('Add the endpoint.')
  const pause = await run.untilPause()
  assert.ok(pause)
  assert.equal(pause.reason, 'implementer_unanswered')
  assert.ok(pause.detail.includes('UNANSWERED: Should the new endpoint be under /api/v1 or /api/v2?'))
  assert.ok(pause.detail.includes('Done so far:'))
  assert.ok(pause.detail.includes('Read the existing routes'))

  run.injectConstraint('Use /api/v1.', { only: 'implementer' })
  await run.continue()

  assert.equal((await run.result()).reason, 'done')
  assert.ok(
    impl.received.some((m) => m.includes('Use /api/v1.')),
    'the human answer must reach the implementer',
  )
  assert.ok(
    !relay.log.some((m) => m.kind === 'instruction' && /UNANSWERED:/.test(m.text)),
    'the UNANSWERED marker is not routed as an instruction',
  )
})

test('a FLAG marker does not pause the run', async (t) => {
  // A FLAG: is a result-qualifying concern, not a build-blocking question. It is carried into
  // the summary and the run continues, so the distinction from UNANSWERED: is enforced by
  // behaviour rather than only by the briefing.
  const dir = repo()
  const relay = await relayOf(
    dir,
    new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']),
    [
      new FakeRotationSession('impl', 'claude', [
        'ack',
        'Done.\nFLAG: conformance.sh remains unrun; inherited reasoning.',
      ]),
    ],
  )
  t.after(() => relay.stop())

  const run = relay.start('Do the thing.')
  assert.equal(await run.untilPause(), undefined, 'a FLAG does not stop the run')
  assert.equal((await run.result()).reason, 'done')
  assert.ok(relay.flags.some((f) => /conformance\.sh/.test(f.text)))
})

test('a declined candidate closes at its own generation, so a LATER compaction is new evidence', async (t) => {
  // Found by three tests hanging: without `#acknowledge` the same compaction re-pauses every
  // advisor turn forever, and the operator either abandons the feature or stops reading the
  // pauses. The second is worse than never having built it.
  //
  // What this test is about is the BASELINE, and that is unchanged. What has changed is what
  // the run then does with the new evidence: since #118 the operator is not re-asked about a
  // compaction whose evidence class they have already declined, so the second candidate below
  // is recorded rather than put. The two halves are separable and both are asserted here --
  // the baseline moves per compaction (this mechanism), and the pause is not repeated on an
  // unchanged class (#118). `rotation.test.ts` owns the other side of #118: an evidence class
  // the operator has NOT ruled on -- a compaction the seat also complains about -- is a new
  // question and is still put, so declining once is not standing consent for anything else.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'One.', 'Two.', 'Three.'])
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do one.', 'Do two.', 'Do three.', 'DONE'])
  const relay = await relayOf(dir, advisor, [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  impl.compact()

  const first = await run.untilPause()
  assert.equal(first!.reason, 'rotation_candidate')
  assert.ok(first!.evidence.some((e) => e.includes('0 → 1')))
  await run.continue()

  // A second, distinct compaction: new evidence, same evidence class, already answered.
  impl.compact()
  assert.equal(
    await run.untilPause(),
    undefined,
    'the same question is not put twice; the run carries on to its end instead',
  )
  assert.equal((await run.result()).reason, 'done')

  // The note is worded about the BASELINE rather than about who decided, because every caller
  // of `#acknowledge` reaches it and only the first of them declined anything (#107). Both
  // compactions reach it, and each closes at its own generation -- which is what makes the
  // second a new candidate rather than the first one re-read, whether or not it was put.
  for (const generation of [1, 2]) {
    assert.equal(
      relay.log.filter((m) => m.text.includes(`rotation candidate closed at compaction generation ${generation}`))
        .length,
      1,
      `exactly one candidate closed at generation ${generation}`,
    )
  }
  // Counted whether or not the operator was interrupted for it. "Not asked" must never quietly
  // become "not watched".
  assert.equal(relay.rotationWatch.candidates, 2)
  assert.ok(
    relay.log.some((m) => /rotation candidate recorded, run continues \(the operator already declined/.test(m.text)),
    `the suppressed candidate is on the record:\n${relay.log.map((m) => m.text).join('\n---\n')}`,
  )
})

test('the advisor cannot end a session out from under an outstanding human instruction', async (t) => {
  // §7a, first paragraph: "The advisor can end the session; the human outranks that and
  // can send them back to work." The loop returned on DONE without checking, so a human
  // message queued for the next exchange was silently dropped when the advisor decided the
  // work was finished — letting the advisor terminate a human instruction out of
  // existence, which inverts the rank order the design rests on.
  //
  // Found by the first live pause run, where the drift probe was never delivered.
  //
  // Injected from `onLog` rather than from a pause: the constraint has to be outstanding
  // at the exact moment the advisor says DONE, and polling for that against fake sessions
  // is a race the poller always loses. The pause is how a human reaches this state; it is
  // not what is being tested.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.', 'Did the extra thing too.'])
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE', 'DONE'])
  let relay: Relay
  let injected = false
  relay = await relayOf(dir, advisor, [impl], {
    onLog: (m) => {
      if (m.kind !== 'report' || injected) return
      injected = true
      relay.say('One more thing before you stop: do the extra thing.', { only: 'implementer' })
    },
  })
  t.after(() => relay.stop())

  const outcome = await relay.start('Keep the work moving.').result()

  assert.ok(injected, 'the test must actually have injected something')
  assert.ok(
    impl.received.some((m) => m.includes('do the extra thing')),
    'a human instruction outstanding at DONE must still be delivered',
  )
  assert.ok(relay.log.some((m) => m.text.includes('the human outranks the advisor')))
  // And the advisor still gets to end it, once the human has nothing outstanding.
  assert.equal(outcome.reason, 'done')
})

test('an advisor DONE with nothing outstanding ends the session as before', async (t) => {
  const dir = repo()
  const relay = await relayOf(
    dir,
    new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']),
    [new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])],
  )
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const outcome = await run.result()
  assert.equal(outcome.reason, 'done')
  assert.ok(!relay.log.some((m) => m.text.includes('the human outranks the advisor')))
})

test('a run that pauses with nobody watching fails result() instead of hanging', async (t) => {
  // The first live rotation deadlocked here. Promotion succeeded, the loop paused again,
  // and the test sat on result() until a 25-minute harness timeout filed an orchestration
  // deadlock as an agent turn overrunning -- with both agents idle and nothing scheduled.
  //
  // Not a timeout: at the moment of a pause with no watcher, result() provably cannot
  // settle without an operator action the caller has demonstrably not arranged.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.', 'And more.'])
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'Do more.', 'DONE'])
  const relay = await relayOf(dir, advisor, [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  await run.requestPause()
  await run.continue()
  // Second pause, with the caller holding only result().
  const pending = run.result()
  impl.compact()

  await assert.rejects(pending, /nothing is waiting for pauses/)
  assert.equal(run.state, 'paused', 'the run itself is unharmed; only the impossible wait failed')
  await run.abort()
})

test('settled() gives one await covering both a pause and the end', async (t) => {
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.', 'And more.'])
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'Do more.', 'DONE'])
  const relay = await relayOf(dir, advisor, [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  impl.compact()

  // What a supervising caller actually wants, and what the live test should have used.
  const seen: string[] = []
  for (;;) {
    const s = await run.settled()
    seen.push(s.kind)
    if (s.kind === 'ended') break
    await run.continue()
  }
  assert.deepEqual(seen, ['paused', 'ended'])
  assert.equal(run.outcome!.reason, 'done')
})

test('settled() resolves immediately when the run is already paused or ended', async (t) => {
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']), [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  await run.requestPause()
  assert.equal((await run.settled()).kind, 'paused', 'already paused')
  await run.continue()
  await run.result()
  assert.equal((await run.settled()).kind, 'ended', 'already ended')
})

test('an advisor instruction that would undo an aside pauses BEFORE it is delivered', async (t) => {
  // The live case, in miniature. The advisor never saw the aside, meets work it did not
  // ask for, and says to remove it. The orchestrator neither adjudicates nor prohibits --
  // it stops before the instruction reaches the implementer and hands the human both sides.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Wrote two.txt.', 'Removed it.'])
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'Remove two.txt and wait.', 'DONE'])
  const relay = await relayOf(dir, advisor, [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  relay.say('Also write the word into two.txt.', { only: 'implementer' }, 'aside')

  const pause = await run.untilPause()
  assert.ok(pause)
  assert.equal(pause.reason, 'authority_conflict')
  assert.ok(pause.conflict)
  assert.deepEqual(pause.conflict.matched, ['two.txt'])
  assert.equal(pause.conflict.origin.excluded[0], 'advisor')

  // BEFORE delivery is the whole point: the instruction is still a proposal.
  assert.ok(
    !impl.received.some((m) => m.includes('Remove two.txt')),
    'the implementer must not have seen the instruction while the human is deciding',
  )
  assert.ok(
    !relay.log.some((m) => m.kind === 'instruction' && m.text.includes('Remove two.txt')),
    'and it must not be recorded as delivered',
  )

  // The human lets it through; the advisor may well be right.
  await run.continue()
  assert.equal((await run.result()).reason, 'done')
  assert.ok(impl.received.some((m) => m.includes('Remove two.txt')), 'continuing delivers it')

  // And the decision REACHES the implementer, at human rank. Found live: without this the
  // implementer declined the delivered instruction because, from its side, the conflict
  // was still unacknowledged — "what I won't do is delete it while the conflict is
  // unacknowledged". The pause bought a delay and nothing else.
  const delivered = impl.received.find((m) => m.includes('Remove two.txt'))!
  assert.ok(delivered.includes('FROM THE HUMAN'), 'the adjudication rides with the instruction')
  assert.ok(delivered.includes('I am allowing the advisor'))
  assert.ok(delivered.includes('not the advisor overriding me'))
})

test('an adjudicated conflict is not raised again for the same instruction', async (t) => {
  // Same rule as a declined rotation candidate: a decision the human has already made must
  // not re-present itself, or the pause becomes noise and stops being read.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Wrote two.txt.', 'Removed it.', 'Again.'])
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'Do it.',
    'Remove two.txt and wait.',
    'Remove two.txt and wait.',
    'DONE',
  ])
  const relay = await relayOf(dir, advisor, [impl], { maxAdvisorTurns: 5 })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  relay.say('Also write the word into two.txt.', { only: 'implementer' }, 'aside')

  let pauses = 0
  for (;;) {
    const s = await run.settled()
    if (s.kind === 'ended') break
    pauses += 1
    await run.continue()
  }
  assert.equal(pauses, 1, 'the identical instruction must be adjudicated once, not every advisor turn')
})

test('an advisor instruction unrelated to the aside is delivered without a pause', async (t) => {
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])
  const advisor = new FakeRotationSession('advisor', 'codex', ['Remove the unused import.', 'DONE'])
  const relay = await relayOf(dir, advisor, [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  relay.say('Also write the word into two.txt.', { only: 'implementer' }, 'aside')

  assert.equal(await run.untilPause(), undefined, 'ordinary traffic must not pause')
  assert.equal((await run.result()).reason, 'done')
})

test('a pause suspends orchestration, not observation', async (t) => {
  // The invariant a paused session has to hold: no participant is given new relay work,
  // but everything that watches them keeps working. A pause that also stopped ingestion
  // would mean the operator is asked to decide using a view that froze at the moment the
  // question was raised -- and the longer they think, the staler their evidence gets.
  //
  // The adapter-side halves of this -- hook ingestion, transcript reconciliation, watchdog
  // supervision -- are not observable through fakes. They are pinned in
  // `pause.live.test.ts`, which is the only place they can be.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.', 'And again.'])
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'Do it again.', 'DONE'])
  const relay = await relayOf(dir, advisor, [impl])
  t.after(() => relay.stop())

  const seen: string[] = []
  void (async () => {
    for await (const e of relay.observe()) if (e.type === 'activity') seen.push(e.participant)
  })()

  const run = relay.start('Keep the work moving.')
  impl.compact()
  await run.untilPause()

  const sentAtPause = impl.received.length
  const eventsAtPause = relay.participants.find((p) => p.rank === 'implementer')!.events.length
  const observedAtPause = seen.length

  // A child keeps running while the human thinks. Its events must still land.
  impl.emit({ type: 'tool_use', tool: 'Read', input: {}, seq: 900, at: Date.now(), provisional: true })
  await new Promise((r) => setTimeout(r, 40))

  const p = relay.participants.find((q) => q.rank === 'implementer')!
  assert.equal(impl.received.length, sentAtPause, 'no new relay work while paused')
  assert.equal(p.events.length, eventsAtPause + 1, 'ingestion continues while paused')
  assert.ok(seen.length > observedAtPause, 'observers keep receiving while paused')

  // Inspection is live, not a snapshot taken when the question was asked.
  const snap = await p.session.snapshot()
  assert.ok(snap.turns.length > 0)
  assert.equal(relay.audit().length >= 0, true)

  await run.abort()
})

test('untilPause resolves immediately for an operator that attaches late', async (t) => {
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']), [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  impl.compact()
  await run.untilPause()

  // Attaching a moment late must not wait forever for an event that already happened.
  const again = await run.untilPause()
  assert.equal(again, run.pause)
  await run.abort()
})

test('continuing a run that is not paused throws rather than doing nothing', async (t) => {
  const dir = repo()
  const relay = await relayOf(
    dir,
    new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']),
    [new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])],
  )
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  await run.result()
  await assert.rejects(() => run.continue(), /not paused/)
  await assert.rejects(() => run.rotateImplementer(), /can only rotate from a paused run/)
})

test('result() resolves for a caller that asks after the run already ended', async (t) => {
  const dir = repo()
  const relay = await relayOf(
    dir,
    new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']),
    [new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])],
  )
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const first = await run.result()
  assert.deepEqual(await run.result(), first)
})

// ---------------------------------------------------------------------------------------
// A pause the system has since withdrawn.
//
// The evidence model is allowed to keep working on a turn after reporting a verdict, and a
// pause is a snapshot of it at one instant. A live run paused on `timed_out`, a late signal
// completed the same turn, and the pause text never changed -- so the operator was
// adjudicating a verdict nothing stood behind. These are about surfacing that, and about
// NOT deciding it: the run stays paused either way.
// ---------------------------------------------------------------------------------------

const TIMED_OUT: Verdict = {
  outcome: 'timed_out',
  confidence: 'uncertain',
  provenance: [{ source: 'orchestrator', detail: 'past the watchdog at 600s with no Stop' }],
}
const COMPLETED: Verdict = {
  outcome: 'completed',
  confidence: 'proven',
  provenance: [{ source: 'hook', detail: 'Stop' }],
}
const CANCELLED: Verdict = {
  outcome: 'cancelled',
  confidence: 'uncertain',
  provenance: [{ source: 'orchestrator', detail: 'cancelled by test control' }],
}

/** Poll for something the relay does asynchronously. Bounded, so a failure is a failure. */
async function until<T>(what: string, f: () => T | undefined, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = f()
    if (v !== undefined) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('a verdict withdrawn while the human is deciding is surfaced on the pause itself', async (t) => {
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it, slowly.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT }
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']), [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const pause = await run.untilPause()
  assert.ok(pause)
  assert.equal(pause.reason, 'turn_incomplete')
  // Via a local: `assert.strict.equal` narrows its first argument, and narrowing the pause
  // field to `undefined` here would make every later assertion about it unreachable.
  const before = pause.superseded
  assert.equal(before, undefined, 'nothing has contradicted it yet')

  // The late Stop the watchdog beat to it.
  impl.lateSignal(COMPLETED)

  const superseded = await until('the pause to be marked superseded', () => run.pause?.superseded?.verdict)
  assert.equal(superseded.outcome, 'completed')
  // The object the operator was handed, not a replacement they will never see.
  assert.equal(pause.superseded?.verdict?.outcome, 'completed')
  assert.match(pause.superseded!.note, /timed_out/)
  assert.match(pause.superseded!.note, /withdrawn/)
  assert.match(pause.superseded!.note, /completed/)

  // Surfaced, not decided.
  assert.equal(run.state, 'paused', 'withdrawing the reason for a decision is not making it')
  await run.abort()
})

test('the withdrawal is recorded, so the log says why the pause stopped meaning anything', async (t) => {
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it, slowly.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT }
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']), [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const pause = await run.untilPause()
  assert.ok(pause)
  impl.lateSignal(COMPLETED)
  await until('the pause to be marked superseded', () => run.pause?.superseded?.verdict)

  const notes = relay.log.filter((m) => m.kind === 'note').map((m) => m.text)
  const raised = notes.findIndex((t) => t.startsWith('paused (turn_incomplete)'))
  const withdrawn = notes.findIndex((t) => /withdrawn/.test(t))
  assert.ok(raised >= 0 && withdrawn > raised, `expected a withdrawal note after the pause:\n${notes.join('\n')}`)
  await run.abort()
})

test('a verdict withdrawn BEFORE the check never raises a pause at all', async (t) => {
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it, slowly.'])
  // The window the relay used to lose: `#exchange` settles on the first turn_end, and the
  // late signal lands while it is still waiting for the transcript to catch up.
  impl.delayMs = 10
  impl.endTurn = { index: 1, verdict: TIMED_OUT, withdraw: COMPLETED }
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']), [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  assert.equal(await run.untilPause(), undefined, 'the verdict was retracted before anyone was asked about it')
  assert.equal((await run.result()).reason, 'done')

  // Retracted is not the same as never said: the log still shows both.
  const notes = relay.log.filter((m) => m.kind === 'note').map((m) => m.text)
  assert.ok(notes.some((t) => /timed_out/.test(t) && /withdrawn/.test(t) && /completed/.test(t)), notes.join('\n'))
})

test('a withdrawal with no replacement pauses, and says so from the moment it is raised', async (t) => {
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it, slowly.'])
  impl.delayMs = 10
  impl.endTurn = { index: 1, verdict: TIMED_OUT, withdraw: 'no_replacement' }
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']), [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const pause = await run.untilPause()
  assert.ok(pause)
  assert.equal(pause.reason, 'turn_incomplete')
  assert.ok(pause.superseded, 'the verdict it rests on was already retracted')
  assert.equal(pause.superseded?.verdict, undefined)
  assert.match(pause.superseded!.note, /no replacement/)
  await run.abort()
})

test('a compaction revision does not mark a verdict pause superseded', async (t) => {
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it, slowly.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT }
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']), [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const pause = await run.untilPause()
  assert.ok(pause)
  assert.equal(pause.reason, 'turn_incomplete')

  // Compaction rewrites history without contradicting a verdict: `replaces` is empty.
  impl.compact()
  await new Promise((r) => setTimeout(r, 100))
  assert.ok(!run.pause?.superseded, 'a rewritten transcript is not a withdrawn verdict')
  await run.abort()
})

test('a late signal does not amend a pause that was never about a verdict', async (t) => {
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']), [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  impl.compact()
  const pause = await run.untilPause()
  assert.ok(pause)
  assert.equal(pause.reason, 'rotation_candidate')

  impl.lateSignal(COMPLETED)
  await new Promise((r) => setTimeout(r, 100))
  assert.ok(!run.pause?.superseded, 'nothing about a rotation candidate rests on a turn verdict')
  await run.abort()
})

// ---------------------------------------------------------------------------------------
// Issue #49: a superseded verdict can be another timeout on the still-running turn, so `pause.superseded`
// is not a "turn landed" signal. The note must say what the verdict was replaced WITH, and
// an unexpired `/wait` must carry across a re-raised pause for the same turn.
// ---------------------------------------------------------------------------------------

test('supersession by completed says the turn ended', async (t) => {
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it, slowly.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT }
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']), [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  await run.untilPause()

  impl.lateSignal(COMPLETED)
  await until('the pause to be marked superseded', () => run.pause?.superseded?.verdict)

  assert.equal(run.pause?.superseded?.verdict?.outcome, 'completed')
  assert.match(run.pause!.superseded!.note, /completed/i)
  assert.match(run.pause!.superseded!.note, /turn ended|turn has ended|the turn landed/i)
  assert.doesNotMatch(run.pause!.superseded!.note, /still running|another timeout|watchdog fired again/i)
  await run.abort()
})

test('supersession by another timed_out says the turn is still running', async (t) => {
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it, slowly.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT }
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']), [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  await run.untilPause()

  impl.lateSignal(TIMED_OUT)
  await until('the pause to be marked superseded', () => run.pause?.superseded?.verdict)

  assert.equal(run.pause?.superseded?.verdict?.outcome, 'timed_out')
  assert.match(run.pause!.superseded!.note, /timed_out/i)
  assert.match(run.pause!.superseded!.note, /still running|another timeout|watchdog fired again|the turn is still/i)
  assert.doesNotMatch(run.pause!.superseded!.note, /turn ended|turn has ended|the turn landed|completed/i)
  await run.abort()
})

test('supersession by a terminal verdict other than completed uses neutral formatVerdict wording', async (t) => {
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it, slowly.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT }
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']), [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  await run.untilPause()

  impl.lateSignal(CANCELLED)
  await until('the pause to be marked superseded', () => run.pause?.superseded?.verdict)

  assert.equal(run.pause?.superseded?.verdict?.outcome, 'cancelled')
  assert.match(run.pause!.superseded!.note, /cancelled/i)
  assert.match(run.pause!.superseded!.note, /orchestrator:cancelled by test control/, 'the provenance from formatVerdict is preserved')
  assert.doesNotMatch(run.pause!.superseded!.note, /turn ended|turn has ended|the turn landed|still running|another timeout|watchdog fired again/i)
  await run.abort()
})

test('an unexpired /wait carries across a re-raised pause with the same verdictOf', async (t) => {
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it, slowly.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT }
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']), [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const pause = await run.untilPause()
  assert.ok(pause)
  const originalEndSeq = pause.verdictOf?.endSeq

  const untilTs = Date.now() + 10_000
  assert.ok(run.wait({ at: Date.now(), until: untilTs }))

  impl.lateSignal(TIMED_OUT)
  await until('the pause to be marked superseded', () => run.pause?.superseded?.verdict)

  assert.ok(run.pause?.waiting, 'the unexpired wait is carried across the re-raised pause')
  assert.equal(run.pause?.waiting?.until, untilTs)
  assert.equal(run.pause?.verdictOf?.endSeq, originalEndSeq, 'the verdict the pause rests on is unchanged')
  await run.abort()
})

test('a /wait is not carried across a re-raised pause after it has expired', async (t) => {
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it, slowly.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT }
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']), [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  await run.untilPause()

  const untilTs = Date.now() - 1
  assert.ok(run.wait({ at: Date.now() - 1000, until: untilTs }))

  impl.lateSignal(TIMED_OUT)
  await until('the pause to be marked superseded', () => run.pause?.superseded?.verdict)

  assert.equal(run.pause?.waiting, undefined, 'an expired wait is dropped when the pause is re-raised')
  await run.abort()
})

test('a /wait is not carried to a fresh pause on a different turn', async (t) => {
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it, slowly.', 'Did it again.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT }
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'Do it again.', 'DONE']), [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const first = await run.untilPause()
  assert.ok(first)
  const firstEndSeq = first.verdictOf?.endSeq
  assert.ok(run.wait({ at: Date.now(), until: Date.now() + 10_000 }))

  // The supersession resolves the first turn, so the operator can continue. The next turn ends
  // with another timed_out and raises a fresh pause — the wait decision was tied to the first.
  impl.lateSignal(COMPLETED)
  await until('the first pause to be marked superseded', () => run.pause?.superseded?.verdict)
  await run.continue()

  impl.endTurn = { index: 2, verdict: TIMED_OUT }
  const second = await run.untilPause()
  assert.ok(second)
  assert.notEqual(second.verdictOf?.endSeq, firstEndSeq, 'the second pause rests on a different turn')
  assert.equal(second.waiting, undefined, 'the wait from the first turn does not leak to the next')
  await run.abort()
})

// ---------------------------------------------------------------------------------------
// RunHandle memory keyed by verdictOf: the in-place mutation is preserved, but a later,
// distinct pause object for the same turn must also carry an unexpired wait decision.
// ---------------------------------------------------------------------------------------

function runHandle(): RunHandle {
  const control = {
    rotate: async () => ({ status: 'rolled_back', reason: 'test', detail: 'test' }) as any,
    constrain: () => ({}) as any,
    requestStop: () => {},
    requestPause: () => {},
  } satisfies RunControl
  return new RunHandle(control)
}

const verdictOf = (participant: string, endSeq: number) => ({ participant, endSeq })

function pauseShape(participant: string, endSeq: number): Omit<import('./run.ts').RunPause, 'at'> {
  return {
    reason: 'turn_incomplete',
    // Computed, exactly as the relay computes it. A literal here would be a second opinion
    // about the classification, free to drift from the one the product actually records.
    resolution: resolutionFor({ reason: 'turn_incomplete', participant }, { rotationArmed: true }),
    detail: 'timed out',
    evidence: [],
    options: ['continue', 'abort'],
    verdictOf: verdictOf(participant, endSeq),
    atSeq: endSeq,
  }
}

test('RunHandle copies an unexpired wait to a distinct later pause with the same verdictOf', async () => {
  const run = runHandle()
  const firstDecision = run.pauseAt(pauseShape('impl', 1))
  const firstPause = run.pause
  assert.ok(firstPause)

  const untilTs = Date.now() + 10_000
  assert.ok(run.wait({ at: Date.now(), until: untilTs }))
  assert.equal(firstPause.waiting?.until, untilTs)

  await run.continue()
  await firstDecision

  const secondDecision = run.pauseAt(pauseShape('impl', 1))
  const secondPause = run.pause
  assert.ok(secondPause)
  assert.notEqual(firstPause, secondPause, 'the two pauses are distinct objects')
  assert.ok(secondPause.waiting, 'the unexpired wait is copied onto the distinct later pause')
  assert.equal(secondPause.waiting?.until, untilTs)
  assert.equal(secondPause.verdictOf?.endSeq, 1)

  await run.continue()
  await secondDecision
})

test('RunHandle does not copy an expired wait to a distinct later pause', async () => {
  const run = runHandle()
  const firstDecision = run.pauseAt(pauseShape('impl', 1))
  assert.ok(run.wait({ at: Date.now() - 1000, until: Date.now() - 1 }))

  await run.continue()
  await firstDecision

  const secondDecision = run.pauseAt(pauseShape('impl', 1))
  assert.equal(run.pause?.waiting, undefined, 'an expired wait is not copied onto a later pause')

  await run.continue()
  await secondDecision
})

test('RunHandle does not copy a wait to a distinct later pause with a different endSeq', async () => {
  const run = runHandle()
  const firstDecision = run.pauseAt(pauseShape('impl', 1))
  assert.ok(run.wait({ at: Date.now(), until: Date.now() + 10_000 }))

  await run.continue()
  await firstDecision

  const secondDecision = run.pauseAt(pauseShape('impl', 2))
  assert.equal(run.pause?.waiting, undefined, 'a different endSeq is a different turn')

  await run.continue()
  await secondDecision
})

test('RunHandle does not copy a wait to a distinct later pause with a different participant', async () => {
  const run = runHandle()
  const firstDecision = run.pauseAt(pauseShape('impl', 1))
  assert.ok(run.wait({ at: Date.now(), until: Date.now() + 10_000 }))

  await run.continue()
  await firstDecision

  const secondDecision = run.pauseAt(pauseShape('advisor', 1))
  assert.equal(run.pause?.waiting, undefined, 'a different participant is a different seat')

  await run.continue()
  await secondDecision
})

// ---------------------------------------------------------------------------------------
// A pause as something you can WATCH, not only something you can await.
//
// `untilPause()` serves the one caller driving the run. Everything else looking at the
// session -- the status recorder, a console, anything attaching mid-run -- reads the
// observation stream, and there a pause was previously visible only as a `note` whose text
// began "paused (". That is prose: a viewer had to match a string to learn the loop had
// stopped, and got nothing structured to render the reason or the evidence from.
//
// These are about the two properties that make the events worth having: the payload is the
// operator's own pause OBJECT, and the pair brackets the suspension in the right order.
// ---------------------------------------------------------------------------------------

/** Narrowing find. `events.find(e => e.type === 'pause')` keeps the whole union. */
function firstOfType<T extends RelayEvent['type']>(
  events: RelayEvent[],
  type: T,
): Extract<RelayEvent, { type: T }> | undefined {
  return events.find((e): e is Extract<RelayEvent, { type: T }> => e.type === type)
}

/** Reads a subscription in the background. Detach, or an abandoned reader outlives the test. */
function collect(relay: Relay): { events: RelayEvent[]; detach: () => void } {
  const events: RelayEvent[] = []
  const it = relay.observe()[Symbol.asyncIterator]()
  void (async () => {
    for (;;) {
      const next = await it.next()
      if (next.done) return
      events.push(next.value)
    }
  })()
  return { events, detach: () => void it.return?.() }
}

test('a pause and its resume reach an observer, bracketing the suspension', async (t) => {
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']), [impl])
  t.after(() => relay.stop())
  const seen = collect(relay)
  t.after(seen.detach)

  const run = relay.start('Keep the work moving.')
  impl.compact()
  const pause = await run.untilPause()
  assert.ok(pause)

  const emitted = await until('the pause to reach the stream', () => firstOfType(seen.events, 'pause'))
  // Identity, not equality. A subscriber holding a copy could never learn the pause had been
  // superseded, because `supersede()` amends in place.
  assert.equal(emitted.pause, pause, 'the stream carries the operator’s own pause object')
  assert.equal(
    firstOfType(seen.events, 'resume'),
    undefined,
    'nothing has resumed: the loop is still suspended at this point',
  )

  await run.continue()
  const resumed = await until('the resume to reach the stream', () => firstOfType(seen.events, 'resume'))
  assert.equal(resumed.pause, pause, 'the pair is matchable by identity rather than by adjacency')
  assert.ok(resumed.seq > emitted.seq)

  assert.equal((await run.result()).reason, 'done')

  // And in the right place relative to the log the notes go to: the raised note, then the
  // suspension, then the withdrawal of it, then the run ending.
  const noteAt = (prefix: string) =>
    seen.events.findIndex((e) => e.type === 'message' && e.message.kind === 'note' && e.message.text.startsWith(prefix))
  const at = (type: RelayEvent['type']) => seen.events.findIndex((e) => e.type === type)
  const order = [noteAt('paused (rotation_candidate)'), at('pause'), at('resume'), noteAt('resumed from')]
  assert.ok(
    order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]!)),
    `expected paused-note < pause < resume < resumed-note, got ${order.join(', ')}`,
  )
  assert.equal(seen.events.at(-1)?.type, 'run_end')
})

test('an aborted pause is never resumed', async (t) => {
  // The end of the run is what says the operator declined, and `run_end` already says it. A
  // resume followed immediately by the end would read as a session that carried on.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']), [impl])
  t.after(() => relay.stop())
  const seen = collect(relay)
  t.after(seen.detach)

  const run = relay.start('Keep the work moving.')
  impl.compact()
  assert.ok(await run.untilPause())
  await run.abort('the operator stopped here')

  const end = await until('the run to end', () => firstOfType(seen.events, 'run_end'))
  assert.ok(firstOfType(seen.events, 'pause'), 'the pause itself was still announced')
  assert.equal(firstOfType(seen.events, 'resume'), undefined, 'an abort is not a resume')
  assert.equal(end.reason, 'stopped')
})

test('the pause on the stream is the one that gets amended, not a snapshot of it', async (t) => {
  // The reason the payload is the object and not a copy. A viewer rendering a pause it was
  // handed here must be able to show that the verdict underneath it has been withdrawn --
  // there is no second event to tell it, because `supersede()` mutates in place precisely
  // because everyone who will hear about the pause already holds it.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it, slowly.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT }
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']), [impl])
  t.after(() => relay.stop())
  const seen = collect(relay)
  t.after(seen.detach)

  const run = relay.start('Keep the work moving.')
  const pause = await run.untilPause()
  assert.equal(pause?.reason, 'turn_incomplete')

  const emitted = await until('the pause to reach the stream', () => firstOfType(seen.events, 'pause'))
  // Via a local, as above: asserting on the field itself narrows it to `undefined` for good.
  const before = emitted.pause.superseded
  assert.equal(before, undefined, 'nothing has contradicted it yet')

  impl.lateSignal(COMPLETED)
  await until('the pause to be marked superseded', () => run.pause?.superseded?.verdict)
  assert.equal(
    emitted.pause.superseded?.verdict?.outcome,
    'completed',
    'a copy would have frozen at the moment of emission',
  )
  await run.abort()
})
