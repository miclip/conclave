/**
 * Both axes, computed — and every pause exactly where it was.
 *
 * #56 adds `ResolutionRequest` metadata to the six unresolved conditions and changes nothing
 * else: no routing, no halt site, no pause option, no recurrence. That is a claim about
 * ABSENCE, and absence is what nothing tests by accident, so it is tested here on purpose.
 *
 * Two halves, and the second is the one that matters:
 *
 *   1. `resolutionFor` classifies each reason on both axes, and derives rotation authority
 *      from configuration rather than taking it from the caller.
 *   2. Each of the six reasons still produces the same pause it produces today — same
 *      reason, same options, still suspended, still routed the same way — WITH the metadata
 *      attached. Two of the six now carry an authority that is not `operator`, and if
 *      anything ever starts acting on that before the resolution paths exist (#60), these
 *      fail rather than the operator quietly losing a decision point.
 *
 * The #55 guard does not cover this. It pins participant ids, the run cwd, the flag sets and
 * the two JSON shapes; it says nothing about which conditions pause, so deleting the
 * `turn_incomplete` pause outright would leave it green. That gap is what this file closes.
 *
 *   node --test src/relay/resolution.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { Verdict } from '../contract/outcome.ts'
import type { AgentSession } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { Relay, type RelayOptions } from './relay.ts'
import { resolutionFor, type EveryReasonIsClassified } from './resolution.ts'
import type { PauseOption, RunHandle, RunPause } from './run.ts'

// ---------------------------------------------------------------------------
// The classifier, on its own.
// ---------------------------------------------------------------------------

test('rotation authority is derived from the checks, not from the caller', () => {
  // `--checks` IS the operator pre-delegating rotation authority: it supplies the
  // verification method that makes the decision mechanical. Absent, the same condition is
  // theirs to answer.
  const armed = resolutionFor({ reason: 'rotation_candidate', participant: 'implementer' }, { rotationArmed: true })
  const unarmed = resolutionFor({ reason: 'rotation_candidate', participant: 'implementer' }, { rotationArmed: false })
  assert.equal(armed.authority, 'mechanical')
  assert.equal(unarmed.authority, 'operator')
  // The scope does not move with it. Who may answer and what stops are orthogonal, which is
  // the entire decision: collapsing them is what put seat identity on the authority axis in
  // both original designs.
  assert.deepEqual(armed.scope, { kind: 'participant', participantId: 'implementer' })
  assert.deepEqual(unarmed.scope, armed.scope)
})

test('each of the six reasons carries the authority and scope D2 classifies it with', () => {
  const armed = { rotationArmed: true }
  assert.deepEqual(resolutionFor({ reason: 'rotation_candidate', participant: 'implementer' }, armed), {
    reason: 'rotation_candidate',
    authority: 'mechanical',
    scope: { kind: 'participant', participantId: 'implementer' },
  })
  assert.deepEqual(resolutionFor({ reason: 'turn_incomplete', participant: 'advisor' }, armed), {
    reason: 'turn_incomplete',
    authority: 'mechanical',
    scope: { kind: 'participant', participantId: 'advisor' },
  })
  assert.deepEqual(resolutionFor({ reason: 'implementer_unanswered', participant: 'implementer' }, armed), {
    reason: 'implementer_unanswered',
    authority: 'advisor',
    scope: { kind: 'participant', participantId: 'implementer' },
  })
  assert.deepEqual(resolutionFor({ reason: 'authority_conflict', workstream: 'implementer' }, armed), {
    reason: 'authority_conflict',
    authority: 'operator',
    scope: { kind: 'workstream', workstreamId: 'implementer' },
  })
  assert.deepEqual(resolutionFor({ reason: 'advisor_escalated' }, armed), {
    reason: 'advisor_escalated',
    authority: 'operator',
    scope: { kind: 'conclave' },
  })
  assert.deepEqual(resolutionFor({ reason: 'operator_requested' }, armed), {
    reason: 'operator_requested',
    authority: 'operator',
    scope: { kind: 'conclave' },
  })
})

/**
 * The seventh-reason guarantee, such as a test can hold it.
 *
 * The real assertion is `EveryReasonIsClassified` in `resolution.ts`: adding a reason to
 * `PauseReason` without classifying it, or classifying one that is not a reason, fails
 * `tsc --noEmit` -- which `npm test` runs before a single test does. Naming it here is what
 * stops the guarantee from being invisible to anyone reading the suite for what is covered.
 */
const EXHAUSTIVE: EveryReasonIsClassified = true

test('every pause reason is classified, checked by the compiler rather than at runtime', () => {
  // A runtime tautology on purpose: it is the compile step above that has already failed if
  // the two sets have drifted, and there is no runtime evidence of a type to assert instead.
  assert.equal(EXHAUSTIVE, true)
})

test('the classification is pure: the same subject and configuration give the same request', () => {
  // Computed rather than stored is the property, and a classifier that read anything else
  // would be storing state somewhere a reader cannot see.
  const once = resolutionFor({ reason: 'turn_incomplete', participant: 'implementer' }, { rotationArmed: false })
  const twice = resolutionFor({ reason: 'turn_incomplete', participant: 'implementer' }, { rotationArmed: false })
  assert.deepEqual(once, twice)
  assert.notEqual(once, twice, 'a fresh object each time, so a caller cannot mutate the next one')
})

// ---------------------------------------------------------------------------
// The six conditions, against a real relay. Nothing here may change.
// ---------------------------------------------------------------------------

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-resolution-'))
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

/** Rotation armed, as the default console and relay invocations arm it with `--checks`. */
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

const TIMED_OUT: Verdict = {
  outcome: 'timed_out',
  confidence: 'uncertain',
  provenance: [{ source: 'orchestrator', detail: 'watchdog fired' }],
}

interface Provoked {
  pause: RunPause
  run: RunHandle
  relay: Relay
  advisor: FakeRotationSession
  impl: FakeRotationSession
}

/**
 * Drive a real relay into each condition.
 *
 * The provocations are the ones `run.test.ts` already uses, deliberately: this file is about
 * what did NOT change, and reproducing the same trigger is what makes that comparable.
 */
async function provoke(t: TestContext, reason: RunPause['reason']): Promise<Provoked> {
  const dir = repo()
  let advisor: FakeRotationSession
  let impl: FakeRotationSession

  switch (reason) {
    case 'rotation_candidate': {
      advisor = new FakeRotationSession('advisor', 'codex', ['Do the thing.', 'DONE'])
      impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])
      const relay = await relayOf(dir, advisor, [impl])
      t.after(() => relay.stop())
      const run = relay.start('Keep the work moving.')
      impl.compact()
      const pause = await run.untilPause()
      assert.ok(pause)
      return { pause, run, relay, advisor, impl }
    }
    case 'advisor_escalated': {
      advisor = new FakeRotationSession('advisor', 'codex', [
        'ESCALATE: I do not know whether this is in scope.',
        'Do the thing.',
        'DONE',
      ])
      impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])
      const relay = await relayOf(dir, advisor, [impl])
      t.after(() => relay.stop())
      const run = relay.start('Keep the work moving.')
      const pause = await run.untilPause()
      assert.ok(pause)
      return { pause, run, relay, advisor, impl }
    }
    case 'implementer_unanswered': {
      advisor = new FakeRotationSession('advisor', 'codex', [
        'Read the routes and report what you find.',
        'Use /api/v1 for the endpoint.',
        'DONE',
      ])
      impl = new FakeRotationSession('impl', 'claude', [
        'ack',
        'Read the existing routes.\nUNANSWERED: Should the new endpoint be under /api/v1 or /api/v2?',
        'Done.',
        'NONE',
      ])
      const relay = await relayOf(dir, advisor, [impl])
      t.after(() => relay.stop())
      const run = relay.start('Add the endpoint.')
      const pause = await run.untilPause()
      assert.ok(pause)
      return { pause, run, relay, advisor, impl }
    }
    case 'authority_conflict': {
      advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'Remove two.txt and wait.', 'DONE'])
      impl = new FakeRotationSession('impl', 'claude', ['ack', 'Wrote two.txt.', 'Removed it.'])
      const relay = await relayOf(dir, advisor, [impl])
      t.after(() => relay.stop())
      const run = relay.start('Keep the work moving.')
      relay.say('Also write the word into two.txt.', { only: 'implementer' }, 'aside')
      const pause = await run.untilPause()
      assert.ok(pause)
      return { pause, run, relay, advisor, impl }
    }
    case 'turn_incomplete': {
      advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])
      impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it, slowly.'])
      impl.endTurn = { index: 1, verdict: TIMED_OUT }
      const relay = await relayOf(dir, advisor, [impl])
      t.after(() => relay.stop())
      const run = relay.start('Keep the work moving.')
      const pause = await run.untilPause()
      assert.ok(pause)
      return { pause, run, relay, advisor, impl }
    }
    case 'operator_requested': {
      // Slow turns, so the request lands while a turn is in flight and the loop honours it
      // at the advisor-turn boundary — which is the only place it can, since neither child CLI
      // ingests input mid-turn.
      advisor = new FakeRotationSession('advisor', 'codex', ['Do the first thing.', 'Do the second thing.', 'DONE'])
      impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did the first thing.', 'Did the second thing.', 'NONE'])
      advisor.delayMs = 20
      impl.delayMs = 20
      const relay = await relayOf(dir, advisor, [impl])
      t.after(() => relay.stop())
      const run = relay.start('Keep the work moving.')
      const pause = await run.requestPause('the operator asked to pause')
      assert.ok(pause)
      return { pause, run, relay, advisor, impl }
    }
  }
}

/**
 * What each condition looks like today, written down.
 *
 * `options` is the operator's menu at that pause and `state` is the run afterwards: a
 * `mechanical` authority that started resolving itself would show up here as a run that is
 * no longer paused, which is precisely the change #56 must not make.
 */
const EXPECTED: Record<
  RunPause['reason'],
  { authority: string; scope: unknown; options: PauseOption[] }
> = {
  rotation_candidate: {
    authority: 'mechanical',
    scope: { kind: 'participant', participantId: 'implementer' },
    options: ['continue', 'rotate', 'constrain', 'abort'],
  },
  turn_incomplete: {
    authority: 'mechanical',
    scope: { kind: 'participant', participantId: 'implementer' },
    options: ['continue', 'rotate', 'constrain', 'abort'],
  },
  implementer_unanswered: {
    authority: 'advisor',
    scope: { kind: 'participant', participantId: 'implementer' },
    options: ['continue', 'rotate', 'constrain', 'abort'],
  },
  authority_conflict: {
    authority: 'operator',
    scope: { kind: 'workstream', workstreamId: 'implementer' },
    options: ['continue', 'rotate', 'constrain', 'abort'],
  },
  advisor_escalated: {
    authority: 'operator',
    scope: { kind: 'conclave' },
    options: ['continue', 'rotate', 'constrain', 'abort'],
  },
  operator_requested: {
    authority: 'operator',
    scope: { kind: 'conclave' },
    options: ['continue', 'rotate', 'constrain', 'abort'],
  },
}

for (const reason of Object.keys(EXPECTED) as RunPause['reason'][]) {
  test(`${reason} still pauses exactly as it does today, and carries both axes`, async (t) => {
    const { pause, run } = await provoke(t, reason)
    const expected = EXPECTED[reason]

    // Unchanged: the reason, the menu, and the fact that the run is suspended waiting for a
    // decision. Two of these six are classified `mechanical` and one `advisor`; all three
    // still stop here, because nothing exists yet that could resolve them and dropping the
    // pause first would lose the decision point rather than automate it.
    assert.equal(pause.reason, reason)
    assert.deepEqual(pause.options, expected.options, 'the operator menu must not change')
    assert.equal(run.state, 'paused', 'the run must still be waiting for a decision')

    // Added: the classification, on the pause the operator was handed.
    assert.equal(pause.resolution.authority, expected.authority)
    assert.deepEqual(pause.resolution.scope, expected.scope)
    // One condition, one classification. The loose `reason` field is what every existing
    // reader is written against, and it cannot be allowed to disagree with the new one.
    assert.equal(pause.resolution.reason, pause.reason)

    await run.abort()
  })
}

test('an advisor turn that ends badly scopes to the advisor, not to the implementer', async (t) => {
  // The one place the scope is not obvious. `turn_incomplete` is raised for either seat --
  // `src/relay/relay.ts:1925` for the advisor, `:2166` for the implementer -- and a scope
  // read off "the implementer" rather than off the seat would be silently wrong for half of
  // them, in a way no N=1 run with one implementer would ever reveal.
  const dir = repo()
  const advisor = new FakeRotationSession('advisor', 'codex', ['', 'Do the thing.', 'DONE'])
  advisor.endTurn = { index: 0, verdict: TIMED_OUT }
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])
  const relay = await relayOf(dir, advisor, [impl])
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const pause = await run.untilPause()
  assert.ok(pause)
  assert.equal(pause.reason, 'turn_incomplete')
  assert.deepEqual(pause.resolution.scope, { kind: 'participant', participantId: 'advisor' })
  assert.equal(pause.resolution.authority, 'mechanical')
  // Rotation replaces the implementer, always, so it is not on the menu for a pause about
  // the advisor. Unchanged, and asserted here because the seat is what decides it.
  assert.deepEqual(pause.options, ['continue', 'constrain', 'abort'])
  await run.abort()
})

test('an unarmed run ends on degradation rather than raising a rotation candidate', async (t) => {
  // Which is why the `operator` branch of the derived rotation authority is not reachable
  // from any pause site: without checks the run does not pause on degradation at all, it
  // ends (`src/relay/relay.ts:1695-1699`). Asserted rather than asserted-in-a-comment,
  // because the classification's other branch rests on it.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])
  // Built without the `rotation` key rather than with an undefined one: `--checks` absent
  // means the option was never supplied, which is the state being tested.
  const relay = await Relay.start({
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])],
      claude: [impl],
    }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 4,
  })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  impl.compact()
  const settled = await run.settled()
  assert.equal(settled.kind, 'ended', 'an unarmed run has no rotation candidate pause to raise')
  assert.equal(settled.outcome.reason, 'escalated')
  assert.match(settled.outcome.detail ?? '', /No rotation checks are configured/)
})

test('an advisor-authority condition is not routed to the advisor', async (t) => {
  // The declared exception in #55's guard, still declared. `implementer_unanswered` is
  // classified `advisor` and the question goes nowhere near the advisor: the run stops and
  // the operator is asked, exactly as before. When that changes it will be #60's doing, and
  // this assertion is what will say so.
  const { pause, run, advisor } = await provoke(t, 'implementer_unanswered')
  assert.equal(pause.resolution.authority, 'advisor')
  assert.ok(
    !advisor.received.some((m) => m.includes('UNANSWERED')),
    'the question must not have reached the advisor while the operator is deciding',
  )
  assert.equal(run.state, 'paused')
  await run.abort()
})

test('a mechanical condition still ends an unattended run rather than resolving itself', async (t) => {
  // `run()` has no handle, so `#halt` escalates and ends. `turn_incomplete` is classified
  // `mechanical`, and if that classification ever started being acted on, the most likely
  // first symptom is an unattended run carrying on past a turn that did not complete --
  // which is the run with nobody watching it happen.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it, slowly.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT }
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']), [impl])
  t.after(() => relay.stop())

  const outcome = await relay.run('Keep the work moving.')
  assert.equal(outcome.reason, 'escalated')
  assert.match(outcome.detail ?? '', /Nobody is attending this run/)
})

test('the routing log says what it said before; the classification is not narrated into it', async (t) => {
  // The log IS the operator's account of the session, `session.ts` renders from it, and
  // other suites match on the exact `paused (<reason>):` prefix. Metadata that leaked into
  // prose would be a rendering change wearing a data change's clothes.
  const { run, relay } = await provoke(t, 'rotation_candidate')
  await run.continue()

  const notes = relay.log.filter((m) => m.kind === 'note').map((m) => m.text)
  assert.ok(
    notes.some((n) => n.startsWith('paused (rotation_candidate): ')),
    notes.join('\n'),
  )
  assert.ok(notes.some((n) => n === 'resumed from rotation_candidate'), notes.join('\n'))
  assert.ok(
    !notes.some((n) => /mechanical|authority:|scope:|workstream|conclave/i.test(n)),
    'no note may narrate the classification',
  )
  await run.abort()
})
