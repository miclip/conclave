/**
 * The terminal record, as data.
 *
 *   node --test src/relay/report.test.ts
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const BUILD = 'test-build'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { AgentRegistry } from '../registry/registry.ts'
import type { DeadlineSupport } from '../registry/types.ts'
import { Relay } from './relay.ts'
import { runReport, REPORT_SCHEMA } from './report.ts'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-report-'))
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })
  return dir
}

/** A pty+hook adapter's declaration: both clocks, both defaulted. Claude and Codex. */
const BOTH_CLOCKS: DeadlineSupport = {
  absolute: { supported: true, defaultMs: 2_700_000 },
  silence: { supported: true, defaultMs: 720_000 },
}

/**
 * A run-per-turn adapter's declaration: an absolute clock that runs only when asked, and no
 * silence clock in the adapter at all. Kimi and OpenCode.
 */
const NO_SILENCE_CLOCK: DeadlineSupport = {
  absolute: { supported: true },
  silence: { supported: false },
}

function registryOf(
  sessions: Record<string, FakeRotationSession[]>,
  deadlines: Record<string, DeadlineSupport> = {},
): AgentRegistry {
  const r = new AgentRegistry()
  for (const [agent, queue] of Object.entries(sessions)) {
    const remaining = [...queue]
    r.register({
      id: agent,
      displayName: agent,
      // Defaulted to the pty+hook shape, which is what every test here but the deadline one
      // is implicitly assuming when it names its fakes `claude` and `codex`.
      deadlines: deadlines[agent] ?? BOTH_CLOCKS,
      capabilities: {
        agent,
        readinessSignal: 'first_turn',
        turnKeySource: 'run_invocation',
        outcomes: {
          completed: 'observed',
          cancelled: 'reasoned_but_unverified',
          permission_refused: 'unsupported',
          process_exited: 'reasoned_but_unverified',
          timed_out: 'reasoned_but_unverified',
          transport_lost: 'reasoned_but_unverified',
          unknown_abnormal_end: 'reasoned_but_unverified',
        },
      },
      launch: { command: agent, baseArgs: [] },
      create: async () => remaining.shift()!,
    })
  }
  return r
}

async function reportOf(replies: string[] = ['DONE']) {
  const dir = repo()
  const relay = await Relay.start({
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', replies)],
      claude: [new FakeRotationSession('impl', 'claude', ['a report'])],
    }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 2,
    rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000 },
  })
  const startedAt = Date.now()
  const outcome = await relay.run('a goal')
  const report = await runReport(relay, { goal: 'a goal', outcome, startedAt, build: BUILD })
  await relay.stop()
  return { report, relay, dir }
}

test('the report carries the supplied build string', async () => {
  const { report } = await reportOf()
  assert.equal(report.build, BUILD)
})

test('the report carries the same claims the prose lines make', async () => {
  const { report, dir } = await reportOf()

  assert.equal(report.schema, REPORT_SCHEMA)
  assert.equal(report.goal, 'a goal')
  assert.equal(report.cwd, dir)
  assert.ok(report.messages > 0)
  assert.ok(report.durationMs >= 0)
  assert.deepEqual(
    report.participants.map((p) => p.id).sort(),
    ['advisor', 'implementer'],
  )
})

/**
 * Two seats whose adapters disagree about what a deadline even is: a pty+hook advisor with
 * both clocks defaulted, and a run-per-turn implementer with an absolute clock that is off
 * unless asked and no silence clock at all.
 *
 * The mixed pairing is the point. A run-wide number would have to describe both, and there
 * is no number that does.
 */
async function mixedDeadlines(turnWatchdogMs?: number, silenceWatchdogMs?: number) {
  const dir = repo()
  const relay = await Relay.start({
    registry: registryOf(
      {
        codex: [new FakeRotationSession('advisor', 'codex', ['DONE'])],
        kimi: [new FakeRotationSession('impl', 'kimi', ['a report'])],
      },
      { codex: BOTH_CLOCKS, kimi: NO_SILENCE_CLOCK },
    ),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'kimi', role: 'implementer' },
    maxAdvisorTurns: 2,
    ...(turnWatchdogMs === undefined ? {} : { turnWatchdogMs }),
    ...(silenceWatchdogMs === undefined ? {} : { silenceWatchdogMs }),
  })
  const startedAt = Date.now()
  const outcome = await relay.run('a goal')
  const report = await runReport(relay, { goal: 'a goal', outcome, startedAt, build: BUILD })
  await relay.stop()
  return report
}

test('each seat reports the clocks it will actually run, unasked', async () => {
  // Nothing configured, so each seat falls to what its own adapter does. The implementer is
  // on NO clock in either direction, and that is the state a run-wide report described
  // worst: it would have claimed 45 minutes and 12 minutes for a seat that enforces neither.
  const report = await mixedDeadlines()
  assert.deepEqual(report.deadlines, {
    configuredAbsoluteMs: null,
    // Nothing asked of either clock, spelled the same way for both. `null` rather than an
    // absent key, for the reason the block already keeps `configuredAbsoluteMs`: a key that
    // vanishes when it has nothing to say cannot be told from one a reader forgot to look for.
    configuredSilenceMs: null,
    participants: [
      {
        id: 'advisor',
        agent: 'codex',
        absolute: { status: 'enforced', ms: 2_700_000 },
        silence: { status: 'enforced', ms: 720_000 },
      },
      {
        id: 'implementer',
        agent: 'kimi',
        // Off, and could be switched on. Distinct from the line below it, which cannot.
        absolute: { status: 'disabled' },
        // The one that has to be said out loud. This seat can go quiet forever and produce
        // no `timed_out` at all, so a reader who assumed a silence deadline applied would be
        // waiting on a verdict that is never coming.
        silence: { status: 'unsupported' },
      },
    ],
  })
})

test('--turn-timeout moves the absolute clock on both seats, and invents neither', async () => {
  // 90s asked for. Both seats support the absolute clock, so both are now enforced at 90s --
  // including the one that was running no deadline a moment ago.
  const report = await mixedDeadlines(90_000)
  assert.deepEqual(report.deadlines, {
    // What was ASKED for, kept beside what each seat did with it. The gap is the point: this
    // request reached the absolute clock on both seats and the silence clock on neither.
    configuredAbsoluteMs: 90_000,
    // And `--silence-timeout` was NOT passed, which is what makes the seat-level assertions
    // below load-bearing rather than incidental: the advisor's 720s is its adapter's own
    // default surviving an absolute request, not a silence request being honoured.
    configuredSilenceMs: null,
    participants: [
      {
        id: 'advisor',
        agent: 'codex',
        absolute: { status: 'enforced', ms: 90_000 },
        // Untouched at its adapter's default. `--turn-timeout` is the absolute clock, and a
        // request that silently retuned the silence budget would be a second setting nobody
        // typed. Written as a number rather than compared to DEFAULT_IDLE_MS, which would
        // agree with itself however the constant moved: 720s is what #36 settled on.
        silence: { status: 'enforced', ms: 720_000 },
      },
      {
        id: 'implementer',
        agent: 'kimi',
        absolute: { status: 'enforced', ms: 90_000 },
        // Still unsupported. No configuration reaches a clock the adapter does not have,
        // which is exactly why this is a separate status from `disabled`.
        silence: { status: 'unsupported' },
      },
    ],
  })
})

test('--silence-timeout moves the silence clock on the seat that has one, and invents none', async () => {
  // 300s asked of the SILENCE clock and nothing asked of the absolute one, which is the
  // pairing that proves the two are wired separately. The mirror of the test above it: there
  // an absolute request left every silence clock at its adapter's default, here a silence
  // request leaves every absolute clock at its adapter's default.
  const report = await mixedDeadlines(undefined, 300_000)

  assert.equal(report.deadlines.configuredSilenceMs, 300_000)
  // Untouched, and asserted rather than assumed: a `--silence-timeout` that also moved the
  // absolute budget would be a second setting nobody typed, which is the objection the
  // `deadlines` getter used to raise against passing `--turn-timeout` into this slot. The
  // objection was to sharing ONE flag between two clocks and it survives; what changed is
  // that the silence clock has a flag of its own.
  assert.equal(report.deadlines.configuredAbsoluteMs, null)

  const advisor = report.deadlines.participants.find((p) => p.id === 'advisor')!
  const implementer = report.deadlines.participants.find((p) => p.id === 'implementer')!

  // The seat that HAS the clock is on the requested budget rather than on DEFAULT_IDLE_MS.
  // Written as literals rather than against the constants, which would agree with themselves
  // however either moved.
  assert.deepEqual(advisor.silence, { status: 'enforced', ms: 300_000 })
  assert.deepEqual(advisor.absolute, { status: 'enforced', ms: 2_700_000 })

  // And the seat that has none is STILL unsupported, on a run that configured one as hard as
  // it can be configured. This is the whole design decision in one assertion: the flag is
  // accepted on a mixed run rather than refused, because refusing would discard a valid
  // setting for the advisor above in order to state a fact about this seat -- and what this
  // seat gets is the fact, not a number its adapter will never enforce.
  assert.deepEqual(implementer.silence, { status: 'unsupported' })
  // Not quietly re-aimed at the clock this seat DOES have, either. A silence request landing
  // on an absolute budget would be the worst available outcome: a deadline the operator did
  // not ask for, on a clock they were not configuring, reported as though they had.
  assert.deepEqual(implementer.absolute, { status: 'disabled' })
})

test('both clocks configured at once stay two independent budgets', async () => {
  // Parity, and the case a single shared knob could never produce: different numbers on the
  // two clocks of one seat. If either flag were reaching the other's slot, one of these two
  // assertions would carry the other's number.
  const report = await mixedDeadlines(90_000, 30_000)

  assert.equal(report.deadlines.configuredAbsoluteMs, 90_000)
  assert.equal(report.deadlines.configuredSilenceMs, 30_000)

  const advisor = report.deadlines.participants.find((p) => p.id === 'advisor')!
  assert.deepEqual(advisor.absolute, { status: 'enforced', ms: 90_000 })
  assert.deepEqual(advisor.silence, { status: 'enforced', ms: 30_000 })

  // The unsupported seat takes the absolute request and refuses the silence one, in the same
  // document, from the same invocation. That is what "reported per seat" buys over a run-wide
  // answer: there is no single pair of numbers that describes this run.
  const implementer = report.deadlines.participants.find((p) => p.id === 'implementer')!
  assert.deepEqual(implementer.absolute, { status: 'enforced', ms: 90_000 })
  assert.deepEqual(implementer.silence, { status: 'unsupported' })
})

test('the report keeps the two clock POLICIES apart, because #36 fixed only one of them', async () => {
  // Two clocks, two budgets, two different questions, and the JSON says so in two fields that
  // are never derived from each other:
  //
  //   absolute   the whole turn, however busy. Refreshed by NOTHING -- child output moves the
  //              other one and never this. `outcomes/watchdog.test.ts` proves that end of it
  //              ("repeated output cannot extend the absolute deadline").
  //   silence    how long the turn may say nothing. The only one output pushes out, and the
  //              one an ordinary hang meets first, because a child that stopped working also
  //              stopped writing.
  //
  // The reason this is worth a test of its own rather than a comment is what it means for a
  // reader of a finished run. #36 is a PARTIAL fix: when a deadline fires the adapters re-read
  // the transcript, which recovers a lost end-of-turn signal (superseded to `completed`, never
  // reported) and moves an ordinary hang onto the shorter clock -- the incident #36 was
  // actually filed about. A turn that is genuinely still working reads `in_progress`, which is
  // not evidence it ended, so it is reported `timed_out` on the absolute cap and nothing
  // corrects it.
  //
  // What the artifact can and cannot do for that reader, stated exactly, because the gap is
  // easy to read past:
  //
  //   CAN     say what each seat was measured against -- both budgets, per participant,
  //           including the seats enforcing neither. The run-wide single number this replaced
  //           could not, and would have claimed 45/12 for a seat honouring neither.
  //   CANNOT  say which of the two clocks produced any particular `timed_out`. That
  //           provenance is on the watchdog update at the moment it fires; nothing carries it
  //           into the report, and no field here is a proxy for it. So these numbers narrow
  //           what a verdict could mean and never settle it.
  const unasked = await mixedDeadlines()
  const pty = unasked.deadlines.participants.find((p) => p.id === 'advisor')!

  assert.deepEqual(pty.absolute, { status: 'enforced', ms: 2_700_000 })
  assert.deepEqual(pty.silence, { status: 'enforced', ms: 720_000 })
  assert.notDeepEqual(
    pty.absolute,
    pty.silence,
    'two independent budgets: neither is the other scaled, and a report that collapsed them ' +
      'would be telling a reader the seat is on one clock when it is on two',
  )

  // Every seat carries BOTH keys, whatever its adapter supports. A clock that vanished when it
  // had nothing to say could not be told from one a reader forgot to look for -- which is the
  // same rule `pausedMs` is kept to, and the reason `unsupported` is a status rather than an
  // absent field.
  for (const seat of unasked.deadlines.participants) {
    assert.ok('absolute' in seat && 'silence' in seat, `${seat.id} must report both clocks`)
  }

  // And the configured knob addresses exactly one of the two policies. `configuredAbsoluteMs`
  // is named for the clock it reaches: it moves every supported absolute clock and leaves every
  // silence clock at whatever its adapter decided, so the field name and the effect agree.
  const asked = await mixedDeadlines(90_000)
  assert.equal(asked.deadlines.configuredAbsoluteMs, 90_000)
  assert.deepEqual(
    asked.deadlines.participants.map((p) => p.absolute),
    [
      { status: 'enforced', ms: 90_000 },
      { status: 'enforced', ms: 90_000 },
    ],
    'the request reaches the whole-turn clock on every seat that has one',
  )
  assert.deepEqual(
    asked.deadlines.participants.map((p) => p.silence),
    unasked.deadlines.participants.map((p) => p.silence),
    'and reaches no silence clock at all: asking for a longer turn must not also buy a longer ' +
      'permitted silence, which would quietly undo the half of #36 that works',
  )
})

test('rotation state is reported even when nothing happened', async () => {
  const { report } = await reportOf()
  // The whole point of rotationWatch: a null is only evidence if the instrument was live.
  // A field that vanished when it had nothing to say would put the reader back where they
  // started, unable to tell "saw nothing" from "this build does not report it".
  assert.equal(report.rotation.armed, true)
  assert.equal(typeof report.rotation.assessments, 'number')
  assert.equal(report.rotation.peakGeneration, 0)
  // Present and EMPTY, by the same argument one field over (#75). `rotations: 0` says nothing
  // rotated; an absent `records` would say nothing about whether this build can tell WHY one
  // did, and a consumer excluding operator-initiated rotations from #10's dataset has to be
  // able to tell those apart before it trusts a single row.
  assert.deepEqual(report.rotation.records, [])
})

// ---------------------------------------------------------------------------------------
// The three populations, on the wire (#75).
//
// The empty case above is the shape claim. This is the CONTENT claim, and it is the one an
// analysis depends on: #10 asks whether compaction predicts degradation strongly enough to act
// on unattended, and a report that carried three rotations without saying which was the proxy
// firing would answer it with rotations that had nothing to do with degradation. Proving the
// array is present is not proving the values are distinguishable in it.
//
// TWO RELAYS, because the intent cannot be forged and should not be: `onDegradation` is a
// run-wide policy, and the automatic path only exists on a run configured to rotate without
// asking. A relay whose policy is `candidate` produces the two populations an operator can be
// in, side by side, which is where "distinguishable" is actually at risk; a second relay
// running the real automatic policy produces the third. Passing the intent in as an argument
// would have fitted all three in one report and proved nothing -- that argument no longer
// exists, for exactly that reason (see `Relay.rotateSeat`).
// ---------------------------------------------------------------------------------------

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
 * A repository with a commit in it.
 *
 * `repo()` above is enough for a run, and not for a ROTATION: the transaction captures the
 * repository around the handoff, and there is nothing to capture before the first commit.
 */
function committedRepo(): string {
  const dir = repo()
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], {
    cwd: dir,
  })
  return dir
}

test('the report tells the operator populations apart, each in its own words (#75)', async () => {
  const dir = committedRepo()
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

  const relay = await Relay.start({
    registry: registryOf({ codex: [advisor], claude: [old, ...replacements] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 5,
    // The policy that ASKS, which is what makes the first rotation an accepted candidate rather
    // than a detector's. Both rows below are reachable by an operator on this one run.
    rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000, onDegradation: 'candidate' },
  })
  const startedAt = Date.now()

  // ONE: the proxy asked and the operator agreed. Through the pause, because the pause is what
  // classifies it -- a reason typed here would not change the population.
  const run = relay.start('a goal')
  const settled = await run.settled()
  assert.ok(settled.kind === 'paused')
  assert.equal(settled.pause.reason, 'rotation_candidate')
  assert.equal((await run.rotateImplementer()).status, 'rotated')
  const outcome = await run.abort()

  // TWO: the operator arrived with their own reason and no pause in front of them. The
  // population #10's dataset has to EXCLUDE, and the one that used to be indistinguishable --
  // it arrives WITH a compaction generation attached, because compaction happens anyway.
  assert.equal(
    (await relay.rotateImplementer('a fresh reader applying the just-committed criterion is a stronger test')).status,
    'rotated',
  )

  const report = await runReport(relay, { goal: 'a goal', outcome, startedAt, build: BUILD })
  await relay.stop()

  // The count an operator already reads, and the rows that explain it. These cannot disagree:
  // a rolled-back rotation records nothing and increments nothing.
  assert.equal(report.rotation.rotations, 2)
  assert.equal(report.rotation.records.length, 2)
  assert.deepEqual(
    report.rotation.records.map((r) => r.intent),
    ['candidate_accepted', 'operator_requested'],
    'in the order they happened, and each in its own population',
  )

  const [accepted, operator] = report.rotation.records
  // WORDS, not just labels. The reason is what a reader checks the label against, and it is
  // the field that used to be the proxy's on both rows.
  assert.match(accepted!.reason, /compaction generation rose 0 → 1/, 'the proxy is what spoke')
  assert.match(operator!.reason, /fresh reader applying the just-committed criterion/)
  assert.doesNotMatch(operator!.reason, /compaction generation/, 'and it is not the proxy\u2019s words')

  // Every row names the seat it replaced and the session that took it, so a reader can join
  // this to the events without matching prose.
  assert.deepEqual(
    report.rotation.records.map((r) => r.seat),
    ['implementer', 'implementer'],
  )
  assert.deepEqual(
    report.rotation.records.map((r) => r.replacement),
    replacements.map((s) => s.sessionId),
  )
  for (const r of report.rotation.records) assert.equal(typeof r.at, 'number')

  // And it survives the wire. `--json` prints this document; a field that only exists on the
  // in-memory object is not something a consumer can read.
  const wire = JSON.parse(JSON.stringify(report)) as typeof report
  assert.deepEqual(wire.rotation.records, report.rotation.records)
})

test('a run that rotates unattended reports the third population, and nobody could have forged it (#75)', async () => {
  // The automatic path, driven by the POLICY rather than declared by the caller. `rotateSeat`
  // takes no intent: an embedder that could pass `degradation_automatic` could write rows into
  // the population #10 reads as the proxy predicting degradation, and a forged row is
  // indistinguishable from evidence. So the only way to produce this value is to configure a run
  // that rotates without asking and let the detector do it -- which is what this does.
  const dir = committedRepo()
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'Do the first thing.',
    HANDOFF,
    'Do the second thing.',
    'DONE',
  ])
  const old = new FakeRotationSession('old', 'claude', ['ack', 'Did the first thing.'])
  old.compactOnTurn = 1
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED, 'Second.', 'NONE'])

  const relay = await Relay.start({
    registry: registryOf({ codex: [advisor], claude: [old, fresh] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 5,
    rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000, onDegradation: 'automatic' },
  })
  const startedAt = Date.now()
  const outcome = await relay.run('a goal')
  const report = await runReport(relay, { goal: 'a goal', outcome, startedAt, build: BUILD })
  await relay.stop()

  assert.equal(report.rotation.rotations, 1)
  assert.deepEqual(
    report.rotation.records.map((r) => r.intent),
    ['degradation_automatic'],
    'nobody was asked, and the record says so rather than filing it under the operator',
  )
  assert.equal(report.rotation.records[0]!.seat, 'implementer')
  assert.equal(report.rotation.records[0]!.replacement, fresh.sessionId)
  // The detector's own words for what it saw, which is what makes the row checkable against
  // its label rather than merely labelled.
  assert.match(report.rotation.records[0]!.reason, /compaction generation/)

  const wire = JSON.parse(JSON.stringify(report)) as typeof report
  assert.deepEqual(wire.rotation.records, report.rotation.records)
})

test('an empty flags array is a claim, not a gap', async () => {
  const { report } = await reportOf()
  assert.deepEqual(report.flags, [])
  assert.deepEqual(report.restricted, [])
})

test('a flagged caveat reaches the record', async () => {
  const dir = repo()
  const relay = await Relay.start({
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['DONE'])],
      claude: [
        new FakeRotationSession('impl', 'claude', [
          'Done.\nFLAG: conformance.sh remains unrun; inherited reasoning.',
        ]),
      ],
    }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 2,
  })
  const outcome = await relay.run('a goal')
  const report = await runReport(relay, { goal: 'a goal', outcome, startedAt: Date.now(), build: BUILD })
  await relay.stop()

  assert.equal(report.flags.length, 1)
  assert.match(report.flags[0]!.text, /conformance\.sh/)
  // An operator confirming this run reads `outcome.reason` and `flags` together. The verdict
  // being `done` while something is outstanding is precisely the case the record exists for.
  assert.equal(report.outcome.reason, 'done')
})

test('per-turn verdicts carry their confidence and provenance, not just a state', async () => {
  const { report } = await reportOf()
  const impl = report.participants.find((p) => p.id === 'implementer')!
  assert.ok(impl.turns.length > 0)
  const turn = impl.turns[0]!
  // The reason this is one issue and not two: a record that reported `completed` without
  // saying how strongly it was evidenced is exactly the prose summary, in JSON.
  assert.equal(typeof turn.state, 'string')
  assert.ok('confidence' in turn, 'the grade travels with the verdict')
  assert.ok(Array.isArray(turn.tools))
})

test('the record is JSON-serialisable with no cycles or undefined-only keys', async () => {
  const { report } = await reportOf()
  const round = JSON.parse(JSON.stringify(report))
  assert.equal(round.schema, REPORT_SCHEMA)
  assert.equal(round.goal, report.goal)
  // Serialised and re-read, because a consumer never sees the object -- it sees the bytes.
  assert.deepEqual(round.rotation, report.rotation)
})

test('under --json nothing but the report may reach stdout', () => {
  // A structural check on the source, because the failure it guards is invisible at runtime
  // until a consumer chokes on a log line it did not expect. `config check --json` learned
  // this the same way: a stray line alongside valid JSON makes a machine-readable mode
  // useless, and the parse succeeds right up until it does not.
  //
  // Every human-facing line in the relay command goes through `say`, which writes to stderr
  // when --json is set. Only the report itself uses console.log.
  const cli = readFileSync(join(REPO, 'bin', 'conclave.ts'), 'utf8')
  const start = cli.indexOf("if (command === 'relay'")
  const end = cli.indexOf("if (command === 'session'")
  assert.ok(start > 0 && end > start, 'the relay command block must be locatable')
  const block = cli.slice(start, end)

  const stdoutWrites = block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('console.log('))
    // Two writes are legitimate and are named rather than counted around:
    //   - the `say` helper's own definition, which is what routes everything else
    //   - `--help`, which returns before a run starts and has no report to conflict with
    .filter((l) => !l.startsWith('const say ='))
    .filter((l) => !l.includes('console.log(USAGE)'))
    //   - `--detach`, whose entire product IS the session id on stdout, for
    //     `ID=$(conclave relay ... --detach)`. It returns before a run starts, so it can
    //     never collide with a report, and under --json it emits JSON like everything else.
    //     Named rather than allowed by pattern: "a bare value is fine" is how the next
    //     stray log line gets in.
    .filter((l) => l !== 'console.log(id)')

  // The invariant is not "one write" -- `--dry-run --json` legitimately emits a plan instead
  // of a report, and the two are mutually exclusive because dry-run returns before the run.
  // It is that NOTHING reaches stdout except serialised JSON.
  for (const line of stdoutWrites) {
    assert.match(
      line,
      /console\.log\(JSON\.stringify\(/,
      `stdout may carry only serialised JSON; found: ${line}`,
    )
  }
  assert.ok(
    stdoutWrites.some((l) => l.includes('runReport')),
    'and the report is one of them',
  )

  // The exception above is only safe while both halves hold: the id goes to stdout ALONE,
  // and --json takes the JSON path instead. Asserted here so the exemption cannot outlive
  // the reasoning for it.
  const detach = block.slice(block.indexOf("if (rest.includes('--detach')) {"))
  const detachEnd = detach.indexOf('\n    }\n')
  const detachBlock = detach.slice(0, detachEnd)
  assert.ok(detachBlock.includes('console.log(id)'), 'the detach block must be locatable')
  assert.ok(
    detachBlock.includes('console.log(JSON.stringify('),
    '--detach --json must emit JSON on stdout, not the bare id',
  )
  assert.ok(
    detachBlock.includes('console.error(`  detached as pid'),
    'everything a human reads about a detached run must go to stderr',
  )
})

test('a resumed relay tells both seats they are continuing (#34)', async () => {
  const dir = repo()
  const lead = new FakeRotationSession('advisor', 'codex', ['DONE'])
  const impl = new FakeRotationSession('impl', 'claude', ['a report'])
  const relay = await Relay.start({
    registry: registryOf({ codex: [lead], claude: [impl] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 2,
    resume: [
      {
        seq: 1,
        at: 1,
        from: 'implementer',
        fromRank: 'implementer',
        to: ['advisor'],
        kind: 'report',
        text: 'The harness is at rung2_measure_test.go; 12 implications found.',
        visibility: 'all',
        excluded: [],
      } as never,
    ],
  })
  await relay.run('finish the measurement')
  await relay.stop()

  // BOTH seats. An advisor that does not know what it already decided re-issues an
  // instruction the log shows as completed, which is the same waste from the other end.
  for (const [who, session] of [['implementer', impl], ['advisor', lead]] as const) {
    const first = session.received[0]!
    assert.match(first, /THIS RUN IS A CONTINUATION/, `${who} must be told it is resuming`)
    assert.match(first, /rung2_measure_test\.go/, `${who} must receive the prior log verbatim`)
  }
})

test('a turn ceiling ends the run with its own reason (#28)', async () => {
  const dir = repo()
  const relay = await Relay.start({
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['keep going', 'keep going', 'keep going'])],
      claude: [new FakeRotationSession('impl', 'claude', ['working', 'working', 'working'])],
    }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 20,
    ceilings: { maxTurns: 3 },
  })
  const outcome = await relay.run('a long goal')
  await relay.stop()

  // Its own reason, not `budget`. `budget` means the advisor turns ran out; this
  // means the run was still going and was stopped, and an operator deciding whether to
  // resume needs to know which happened.
  assert.equal(outcome.reason, 'ceiling')
  assert.match(outcome.detail ?? '', /turn ceiling reached/)
})

test('the default briefing is byte-identical when the operator is human (#27)', async () => {
  // A live experiment runs against the unmodified briefing, and its pre-registration says not
  // to change it mid-study (spikes/experiments/04-complaint-as-signal.md). The agent-operator
  // guidance is APPENDED for one case rather than edited into LEAD_BRIEFING, so the default
  // path stays exactly what the experiment measured.
  const dir = repo()
  const lead = new FakeRotationSession('advisor', 'codex', ['DONE'])
  const relay = await Relay.start({
    registry: registryOf({ codex: [lead], claude: [new FakeRotationSession('i', 'claude', ['r'])] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 2,
  })
  await relay.run('a goal')
  await relay.stop()

  assert.doesNotMatch(lead.received[0]!, /operator of this session is an AGENT/)
  assert.equal(relay.operator, 'human')
})

test('an agent operator is told what to escalate, and what not to', async () => {
  const dir = repo()
  const lead = new FakeRotationSession('advisor', 'codex', ['DONE'])
  const relay = await Relay.start({
    registry: registryOf({ codex: [lead], claude: [new FakeRotationSession('i', 'claude', ['r'])] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 2,
    operator: 'agent',
  })
  const outcome = await relay.run('a goal')
  const first = lead.received[0]!

  assert.match(first, /operator of this session is an AGENT/)
  // Not merely "ask more". An operator of the same kind as the participants shares their
  // blind spots, so permission questions add nothing and premise questions are the value.
  assert.match(first, /premise in the goal you suspect is wrong/)
  assert.match(first, /Do NOT escalate to ask permission/)
  // And the advisor is told the answer is not independent evidence.
  assert.match(first, /not independent confirmation/)

  // Recorded, because it changes what an escalation MEANS and the routing log cannot show it.
  const report = await runReport(relay, { goal: 'a goal', outcome, startedAt: Date.now(), build: BUILD })
  assert.equal(report.operator, 'agent')
  await relay.stop()
})

test('an advisor that produces no instruction never relays an empty message (#35)', async () => {
  // The minimum bar from the issue: there is no circumstance in which relaying nothing is
  // right. The implementer received a routing header with no body, asked for a resend, and
  // the run churned advisor turns toward its budget instead of failing with the real reason.
  //
  // The existing `turn_incomplete` guard covers the IMPLEMENTER only, which is why an
  // advisor whose turn errored went straight through it.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['a report'])
  const relay = await Relay.start({
    registry: registryOf({
      // No scripted replies: every advisor turn comes back empty, as an errored one does.
      codex: [new FakeRotationSession('advisor', 'codex', [])],
      claude: [impl],
    }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 4,
  })
  const outcome = await relay.run('a goal')
  await relay.stop()

  // Ends rather than churning advisor turns.
  assert.equal(outcome.reason, 'escalated')
  assert.match(outcome.detail ?? '', /produced no instruction/)
  // And the implementer was never handed an empty body.
  const relayed = relay.log.filter((m) => m.from === 'advisor' && m.to.includes('implementer'))
  assert.ok(
    relayed.every((m) => m.text.trim() !== ''),
    'no empty instruction may reach the implementer',
  )
})

test('the implementer gets a guaranteed last word when the advisor says DONE (#37)', async () => {
  // A run used to end on the advisor's verdict alone. In the first live four-agent run the
  // implementer ended its report with a direct question -- "if you intended something else,
  // tell me what the expected behaviour should be" -- the advisor replied DONE, and the run
  // reported unqualified success with the question unanswered and unrecorded.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', [
    'Done, but I did not change anything because nothing was wrong.',
    'FLAG: the premise in the goal was false; add() already returned a + b.',
  ])
  const relay = await Relay.start({
    registry: registryOf({ codex: [new FakeRotationSession('advisor', 'codex', ['DONE'])], claude: [impl] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 3,
  })
  const outcome = await relay.run('a goal with a false premise')
  const report = await runReport(relay, { goal: 'g', outcome, startedAt: Date.now(), build: BUILD })
  await relay.stop()

  assert.match(impl.received.at(-1)!, /is anything unresolved, unverified, or unanswered/)
  assert.equal(outcome.reason, 'done', 'it does not reopen the work')
  assert.equal(report.flags.length, 1)
  assert.match(report.flags[0]!.text, /premise in the goal was false/)
})

test('an unstructured closing answer is carried anyway (#38)', async () => {
  // The FLAG: convention was not used by the one real participant that had something to
  // flag -- it wrote prose. Discarding an answer for lacking a prefix would repeat exactly
  // the failure this exists to fix.
  const dir = repo()
  const relay = await Relay.start({
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['DONE'])],
      claude: [new FakeRotationSession('impl', 'claude', ['done', 'I never ran the conformance script.'])],
    }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 3,
  })
  const outcome = await relay.run('a goal')
  const report = await runReport(relay, { goal: 'g', outcome, startedAt: Date.now(), build: BUILD })
  await relay.stop()

  assert.equal(report.flags.length, 1)
  assert.match(report.flags[0]!.text, /never ran the conformance script/)
})

test('NONE means nothing outstanding, and adds no noise', async () => {
  // The line must not appear on a clean run, or it trains the reader to skip the exact place
  // a real flag shows up.
  const dir = repo()
  const relay = await Relay.start({
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['DONE'])],
      claude: [new FakeRotationSession('impl', 'claude', ['done', 'NONE'])],
    }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 3,
  })
  const outcome = await relay.run('a goal')
  const report = await runReport(relay, { goal: 'g', outcome, startedAt: Date.now(), build: BUILD })
  await relay.stop()

  assert.deepEqual(report.flags, [])
  assert.deepEqual(relay.flagSummary(), [])
})

test('an advisor NOTE reaches the human without halting or reaching the implementer (#1)', async () => {
  // The advisor had two options and neither was this: fold the finding into the next
  // instruction, polluting it with something the implementer does not need, or ESCALATE,
  // which stops the run to say it. A finding worth recording but not worth stopping for died
  // with the turn.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['did it', 'NONE'])
  const relay = await Relay.start({
    registry: registryOf({
      codex: [
        new FakeRotationSession('advisor', 'codex', [
          'NOTE: the goal assumes a bug that may not exist; proceeding to check rather than fix.\nRead calc.py and report what add() does.',
          'DONE',
        ]),
      ],
      claude: [impl],
    }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 3,
  })
  const outcome = await relay.run('a goal')
  await relay.stop()

  // Non-halting: the run carried on to its normal end.
  assert.equal(outcome.reason, 'done')

  // Recorded for the operator, addressed to nobody.
  const note = relay.log.find((m) => m.from === 'advisor' && m.kind === 'note' && /may not exist/.test(m.text))
  assert.ok(note, 'the note is in the routing log')
  assert.deepEqual(note!.to, [], 'addressed to the operator, not to a participant')

  // And stripped from what the implementer received, which is the whole point.
  const sent = impl.received.join('\n')
  assert.match(sent, /Read calc\.py/, 'the instruction still arrived')
  assert.doesNotMatch(sent, /may not exist/, 'the note did not')
})

test('a reply that is ONLY a note is not treated as an instruction', async () => {
  // Otherwise stripping the note leaves an empty instruction, which the #35 guard would
  // correctly refuse -- ending a run because the advisor said something useful.
  const { splitNotes } = await import('./relay.ts')
  const { notes, rest } = splitNotes('NOTE: just so you know.')
  assert.deepEqual(notes, ['just so you know.'])
  assert.equal(rest, '', 'the caller sees an empty instruction and handles it as one')
})

test('a note-only reply is asked again rather than ending the run (#1)', async () => {
  // Stripping a note can leave an empty instruction, which the #35 guard correctly refuses.
  // Halting there would end a run BECAUSE the advisor said something useful, so it is asked
  // once for the instruction that goes with the note.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['did it', 'NONE'])
  const relay = await Relay.start({
    registry: registryOf({
      codex: [
        new FakeRotationSession('advisor', 'codex', [
          'NOTE: the premise looks wrong to me.',
          'Read calc.py and report what add() does.',
          'DONE',
        ]),
      ],
      claude: [impl],
    }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 3,
  })
  const outcome = await relay.run('a goal')
  await relay.stop()

  assert.equal(outcome.reason, 'done', 'the run was not ended by a useful note')
  assert.ok(relay.log.some((m) => m.kind === 'note' && /premise looks wrong/.test(m.text)))
  assert.match(impl.received.join('\n'), /Read calc\.py/, 'and the instruction still arrived')
})

test('a dead implementer does not turn a completed run into a transport failure (#5 review)', async () => {
  // The closing question runs AFTER the advisor's DONE is recorded. If the implementer's
  // session is gone, `send` throws, `#loop`'s catch converts an already-completed run into
  // `transport_failed`, and the log contradicts itself -- `advisor reports the work complete`
  // is already in it.
  //
  // A closing question is worth one turn, never a verdict.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['did the work'])
  const relay = await Relay.start({
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['DONE'])],
      claude: [impl],
    }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 3,
  })
  // Every send after the first throws, as a dead pty does.
  impl.failSendOnTurn = 1

  const outcome = await relay.run('a goal')
  await relay.stop()

  assert.equal(outcome.reason, 'done', 'the advisor said DONE and that stands')
  assert.notEqual(outcome.reason, 'transport_failed')
})
