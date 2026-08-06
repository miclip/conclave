/**
 * The attended run: pause as a state, and the transitions out of it.
 *
 * The property these are about is that a pause **preserves the loop**. Restarting `run()`
 * from the goal was always available; what was missing was continuing from where the
 * session actually was. So the assertions are mostly about what the participants see next
 * — an implementer that gets the round-3 instruction rather than the round-1 one is the
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
import type { AgentSession } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { Relay, type RelayOptions } from './relay.ts'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-run-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'work.ts'), 'export const answer = 42\n')
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

const HANDOFF = `## GOAL
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
    maxRounds: 4,
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
  // The whole point. Restarting run() was always available; continuing from the round the
  // session had actually reached was not.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did the first thing.', 'Did the second thing.'])
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do the first thing.', 'Do the second thing.', 'DONE'])
  const relay = await relayOf(dir, advisor, [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  impl.compact()
  await run.untilPause()
  await run.continue()

  assert.equal((await run.result()).reason, 'done')
  // Three sends: the briefing, then one instruction per round. A replay would have sent
  // the briefing and the first instruction twice.
  assert.equal(impl.received.length, 3)
  assert.ok(impl.received[1]!.includes('Do the first thing.'))
  assert.ok(impl.received[2]!.includes('Do the second thing.'))
  assert.equal(relay.log.filter((m) => m.kind === 'goal').length, 1)
})

test('rotating from a pause replaces the implementer and the loop carries on with it', async (t) => {
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude', ['ack', 'Did the first thing.'])
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED, 'Carried on.'])
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
  assert.ok(fresh.received.at(-1)!.includes('Do the second thing.'), 'the replacement got the NEXT instruction')
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
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did the first thing.', 'Did the second.'])
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

  assert.ok(impl.received.at(-1)!.includes('FROM THE HUMAN'))
  assert.ok(impl.received.at(-1)!.includes('src/adapters'))
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
  assert.ok(!impl.received.some((m) => m.includes('ESCALATE')))
  assert.ok(advisor.received.some((m) => m.includes('It is in scope.')))
})

test('a declined candidate is remembered, and a LATER compaction raises it again', async (t) => {
  // Found by three tests hanging: without this the same compaction re-pauses every round
  // forever, and the operator either abandons the feature or stops reading the pauses.
  // The second is worse than never having built it.
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

  // A second, distinct compaction is new evidence and must be raised. Declining once is
  // not standing consent for whatever happens next.
  impl.compact()
  const second = await run.untilPause()
  assert.ok(second, 'a later compaction is new evidence')
  assert.ok(second.evidence.some((e) => e.includes('1 → 2')))
  await run.abort()

  assert.equal(
    relay.log.filter((m) => m.text.includes('rotation candidate declined')).length,
    1,
    'exactly one decline was recorded between the two compactions',
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
