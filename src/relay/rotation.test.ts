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
    maxRounds: 2,
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
    maxRounds: 3,
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

  const relay = await relayOf(dir, advisor, [old, fresh], { maxRounds: 3 })
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

test('a complaint with nothing behind it continues, and is counted', async (t) => {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do the thing.', 'DONE'])
  const old = new FakeRotationSession('old', 'claude', ['ack', 'I need a fresh session before I can continue.'])
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED])

  const relay = await relayOf(dir, advisor, [old, fresh], { maxRounds: 2 })
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

  const relay = await relayOf(dir, advisor, [old], { rotation: undefined, maxRounds: 2 })
  t.after(() => relay.stop())

  old.compact()
  const outcome = await relay.run('Keep the work moving.')

  // Detection does not depend on configuration; only the automatic response does.
  assert.equal(outcome.reason, 'escalated')
  assert.ok(outcome.detail!.includes('degraded'))
  assert.ok(outcome.detail!.includes('needs a human'))
  assert.equal(old.state, 'running')
})

test('the replacement is not judged degraded by the retired session’s compaction', async (t) => {
  // The event list survives rotation, so without a cursor the replacement inherits the
  // evidence that retired its predecessor and rotates again immediately.
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', HANDOFF, 'Keep going.', 'DONE'])
  const old = new FakeRotationSession('old', 'claude', ['ack', 'Did it.'])
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED, 'Still going.'])

  const relay = await relayOf(dir, advisor, [old, fresh], { maxRounds: 4 })
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
