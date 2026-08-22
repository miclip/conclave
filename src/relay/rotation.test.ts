/**
 * Rotation inside a running relay.
 *
 * `rotation/rotate.test.ts` proves the transaction against sessions in isolation. What it
 * cannot show is the part that only exists here: a relay is mid-conversation when this
 * happens, and the replacement has to take over an identity that the routing log, the
 * event stream and the advisor all already refer to.
 *
 * So these tests are about the seam, not the protocol — who the log says is talking, which
 * reader owns which queue, and whether the session that ends up running is the one the
 * transaction chose.
 *
 *   node --test src/relay/rotation.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AgentSession } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { Relay, extractFlags, type RelayOptions } from './relay.ts'
import type { RelayEvent } from './observe.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
// The recorder, used here rather than a hand-built status document: an agent operator reads
// `status.json` and nothing else, so a claim about what it contains has to be made through the
// call the console makes (#103, #107).
import { newSessionId, readSession, recordSession } from '../workspace/sessionRecord.ts'
// The two renderings the operator actually sees. `status --json` prints the first and the
// human `status` prints the second, so a claim about what a poller can read has to be made
// through them rather than off the record they format.
import { formatSession, formatSessionJson } from '../workspace/sessionView.ts'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-relay-rot-'))
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

/**
 * A registry that hands out a queue of sessions per agent, so the second `create` for the
 * implementer returns the replacement rather than the session being retired.
 */
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
  // `rotation` is lifted out of the Partial because `exactOptionalPropertyTypes` makes
  // `rotation: undefined` an error rather than an omission, and "no rotation configured"
  // is a case these tests have to be able to express.
  over: Omit<Partial<RelayOptions>, 'rotation'> & { rotation?: RelayOptions['rotation'] | undefined } = {},
): Promise<Relay> {
  return Relay.start({
    registry: registryOf({ codex: [advisor], claude: implementers }),
    cwd,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 2,
    rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000, onDegradation: 'automatic' },
    ...over,
    // `exactOptionalPropertyTypes` treats `rotation: undefined` as an error rather than an
    // omission, and "no rotation configured" is a case these tests must be able to express.
    ...(over.rotation === undefined && 'rotation' in over ? { rotation: undefined } : {}),
  } as RelayOptions)
}

test('a rotation swaps the session and keeps the participant identity', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', [HANDOFF])
  const old = new FakeRotationSession('old', 'claude')
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED])

  const relay = await relayOf(dir, advisor, [old, fresh])
  t.after(() => relay.stop())

  const r = await relay.rotateImplementer('context exhausted')
  assert.equal(r.status, 'rotated')

  const impl = relay.participants.find((p) => p.rank === 'implementer')!
  // The id is what the log, the advisor and every audit entry already refer to. A rotation
  // that changed it would break every reference to the implementer that already exists.
  assert.equal(impl.id, 'implementer')
  assert.equal(impl.session, fresh)
  assert.equal(old.state, 'terminated')
  assert.equal(fresh.state, 'running')

  // The counter every run report and summary line quotes.
  //
  // It was initialised to 0 and incremented nowhere, so every run reported `0 rotations`
  // whatever happened -- including the first successful rotation this project performed,
  // which the routing log recorded as `rotated into <id>` on the very same line. That zero
  // was then read, repeatedly, as evidence that rotation had never fired. An instrument
  // that cannot report the thing it watches for makes every reading worthless, including
  // the ones that happen to be right.
  assert.equal(relay.rotationWatch.rotations, 1, 'an accepted rotation must be counted')
  // And the summary says so. It short-circuits on zero assessments with "nothing was
  // measured", which is right for a run that ended before the instrument was used and a
  // falsehood over the top of a completed transfer -- an operator can force a rotation at a
  // pause before any assessment exists, which is exactly what this test does.
  assert.match(relay.rotationSummary(), /1 rotations/)
})

test('the retired session’s reader retires with it, so the queue is not double-read', async (t) => {
  // The single-consumer invariant is the one this project has been bitten by twice. A
  // rotation that left the old reader running would be a third.
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', [HANDOFF])
  const old = new FakeRotationSession('old', 'claude')
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED])

  const relay = await relayOf(dir, advisor, [old, fresh])
  t.after(() => relay.stop())
  await relay.rotateImplementer('context exhausted')

  const impl = relay.participants.find((p) => p.rank === 'implementer')!
  const before = impl.events.length
  fresh.emit({ type: 'tool_use', tool: 'Read', input: {}, seq: 99, at: Date.now(), provisional: true })
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(impl.events.length, before + 1, 'exactly one reader delivered the event')
  assert.equal(impl.events.at(-1)!.type, 'tool_use')
})

test('activity from the replacement is attributed to the implementer, not to an audition', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', [HANDOFF])
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED])

  const relay = await relayOf(dir, advisor, [new FakeRotationSession('old', 'claude'), fresh])
  t.after(() => relay.stop())

  const seen: RelayEvent[] = []
  void (async () => {
    for await (const e of relay.observe()) seen.push(e)
  })()

  await relay.rotateImplementer('context exhausted')
  fresh.emit({ type: 'tool_use', tool: 'Edit', input: {}, seq: 99, at: Date.now(), provisional: true })
  await new Promise((r) => setTimeout(r, 30))

  const attributed = seen.filter((e) => e.type === 'activity' && e.event.type === 'tool_use')
  assert.ok(attributed.length > 0)
  const last = attributed.at(-1)!
  assert.equal(last.type, 'activity')
  if (last.type !== 'activity') return
  // While it was auditioning it was correctly not the implementer. Once promoted it is,
  // and an observer that saw `implementer~replacement` forever would be reading a
  // participant that does not exist.
  assert.equal(last.participant, 'implementer')
})

test('a failed rotation leaves the original in service and says so in the log', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', ['I would just start over, roughly here.'])
  const old = new FakeRotationSession('old', 'claude')
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED])

  const relay = await relayOf(dir, advisor, [old, fresh])
  t.after(() => relay.stop())

  const r = await relay.rotateImplementer('context exhausted')
  assert.equal(r.status, 'rolled_back')

  const impl = relay.participants.find((p) => p.rank === 'implementer')!
  assert.equal(impl.session, old)
  assert.equal(old.state, 'running')
  assert.ok(
    relay.log.some((m) => m.text.includes('rolled back') && m.text.includes('back in service')),
    'a rollback the log does not mention is the silent failure the protocol exists to prevent',
  )
})

test('a rotation whose outgoing disposal is unconfirmed still promotes the replacement (#155)', async (t) => {
  /**
   * `rotated_cleanup_failed` through the relay, which is where it either loses a seat or does not.
   *
   * The transaction's own tests prove the outcome is produced. What only exists here is what the
   * relay DOES with it, and the promotion block was a `result.status === 'rotated'` check: a
   * third variant walked straight past it, leaving the seat holding a session this transaction
   * had already torn the transport off, with a live, proven, unreferenced replacement beside it.
   * The compiler could not see that -- the branch is truthiness on a string, not exhaustiveness
   * -- so it is pinned here instead.
   *
   * The failure is injected at the position the adapters actually fail from: `terminated` is
   * their last statement, so a close that rejects leaves the state at `rotating`. `unquiesce()`
   * accepts `rotating`, which is why this used to come back as `rolled_back` with the original
   * reported restored -- over a session that could not answer, and might or might not still have
   * a child behind it. Neither this test nor the code can tell which; that is the point.
   */
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', [HANDOFF])
  const old = new FakeRotationSession('old', 'claude')
  old.closeThrowsBeforeTerminated = 'receiver.stop: the socket is already gone'
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED])

  const relay = await relayOf(dir, advisor, [old, fresh])
  t.after(() => relay.stop())

  const r = await relay.rotateImplementer('context exhausted')
  assert.equal(r.status, 'rotated_cleanup_failed')

  // 1. The replacement is promoted exactly as for `rotated`: same seat id, same object.
  const impl = relay.participants.find((p) => p.rank === 'implementer')!
  assert.equal(impl.id, 'implementer', 'the seat keeps the identity the log already refers to')
  assert.equal(impl.session, fresh, 'the proven replacement holds the seat')
  assert.equal(fresh.state, 'running')
  assert.equal(fresh.closedAs, undefined, 'and was not abandoned by a rollback of a rotation that happened')
  assert.equal(relay.rotationWatch.rotations, 1, 'it is a rotation, and the counter every report quotes says so')

  // 2. The outgoing session is NOT reported back into service. Its transport is gone; nothing
  //    unquiesced it, and it does not hold the seat.
  assert.notEqual(old.state, 'running', 'a session whose transport has been disposed of is not restored')
  assert.equal(old.transportDisposed, true, 'precondition: the fixture ran its teardown before it rejected')
  assert.notEqual(impl.session, old)

  // 3. The record an analysis outside the process reads carries it. Without this a run whose
  //    rotations all left a child behind reads identically to one whose rotations were clean.
  const records = relay.rotationRecords()
  assert.equal(records.length, 1)
  assert.ok(records[0]!.cleanupFailure, 'the record says the loser was not confirmed disposed of')
  assert.match(records[0]!.cleanupFailure!.detail, /socket is already gone/)
  assert.equal(records[0]!.cleanupFailure!.outgoingState, 'rotating')

  // 4. The routing log says it, at human rank, in its own note. The rotation note beside it is
  //    unchanged: this is an addition to the record, not a replacement of the success.
  assert.ok(
    relay.log.some((m) => m.text.includes('rotated into fresh')),
    'the rotation itself is still recorded as one',
  )
  //    Two notes say it, from the two layers that know different halves: the transaction's own
  //    completion line (through `deps.note`), which used to read `old terminated` and would have
  //    been the false one, and the relay's, which is the one that names an action.
  const disposal = relay.log.filter((m) => m.text.includes('NOT be confirmed disposed of'))
  assert.equal(disposal.length, 2, `both layers must say it: ${JSON.stringify(relay.log.map((m) => m.text))}`)
  assert.ok(
    disposal.every((m) => m.fromRank === 'human'),
    'at the rank the rotation itself is recorded at, not buried as orchestrator chatter',
  )
  assert.ok(
    disposal.some((m) => m.text.includes(`old could NOT be confirmed disposed of`)),
    'the transaction names the session, where it used to claim it was terminated',
  )
  const orphan = relay.log.find((m) => m.text.includes('orphaned process'))
  assert.ok(orphan, 'the relay names what the operator should go and look for')
  assert.match(orphan.text, /state reads 'rotating'/, 'and reports the state as read')
  assert.match(orphan.text, /rotation itself stands/, 'while saying plainly that the transfer happened')
  assert.ok(
    !relay.log.some((m) => m.text.includes('rolled back')),
    'and it is not described as a rollback, because nothing was rolled back',
  )

  // 5. The end-of-run summary both front-ends print. The routing log is 300 lines up by then.
  const summary = relay.rotationSummary()
  assert.match(summary, /1 rotations/, 'still counted as a rotation')
  assert.match(summary, /outgoing session NOT confirmed disposed of \(state 'rotating'\)/)
  assert.match(summary, /check for an orphaned process/)
})

test('human constraints are replayed to the replacement at human rank', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', [HANDOFF])
  const fresh = new FakeRotationSession('fresh', 'claude', ['Understood.', ACCEPTED])

  const relay = await relayOf(dir, advisor, [new FakeRotationSession('old', 'claude'), fresh])
  t.after(() => relay.stop())

  relay.say('Never stage with git add -A while a session is live.', 'all')
  const r = await relay.rotateImplementer('context exhausted')

  assert.equal(r.status, 'rotated')
  assert.ok(fresh.received[0]!.includes('FROM THE HUMAN'))
  assert.ok(fresh.received[0]!.includes('git add -A'))
})

test('an advisor-only aside is not replayed to the replacement', async (t) => {
  // Replaying it would hand the new implementer something the old one was never shown,
  // which quietly rewrites the asymmetry the audit is supposed to describe.
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', [HANDOFF])
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED])

  const relay = await relayOf(dir, advisor, [new FakeRotationSession('old', 'claude'), fresh])
  t.after(() => relay.stop())

  relay.say('Do not tell the implementer this.', { only: 'advisor' }, 'aside')
  await relay.rotateImplementer('context exhausted')

  assert.ok(!fresh.received.some((m) => m.includes('Do not tell the implementer')))
})

test('rotation without configured checks is refused rather than done unverified', async (t) => {
  const dir = repo()
  const relay = await relayOf(
    dir,
    new FakeRotationSession('advisor', 'codex', [HANDOFF]),
    [new FakeRotationSession('old', 'claude'), new FakeRotationSession('fresh', 'claude', [ACCEPTED])],
    { rotation: undefined },
  )
  t.after(() => relay.stop())

  await assert.rejects(() => relay.rotateImplementer('context exhausted'), /transfer nobody demonstrated/)
})

test('compaction is a rotation CANDIDATE by default, recorded and not acted on', async (t) => {
  // Two claims, and only one of them has evidence. That Conclave can execute a
  // transactional rotation is answerable -- live runs do it. That compaction predicts
  // degradation strongly enough to ACT on needs a comparison across sessions, because a
  // session may compact without degrading and may degrade before compacting. Until that
  // exists, nothing is spent on the proxy.
  //
  // An unattended run used to END here. That was invisible for as long as the counter could
  // not move -- no unattended run had ever raised a candidate -- and the moment the counter
  // was fixed every long run would have stopped at its first compaction. Ending a run is the
  // most drastic action available, not a neutral one, so "recorded, not acted on" now means
  // exactly that: the count reaches the operator through the summary and the work continues.
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do the first thing.', HANDOFF, 'DONE'])
  const old = new FakeRotationSession('old', 'claude', ['ack', 'Did the first thing.'])
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED, 'Carried on.'])

  const relay = await relayOf(dir, advisor, [old, fresh], {
    maxAdvisorTurns: 3,
    rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000 },
  })
  t.after(() => relay.stop())

  old.compact()
  const outcome = await relay.run('Keep the work moving.')

  // The run finishes rather than stopping at the compaction.
  assert.notEqual(outcome.reason, 'escalated', 'a candidate must not end an unattended run')
  assert.equal(relay.rotationWatch.candidates, 1, 'but it is counted')
  assert.ok(
    relay.log.some((m) => m.kind === 'note' && /rotation candidate recorded, run continues/.test(m.text)),
    'and recorded where an operator will read it',
  )
  assert.match(relay.rotationSummary(), /1 candidates/)
  assert.equal(old.state, 'running', 'nothing is spent on a proxy that has never been checked')
  assert.equal(fresh.state, 'running', 'and no replacement was started')
  assert.equal(relay.participants.find((p) => p.rank === 'implementer')!.session, old)

  // The trailing "and the human can still rotate" check has moved out of this test. It
  // belonged to the old shape, where the run ENDED at the candidate and the replacement was
  // therefore untouched. Now the run continues and consumes it, so rotating afterwards
  // exercises a different scenario than the one this test is about. The mechanism is covered
  // by the dedicated rotation tests above, and by the live rollback suite.
})

test('a run rotates automatically when the implementer compacts, if opted in', async (t) => {
  const dir = repo()
  // The advisor's first turn answers its briefing with the opening instruction; the
  // implementer's answers its own briefing with an acknowledgement.
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do the first thing.', HANDOFF, 'DONE'])
  const old = new FakeRotationSession('old', 'claude', ['ack', 'Did the first thing.'])
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED, 'Carried on.'])

  const relay = await relayOf(dir, advisor, [old, fresh], { maxAdvisorTurns: 3 })
  t.after(() => relay.stop())

  // Compaction with no complaint: degradation alone is sufficient, because a model may
  // compact without noticing or notice and not say.
  old.compact()

  const outcome = await relay.run('Keep the work moving.')

  assert.equal(outcome.reason, 'done')
  assert.equal(old.state, 'terminated')
  assert.equal(relay.participants.find((p) => p.rank === 'implementer')!.session, fresh)
  assert.ok(relay.log.some((m) => m.text.includes('rotating implementer')))
  assert.ok(relay.log.some((m) => m.text.includes('did not say so')))
})

test('an automatic rotation with an unconfirmed disposal carries the run on rather than halting (#155)', async (t) => {
  /**
   * The unattended consumer of `rotated_cleanup_failed`, and the branch a third variant could
   * silently fall out of.
   *
   * The degradation path reads the transaction's result to decide whether the loop continues:
   * `rotated` returns and the run carries on, anything else escalates to a halt. A new outcome
   * that is a SUCCESS would have been read as an escalation -- an unattended run stopping to put
   * a pause in front of a human who is not there, over a session the transaction had already
   * replaced.
   *
   * Halting is also the wrong remedy on its own terms. There may be an orphaned child; there may
   * equally not be, because a step that rejects may have completed its work first. Stopping the
   * work to report a process that may not exist trades a run for a note the record already
   * carries -- which is why the ambiguity goes in the routing log and the run report, and the
   * loop does not act on it.
   */
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do the first thing.', HANDOFF, 'DONE'])
  const old = new FakeRotationSession('old', 'claude', ['ack', 'Did the first thing.'])
  old.closeThrowsBeforeTerminated = 'receiver.stop: the socket is already gone'
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED, 'Carried on.'])

  const relay = await relayOf(dir, advisor, [old, fresh], { maxAdvisorTurns: 3 })
  t.after(() => relay.stop())

  old.compact()
  const outcome = await relay.run('Keep the work moving.')

  assert.equal(outcome.reason, 'done', 'the run finishes; a failed teardown is not a reason to stop working')
  assert.equal(relay.participants.find((p) => p.rank === 'implementer')!.session, fresh)
  assert.notEqual(old.state, 'running', 'and the session with no transport left is not back in service')
  assert.equal(relay.rotationWatch.rotations, 1)
  assert.equal(relay.rotationRecords()[0]!.intent, 'degradation_automatic', 'still the detector‘s population')
  assert.ok(relay.rotationRecords()[0]!.cleanupFailure, 'and the record carries what could not be confirmed')
  // The evidence reaches the unattended operator the only way it can: the record they read after.
  assert.ok(relay.log.some((m) => m.text.includes('orphaned process')))
  assert.match(relay.rotationSummary(), /outgoing session NOT confirmed disposed of/)
})

/**
 * The rotation trigger, on a snapshot no read confirmed.
 *
 * `snapshot()` on both adapters is contained: a transcript that will not answer produces the
 * last projection the view could build, flagged `containedFallback`, rather than a rejection.
 * That containment is what keeps a wedged transcript from stranding a report or a quiesced
 * rotation -- and it means the `compactionGeneration` in that projection is a number from a read
 * that could not be repeated.
 *
 * `rotation/rotate.ts` already declines to write such a generation into a handoff record. That
 * left the trigger as the hole: the relay would START a rotation -- quiesce a working session,
 * spend an advisor handoff turn, launch a replacement -- on exactly the number the transaction
 * would then refuse to record as evidence.
 *
 * The generation is set directly rather than through `compact()`, and that is the point of the
 * test: `compact()` moves BOTH channels, and this is about the one that depends on a read having
 * happened. `degradation.ts` reads the snapshot generation and the live `revision` events
 * independently, and only the first of them is in doubt here.
 */
test('a compaction generation from a contained fallback does not start a rotation', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do the first thing.', HANDOFF, 'DONE'])
  const old = new FakeRotationSession('old', 'claude', ['ack', 'Did the first thing.'])
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED, 'Carried on.'])

  const relay = await relayOf(dir, advisor, [old, fresh], { maxAdvisorTurns: 3 })
  t.after(() => relay.stop())

  // A compaction that shows up ONLY in a snapshot the view could not confirm.
  old.compactionGeneration = 1
  old.containedFallback = true

  const outcome = await relay.run('Keep the work moving.')

  assert.equal(outcome.reason, 'done')
  assert.equal(old.state, 'running', 'an unverified number must not spend a working session')
  assert.equal(relay.participants.find((p) => p.rank === 'implementer')!.session, old)
  assert.equal(relay.rotationWatch.rotations, 0)
  assert.equal(relay.rotationWatch.candidates, 0, 'and must not even be raised as a candidate')

  // Withheld is not the same as unseen. The whole justification for not acting is that the
  // signal is recorded and weighed again later; if it left no trace, this would be a run that
  // silently stopped watching.
  const note = relay.log.find((m) => m.kind === 'note' && /was NOT counted as rotation evidence/.test(m.text))
  assert.ok(note, `the withheld generation must be recorded:\n${relay.log.map((m) => m.text).join('\n---\n')}`)
  assert.match(note!.text, /contained fallback/, 'and the record must say WHY it was not counted')
  assert.match(note!.text, /generation 1 \(baseline 0\)/, 'and name the number it declined to believe')

  // The evidence is deferred, not consumed. `#acknowledge` moves the baseline so one compaction
  // is raised once -- doing that here would swallow the compaction for good, and the next turn
  // whose read succeeds would see no delta and say nothing. This assertion is the difference
  // between "not yet" and "never".
  assert.equal(
    relay.participants.find((p) => p.rank === 'implementer')!.baselineGeneration,
    0,
    'the baseline must not move on evidence that was never weighed',
  )
})

/**
 * The control for the test above, and the reason it is worth anything.
 *
 * Identical in every respect except the flag. Without this, a mistake that broke the snapshot
 * channel outright -- or an `assess` call that stopped reading the generation at all -- would
 * leave the test above passing while the feature it guards was gone.
 */
test('the same generation rotates when the read behind it answered', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do the first thing.', HANDOFF, 'DONE'])
  const old = new FakeRotationSession('old', 'claude', ['ack', 'Did the first thing.'])
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED, 'Carried on.'])

  const relay = await relayOf(dir, advisor, [old, fresh], { maxAdvisorTurns: 3 })
  t.after(() => relay.stop())

  old.compactionGeneration = 1
  // and `containedFallback` stays false: this snapshot is a read, not the last thing built.

  const outcome = await relay.run('Keep the work moving.')

  assert.equal(outcome.reason, 'done')
  assert.equal(old.state, 'terminated', 'a verified generation is evidence and still rotates')
  assert.equal(relay.participants.find((p) => p.rank === 'implementer')!.session, fresh)
  assert.ok(
    !relay.log.some((m) => /was NOT counted as rotation evidence/.test(m.text)),
    'and nothing is withheld, so nothing says it was',
  )
})

/**
 * Only the snapshot channel is withheld.
 *
 * A `revision` event is a live signal that already arrived on the session's own stream. It does
 * not become doubtful because a later read of the transcript did not answer, and treating the
 * fallback flag as a blanket veto over `detectDegradation` would throw away the one channel that
 * is still telling the truth -- turning a wedged transcript into a blind spot rather than a
 * delayed one.
 */
test('a contained fallback does not silence the revision-event channel', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do the first thing.', HANDOFF, 'DONE'])
  const old = new FakeRotationSession('old', 'claude', ['ack', 'Did the first thing.'])
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED, 'Carried on.'])

  const relay = await relayOf(dir, advisor, [old, fresh], { maxAdvisorTurns: 3 })
  t.after(() => relay.stop())

  // Both channels move, and then the transcript stops answering.
  old.compact()
  old.containedFallback = true

  const outcome = await relay.run('Keep the work moving.')

  assert.equal(outcome.reason, 'done')
  assert.equal(old.state, 'terminated', 'the event is evidence on its own and still rotates')
  assert.equal(relay.participants.find((p) => p.rank === 'implementer')!.session, fresh)
  // The note is still written: the rotation was decided on the event, and the record has to say
  // that the number beside it in the log was not part of that decision.
  assert.ok(relay.log.some((m) => /was NOT counted as rotation evidence/.test(m.text)))
})

/**
 * A fallback with nothing to withhold writes nothing.
 *
 * A wedged transcript is read on every advisor turn, so a note keyed to the FLAG rather than to
 * the flag mattering would append a paragraph per turn to a log an operator is supposed to read.
 * The note exists to be noticed; one that fires on every turn of a normal long run is one nobody
 * reads, and that costs the same as not writing it.
 */
test('a contained fallback whose generation has not moved records nothing', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do the thing.', 'DONE'])
  const old = new FakeRotationSession('old', 'claude', ['ack', 'Done that.'])

  const relay = await relayOf(dir, advisor, [old], { maxAdvisorTurns: 2 })
  t.after(() => relay.stop())

  old.containedFallback = true

  await relay.run('Keep the work moving.')

  assert.equal(old.state, 'running')
  assert.ok(
    !relay.log.some((m) => /was NOT counted as rotation evidence/.test(m.text)),
    'nothing was withheld, so there is nothing to report',
  )
})

test('a complaint with nothing behind it continues, and is counted', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do the thing.', 'DONE'])
  const old = new FakeRotationSession('old', 'claude', ['ack', 'I need a fresh session before I can continue.'])
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED])

  const relay = await relayOf(dir, advisor, [old, fresh], { maxAdvisorTurns: 2 })
  t.after(() => relay.stop())

  await relay.run('Keep the work moving.')

  assert.equal(old.state, 'running', 'a reflex must not spend a session')
  assert.equal(relay.complaints.count('implementer', 'wants-fresh-session'), 1)
  assert.ok(relay.log.some((m) => m.text.includes('no compaction behind it')))
})

test('degradation with no checks configured escalates rather than rotating blind', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do the thing.', 'DONE'])
  const old = new FakeRotationSession('old', 'claude', ['ack', 'Done that.'])

  const relay = await relayOf(dir, advisor, [old], { rotation: undefined, maxAdvisorTurns: 2 })
  t.after(() => relay.stop())

  old.compact()
  const outcome = await relay.run('Keep the work moving.')

  // Detection does not depend on configuration; only the RESPONSE does, and the response is
  // no longer to end (#96). Unattended and unarmed, the candidate is recorded and the run
  // carries on -- the same treatment the armed unattended run already got, for the same
  // reason: ending is the most drastic action available, not the neutral thing to do while
  // there is nobody to ask.
  assert.notEqual(outcome.reason, 'escalated', 'a compaction must not end an unattended run')
  assert.equal(old.state, 'running', 'and must never rotate blind: there is nothing to verify against')

  // Recorded rather than silent. This is the whole justification for not ending -- if the
  // candidate left no trace, "carries on" would mean the operator never learns it happened.
  assert.equal(relay.rotationWatch.candidates, 1)
  assert.ok(
    relay.log.some((m) => /rotation candidate recorded, run continues \(unattended/.test(m.text) && /degraded/.test(m.text)),
    `the log must record the candidate:\n${relay.log.map((m) => m.text).join('\n---\n')}`,
  )
})

/**
 * The same condition, on a run an AGENT is driving (#107).
 *
 * #96 turned the unarmed candidate from a run-ending escalation into a question, and the
 * question is right when a human is at the console: it costs them a moment and the answer is
 * theirs. `--operator agent` is the case that reasoning does not cover. The only answers the
 * pause offers are `continue` and "stop and re-run with --checks", and an agent operator
 * cannot re-launch the run it is presently driving — so every one of these pauses resolves
 * `continue`, having spent a full operator round-trip to say so.
 *
 * And it is not one pause. `#acknowledge` moves the baseline so a single compaction is raised
 * once, which is exactly what makes a LATER compaction new evidence — so a long implementer,
 * which compacts repeatedly by design, walks the run into the same pause again and again. That
 * is the shape this test is built around: repeated DISTINCT compactions, not one replayed.
 *
 * The two assertions that matter are a pair, and neither alone would catch a regression:
 * nothing paused, and every candidate was still written down. "Recorded, not acted on" has to
 * mean both halves, or this becomes a run that silently stops watching.
 *
 * The record is checked where an agent operator actually reads it -- `status.json`, through the
 * real recorder -- and not only on the relay object. An agent driving this run has no console
 * and no `relay.log`; if the seat's #103 rotation block went missing or started claiming an
 * armed policy, the in-process assertions below would all still pass while the one interface
 * the operator has went wrong.
 */
test('an agent-operated run records every compaction and never stops for one', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'Do the first thing.',
    'Do the second thing.',
    'Do the third thing.',
    'DONE',
  ])
  const impl = new FakeRotationSession('impl', 'claude', [
    'ack',
    'Did the first thing.',
    'Did the second thing.',
    'Did the third thing.',
  ])
  // Compacts at the start of every turn that does work, and not on the briefing turn — a long
  // session compacting more than once is the ordinary case, and `compactOnTurn` can only
  // express the single one. Each compaction is a new generation, so each is new evidence
  // rather than the same finding re-read.
  let sends = 0
  impl.onSend = () => {
    if (sends++ > 0) impl.compact()
  }

  // Unarmed and attended: no checks to adjudicate with, and a handle to suspend into. That is
  // the exact branch #96 gave a pause, and `operator: 'agent'` is the only difference between
  // this run and the one below it.
  const relay = await relayOf(dir, advisor, [impl], {
    rotation: undefined,
    maxAdvisorTurns: 4,
    operator: 'agent',
  })
  t.after(() => relay.stop())

  // The real recorder, on the real relay, writing the real file -- the same call the console
  // makes. `status.json` is the whole of an agent operator's interface to a run it is driving,
  // so the record has to be checked there and not only on the object.
  const recording = recordSession(relay, {
    repoRoot: dir,
    id: newSessionId(Date.now(), process.pid),
    goal: 'Keep the work moving.',
    front: 'session',
    startedAt: Date.now(),
    build: 'test-build',
  })
  t.after(() => recording.close())

  const run = relay.start('Keep the work moving.')
  // `settled()` rather than `result()`: it covers the pause and the end together, so a run
  // that stops here fails this assertion instead of deadlocking against a promise that
  // provably cannot settle.
  const settled = await run.settled()

  assert.ok(
    settled.kind === 'ended',
    settled.kind === 'paused'
      ? `an agent-operated run must not stop on a compaction it has no means to act on, and it ` +
        `stopped on ${settled.pause.reason}: ${settled.pause.detail}`
      : '',
  )
  assert.notEqual(settled.outcome.reason, 'escalated', 'compaction must never end the run either')
  assert.equal(run.state, 'ended')

  // The halt site records `paused (<reason>)` BEFORE it looks at the handle, so this reads
  // whether the site was entered at all rather than whether it happened to suspend. Zero
  // pauses of any reason: nothing else in this run raises one, so a match here is this fix.
  assert.deepEqual(
    relay.log.filter((m) => /^paused \(/.test(m.text)).map((m) => m.text),
    [],
    'no pause was raised at all',
  )

  // And every candidate is still on the record, which is the half that keeps "continues" from
  // meaning "stopped looking".
  const notes = relay.log.filter(
    (m) => m.kind === 'note' && /rotation candidate recorded, run continues \(agent-operated/.test(m.text),
  )
  assert.ok(
    notes.length >= 3,
    `three work turns compacted, so three candidates must be recorded; log:\n${relay.log
      .map((m) => m.text)
      .join('\n---\n')}`,
  )
  assert.equal(relay.rotationWatch.candidates, notes.length, 'the counter and the log agree')
  // DISTINCT compactions. The generation pair travels in the evidence the note carries, so a
  // baseline that had stopped moving — one compaction re-raised N times — would collapse this
  // set and fail here rather than passing as N candidates.
  const generations = new Set(notes.map((m) => /rose (\d+ → \d+)/.exec(m.text)?.[1]))
  assert.equal(
    generations.size,
    notes.length,
    `each candidate must be a new compaction, not the same one re-read: ${[...generations].join(', ')}`,
  )
  assert.match(relay.rotationSummary(), /NOT ARMED/)

  // And the same three facts as an agent operator can actually get at them. #103 was a probe
  // reading a key that did not exist and getting a falsy value it could not tell from a build
  // that does not report the field, so "present" is asserted as its own claim before the
  // values are.
  await recording.refresh()
  const status = readSession(dir, recording.id)
  assert.ok(status, 'the run this test drove must be readable as a session record')
  const seat = status.status.participants.find((p) => p.id === 'implementer')
  assert.notEqual(seat, undefined, 'the implementer seat is in the status document')
  assert.notEqual(seat!.rotation, undefined, 'and it carries a rotation block even unarmed (#103)')
  assert.deepEqual(
    seat!.rotation,
    { configured: false, armed: false, checks: [], onDegradation: null },
    'the run configured no rotation, and the block says exactly that rather than going missing',
  )
  // Who was driving, in the same document. It is what makes the block above readable as a
  // deliberate policy rather than as a run that happened not to be watched.
  assert.equal(status.status.operator, 'agent')
})

test('a HUMAN-attended run still pauses on that compaction (#96 stands)', async (t) => {
  // The other half of #107, and the one that says what was NOT changed. The pause is still
  // the right thing for a human: they can stop the run and re-launch it with --checks, which
  // is the one answer that widens the decision next time, and it is an answer an agent
  // operator driving this run cannot give.
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do the first thing.', 'DONE'])
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did the first thing.'])
  impl.compactOnTurn = 1

  // Identical to the run above but for the operator, which is left at its default.
  const relay = await relayOf(dir, advisor, [impl], { rotation: undefined, maxAdvisorTurns: 4 })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const settled = await run.settled()

  assert.ok(
    settled.kind === 'paused',
    'a human at the console is still asked about a compaction that cannot be adjudicated',
  )
  assert.equal(settled.pause.reason, 'rotation_candidate')
  assert.match(settled.pause.detail, /re-run with --checks/)
  // No `rotate`: unarmed, so a replacement could not be verified and the option would be inert.
  assert.deepEqual(settled.pause.options, ['continue', 'constrain', 'abort'])
  assert.equal(relay.operator, 'human')

  await run.abort()
})

test('the UNARMED human-attended pause is not repeated either (#118)', async (t) => {
  // The same latch on the other branch that puts this question. Unarmed, the menu is `continue`
  // or "stop and re-run with --checks" -- which makes repeating it worse rather than better,
  // because the answer that would widen the decision is one the operator has to leave the run
  // to give. #96 argued the pause is worth a human's moment; it did not argue it is worth their
  // moment once per compaction.
  //
  // Asserted separately from the armed case because the two branches are separate code with
  // separate attendance rules -- this one excludes an agent operator (#107) and the armed one
  // does not -- so a latch on one says nothing about the other.
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'Do the first thing.',
    'Do the second thing.',
    'Do the third thing.',
    'DONE',
  ])
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'One.', 'Two.', 'Three.'])
  let worked = 0
  impl.onSend = () => {
    if (worked++ > 0) impl.compact()
  }

  const relay = await relayOf(dir, advisor, [impl], { rotation: undefined, maxAdvisorTurns: 4 })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const asked: { detail: string; options: readonly string[] }[] = []
  for (;;) {
    const s = await run.settled()
    if (s.kind === 'ended') break
    asked.push({ detail: s.pause.detail, options: [...s.pause.options] })
    if (asked.length > 4) {
      await run.abort()
      break
    }
    await run.continue()
  }

  assert.equal(asked.length, 1, `asked once, on the first compaction:\n${asked.map((a) => a.detail).join('\n---\n')}`)
  assert.match(asked[0]!.detail, /rose 0 → 1/)
  assert.match(asked[0]!.detail, /re-run with --checks/)
  // Still no `rotate`: nothing to verify a replacement against, so the option would be inert.
  assert.deepEqual(asked[0]!.options, ['continue', 'constrain', 'abort'])

  // The later compactions are counted and written down, exactly as on the armed branch.
  assert.equal(relay.rotationWatch.candidates, 3, 'three compactions, all counted')
  assert.equal(
    relay.log.filter((m) => /rotation candidate recorded, run continues \(the operator already declined/.test(m.text))
      .length,
    2,
    `the two the operator was spared are on the record:\n${relay.log.map((m) => m.text).join('\n---\n')}`,
  )
  assert.equal(run.outcome!.reason, 'done')
})

test('an ARMED agent-operated run still raises the candidate, with rotate offered', async (t) => {
  // The boundary of #107, and the assertion that keeps it a boundary. What was changed is the
  // branch where the pause has no answer: unarmed, there is nothing to verify a replacement
  // against, so `continue` and "re-run with --checks" are the whole menu and an agent operator
  // can pick neither usefully. Armed is the opposite case. `rotate` is a real option, it is
  // pre-delegated authority the operator configured on purpose (D2), and an agent CAN take it
  // — so the question is worth asking and is still asked.
  //
  // Without this, the obvious over-broad fix — "an agent operator is never asked about
  // rotation" — would pass every other test in this file.
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do the first thing.', 'DONE'])
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did the first thing.'])
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED])
  impl.compactOnTurn = 1

  const relay = await relayOf(dir, advisor, [impl, fresh], {
    // Armed, and on the `candidate` policy rather than `automatic`: the policy that says raise
    // it and let the operator decide, which is the default `rotationFor` resolves to.
    rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000, onDegradation: 'candidate' },
    maxAdvisorTurns: 4,
    operator: 'agent',
  })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const settled = await run.settled()

  assert.ok(
    settled.kind === 'paused',
    'an armed candidate is a decision an agent operator can actually make, so it is still put',
  )
  assert.equal(settled.pause.reason, 'rotation_candidate')
  assert.match(settled.pause.detail, /Recorded as a rotation candidate, not acted on/)
  assert.ok(
    settled.pause.options.includes('rotate'),
    `rotate is the option that makes this pause worth raising: ${settled.pause.options.join(', ')}`,
  )
  assert.equal(relay.operator, 'agent', 'the premise: an agent is driving, and is asked anyway')
  // Untouched while the decision is outstanding, which is what "candidate, not verdict" means.
  assert.equal(impl.state, 'running')
  assert.equal(fresh.state, 'running')

  await run.abort()
})

/**
 * The same pause, asked again and again, of a human who already answered it (#118).
 *
 * #107 took the repeating pause away from an AGENT operator on the grounds that it had no
 * answer it could give. A human at an ARMED `candidate` run does have one — `rotate` is on the
 * menu — so the pause was kept, and kept unconditionally. That is the gap this test is about.
 *
 * The falsifier for "this is just replayed evidence" is closed. `#considerRotation` reads
 * `impl.baselineGeneration` against the live snapshot, and `#acknowledge` moves that baseline
 * every time the site is reached — so each pause below carries a DIFFERENT generation pair and
 * is therefore a genuinely new compaction, not one finding re-read. The generation pairs are
 * asserted for exactly that reason: if the baseline ever stopped moving, this test would be
 * describing a replay defect and would say so by collapsing the set.
 *
 * So the defect is rate and class, not detection. A long implementer compacts by design; every
 * compaction is real, and every one of them re-puts a question the operator answered `continue`
 * to the first time, in the same terms, on the same evidence class. An operator asked the same
 * question five times stops reading pauses, and the fifth one is the one that mattered.
 *
 * What must survive the fix is the part that makes "asked once" honest:
 *
 *   - every candidate is still counted and still written to the routing log, with its own
 *     generation pair, so "not asked" never quietly becomes "not watched";
 *   - a candidate whose evidence class CHANGES is a new question and is put again. Here that is
 *     `corroborated`: the seat compacted AND said so, which is strictly more than the
 *     `degraded`-only evidence the operator declined on, and the operator never answered it.
 *
 * Without the second half the obvious fix — "raise a rotation candidate at most once per run" —
 * would pass every other assertion here.
 */
test('a declined candidate is not re-put on the same evidence class, but a corroborated one is (#118)', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'Do the first thing.',
    'Do the second thing.',
    'Do the third thing.',
    'Do the fourth thing.',
    'DONE',
  ])
  const impl = new FakeRotationSession('impl', 'claude', [
    'ack',
    'Did the first thing.',
    'Did the second thing.',
    'Did the third thing.',
    // The fourth turn adds the complaint. First person and past participle, which is what
    // `detectComplaint` discriminates on -- prose ABOUT compaction is not a report of one.
    'Did the fourth thing. I have been compacted and I am losing track of what I was doing; ' +
      'I need a fresh session before I can carry on.',
  ])
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED])
  // Compacts at the start of every turn that does work, and not on the briefing turn.
  // `compactOnTurn` can only express one; four distinct compactions is the point.
  let sends = 0
  impl.onSend = () => {
    if (sends++ > 0) impl.compact()
  }

  // Armed, `candidate`, and attended by a human: the one configuration where the pause has a
  // real answer and is therefore still put. `operator` is left at its default.
  const relay = await relayOf(dir, advisor, [impl, fresh], {
    rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000, onDegradation: 'candidate' },
    maxAdvisorTurns: 5,
  })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')

  // Decline every pause with `continue`, and record what was asked. Capped rather than
  // unbounded: the defect this test describes is "asked too often", so a loop that answered
  // forever would hang on the very failure it is meant to report.
  const asked: { detail: string; evidence: string[]; options: readonly string[] }[] = []
  for (;;) {
    const s = await run.settled()
    if (s.kind === 'ended') break
    asked.push({ detail: s.pause.detail, evidence: [...s.pause.evidence], options: [...s.pause.options] })
    if (asked.length > 6) {
      await run.abort()
      break
    }
    await run.continue()
  }

  /** The generation pair a candidate rests on: `0 → 1`, and so on. */
  const genOf = (lines: string[]): string | undefined =>
    lines.map((l) => /rose (\d+ → \d+)/.exec(l)?.[1]).find((g) => g !== undefined)

  // THE SEQUENCE. Two questions, not four: the first compaction, and the one whose evidence
  // class the operator has not yet ruled on.
  assert.deepEqual(
    asked.map((p) => genOf(p.evidence)),
    ['0 → 1', '3 → 4'],
    `the operator is asked once per evidence class, not once per compaction; asked:\n${asked
      .map((p) => `${genOf(p.evidence)}: ${p.detail}`)
      .join('\n---\n')}`,
  )
  // The first is the ordinary armed candidate, with rotation actually on the menu -- which is
  // what makes it worth asking at all.
  assert.match(asked[0]!.detail, /Recorded as a rotation candidate, not acted on/)
  assert.match(asked[0]!.detail, /did not say so/, 'the first is compaction alone: the `degraded` class')
  assert.ok(asked[0]!.options.includes('rotate'), `rotate must be offered: ${asked[0]!.options.join(', ')}`)
  // The second is a different question. The seat now SAYS it is spent, which is evidence the
  // operator has not seen and did not decline.
  assert.match(asked[1]!.detail, /and said so/, 'the second is the `corroborated` class, and is put again')
  assert.ok(asked[1]!.options.includes('rotate'))

  // AND EVERY CANDIDATE IS STILL ON THE RECORD. This is the half that keeps "asked once" from
  // meaning "stopped watching" -- four compactions happened and four were seen, whatever was
  // done about them.
  assert.equal(relay.rotationWatch.candidates, 4, 'every compaction is still a counted candidate')
  assert.equal(relay.rotationWatch.degradationsSeen, 4)
  assert.equal(relay.rotationWatch.complaintsSeen, 1, 'exactly one turn complained')

  // The two that were NOT put are written to the routing log instead, each carrying its own
  // generation pair -- so a retrospective reader can see the compactions the operator was
  // spared, and can tell them apart.
  const notes = relay.log.filter(
    (m) => m.kind === 'note' && /rotation candidate recorded, run continues/.test(m.text),
  )
  assert.deepEqual(
    notes.map((m) => genOf([m.text])),
    ['1 → 2', '2 → 3'],
    `the unasked candidates must be logged, distinctly:\n${relay.log.map((m) => m.text).join('\n---\n')}`,
  )
  // The pauses that WERE raised, read from the log rather than the handle, because this is the
  // record an operator or a status reader gets after the fact.
  assert.equal(
    relay.log.filter((m) => /^paused \(rotation_candidate\)/.test(m.text)).length,
    2,
    'the log agrees with the handle about how many times the run stopped',
  )

  assert.equal(run.outcome!.reason, 'done', 'and the run still finishes')
})

test('rotating AT the pause is not a decline, so the replacement is still asked (#118)', async (t) => {
  // The narrower of the two ways a decline is scoped to its session, and the one the test below
  // cannot reach. `rotate` is an option ON a pause and does not resolve it, so the operator
  // rotates and then still has to say what the run should do. That resume looks exactly like a
  // decline from inside `#considerRotation` -- `#halt` returned without ending the run -- and it
  // is not one: the session the question was about has already left the seat, and the answer was
  // to replace it rather than to live with it.
  //
  // Latching there would hand the replacement a decline nobody made about it, and the first
  // compaction of a brand new session would go unremarked. Isolated here because the sibling
  // test rotates at a DIFFERENT class than the one it later checks, so a wrongly latched class
  // slips past it.
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'Do the first thing.',
    HANDOFF,
    'Do the second thing.',
    'Do the third thing.',
    'DONE',
  ])
  const old = new FakeRotationSession('old', 'claude', ['ack', 'Did the first thing.'])
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED, 'Second.', 'Third.'])
  old.compactOnTurn = 1
  let worked = 0
  fresh.onSend = () => {
    if (worked++ > 0) fresh.compact()
  }

  const relay = await relayOf(dir, advisor, [old, fresh], {
    rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000, onDegradation: 'candidate' },
    maxAdvisorTurns: 5,
  })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const asked: string[] = []
  let rotated = false
  for (;;) {
    const s = await run.settled()
    if (s.kind === 'ended') break
    asked.push(s.pause.detail)
    if (!rotated) {
      assert.equal((await run.rotateImplementer('the operator chose to rotate')).status, 'rotated')
      rotated = true
    }
    if (asked.length > 4) {
      await run.abort()
      break
    }
    await run.continue()
  }

  assert.equal(relay.rotationWatch.rotations, 1)
  assert.equal(relay.participants.find((p) => p.rank === 'implementer')!.session, fresh)
  // Two: the compaction that prompted the rotation, and the replacement's own first one, which
  // is the same evidence class and a question about a different session.
  assert.equal(
    asked.length,
    2,
    `rotating at a pause answers it about the retired session only:\n${asked.join('\n---\n')}`,
  )
  assert.match(asked[0]!, /compaction generation rose 0 → 1/)
  assert.match(asked[1]!, /transcript declares a compaction/)
  // And counted from the REPLACEMENT's own zero (#128, #129). This line was the one the old
  // baseline defect removed: the seat carried the retired session's generation, so the snapshot
  // channel had nothing to say about a new session at generation 1 and only the revision channel
  // spoke here. Asserted now because it is the difference between two channels agreeing and one
  // of them silently sitting out.
  assert.match(asked[1]!, /compaction generation rose 0 → 1/)
  assert.equal(run.outcome!.reason, 'done')
})

test('the decline does not survive the session it was about (#118)', async (t) => {
  // The scope that makes the latch safe. A decline says "not this session, not on this
  // evidence"; a replacement is a different session, and its first compaction is a question
  // nobody has been asked. Carrying the answer across the swap would suppress the very first
  // candidate raised against a brand new implementer -- which is the failure a "raise it at most
  // once per run" fix would have, one seat further along.
  //
  // Built to separate the two places the clearing happens, because they overlap and a test that
  // only reached the overlap would leave one of them unexercised. Written after a mutation
  // showed exactly that: deleting the latch at the rotation site changed nothing, because the
  // simpler scenario was already covered by the resume-side guard.
  //
  //   1. the seat compacts             -> declined, `degraded` latched
  //   2. it compacts AND complains     -> `corroborated`: a class nobody has ruled on, so it is
  //                                       still put, and the operator ROTATES at it
  //   3. the replacement compacts      -> `degraded` again, and it must be PUT
  //
  // Step 3 is the isolating one. The resume in step 2 declines to latch `corroborated` because
  // the session changed under it -- but the `degraded` latched in step 1 is still there, and
  // only `rotateSeat` dropping it lets step 3 reach the operator.
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'Do the first thing.',
    'Do the second thing.',
    HANDOFF,
    'Do the third thing.',
    'Do the fourth thing.',
    'Do the fifth thing.',
    'DONE',
  ])
  const old = new FakeRotationSession('old', 'claude', [
    'ack',
    'Did the first thing.',
    'Did the second thing. I have been compacted and I need a fresh session.',
  ])
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED, 'Third.', 'Fourth.', 'Fifth.'])
  // Both sessions compact on every turn that does work, and not on their briefing or acceptance
  // turn. An ordinary long session on either side of the swap.
  let retiring = 0
  old.onSend = () => {
    if (retiring++ > 0) old.compact()
  }
  let replacing = 0
  fresh.onSend = () => {
    if (replacing++ > 0) fresh.compact()
  }

  const relay = await relayOf(dir, advisor, [old, fresh], {
    rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000, onDegradation: 'candidate' },
    maxAdvisorTurns: 7,
  })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const asked: string[] = []
  let rotated = false
  for (;;) {
    const s = await run.settled()
    if (s.kind === 'ended') break
    asked.push(s.pause.detail)
    if (asked.length === 2 && !rotated) {
      // The option this pause offers, taken. `rotate` does not resolve the pause, so continuing
      // is still a separate decision -- and it is the resume that would latch, if the session
      // under it had not just been replaced.
      assert.equal((await run.rotateImplementer('the operator chose to rotate')).status, 'rotated')
      rotated = true
    }
    if (asked.length > 5) {
      await run.abort()
      break
    }
    await run.continue()
  }

  assert.equal(relay.rotationWatch.rotations, 1)
  assert.equal(relay.participants.find((p) => p.rank === 'implementer')!.session, fresh)

  assert.equal(asked.length, 3, `three questions, one per class per session:\n${asked.join('\n---\n')}`)
  assert.match(asked[0]!, /compacted and did not say so: compaction generation rose 0 → 1/)
  assert.match(asked[1]!, /compacted and said so: compaction generation rose 1 → 2/)
  // The replacement's own first compaction, on the class the RETIRED session's operator already
  // declined. Asked anyway, because that decline went with the session it was about.
  assert.match(asked[2]!, /compacted and did not say so/)
  assert.match(asked[2]!, /transcript declares a compaction/)
  // Counted from the replacement's OWN zero (#128). Before that fix this line was absent and
  // only the revision channel spoke here, because the seat had been handed the retired session's
  // baseline and the snapshot channel had nothing it could say about a session at generation 1.
  assert.match(asked[2]!, /compaction generation rose 0 → 1/)

  // And the latch re-arms per session: once the replacement's class has been declined too, its
  // later compactions are recorded rather than put, exactly as the first session's were.
  assert.equal(relay.rotationWatch.candidates, 5, 'five compactions, all counted')
  assert.equal(
    relay.log.filter((m) => /rotation candidate recorded, run continues \(the operator already declined/.test(m.text))
      .length,
    2,
    `the replacement's later compactions are suppressed and logged:\n${relay.log.map((m) => m.text).join('\n---\n')}`,
  )
  assert.equal(run.outcome!.reason, 'done')
})

test('a rotation at a pause leaves the replacement its OWN baseline (#128)', async (t) => {
  // `#considerRotation` snapshots once, at the top, and that snapshot belongs to the session
  // that is in the seat when the assessment begins. If the operator takes the `rotate` option
  // during the halt, the session under it changes -- `rotateSeat` promotes the replacement and
  // correctly sets `baselineGeneration = 0` -- and the `#acknowledge` after the halt then
  // overwrote that with a generation belonging to a session that had already been retired.
  //
  // The consequence is quiet, which is why it survived: `detectDegradation` reads two channels,
  // so the replacement's first compaction still raised a candidate off its `revision` event.
  // What went missing was the snapshot half of the evidence -- the `rose N → M` line an operator
  // reads to see how far the seat has gone -- and the baseline stayed one generation ahead of
  // the session for the rest of the run.
  //
  // Asserted on `baselineGeneration` directly rather than inferred from the evidence prose. The
  // prose is the symptom; the field is the defect, and a fix that repaired the sentence while
  // leaving the number wrong would pass a test written the other way round.
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'Do the first thing.',
    HANDOFF,
    'Do the second thing.',
    'DONE',
  ])
  const old = new FakeRotationSession('old', 'claude', ['ack', 'Did the first thing.'])
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED, 'Second.'])
  old.compactOnTurn = 1

  const relay = await relayOf(dir, advisor, [old, fresh], {
    rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000, onDegradation: 'candidate' },
    maxAdvisorTurns: 4,
  })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const first = await run.untilPause()
  assert.equal(first!.reason, 'rotation_candidate')
  assert.ok(first!.evidence.some((e) => e.includes('rose 0 → 1')), 'the retired session had compacted once')

  // The option the pause offers, taken -- and `rotate` does not resolve the pause, so the seat
  // is measured here, between the replacement landing and the run being told to carry on.
  assert.equal((await relay.rotateImplementer('the operator chose to rotate')).status, 'rotated')
  const impl = relay.participants.find((p) => p.rank === 'implementer')!
  assert.equal(impl.session, fresh, 'the replacement is in the seat')
  assert.equal(impl.baselineGeneration, 0, 'and rotateSeat gave it a baseline of its own')

  await run.continue()
  await run.result()

  // The claim, and the whole of #128: resuming must not hand the new session the retired one's
  // generation. `fresh` never compacted, so anything above 0 here is the old session's number
  // wearing the replacement's name -- and it would take TWO compactions before the snapshot
  // channel could speak again.
  assert.equal(
    impl.baselineGeneration,
    0,
    'the replacement kept its own baseline across the resume; it did not inherit generation 1',
  )
})

test('a seat DISARMED by its own policy is unarmed for this purpose too, agent-operated', async (t) => {
  // The third state, and the one a run-level flag cannot express (#103, D7): the run is armed
  // and THIS SEAT is not, because its own policy entry sets no checks. `#considerRotation`
  // decides armed-or-not with `!cfg || cfg.checks.length === 0`, and only the second half of
  // that test sees this case — a run configured no rotation at all leaves `cfg` undefined and
  // takes the first half.
  //
  // Written because a mutation exposed the hole rather than because a defect did. Narrowing the
  // discriminator to `!cfg` survived the entire suite: nothing anywhere distinguished "the run
  // configured none" from "this seat's policy sets none" at this branch. It matters more since
  // #107 than it did before, because the two halves now lead somewhere different for an agent
  // operator — one continues and, under that mutation, the other pauses.
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'Do the first thing.',
    'Do the second thing.',
    'DONE',
  ])
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did the first thing.', 'And the second.'])
  impl.compactOnTurn = 1

  const relay = await relayOf(dir, advisor, [impl], {
    // Armed at the RUN level, disarmed on the one seat that has work to do.
    rotation: {
      checks: ['exit 0'],
      checkTimeoutMs: 30_000,
      onDegradation: 'candidate',
      seats: { implementer: { checks: [] } },
    },
    maxAdvisorTurns: 3,
    operator: 'agent',
  })
  t.after(() => relay.stop())

  const recording = recordSession(relay, {
    repoRoot: dir,
    id: newSessionId(Date.now(), process.pid),
    goal: 'Keep the work moving.',
    front: 'session',
    startedAt: Date.now(),
    build: 'test-build',
  })
  t.after(() => recording.close())

  const run = relay.start('Keep the work moving.')
  const settled = await run.settled()

  assert.ok(
    settled.kind === 'ended',
    settled.kind === 'paused'
      ? `a seat with nothing to verify against is unarmed however the run is configured, and it ` +
        `stopped on ${settled.pause.reason}: ${settled.pause.detail}`
      : '',
  )
  // The note names the SEAT's policy rather than the run's, which is the half of the sentence
  // that says which of the two states this was.
  assert.ok(
    relay.log.some(
      (m) => m.kind === 'note' && /run continues \(agent-operated, seat has no checks/.test(m.text),
    ),
    `the record must say the SEAT is the one with no checks:\n${relay.log.map((m) => m.text).join('\n---\n')}`,
  )
  assert.equal(relay.rotationWatch.candidates, 1)

  // And `status.json` reports the state a run-wide answer gets wrong: configured, not armed.
  await recording.refresh()
  const status = readSession(dir, recording.id)
  assert.ok(status)
  const seat = status.status.participants.find((p) => p.id === 'implementer')
  assert.deepEqual(seat?.rotation, {
    configured: true,
    armed: false,
    checks: [],
    onDegradation: 'candidate',
  })
})

test('the replacement is not judged degraded by the retired session’s compaction', async (t) => {
  // The event list survives rotation, so without a cursor the replacement inherits the
  // evidence that retired its predecessor and rotates again immediately.
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', HANDOFF, 'Keep going.', 'DONE'])
  const old = new FakeRotationSession('old', 'claude', ['ack', 'Did it.'])
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED, 'Still going.'])

  const relay = await relayOf(dir, advisor, [old, fresh], { maxAdvisorTurns: 4 })
  t.after(() => relay.stop())

  old.compact()
  const outcome = await relay.run('Keep the work moving.')

  assert.equal(outcome.reason, 'done')
  assert.equal(
    relay.log.filter((m) => m.text.startsWith('rotating implementer')).length,
    1,
    'exactly one rotation: the replacement must not inherit its predecessor’s degradation',
  )
})

test('arming reflects configuration, not how far the run got (#31)', async (t) => {
  // A single live invocation asserted BOTH `rotation armed — ... verified by:
  // make check-doc-numbers` on its first line and `rotation: NOT ARMED (no checks
  // configured)` in its summary. `--checks` had been supplied and echoed back correctly at
  // startup.
  //
  // The cause: `armed` was assigned inside #considerRotation, so it only became true once an
  // assessment had been made. That run escalated on an empty report before its first
  // assessment, so the flag kept its initial `false` and the summary claimed the checks were
  // never configured.
  //
  // This is worse than the ambiguity rotationWatch exists to remove. Previously the arming
  // state was unknown; contradictory is worse, because a reader who sees one line believes
  // the wrong thing confidently -- and every negative result these counters support becomes
  // unciteable.
  const dir = repo()
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex'), [
    new FakeRotationSession('impl', 'claude'),
  ])
  t.after(() => relay.stop())

  // Before any turn has been taken, and therefore before any assessment.
  assert.equal(relay.rotationWatch.armed, true, 'configured is configured, from the start')
  assert.equal(relay.rotationWatch.assessments, 0)

  const summary = relay.rotationSummary()
  assert.doesNotMatch(
    summary,
    /no checks configured/,
    'checks WERE configured; saying otherwise is a false claim, not merely a vague one',
  )
  // A third state, distinct from both "armed and saw nothing" and "never configured": the
  // instrument was live but never used, so the run is uninformative rather than negative.
  assert.match(summary, /armed/)
  assert.match(summary, /this is not a negative result/)
})

test('an unconfigured run still says so plainly', async (t) => {
  const dir = repo()
  const relay = await relayOf(
    dir,
    new FakeRotationSession('advisor', 'codex'),
    [new FakeRotationSession('impl', 'claude')],
    { rotation: undefined },
  )
  t.after(() => relay.stop())

  assert.equal(relay.rotationWatch.armed, false)
  assert.match(relay.rotationSummary(), /NOT ARMED \(no checks configured\)/)
})

test('a transport failure ends the run with a verdict, it does not escape it (#32)', async (t) => {
  // A 12-turn run died on `no UserPromptSubmit hook after send`. The process exited with no
  // `=== relay ended:` line, no message count and no rotation summary, because all three sit
  // after `relay.run(goal)` returns. The runs most worth diagnosing reported the least.
  //
  // `start()` already caught throws and settled the handle; `run()` -- the unattended form
  // the CLI uses -- did not. Fixed where both share a path.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude')
  impl.failSendOnTurn = 1 // succeed once, then lose the transport mid-run
  // The advisor is given instructions to issue. Without them it produces an empty turn, and
  // since #35 an advisor that produces no instruction halts the run on its own -- which would
  // end this test before the transport failure it is actually about.
  const relay = await relayOf(
    dir,
    new FakeRotationSession('advisor', 'codex', ['do the first thing', 'do the second thing']),
    [impl],
  )
  t.after(() => relay.stop())

  const outcome = await relay.run('do the thing')

  // Its own reason. `escalated` would mean the agents wanted a human; this means Conclave
  // lost the ability to observe a turn, and hiding a defect inside a normal outcome is how
  // it goes unnoticed.
  assert.equal(outcome.reason, 'transport_failed')
  assert.match(outcome.detail ?? '', /UserPromptSubmit/)

  // The operator's record must survive the abnormal path -- that is the whole fix.
  assert.ok(relay.log.length > 0, 'the routing log is intact')
  assert.match(relay.rotationSummary(), /armed/, 'the rotation summary is still reachable')
})

test('a flagged caveat is carried into the summary of an otherwise DONE run (#30)', async (t) => {
  // A run ended `done` while the implementer had explicitly flagged that a conformance
  // script remained unrun, and that its belief about it was inherited from a comment rather
  // than confirmed. The caveat survived only in the middle of a 350-line routing log, and
  // the last three lines -- which is what a DONE invites you to read -- showed unqualified
  // success.
  //
  // The verdict was not wrong. The defect was that a terminal verdict could carry nothing
  // but its own binary value.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', [
    'Rewrote the normaliser and the goldens pass.\n' +
      'FLAG: oathrs/conformance.sh remains unrun; inherited reasoning, not confirmed.',
  ])
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', [ACCEPTED]), [impl])
  t.after(() => relay.stop())

  await relay.run('rewrite the normaliser')

  assert.equal(relay.flags.length, 1)
  assert.equal(relay.flags[0]!.participant, 'implementer')
  assert.match(relay.flags[0]!.text, /conformance\.sh remains unrun/)

  const summary = relay.flagSummary()
  assert.match(summary[0]!, /1 flagged item carried:/)
  assert.match(summary[1]!, /implementer .*conformance\.sh/)
})

test('a run with nothing outstanding says nothing', () => {
  // The line must not appear on a clean run, or it becomes noise that trains the reader to
  // skip the exact place a real flag would show up.
  assert.deepEqual(extractFlags('All done. Everything passes.'), [])
  // Prose ABOUT flagging is not a flag: the marker is line-initial.
  assert.deepEqual(extractFlags('I could FLAG: something here mid-sentence'), [])
  assert.deepEqual(extractFlags('done\nFLAG: one thing\nFLAG: another'), ['one thing', 'another'])
})

// ---------------------------------------------------------------------------------------
// #75: what each rotation was FOR.
//
// Rotation was built as recovery and is being used as an instrument. Replacing a seat so a
// fresh reader applies a just-committed criterion is a good reason to rotate and is
// methodologically unrelated to degradation -- and it arrives WITH a compaction generation
// attached, because compaction happens anyway. So it reads as "the proxy fired and the
// operator agreed", which is precisely the correlation #10 exists to measure.
//
// These prove the two populations end up on separate sides of one field, through the real
// transaction, in the run report and in the status file an agent operator polls.
// ---------------------------------------------------------------------------------------

test('a rotation the operator initiated is recorded as theirs, in their own words (#75)', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', [HANDOFF])
  const old = new FakeRotationSession('old', 'claude')
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED])

  const relay = await relayOf(dir, advisor, [old, fresh])
  t.after(() => relay.stop())

  // No run and therefore no pause: the plainest operator-initiated rotation there is, and the
  // one an embedder makes. The reason is the methodological one #75 was reported from.
  const r = await relay.rotateImplementer('a fresh reader applying the just-committed criterion is a stronger test')
  assert.equal(r.status, 'rotated')

  assert.equal(relay.rotationWatch.rotations, 1)
  const records = relay.rotationRecords()
  assert.equal(records.length, 1, 'the count and the records are written together and cannot disagree')
  assert.equal(records[0]!.seat, 'implementer')
  assert.equal(records[0]!.intent, 'operator_requested')
  assert.match(records[0]!.reason, /fresh reader applying the just-committed criterion/)
  assert.equal(records[0]!.replacement, fresh.sessionId)
  // Copied on the way out. A caller that kept this and watched it grow would be reading a list
  // the relay still owns.
  assert.notEqual(relay.rotationRecords(), records)
})

test('accepting a rotation candidate at the pause is recorded as the proxy having fired (#75)', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'Do the first thing.',
    HANDOFF,
    'Do the second thing.',
    'DONE',
  ])
  const old = new FakeRotationSession('old', 'claude', ['ack', 'Did the first thing.'])
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED, 'Second.', 'NONE'])
  old.compactOnTurn = 1

  const relay = await relayOf(dir, advisor, [old, fresh], {
    rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000, onDegradation: 'candidate' },
    maxAdvisorTurns: 5,
  })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const settled = await run.settled()
  assert.ok(settled.kind === 'paused')
  assert.equal(settled.pause.reason, 'rotation_candidate')

  // No reason typed, and none is asked for: at THIS pause the proxy is what spoke, so the
  // pause's own detail is the honest record and the handle carries it.
  assert.equal(run.rotationNeedsReason(), false)
  assert.equal((await run.rotateImplementer()).status, 'rotated')

  const records = relay.rotationRecords()
  assert.equal(records.length, 1)
  assert.equal(records[0]!.intent, 'candidate_accepted')
  // The proxy's own words, which is what makes this population identifiable without reading them.
  assert.match(records[0]!.reason, /compaction generation rose 0 → 1/)

  await run.abort()
})

test('a reason typed at a candidate does not become the record, through the real transaction (#75)', async (t) => {
  // The same acceptance as above, with the operator typing something as they take it -- which
  // is a natural thing to do and used to decide the record. `candidate_accepted` beside the
  // operator's sentence is a record whose two fields describe different events: the intent says
  // the proxy raised this seat, the reason says a human had their own cause. An analysis reading
  // either field alone would then get a different answer about the same rotation.
  //
  // Through the whole transaction rather than at the handle, because that is where the string
  // becomes a `RotationRecord` an analysis actually reads.
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'Do the first thing.',
    HANDOFF,
    'Do the second thing.',
    'DONE',
  ])
  const old = new FakeRotationSession('old', 'claude', ['ack', 'Did the first thing.'])
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED, 'Second.', 'NONE'])
  old.compactOnTurn = 1

  const relay = await relayOf(dir, advisor, [old, fresh], {
    rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000, onDegradation: 'candidate' },
    maxAdvisorTurns: 5,
  })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const settled = await run.settled()
  assert.ok(settled.kind === 'paused')
  assert.equal(settled.pause.reason, 'rotation_candidate')

  assert.equal((await run.rotateImplementer('the session is wedged')).status, 'rotated')

  const records = relay.rotationRecords()
  assert.equal(records.length, 1)
  assert.equal(records[0]!.intent, 'candidate_accepted')
  assert.match(records[0]!.reason, /compaction generation rose 0 → 1/, 'the proxy is what spoke')
  assert.doesNotMatch(records[0]!.reason, /wedged/, 'and the operator’s gloss is not what the record says')
  // The line a human reads at the end of the run says the same thing, so the two cannot drift.
  assert.match(relay.rotationSummary(), /implementer \(candidate_accepted\) — .*compaction generation rose 0 → 1/)

  await run.abort()
})

test('the detector rotating on its own is neither of the operator populations (#75)', async (t) => {
  // `onDegradation: 'automatic'` asks nobody, so there is no pause to classify from -- and the
  // default reading would call it operator-initiated, filing the ONE unambiguously proxy-driven
  // rotation in the run into the population an analysis exists to exclude. The detector says
  // what it is at the call site, because it is the only thing that knows.
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do the first thing.', HANDOFF, 'Do the second thing.', 'DONE'])
  const old = new FakeRotationSession('old', 'claude', ['ack', 'Did the first thing.'])
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED, 'Second.', 'NONE'])
  old.compactOnTurn = 1

  const relay = await relayOf(dir, advisor, [old, fresh], { maxAdvisorTurns: 5 })
  t.after(() => relay.stop())

  assert.equal((await relay.run('Keep the work moving.')).reason, 'done')

  const records = relay.rotationRecords()
  assert.equal(records.length, 1, 'the compaction rotated the seat without asking anybody')
  assert.equal(records[0]!.intent, 'degradation_automatic')
  assert.equal(records[0]!.seat, 'implementer')
})

test('a rolled-back rotation leaves no record, so records.length still means rotations (#75)', async (t) => {
  const dir = repo()
  // No headings, so the handoff is unusable and the transaction rolls back.
  const advisor = new FakeRotationSession('advisor', 'codex', ['no headings here'])
  const old = new FakeRotationSession('old', 'claude')
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED])

  const relay = await relayOf(dir, advisor, [old, fresh])
  t.after(() => relay.stop())

  assert.equal((await relay.rotateImplementer('trying it')).status, 'rolled_back')
  assert.equal(relay.rotationWatch.rotations, 0)
  assert.deepEqual(relay.rotationRecords(), [], 'nothing was replaced, so nothing is recorded as having been')
})

test('the terminal summary names the intent and the reason, not just a count (#75)', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', [HANDOFF])
  const old = new FakeRotationSession('old', 'claude')
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED])

  const relay = await relayOf(dir, advisor, [old, fresh])
  t.after(() => relay.stop())

  // Nothing rotated yet: a breakdown of zero is noise, and the line the run report already
  // prints must not gain a row on every run of a feature most runs never reach.
  assert.equal(relay.rotationIntentSummary(), '')

  assert.equal((await relay.rotateImplementer('wanted a blind reader on the criterion')).status, 'rotated')

  const summary = relay.rotationSummary()
  assert.match(summary, /1 rotations/, 'the count an operator already reads is unchanged')
  assert.match(summary, /rotation intent: 1 operator_requested/)
  // The reason, because the terminal report is what a human actually reads at the end of a run
  // and `1 rotations` beside a compaction generation reads as the proxy having fired.
  assert.match(summary, /implementer \(operator_requested\) — wanted a blind reader on the criterion/)
})

test('status --json carries every rotation and why, while the run is still live (#75)', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', [HANDOFF])
  const old = new FakeRotationSession('old', 'claude')
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED])

  const relay = await relayOf(dir, advisor, [old, fresh])
  t.after(() => relay.stop())

  // The real recorder on the real relay, as above: `status.json` is the whole of an agent
  // operator's interface, so the claim has to be made through the call the console makes.
  const recording = recordSession(relay, {
    repoRoot: dir,
    id: newSessionId(Date.now(), process.pid),
    goal: 'Keep the work moving.',
    front: 'session',
    startedAt: Date.now(),
    build: 'test-build',
  })
  t.after(() => recording.close())

  // PRESENT AND EMPTY before anything rotates, which is the whole of #103's lesson one field
  // over: a probe reading a key that does not exist gets a falsy value it cannot tell from a
  // build that does not report the field at all.
  await recording.refresh()
  assert.deepEqual(readSession(dir, recording.id)!.status.rotations, [])

  assert.equal((await relay.rotateImplementer('a blind reader is a stronger test')).status, 'rotated')

  await recording.refresh()
  const rotations = readSession(dir, recording.id)!.status.rotations
  assert.equal(rotations?.length, 1, 'the rotation reaches the file a poller reads, while the run is still live')
  assert.equal(rotations![0]!.seat, 'implementer')
  assert.equal(rotations![0]!.intent, 'operator_requested')
  assert.match(rotations![0]!.reason, /blind reader/)
})

test('the operator populations reach the printed status surfaces distinguishably (#75)', async (t) => {
  // The test above proves one record reaches the FILE. This is the other half of the same
  // claim, and the half an agent operator actually consumes: `conclave status --json` prints
  // `formatSessionJson`, and a human reads `formatSession`. A record that reached the file but
  // arrived on those surfaces without its intent would be a dataset nobody can filter.
  //
  // Two rotations rather than one, because "distinguishable" is not a property of a row -- it
  // is a property of rows side by side. These are the two an OPERATOR can be responsible for,
  // which is where the confusion #75 is about actually lives; the detector's own population
  // needs a different run policy and is asserted in the test after this one.
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'Do the first thing.',
    // One per rotation: `rotate()` spends an advisor turn asking for the handoff.
    HANDOFF,
    HANDOFF,
  ])
  const old = new FakeRotationSession('old', 'claude', ['ack', 'Did the first thing.'])
  old.compactOnTurn = 1
  const replacements = [
    new FakeRotationSession('fresh-1', 'claude', [ACCEPTED]),
    new FakeRotationSession('fresh-2', 'claude', [ACCEPTED]),
  ]

  const relay = await relayOf(dir, advisor, [old, ...replacements], {
    rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000, onDegradation: 'candidate' },
    maxAdvisorTurns: 5,
  })
  t.after(() => relay.stop())

  const recording = recordSession(relay, {
    repoRoot: dir,
    id: newSessionId(Date.now(), process.pid),
    goal: 'Keep the work moving.',
    front: 'session',
    startedAt: Date.now(),
    build: 'test-build',
  })
  t.after(() => recording.close())

  // ONE: the proxy asked, at the pause, and the operator agreed.
  const run = relay.start('Keep the work moving.')
  const settled = await run.settled()
  assert.ok(settled.kind === 'paused')
  assert.equal(settled.pause.reason, 'rotation_candidate')
  assert.equal((await run.rotateImplementer()).status, 'rotated')
  await run.abort()

  // TWO: the operator, with their own reason and no pause in front of them.
  assert.equal(
    (await relay.rotateImplementer('a fresh reader applying the just-committed criterion is a stronger test')).status,
    'rotated',
  )

  await recording.refresh()
  const read = readSession(dir, recording.id)!

  // THE JSON SURFACE. Parsed from the string the console prints, not read off the record: a
  // consumer sees the string, and a field lost in the serialisation is lost to them whatever
  // the object behind it held.
  const doc = JSON.parse(formatSessionJson(read, Date.now())) as {
    rotations: { seat: string; intent: string; reason: string; replacement: string; at: number }[]
  }
  assert.equal(doc.rotations.length, 2)
  assert.deepEqual(
    doc.rotations.map((r) => r.intent),
    ['candidate_accepted', 'operator_requested'],
  )
  assert.match(doc.rotations[0]!.reason, /compaction generation rose 0 \u2192 1/, 'the proxy is what spoke')
  assert.match(doc.rotations[1]!.reason, /fresh reader applying the just-committed criterion/)
  assert.doesNotMatch(doc.rotations[1]!.reason, /compaction generation/, 'and the operator\u2019s is not the proxy\u2019s')
  assert.deepEqual(
    doc.rotations.map((r) => r.replacement),
    replacements.map((s) => s.sessionId),
    'each row names the session that took the seat, so this joins to the events without prose',
  )

  // THE PROSE SURFACE, which is what a human reads and where the misreading #75 is about
  // happens: `implementer replaced` beside a compaction generation reads as the proxy having
  // fired whether or not it did, so the intent is on the line itself.
  const prose = formatSession(read, Date.now())
  assert.match(prose, /rotated:\s+implementer \(candidate_accepted\) \u2014 .*compaction generation rose 0 \u2192 1/)
  assert.match(prose, /rotated:\s+implementer \(operator_requested\) \u2014 a fresh reader applying/)
})

test('an unattended rotation reaches those same surfaces as the detector\u2019s, not the operator\u2019s (#75)', async (t) => {
  // The third population, produced the only way it can be: by a run whose policy is to rotate
  // without asking. `rotateSeat` takes no intent argument, so this value cannot be written by a
  // caller at all -- which is the point of it, since a forged `degradation_automatic` row is
  // indistinguishable from the evidence #10 is trying to weigh.
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'Do the first thing.',
    HANDOFF,
    'Do the second thing.',
    'DONE',
  ])
  const old = new FakeRotationSession('old', 'claude', ['ack', 'Did the first thing.'])
  old.compactOnTurn = 1
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED, 'Second.', 'NONE'])

  // `relayOf` defaults to `onDegradation: 'automatic'`, which is the policy under test.
  const relay = await relayOf(dir, advisor, [old, fresh], { maxAdvisorTurns: 5 })
  t.after(() => relay.stop())

  const recording = recordSession(relay, {
    repoRoot: dir,
    id: newSessionId(Date.now(), process.pid),
    goal: 'Keep the work moving.',
    front: 'session',
    startedAt: Date.now(),
    build: 'test-build',
  })
  t.after(() => recording.close())

  assert.equal((await relay.run('Keep the work moving.')).reason, 'done')

  await recording.refresh()
  const read = readSession(dir, recording.id)!

  const doc = JSON.parse(formatSessionJson(read, Date.now())) as {
    rotations: { seat: string; intent: string; reason: string; replacement: string }[]
  }
  assert.deepEqual(
    doc.rotations.map((r) => r.intent),
    ['degradation_automatic'],
    'a poller must be able to exclude the rotations nobody chose, and to keep the ones nobody chose',
  )
  assert.equal(doc.rotations[0]!.seat, 'implementer')
  assert.equal(doc.rotations[0]!.replacement, fresh.sessionId)
  assert.match(doc.rotations[0]!.reason, /compaction generation/)

  const prose = formatSession(read, Date.now())
  assert.match(prose, /rotated:\s+implementer \(degradation_automatic\) \u2014 .*compaction generation/)
})

test('an embedder cannot label its own rotation as the detector’s (#75)', async (t) => {
  // The claim the private helper exists to make, asserted at RUNTIME rather than left to the
  // type checker. `rotateSeat` used to take an optional intent, and an optional argument is
  // available to everybody: an embedder could write rows into `degradation_automatic`, which is
  // the population #10 reads as the proxy predicting degradation. A forged row there is not a
  // mislabelled entry -- it is indistinguishable from evidence, and it confirms the hypothesis
  // by construction.
  //
  // Cast through `any` on purpose. TypeScript already refuses the third argument, and a
  // JavaScript embedder walks straight through TypeScript; what has to hold is that the value
  // is not read even when it is passed.
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', [HANDOFF])
  const old = new FakeRotationSession('old', 'claude')
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED])

  const relay = await relayOf(dir, advisor, [old, fresh])
  t.after(() => relay.stop())

  const forge = relay.rotateSeat as (seat: string, reason: string, intent?: string) => Promise<unknown>
  const result = (await forge.call(relay, 'implementer', 'a blind reader is a stronger test', 'degradation_automatic')) as {
    status: string
  }
  assert.equal(result.status, 'rotated')

  const records = relay.rotationRecords()
  assert.equal(records.length, 1)
  assert.equal(
    records[0]!.intent,
    'operator_requested',
    'the pause is what classifies a public rotation, and there was none — the passed value is not read',
  )
})
