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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { Verdict } from '../contract/outcome.ts'
import type { AgentSession } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { Relay, type RelayOptions } from './relay.ts'
import {
  actorFor,
  resolutionFor,
  type EveryReasonIsClassified,
  type ResolutionRequest,
  type ResolutionSubject,
} from './resolution.ts'
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

/**
 * Every subject, with the evidence its scope needs. One list, so a test asking "all of them"
 * cannot quietly mean four.
 */
const EVERY_SUBJECT: ResolutionSubject[] = [
  { reason: 'rotation_candidate', participant: 'implementer' },
  { reason: 'turn_incomplete', participant: 'implementer' },
  { reason: 'implementer_unanswered', participant: 'implementer' },
  { reason: 'authority_conflict', workstream: 'implementer' },
  { reason: 'advisor_escalated' },
  { reason: 'operator_requested' },
]

test('every classified request has an actor routed to answer it', () => {
  // The invariant, and it is vacuous today on purpose: routing sends everything to the
  // operator whatever the authority says, so this passes for all six reasons under both
  // configurations and could not fail. What it pins is that the routing table is TOTAL.
  //
  // It stops being vacuous when #56's routing lands. A `mechanical` authority wired to a
  // resolver that was never built is a request with no respondent -- nothing is waiting on
  // it, nobody was asked, and the run reports healthy. That failure arrives as silence, and
  // this is the two lines that turn it into a throw at the halt site instead.
  assert.equal(EVERY_SUBJECT.length, 6, 'all six reasons, not the ones that happened to be listed')
  for (const config of [{ rotationArmed: true }, { rotationArmed: false }]) {
    for (const subject of EVERY_SUBJECT) {
      const request = resolutionFor(subject, config)
      assert.equal(actorFor(request), 'operator', `${subject.reason} routes to the operator today`)
    }
  }
  // Including the authority no reason currently produces at the site that raises pauses:
  // `rotation_candidate` reaches `mechanical` only with checks configured, and the table is
  // keyed by the authority union rather than by the reasons that happen to occur.
  for (const authority of ['mechanical', 'advisor', 'operator'] as const) {
    assert.equal(actorFor({ reason: 'turn_incomplete', authority, scope: { kind: 'conclave' } }), 'operator')
  }
})

test('an authority with nobody routed to it is refused rather than left unanswered', () => {
  // Unreachable through the union, which is the point of the `Record`: adding a seventh
  // authority fails `tsc` until somebody says who answers it. This is the same guarantee at
  // runtime, for the case the compiler cannot see -- a routing table assembled from
  // configuration, or a cast. Constructed by cast because there is no honest way to build it.
  const unrouted = { reason: 'turn_incomplete', authority: 'arbiter', scope: { kind: 'conclave' } } as unknown
  assert.throws(() => actorFor(unrouted as ResolutionRequest), /no actor is routed for arbiter authority/)
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
    case 'merge_blocked': {
      // The one condition that needs two seats and real git, because it is about two seats
      // and real git. Both write the same line from the same base: the first merges, the
      // second cannot, and its repair turn changes nothing — which is the second failure
      // against the same integration parent, and the only thing that escalates.
      //
      // The repo() above commits with `-c user.email` rather than configuring the repository,
      // so a boundary commit made by the relay would have no identity to use.
      execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
      execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
      advisor = new FakeRotationSession('advisor', 'codex', [
        'Set the answer to one.',
        'Set the answer to two.',
        '@seat implementer-2: Resolve the conflict in your own worktree.',
        'DONE',
      ])
      const first = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.', 'NONE'])
      impl = new FakeRotationSession('impl-2', 'claude', ['ack', 'Did it.', 'Still stuck.', 'NONE'])
      const relay = await relayOf(dir, advisor, [first, impl], {
        implementers: [
          { id: 'implementer', agent: 'claude', role: 'implementer' },
          { id: 'implementer-2', agent: 'claude', role: 'implementer' },
        ],
        maxAdvisorTurns: 5,
      })
      t.after(() => relay.stop())
      const trees = Object.fromEntries(relay.worktrees!.seats.map((s) => [s.seatId, s.worktreePath]))
      // Each seat writes into ITS OWN tree, which is the only reason these conflict at merge
      // time rather than overwriting each other as they go.
      first.onSend = () => writeFileSync(join(trees.implementer!, 'work.ts'), 'export const answer = 1\n')
      impl.onSend = () => writeFileSync(join(trees['implementer-2']!, 'work.ts'), 'export const answer = 2\n')
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
    case 'review_blocked': {
      // One implementer, one reviewer (#72). The reviewer rejects the same work twice; no
      // advisor instruction ever addresses it, since review is dispatched automatically.
      advisor = new FakeRotationSession('advisor', 'codex', ['Write the answer.', 'DONE', 'DONE', 'DONE', 'DONE'])
      impl = new FakeRotationSession('impl', 'claude', ['ack', 'Wrote it.', 'Wrote it again.'])
      const reviewer = new FakeRotationSession('reviewer', 'claude', [
        'ack',
        'REJECT: not good enough.',
        'REJECT: still not good enough.',
      ])
      const relay = await relayOf(dir, advisor, [impl, reviewer], {
        reviewer: { id: 'reviewer', agent: 'claude', role: 'reviewer' },
        maxAdvisorTurns: 6,
      })
      t.after(() => relay.stop())
      const run = relay.start('Keep the work moving.')
      const pause = await run.untilPause()
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
  merge_blocked: {
    authority: 'operator',
    // The SEAT, not the conclave: its branch and tree are what cannot proceed, and no other
    // seat's work is waiting on this decision.
    scope: { kind: 'participant', participantId: 'implementer-2' },
    // `rotate` IS offered now, and the reason it was not is the reason it is. The entry used to
    // read "this run has two implementer seats and `rotateImplementer` names none of them, so
    // offering it would be the inert menu entry the option list exists to prevent" -- true while
    // rotation could only replace "the implementer". Since #78 it replaces a NAMED seat, and
    // this pause names one: it is scoped to `implementer-2`, which is exactly the seat the
    // option would act on. The choice is not inert either -- the seat reached this pause by
    // failing its OWN repair against an unmoved parent, which is the case where "give this seat
    // a session that has not already tried and failed" is a real thing an operator can want. It
    // replaces the session and leaves the branch, the tree and the block where they are; nothing
    // here claims a rotation resolves a conflict.
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
  review_blocked: {
    authority: 'operator',
    // The SEAT, not the conclave: its work is what cannot proceed, and no other seat is
    // waiting on this decision.
    scope: { kind: 'participant', participantId: 'implementer' },
    // Unlike `merge_blocked` above: this run has exactly ONE implementer seat -- the
    // reviewer does not count (#72, `#implementers()` is role-scoped) -- so `rotate` is a
    // live option rather than the inert menu entry a second implementer seat would make it.
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
  // `src/relay/relay.ts:4590` for the advisor, `:4974` for the implementer -- and a scope
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

test('an unarmed run PAUSES on degradation, and the pause is the operator\'s to resolve', async (t) => {
  // This asserted the opposite until #96, and the old behaviour is what the assertion was
  // protecting: an unarmed run ENDED on degradation, so the `operator` branch of the derived
  // authority described a configuration that could never produce a pause. The classification
  // was honest and unreachable at once.
  //
  // Ending was the wrong response to "cannot rotate". Rotation needs checks to reproduce, so
  // an unarmed run genuinely cannot rotate -- but ending is the most drastic action available,
  // taken here on the weakest evidence there is (#10: nothing shows compaction and degradation
  // coincide) and in the configuration with the least means to check. Observed on oath-lang: a
  // healthy seat compacted mid-work and the run ended, telling a human it needed them while
  // that human was at the console.
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

  assert.equal(settled.kind, 'paused', 'an unarmed run must ask rather than end')
  const pause = settled.pause
  assert.equal(pause.reason, 'rotation_candidate')
  // The derivation, now reachable: no checks means nothing mechanical can settle it.
  assert.equal(pause.resolution.authority, 'operator')
  assert.deepEqual(pause.resolution.scope, { kind: 'participant', participantId: 'implementer' })
  // Rotation is NOT offered, because it is the one thing an unarmed run cannot do. A menu
  // listing it would be the failure #66 and #76 are both about: an option that no-ops.
  assert.ok(!pause.options.includes('rotate'), `rotate must not be offered without checks: ${pause.options}`)
  assert.match(pause.detail ?? '', /No rotation checks are configured/)
  assert.match(pause.detail ?? '', /--checks/, 'the pause must name what would widen the choice next time')

  // What the pause CLAIMS, not just what it offers (#98). The detail used to open
  // "implementer is degraded", which states as fact the one thing #10 exists because nobody has
  // established -- and stated it in the place where an operator is being asked to act on it,
  // fifteen lines above relay.ts's own comment saying the link is unproven. The same string is
  // handed to `rotateSeat` as a rotation's recorded reason, so the claim outlived the run.
  //
  // Pinned as three separate assertions because they fail for three different reasons: the
  // conclusion coming back, the observation going missing, and the caveat being dropped. One
  // regex over the whole sentence would go red for all three and say which for none.
  const detail = pause.detail ?? ''
  assert.ok(
    !/is degraded/.test(detail),
    `the pause must not assert degradation as fact: ${detail}`,
  )
  assert.match(detail, /compacted/, 'the pause must say what was actually observed')
  assert.match(
    detail,
    /unestablished \(#10\)/,
    'the pause must name the open question it is asking the operator to weigh',
  )

  // And it resumes: the whole point is that a compaction is survivable.
  await run.continue()
  const after = await run.settled()
  assert.equal(after.kind, 'ended', `the run continues past the compaction: ${JSON.stringify(after)}`)
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

/**
 * The same gap on the other axis: that the invariant is CALLED.
 *
 * `actorFor` is total today, so deleting its call from `#halt` changes nothing observable —
 * measured, not assumed: the mutation survived the whole suite. The check exists for the day
 * a request stops being routed to the operator, and a check that has been quietly unwired by
 * then is worse than one that was never written, because its presence reads as coverage.
 *
 * Pinned by reading the source, for the reason the sweep's twin test in `dispatch.test.ts`
 * gives: the alternative is a test-only seam in `Relay`, and production API that exists for
 * a test is the thing this branch has twice now decided not to build.
 */
test('#halt calls actorFor on the classified request before raising the pause (source inspection)', () => {
  const src = readFileSync(new URL('./relay.ts', import.meta.url), 'utf8')

  // One classification site and one pause site, which is what makes "every pause passes
  // through this check" a true statement rather than a hope about the one path that was
  // read. A second `pauseAt` would need its own invariant, and this fails until it has one.
  assert.equal(src.split('resolutionFor(').length - 1, 1, 'exactly one classification site')
  assert.equal(src.split('pauseAt(').length - 1, 1, 'exactly one site that raises a pause')
  assert.equal(src.split('actorFor(').length - 1, 1, 'called once, at that site')

  const classified = src.indexOf('const resolution = resolutionFor(')
  const checked = src.indexOf('actorFor(resolution)')
  const raised = src.indexOf('pauseAt(')
  assert.notEqual(classified, -1, '#halt classifies the condition')
  assert.notEqual(checked, -1, '#halt asserts the request has an actor')
  // Between the two: after the request exists, and before anything is asked of a human on the
  // strength of it. A check placed after the pause would be asserting about a decision the
  // operator had already been handed.
  assert.ok(classified < checked && checked < raised, 'checked after classification, before the pause')
})
