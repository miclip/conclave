/**
 * Whether the advisor used the assignment syntax, measured on a real run (#79).
 *
 * The claim under test is not that `parseDecisions` can read `@seat` — `assignmentSyntax.test.ts`
 * has that — but that a RUN can afterwards be asked whether the advisor ever wrote it. That
 * question had no answer at all before this: an unaddressed reply and an `@role`-addressed one
 * are identical at the parser's own output, so nothing in the routing log, the run report, the
 * status document or the resumable log could tell them apart, and an advisor that never learned
 * the syntax left the same record as one that deliberately worked one seat at a time.
 *
 * So every case here drives a real `Relay` with scripted advisors and reads the production
 * surfaces: the counters, the routing log an operator scrolls, the report `runReport` assembles
 * and the document `recordSession` writes for `conclave status --json`. Each case is a reading
 * the instrument has to be able to distinguish from the others:
 *
 *   - one that ADDRESSES every turn — the briefing worked;
 *   - one that NEVER does — the finding, and it must be legible as one rather than inferred
 *     from a seat that looks idle;
 *   - one that addresses SOME turns — the counters must split rather than round to a verdict;
 *   - one that addresses a seat and is REFUSED by the parser — the briefing worked and the
 *     reply was wrong, which is a different finding from the one above and needs the opposite
 *     repair;
 *   - one whose VALID addressed batch a run ceiling refuses whole — the briefing worked, the
 *     reply was right, and the run had no room. The repair is the ceiling, and this was the
 *     last case the instrument lost entirely: the ceiling check exits the advisor loop, so
 *     everything below it, recorder included, went unreached;
 *   - one that addresses a seat on a turn that DOES NOT COMPLETE — evidence of a different
 *     KIND, which must be recorded and must NOT be resolved. Not elicitation, because a reply
 *     cut off mid-directive may not be the form it looks like; not under-use either. A run with
 *     nothing but this reads INCONCLUSIVE, in the summary and in the live status line;
 *   - one whose addressed turn TIMED OUT and was then withdrawn and replaced with `completed` —
 *     which is not an incomplete turn at all, and was being filed as one because the advisor
 *     path read its verdict without resolving supersession the way the implementer path does.
 *     Both arrival orders are driven: the replacement landing BEFORE the guard, where the turn
 *     simply dispatches, and DURING the pause, where the dispatch decision has already been
 *     taken and only the record can still be made to agree with the adapter's last word;
 *   - one whose reply named NOBODY and dispatched nothing — empty, or a whole valid batch a
 *     ceiling refused. These are in the DENOMINATOR, because the advisor was asked for an
 *     instruction and spent a turn on it, and credited to no conclusion, because nothing here
 *     wrote the syntax and nothing went out by fallback either;
 *
 *     Those are the readings the instrument used to get backwards. Recording happened only
 *     after validation and queue admission, so a turn that used the syntax and then failed —
 *     any of these ways — was recorded as nothing, and a run whose advisor targeted every turn
 *     could report that none of them had. Each is driven here, alone and mixed with turns that
 *     did dispatch.
 *
 *   - a ONE-SEAT run — which must report nothing about targeting ANYWHERE: no counter, no
 *     note, no summary line, and no key in either document, because it had no seat to name and
 *     its advisor was never given the syntax.
 *
 * And one case that is about the SURFACES rather than about a reading: all four of them — the
 * run report, the console summary, the relay summary and the live status line — must render one
 * conclusion, AND none of them may quote an uncertain turn as usage. They used to each decide,
 * and they disagreed; and both prose surfaces then counted truncated turns into `N used
 * @seat/@role without dispatching` and certified the briefing off that total, which is the
 * exclusion `targetingElicited` makes being undone in the sentence beside it. Driven on
 * truncated-only, dispatched-plus-refused and dispatched-plus-incomplete evidence. The console's
 * own rendering is pinned in src/repl/session.test.ts, which is where a console assertion
 * belongs.
 *
 *   node --test src/relay/targetingWatch.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { listSessions, newSessionId, readSession, recordSession } from '../workspace/sessionRecord.ts'
import { formatSession, formatSessionJson } from '../workspace/sessionView.ts'
import { Relay } from './relay.ts'
import type { Ceilings } from './guardrails.ts'
import { runReport } from './report.ts'
import {
  reportedTargeting,
  targetingElicited,
  targetingReading,
  targetingStatusLine,
  targetingSummary,
  targetingTurns,
} from './targeting.ts'
import type { RelayMessage } from './message.ts'

/** One agent per fake session, as `implementerSeats.test.ts` builds one. */
function registryOf(sessions: Record<string, FakeRotationSession>): AgentRegistry {
  const r = new AgentRegistry()
  for (const [agent, session] of Object.entries(sessions)) {
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
        return session
      },
    })
  }
  return r
}

/** A repository to run in: the lock samples `git status`, and the relay lists worktrees. */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-targeting-'))
  execFileSync('git', ['init', '--quiet'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'README.md'), '# hello')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: dir })
  return dir
}

/** The orchestrator notes this instrument writes, and nothing else from the log. */
function unaddressedNotes(log: readonly RelayMessage[]): string[] {
  return log.filter((m) => m.from === 'orchestrator' && /named no seat/.test(m.text)).map((m) => m.text)
}

/**
 * A two-seat run whose advisor says exactly this, then DONE.
 *
 * Both seats are scripted with enough replies to answer whatever they are given plus the
 * closing question, so which seat a turn lands on never decides whether the run completes --
 * this file is about what the ADVISOR wrote, and a fixture that starved a seat would fail for
 * a reason that has nothing to do with targeting.
 */
async function twoSeatRun(
  repo: string,
  advisorReplies: string[],
  /**
   * Reach the advisor's session before the run starts, so a test can script HOW a turn ends and
   * not only what it says. Only the timed-out case needs it; everything else ends `completed`.
   */
  scriptLead?: (lead: FakeRotationSession) => void,
  /**
   * Ceilings for the run, so a test can drive the batch-sized queue projection that refuses a
   * whole valid reply. Absent everywhere else: an unbounded run is what every other case here
   * is about, and a ceiling nobody asked for would end runs for reasons unrelated to targeting.
   */
  ceilings?: Ceilings,
): Promise<{ relay: Relay; outcome: Awaited<ReturnType<Relay['run']>> }> {
  const spare = (): string[] => ['ack', ...Array.from({ length: 8 }, () => 'Did it.'), 'NONE']
  // DONE repeated, not once: a DONE issued while a seat is still working does not end the run --
  // the outstanding report is handed over first and the advisor is asked again -- so a script
  // with one would run out of replies and end the run on an empty instruction instead. Every
  // one of these is a `done` decision and none of them is counted, which is itself the point.
  const script = [...advisorReplies, ...Array.from({ length: 6 }, () => 'DONE')]
  const lead = new FakeRotationSession('lead-1', 'lead', script)
  scriptLead?.(lead)
  const relay = await Relay.start({
    registry: registryOf({
      lead,
      alpha: new FakeRotationSession('alpha-1', 'alpha', spare()),
      beta: new FakeRotationSession('beta-1', 'beta', spare()),
    }),
    cwd: repo,
    lead: { id: 'advisor', agent: 'lead', role: 'advisor' },
    implementer: { id: 'seat-alpha', agent: 'alpha', role: 'implementer' },
    implementers: [
      { id: 'seat-alpha', agent: 'alpha', role: 'implementer' },
      { id: 'seat-beta', agent: 'beta', role: 'implementer' },
    ],
    maxAdvisorTurns: script.length + 2,
    ...(ceilings === undefined ? {} : { ceilings }),
  })
  const outcome = await relay.run('Keep the work moving.')
  return { relay, outcome }
}

test('an advisor that addresses every turn is counted as having done so, and named seats are recorded', async () => {
  const repo = tempRepo()
  const { relay, outcome } = await twoSeatRun(repo, [
    '@seat seat-alpha: Add the parser tests.\n@seat seat-beta: Sweep the docs.',
    '@role implementer: Run the suite and report what fails.',
  ])
  try {
    assert.equal(outcome.reason, 'done')
    assert.equal(relay.targetingWatch.applicable, true, 'two implementer seats is what makes addressing possible at all')
    assert.equal(relay.targetingWatch.seats, 2)
    const w = targetingReading(relay.targetingWatch).counts
    assert.equal(w.addressedTurns, 2, 'both instructing turns used the syntax')
    assert.equal(w.unaddressedTurns, 0)
    // Which seats, per turn, in the order the advisor wrote them. This is the half of the
    // question a bare count cannot answer: an advisor that addresses one seat nine times has
    // used the syntax and still never parallelised, and a blocked seat is unblocked only by
    // being NAMED.
    assert.deepEqual(
      relay.targetingRecords().map((r) => ({ addressed: r.addressed, targets: r.targets, outcome: r.outcome })),
      [
        { addressed: true, targets: ['@seat seat-alpha', '@seat seat-beta'], outcome: 'admitted' },
        { addressed: true, targets: ['@role implementer'], outcome: 'admitted' },
      ],
      'the record must say what each turn named, not merely that it named something',
    )
    // `@role implementer` is the case that proves the form comes from the parser. Its resulting
    // TaskTarget is byte-identical to the fallback an unaddressed reply produces, so a relay
    // deriving `addressed` from the target would have called this turn unaddressed.
    assert.deepEqual(unaddressedNotes(relay.log), [], 'an addressed reply must produce no note')
    assert.match(
      relay.targetingSummary() ?? '',
      /2 of 2 instructing turns addressed a seat/,
      'the operator line must report the run that worked as plainly as the one that did not',
    )
    assert.match(relay.targetingSummary() ?? '', /@seat seat-alpha \(1\), @seat seat-beta \(1\), @role implementer \(1\)/)
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('an advisor that never addresses a seat is the finding, and the run says so in the log, the counters and the report', async () => {
  const repo = tempRepo()
  const { relay, outcome } = await twoSeatRun(repo, [
    'Add the parser tests.',
    'Now sweep the docs for the old flag name.',
    'Run the suite and report what fails.',
  ])
  try {
    assert.equal(outcome.reason, 'done', 'the run still works — under-use is not a failure, it is a finding')
    const w = targetingReading(relay.targetingWatch).counts
    assert.equal(w.addressedTurns, 0)
    assert.equal(w.unaddressedTurns, 3, 'every instructing turn named nobody')
    assert.deepEqual(
      relay.targetingRecords().map((r) => r.targets),
      [[], [], []],
      'an unaddressed turn names nothing, and the record must not invent the seat it landed on',
    )

    // The live half: an operator scrolling the run sees it at the turn it happened, not only in
    // a summary an hour later. Once per unaddressed turn, and it says what the consequence is --
    // a note that only said "no @seat" would leave the reader to know why that matters.
    const notes = unaddressedNotes(relay.log)
    assert.equal(notes.length, 3, 'one note per unaddressed turn')
    assert.match(notes[0]!, /fallback routing to @role implementer/)
    assert.match(notes[0]!, /2 implementer seats/)
    assert.match(notes[0]!, /takes only the repair addressed to it BY NAME/)

    // The summary line, which is what anyone actually reads. It has to name the finding rather
    // than leave `0 of 3` for the reader to interpret.
    const line = relay.targetingSummary() ?? ''
    assert.match(line, /NONE of 3 instructing turns used @seat\/@role/)
    assert.match(line, /never dispatched concurrently and a blocked seat could not have been repaired/)
    // NONE is reachable only because nothing was refused either. A run with a refused turn takes
    // the other branch, because "the advisor never wrote it" would be false there.
    assert.equal(w.invalidTurns, 0, 'no turn used the syntax at all, which is what makes NONE literally true')

    // And it survives into the record, which is the point: the finding must be readable from a
    // finished run by someone who was not there.
    const report = await runReport(relay, {
      goal: 'Keep the work moving.',
      outcome,
      startedAt: Date.now(),
      build: 'test',
    })
    assert.ok(report.targeting, 'a multi-seat run carries the block')
    assert.deepEqual(
      { ...report.targeting, records: report.targeting.records.length },
      {
        applicable: true,
        seats: 2,
        addressedTurns: 0,
        unaddressedTurns: 3,
        invalidTurns: 0,
        ceilingTurns: 0,
        incompleteTurns: 0,
        unadmittedTurns: 0,
        withdrawnTurns: 0,
        unaddressedFailedTurns: 0,
        conclusion: 'none',
        records: 3,
      },
      'the run report must carry the counters, not a rendering of them',
    )
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('an advisor that addresses some turns and not others is counted both ways, in order', async () => {
  const repo = tempRepo()
  const { relay, outcome } = await twoSeatRun(repo, [
    '@seat seat-beta: Sweep the docs.',
    'Add the parser tests.',
    '@seat seat-alpha: Run the suite.',
    'Report what fails.',
  ])
  try {
    assert.equal(outcome.reason, 'done')
    const w = targetingReading(relay.targetingWatch).counts
    assert.equal(w.addressedTurns, 2)
    assert.equal(w.unaddressedTurns, 2)
    assert.deepEqual(
      relay.targetingRecords().map((r) => r.addressed),
      [true, false, true, false],
      'the records are per turn and in turn order, so a reader can see WHEN the advisor stopped',
    )
    // Each record is keyed to the advisor turn it came from, by the RUN's numbering: four
    // replies processed on the loop's first four passes are turns 1 to 4, which is the same
    // numbering `maxAdvisorTurns` bounds and a pause quotes. A counter alone cannot be joined
    // to anything; these can be read against the routing log, the ceiling and a seat's state at
    // the time. See `TargetingRecord.turn`, and the note-only case below it for why the
    // advisor session's own sequence is a different number.
    assert.deepEqual(
      relay.targetingRecords().map((r) => r.turn),
      [1, 2, 3, 4],
      'the keys are the run\'s advisor turns, distinct and in the order they happened',
    )

    assert.equal(unaddressedNotes(relay.log).length, 2, 'a note for the unaddressed turns and only those')
    const line = relay.targetingSummary() ?? ''
    assert.match(line, /2 of 4 instructing turns addressed a seat \(2 named nobody/)
    assert.doesNotMatch(line, /NONE/, 'a run that used the syntax twice is not the never-addressed finding')
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a record is keyed to the run\'s advisor turn, not to the advisor session\'s own sequence', async () => {
  const repo = tempRepo()
  // A reply that is ONLY a NOTE is not a failure to instruct -- the advisor is asked once more,
  // inside the same pass of the advisor loop. That re-ask spends a turn of the advisor's CHILD
  // and no turn of the RUN, so from here on the session's `TurnEndEvent.seq` runs permanently
  // ahead of the advisor-turn number every other operator-facing surface uses: the ceiling's
  // bound, the "advisor turn 3 of 8" a pause quotes, the budget an operator raised.
  //
  // The re-ask is only the clearest of several. The advisor's child also takes a turn for the
  // opening briefing and one for every report routed to it, none of which advance the loop, so
  // the seq does not merely start one ahead -- it drifts, and by the fourth instruction of the
  // alternating run above it is off by four. A reader joining `turn` against "advisor turn 6 of
  // 8" would be reading a different turn entirely, which is what makes this an audit flaw and
  // not a cosmetic one. Both assertions here fail if the key goes back to the seq.
  //
  // It is also the wrong KIND of key regardless of the numbers: it belongs to a session, and a
  // session can be replaced -- today only for an implementer seat, because
  // `#rotateSeatDeclaring` refuses any other rank, but a key whose uniqueness rests on a
  // refusal made elsewhere is not unique on its own account.
  const { relay, outcome } = await twoSeatRun(repo, [
    'NOTE: the goal says nothing about the migration, so I am leaving it alone.',
    '@seat seat-alpha: Add the parser tests.',
    'Sweep the docs for the old flag name.',
  ])
  try {
    assert.equal(outcome.reason, 'done')
    assert.deepEqual(
      relay.targetingRecords().map((r) => ({ turn: r.turn, addressed: r.addressed })),
      [
        { turn: 1, addressed: true },
        { turn: 2, addressed: false },
      ],
      'the note cost the advisor a child turn and the run no advisor turn, and the key follows the run',
    )
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a reply that named a seat the run does not have is counted as having USED the syntax, not as silence', async () => {
  const repo = tempRepo()
  // The correction this test used to enshrine. It previously asserted that a refused reply is
  // recorded as NOTHING, on the reasoning that it assigned no work -- which is true and is the
  // wrong question. `@seat nobody-here:` is positive evidence that the briefing ELICITED the
  // syntax, with a bad target, and the parser knows the reply is in addressed form before it
  // validates anything. Recording only after validation threw that away, and the run could then
  // report `NONE of N instructing turns used @seat/@role` about an advisor that used it every
  // turn. That is the instrument stating the opposite of what happened, in the one direction
  // that misleads: "rewrite the briefing" and "fix the seat names in it" are opposite repairs.
  //
  // The refusal itself is unchanged and that is asserted too: nothing is queued, and the run
  // still ends on the halt because there is nobody to answer it.
  const { relay, outcome } = await twoSeatRun(repo, [
    '@seat seat-alpha: Add the parser tests.',
    '@seat nobody-here: Sweep the docs.',
  ])
  try {
    assert.equal(outcome.reason, 'escalated', 'the parser still fails closed; a refusal with nobody to answer ends the run')
    const w = targetingReading(relay.targetingWatch).counts
    assert.equal(w.addressedTurns, 1, 'one turn addressed a seat AND dispatched')
    assert.equal(w.invalidTurns, 1, 'and one addressed a seat and was refused — the count that did not exist')
    assert.equal(w.unaddressedTurns, 0, 'a refused reply is still not an unaddressed one; it named somebody')
    // The record, whole. `targets` carries the name AS WRITTEN -- it is not a seat of this run,
    // which is the point: an operator deciding between the two repairs has to read the name the
    // advisor reached for, and `refusal` says which rule rejected it.
    assert.deepEqual(relay.targetingRecords(), [
      { turn: 1, addressed: true, targets: ['@seat seat-alpha'], outcome: 'admitted' },
      { turn: 2, addressed: true, targets: ['@seat nobody-here'], outcome: 'invalid', refusal: 'unknown_target' },
    ])
    assert.deepEqual(unaddressedNotes(relay.log), [], 'neither turn named nobody, so neither gets that note')

    // The live half, beside the refusal it explains. The existing `produced no instruction` note
    // is true and says nothing about the advisor having tried to address a seat, which is the
    // part that decides what to fix.
    const refusedNotes = relay.log.filter((m) => m.from === 'orchestrator' && /DID use @seat/.test(m.text))
    assert.equal(refusedNotes.length, 1)
    assert.match(refusedNotes[0]!.text, /it named @seat nobody-here/)
    assert.match(refusedNotes[0]!.text, /refused before dispatch \(unknown_target: no seat named nobody-here\)/)
    assert.match(refusedNotes[0]!.text, /the repair is the target it named or the form of the reply/)

    // The summary keeps the two apart on a run where some turns DID dispatch by name: `1 of 2`
    // alone would leave the refused turn looking like a turn that never happened.
    const line = relay.targetingSummary() ?? ''
    assert.match(line, /1 of 2 instructing turns addressed a seat/)
    assert.match(
      line,
      /1 further turn used @seat\/@role without dispatching \[refused by the parser — turn 2: unknown_target \(@seat nobody-here\)\]/,
    )

    const report = await runReport(relay, {
      goal: 'Keep the work moving.',
      outcome,
      startedAt: Date.now(),
      build: 'test',
    })
    assert.deepEqual(report.targeting?.records[1], {
      turn: 2,
      addressed: true,
      targets: ['@seat nobody-here'],
      outcome: 'invalid',
      refusal: 'unknown_target',
    })
    assert.equal(report.targeting?.invalidTurns, 1, 'and it survives into the record a reader has afterwards')
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a run whose every targeted turn was refused reports the briefing as WORKING, never as NONE', async () => {
  const repo = tempRepo()
  // The reading the whole correction is for, and the one the summary got backwards. Here the
  // advisor addresses a seat on its only instructing turn and the reply is refused for a reason
  // that is not the target at all -- a preamble outside every directive (`stray_prose`), the
  // half-addressed form. `addressedTurns` is 0, exactly as it is on a run whose advisor never
  // wrote the syntax, and the two runs need opposite responses.
  //
  // `stray_prose` also proves `named` is preserved when the failure is NOT about the target: the
  // seat it addressed is real and the reply still failed, so what the record carries is what the
  // advisor asked for rather than what survived validation.
  const { relay, outcome } = await twoSeatRun(repo, [
    'Here is the plan for this round.\n@seat seat-alpha: Add the parser tests.',
  ])
  try {
    assert.equal(outcome.reason, 'escalated')
    const w = targetingReading(relay.targetingWatch).counts
    assert.equal(w.addressedTurns, 0)
    assert.equal(w.unaddressedTurns, 0)
    assert.equal(w.invalidTurns, 1)
    assert.deepEqual(relay.targetingRecords(), [
      { turn: 1, addressed: true, targets: ['@seat seat-alpha'], outcome: 'invalid', refusal: 'stray_prose' },
    ])

    const line = relay.targetingSummary() ?? ''
    assert.match(line, /the briefing ELICITED @seat\/@role — 1 of 1 instructing turn wrote it/)
    assert.match(line, /not one of them dispatched \[refused by the parser — turn 1: stray_prose \(@seat seat-alpha\)\]/)
    assert.match(line, /a briefing rewrite is not what this run is asking for/)
    // The two wordings this run must never produce. Both were reachable before: the summary read
    // `addressedTurns === 0` as "the advisor never used the syntax", and a run refused on its
    // first turn had `addressedTurns + unaddressedTurns === 0` and read as "nothing was measured".
    // A bare token, and it stays bare: NONE is reserved for the one reading "the advisor never
    // wrote the syntax", so no other branch may contain the word at all.
    assert.doesNotMatch(line, /NONE/, 'the advisor used the syntax; saying NONE sends a reader to rewrite a working briefing')
    assert.doesNotMatch(line, /nothing was measured/, 'a refused turn IS a measurement of the briefing')

    // And in the record, where someone who was not there reads it.
    const report = await runReport(relay, {
      goal: 'Keep the work moving.',
      outcome,
      startedAt: Date.now(),
      build: 'test',
    })
    assert.deepEqual(
      { ...report.targeting, records: report.targeting?.records.length },
      {
        applicable: true,
        seats: 2,
        addressedTurns: 0,
        unaddressedTurns: 0,
        invalidTurns: 1,
        ceilingTurns: 0,
        incompleteTurns: 0,
        unadmittedTurns: 0,
        withdrawnTurns: 0,
        unaddressedFailedTurns: 0,
        conclusion: 'elicited',
        records: 1,
      },
    )

    // And the prose an operator at a terminal reads. Its gate used to be
    // `addressed + unaddressed > 0`, which is 0 here -- so a run whose every turn was targeted
    // and refused printed no targeting line at all, and the one reading that most needs saying
    // was the one reading with no line. Now it prints, and it says the syntax IS arriving rather
    // than "NONE addressed".
    const id = newSessionId(Date.now(), process.pid)
    const recording = recordSession(relay, {
      repoRoot: repo,
      id,
      goal: 'Keep the work moving.',
      front: 'relay',
      startedAt: Date.now(),
      build: 'test',
    })
    try {
      recording.set('ended', { outcome })
      await recording.refresh()
      const prose = formatSession(readSession(repo, id)!, Date.now())
      assert.match(prose, /targeting: 0 of 1 instructing turns named a seat \(@seat\/@role\), 2 implementer seats/)
      assert.match(prose, /1 used @seat\/@role without dispatching \(1 refused\), so the syntax IS reaching the advisor/)
      assert.doesNotMatch(prose, /NONE addressed/)
    } finally {
      await recording.close()
    }
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a targeted reply on a turn that TIMED OUT is recorded, and the run reads INCONCLUSIVE — not elicited, not NONE', async () => {
  const repo = tempRepo()
  // The exclusion this instrument used to make, and it was the same false negative in a
  // different coat. A turn that dies holding an `@seat` line is weaker evidence -- the reply may
  // have been cut between the directive and its body -- but a run whose advisor targets every
  // turn and finishes none would report `NONE used @seat/@role` if the weak evidence were
  // dropped, which is exactly the reading #79 exists to prevent. So it is counted, as its OWN
  // outcome, carrying the verdict that ended it.
  //
  // And then NOT resolved in the other direction either, which is the correction after that
  // one. Counting a truncated turn as elicitation certifies a briefing on text nobody read to
  // the end: the reply may have been cut between `@seat` and the body, so the form it appears
  // to be in is partly an artefact of where it stopped. `ELICITED` there would be the mirror of
  // the failure this whole instrument exists to prevent, and just as wrong. So this run is
  // INCONCLUSIVE -- it resolves nothing, in either direction, and says so in that word.
  //
  // Turn index 0: the advisor's opening exchange IS its first instructing reply -- the briefing
  // asks for one -- so the reply the advisor loop reads on its first pass is the child's turn 0.
  const { relay, outcome } = await twoSeatRun(
    repo,
    ['@seat seat-beta: Sweep the docs for the old flag name.'],
    (lead) => {
      lead.endTurn = {
        index: 0,
        verdict: {
          outcome: 'timed_out',
          confidence: 'uncertain',
          provenance: [{ source: 'orchestrator', detail: 'past the watchdog with no Stop' }],
        },
      }
    },
  )
  try {
    // Dispatch is untouched: a bad verdict still halts, and unattended the halt still ends the
    // run. The instrument observes it; it does not adjudicate it.
    assert.notEqual(outcome.reason, 'done', 'a turn that did not complete still ends the run unattended')
    const w = targetingReading(relay.targetingWatch).counts
    assert.equal(w.addressedTurns, 0, 'nothing dispatched: the turn never produced an admitted instruction')
    assert.equal(w.invalidTurns, 0, 'and this is not a parse refusal — the reply itself was fine')
    assert.equal(w.incompleteTurns, 1)
    assert.equal(w.unaddressedTurns, 0)
    // The verdict is on the record, because it is what tells a reader how far to trust it.
    assert.deepEqual(relay.targetingRecords(), [
      { turn: 1, addressed: true, targets: ['@seat seat-beta'], outcome: 'incomplete', verdict: 'timed_out' },
    ])

    const notes = relay.log.filter((m) => m.from === 'orchestrator' && /DID use @seat/.test(m.text))
    assert.equal(notes.length, 1)
    assert.match(notes[0]!.text, /it named @seat seat-beta — and its turn ended timed_out/)
    assert.match(notes[0]!.text, /Read it as UNCERTAIN and as evidence of NEITHER kind/)
    assert.match(notes[0]!.text, /does not count as the briefing having elicited the syntax/)
    assert.match(notes[0]!.text, /does not count against the briefing either/)

    // The summary must not report this run as a briefing that failed, and must not report it as
    // a measurement that succeeded. Both are conclusions, and this run supports neither.
    const line = relay.targetingSummary() ?? ''
    assert.match(line, /INCONCLUSIVE — 1 of 1 instructing turn appears to have written @seat\/@role/)
    assert.match(line, /on a turn that did not complete — turn 1: timed_out \(@seat seat-beta\)/)
    assert.match(line, /an UNCERTAIN reading held OUTSIDE the elicited count/)
    assert.match(line, /evidence NEITHER that the briefing works NOR that it does not/)
    // The three wordings this reading must never produce, each reserved for a conclusion this
    // run has not earned: NONE for "the advisor never wrote it", ELICITED for "it demonstrably
    // did", and "nothing was measured" for a run that never instructed at all.
    assert.doesNotMatch(line, /NONE/)
    assert.doesNotMatch(line, /ELICITED/)
    assert.doesNotMatch(line, /nothing was measured/)
    assert.doesNotMatch(line, /IS reaching the advisor/)
    // The counter behind it: a truncated turn is in the denominator (a turn WAS spent trying to
    // instruct) and out of the elicited numerator (what it wrote is not established).
    assert.equal(targetingElicited(w), 0, 'a truncated reply certifies nothing')
    assert.equal(targetingTurns(w), 1, 'and the turn still happened')

    const report = await runReport(relay, {
      goal: 'Keep the work moving.',
      outcome,
      startedAt: Date.now(),
      build: 'test',
    })
    assert.deepEqual(report.targeting, {
      applicable: true,
      seats: 2,
      addressedTurns: 0,
      unaddressedTurns: 0,
      invalidTurns: 0,
      ceilingTurns: 0,
      incompleteTurns: 1,
      unadmittedTurns: 0,
      withdrawnTurns: 0,
      unaddressedFailedTurns: 0,
      conclusion: 'inconclusive',
      records: [
        { turn: 1, addressed: true, targets: ['@seat seat-beta'], outcome: 'incomplete', verdict: 'timed_out' },
      ],
    })

    // And the LIVE line, which is where an operator decides whether to intervene. Its tail was
    // gated on "anything undispatched" and said the syntax IS reaching the advisor -- a
    // certification, printed on the strength of a reply nobody read to the end. An operator
    // told that mid-run stops looking at the briefing.
    const id = newSessionId(Date.now(), process.pid)
    const recording = recordSession(relay, {
      repoRoot: repo,
      id,
      goal: 'Keep the work moving.',
      front: 'relay',
      startedAt: Date.now(),
      build: 'test',
    })
    try {
      recording.set('ended', { outcome })
      await recording.refresh()
      const prose = formatSession(readSession(repo, id)!, Date.now())
      assert.match(
        prose,
        /targeting: 0 of 1 instructing turns named a seat \(@seat\/@role\), 2 implementer seats — INCONCLUSIVE: 1 wrote @seat\/@role only on turns that never reached a settled readable end \(1 on a turn that did not complete\)/,
      )
      assert.doesNotMatch(prose, /IS reaching the advisor/)
      assert.doesNotMatch(prose, /NONE addressed/)
    } finally {
      await recording.close()
    }
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a run that dispatched by name AND lost a targeted turn reports both, in the line and the prose', async () => {
  const repo = tempRepo()
  // The mixed reading, which is the common one on a real run: the advisor is using the syntax,
  // most of it lands, and one turn dies holding it. The leading count must stay what it was --
  // one turn really did dispatch by name -- and the lost turn must be a tail rather than a
  // silence, or `1 of 2` reads as though the second turn never happened.
  const { relay, outcome } = await twoSeatRun(
    repo,
    ['@seat seat-alpha: Add the parser tests.', '@seat seat-beta: Sweep the docs.'],
    (lead) => {
      lead.endTurn = {
        index: 1,
        verdict: {
          outcome: 'transport_lost',
          confidence: 'uncertain',
          provenance: [{ source: 'orchestrator', detail: 'the child stopped answering' }],
        },
      }
    },
  )
  try {
    const w = targetingReading(relay.targetingWatch).counts
    assert.equal(w.addressedTurns, 1)
    assert.equal(w.incompleteTurns, 1)
    assert.equal(w.invalidTurns, 0)
    assert.deepEqual(
      relay.targetingRecords().map((r) => ({ outcome: r.outcome, verdict: r.verdict })),
      [
        { outcome: 'admitted', verdict: undefined },
        { outcome: 'incomplete', verdict: 'transport_lost' },
      ],
    )
    const line = relay.targetingSummary() ?? ''
    assert.match(line, /1 of 2 instructing turns addressed a seat/)
    // The truncated turn is reported and is NOT reported as usage. It used to be counted into
    // `1 further turn used @seat/@role without dispatching`, which is the elicited count being
    // smuggled back into the prose after the arithmetic had been taught to exclude it: the
    // sentence claimed of a cut-off reply exactly what `targetingElicited` refuses to claim, and
    // the sentence is the half that gets read.
    assert.match(
      line,
      /1 turn settled nothing either way \[appeared to name a seat on a turn that did not complete — turn 2: transport_lost \(@seat seat-beta\)/,
    )
    assert.doesNotMatch(
      line,
      /1 further turn used @seat\/@role/,
      'a reply nobody read to the end is not a turn that used the syntax',
    )

    // And the status line, whose "(N refused)" clause must not claim a refusal that did not
    // happen just because the two kinds share one count.
    const id = newSessionId(Date.now(), process.pid)
    const recording = recordSession(relay, {
      repoRoot: repo,
      id,
      goal: 'Keep the work moving.',
      front: 'relay',
      startedAt: Date.now(),
      build: 'test',
    })
    try {
      recording.set('ended', { outcome })
      await recording.refresh()
      const prose = formatSession(readSession(repo, id)!, Date.now())
      assert.match(
        prose,
        /targeting: 1 of 2 instructing turns named a seat \(@seat\/@role\), 2 implementer seats — 1 turn settled nothing \(1 on a turn that did not complete\)/,
      )
      // The same overclaim as the summary's, and the one this line was actually caught making:
      // the truncated turn counted as `1 used @seat/@role without dispatching` and then
      // certified `the syntax IS reaching the advisor` off that count. The certification is
      // gated on turns the parser read to the end, and there are none here -- the one turn that
      // WAS read whole dispatched, which the leading count already says.
      assert.doesNotMatch(prose, /used @seat\/@role without dispatching/)
      assert.doesNotMatch(prose, /IS reaching the advisor/)
      assert.doesNotMatch(prose, /0 refused/, 'a count of zero is a kind that did not happen; do not print it')
    } finally {
      await recording.close()
    }
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a VALID addressed batch the queue ceiling refuses is counted as elicitation, not lost with the run', async () => {
  const repo = tempRepo()
  // The last place recording still sat below the exit, and the worst of them: the evidence
  // thrown away here is the BEST this instrument can collect short of admission. This reply is
  // written whole, `parseDecisions` accepts it, and both seats it names exist -- and then the
  // batch meets the queue ceiling, `continue advisor` leaves the loop, and every line below the
  // check went unreached. So a run that ended on the ceiling at its first addressed turn
  // reported that no turn had ever used the syntax: `0 turns produced an instruction, so
  // nothing was measured`, about the one reply that proves the briefing works.
  //
  // `maxQueueDepth: 0` with two instructions makes the projection `0 + 2` and breaches on the
  // first turn. The ceiling is asked once for the WHOLE batch and before any of it is admitted,
  // which is why nothing is queued and why there is exactly one record to find.
  const { relay, outcome } = await twoSeatRun(
    repo,
    ['@seat seat-alpha: Add the parser tests.\n@seat seat-beta: Sweep the docs.'],
    undefined,
    { maxQueueDepth: 0 },
  )
  try {
    // The ceiling is untouched: still all-or-none, still checked before any mutation, still
    // ends the run. This instrument observes it and does not adjudicate it.
    assert.equal(outcome.reason, 'ceiling', 'the batch is still refused whole and the run still ends on it')
    const w = targetingReading(relay.targetingWatch).counts
    assert.equal(w.addressedTurns, 0, 'nothing was admitted, so nothing dispatched by name')
    assert.equal(w.ceilingTurns, 1, 'and the turn that used the syntax is counted — the count that did not exist')
    assert.equal(w.invalidTurns, 0, 'the parser did not refuse this: the reply was valid')
    assert.equal(w.incompleteTurns, 0, 'and the turn completed — nothing about it is uncertain')
    assert.equal(w.unaddressedTurns, 0)
    // Both names, as written, and WHICH ceiling. `queue_depth` tells an operator to raise
    // `--max-queue-depth` or let the seats drain; a record that named the briefing or the seat
    // names would send them to fix something that is working.
    assert.deepEqual(relay.targetingRecords(), [
      {
        turn: 1,
        addressed: true,
        targets: ['@seat seat-alpha', '@seat seat-beta'],
        outcome: 'ceiling',
        ceiling: 'queue_depth',
      },
    ])
    assert.equal(targetingElicited(w), 1, 'a whole, valid, addressed reply is elicitation whatever refused it')

    // The live half, beside the ceiling note that explains the ending. The ceiling's own
    // sentence says the queue is full; it says nothing about the advisor having addressed two
    // seats by name, which is the part that decides what an operator concludes about the run.
    const notes = relay.log.filter((m) => m.from === 'orchestrator' && /DID use @seat/.test(m.text))
    assert.equal(notes.length, 1)
    assert.match(notes[0]!.text, /it named @seat seat-alpha, @seat seat-beta/)
    assert.match(notes[0]!.text, /the queue_depth ceiling refused the whole batch before any of it was admitted/)
    assert.match(notes[0]!.text, /what stopped this run is the ceiling, not the advisor/)

    // The summary, which is the surface the finding was inverted on. `addressedTurns` is 0 here
    // exactly as it is on a run whose advisor never wrote the syntax, and those two need
    // opposite responses.
    const line = relay.targetingSummary() ?? ''
    assert.match(line, /the briefing ELICITED @seat\/@role — 1 of 1 instructing turn wrote it in a reply that was read whole/)
    assert.match(
      line,
      /refused whole by a run ceiling before admission — turn 1: queue_depth \(@seat seat-alpha, @seat seat-beta\)/,
    )
    assert.match(line, /the reply itself was valid and named real seats/)
    assert.doesNotMatch(line, /NONE/, 'the advisor used the syntax; NONE would send a reader to rewrite a working briefing')
    assert.doesNotMatch(line, /nothing was measured/, 'a ceiling-refused batch IS a measurement of the briefing')

    // And into the record someone reads afterwards, which for a ceiling ending is the only
    // account there is -- the run stopped, so nobody watched it happen.
    const report = await runReport(relay, {
      goal: 'Keep the work moving.',
      outcome,
      startedAt: Date.now(),
      build: 'test',
    })
    assert.deepEqual(report.targeting, {
      applicable: true,
      seats: 2,
      addressedTurns: 0,
      unaddressedTurns: 0,
      invalidTurns: 0,
      ceilingTurns: 1,
      incompleteTurns: 0,
      unadmittedTurns: 0,
      withdrawnTurns: 0,
      unaddressedFailedTurns: 0,
      conclusion: 'elicited',
      records: [
        {
          turn: 1,
          addressed: true,
          targets: ['@seat seat-alpha', '@seat seat-beta'],
          outcome: 'ceiling',
          ceiling: 'queue_depth',
        },
      ],
    })

    // And the status prose, whose tail must name the ceiling rather than a refusal that did not
    // happen -- the two are repaired in different places.
    const id = newSessionId(Date.now(), process.pid)
    const recording = recordSession(relay, {
      repoRoot: repo,
      id,
      goal: 'Keep the work moving.',
      front: 'relay',
      startedAt: Date.now(),
      build: 'test',
    })
    try {
      recording.set('ended', { outcome })
      await recording.refresh()
      const prose = formatSession(readSession(repo, id)!, Date.now())
      assert.match(
        prose,
        /targeting: 0 of 1 instructing turns named a seat \(@seat\/@role\), 2 implementer seats — 1 used @seat\/@role without dispatching \(1 refused whole by a ceiling\), so the syntax IS reaching the advisor/,
      )
      assert.doesNotMatch(prose, /NONE addressed/)
      assert.doesNotMatch(prose, /1 refused,/, 'a parser refusal is a different repair; do not report one that did not happen')
    } finally {
      await recording.close()
    }
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('an addressed turn whose timed_out verdict is withdrawn and replaced with completed is reconciled, not filed as incomplete', async () => {
  const repo = tempRepo()
  // The advisor path was not resolving supersession, and the implementer path has been doing it
  // since the pause it was written for. `#exchange` settles on the FIRST `turn_end`, and the
  // late signal that withdraws it lands during the transcript settle window that follows -- the
  // same window that exists because a late `Stop` is expected. Reading `next.end` directly meant
  // an advisor turn whose `timed_out` had already been retracted was failed, halted on and
  // re-asked, and -- since the instrument was put on that path -- filed forever as an
  // `incomplete` targeting attempt: a reply that was whole, and whose own adapter said so,
  // recorded as evidence that could not be trusted.
  //
  // `withdraw` fires the revision the instant the verdict is reported, which is the shape the
  // real adapters emit from `#apply`; `delayMs` keeps the turn in flight long enough for the
  // window to be the one that used to lose it.
  const { relay, outcome } = await twoSeatRun(
    repo,
    ['@seat seat-alpha: Add the parser tests.'],
    (lead) => {
      lead.delayMs = 10
      lead.endTurn = {
        index: 0,
        verdict: {
          outcome: 'timed_out',
          confidence: 'uncertain',
          provenance: [{ source: 'orchestrator', detail: 'past the watchdog with no Stop' }],
        },
        withdraw: { outcome: 'completed', confidence: 'proven', provenance: [{ source: 'hook', detail: 'Stop' }] },
      }
    },
  )
  try {
    // Nothing was ever wrong with this turn, so nothing about it should have ended the run.
    assert.equal(outcome.reason, 'done', 'a verdict the adapter retracted must not fail the turn it was read from')
    const w = targetingReading(relay.targetingWatch).counts
    assert.equal(w.incompleteTurns, 0, 'the turn completed; filing it as truncated would misreport a whole reply')
    assert.equal(w.addressedTurns, 1, 'it addressed a seat and its work was admitted')
    assert.deepEqual(relay.targetingRecords(), [
      { turn: 1, addressed: true, targets: ['@seat seat-alpha'], outcome: 'admitted' },
    ])
    // Retracted is not the same as never said: the withdrawal is in the log either way, which is
    // what lets a reader see why the record and the first verdict disagree.
    const notes = relay.log.filter((m) => m.kind === 'note').map((m) => m.text)
    assert.ok(
      notes.some((t) => /timed_out verdict was withdrawn/.test(t) && /replaced with completed/.test(t)),
      notes.join('\n'),
    )
    // And no failure note at all, because there was no failure: the reply was relayed.
    assert.equal(
      relay.log.filter((m) => /DID use @seat/.test(m.text)).length,
      0,
      'the reply dispatched, so the failure-path note about a targeted reply must not appear',
    )
    assert.doesNotMatch(relay.targetingSummary() ?? '', /INCONCLUSIVE/)
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

/** The verdicts the supersession cases are driven with, in the shape the adapters report. */
const TIMED_OUT = {
  outcome: 'timed_out' as const,
  confidence: 'uncertain' as const,
  provenance: [{ source: 'orchestrator' as const, detail: 'past the watchdog with no Stop' }],
}
const COMPLETED = {
  outcome: 'completed' as const,
  confidence: 'proven' as const,
  provenance: [{ source: 'hook' as const, detail: 'Stop' }],
}

/** Poll for something the relay does asynchronously. Bounded, so a failure is a failure. */
async function until<T>(what: string, f: () => T | undefined, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = f()
    if (v !== undefined) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('an advisor turn whose verdict is replaced DURING the pause is reconciled, not filed as incomplete', async () => {
  const repo = tempRepo()
  // The other half of the reconciliation, and the half the earlier fix could not reach. When the
  // withdrawal arrives before the guard, `current` is the replacement and the turn simply
  // dispatches. When it arrives WHILE THE OPERATOR IS READING THE PAUSE, the dispatch decision
  // has already been taken on a verdict that no longer stands and cannot be unmade -- but the
  // record is written after, at the finalization site, so it can still be made to agree with the
  // adapter's last word.
  //
  // What it must NOT say is `incomplete`. That is a permanent claim that the advisor's reply
  // could not be trusted, about a turn its own adapter says ended -- and `incompleteTurns` is the
  // bucket that makes a run read INCONCLUSIVE, so one stale verdict would suppress a finding on
  // every surface for the rest of the run.
  const lead = new FakeRotationSession('lead-1', 'lead', [
    '@seat seat-alpha: Add the parser tests.',
    ...Array.from({ length: 6 }, () => 'DONE'),
  ])
  lead.delayMs = 10
  // No `withdraw` here, unlike the before-the-guard case: the turn ends `timed_out` and STAYS
  // that way until the test fires the late signal by hand, at the pause.
  lead.endTurn = { index: 0, verdict: TIMED_OUT }
  const spare = (): string[] => ['ack', ...Array.from({ length: 8 }, () => 'Did it.'), 'NONE']
  const relay = await Relay.start({
    registry: registryOf({
      lead,
      alpha: new FakeRotationSession('alpha-1', 'alpha', spare()),
      beta: new FakeRotationSession('beta-1', 'beta', spare()),
    }),
    cwd: repo,
    lead: { id: 'advisor', agent: 'lead', role: 'advisor' },
    implementer: { id: 'seat-alpha', agent: 'alpha', role: 'implementer' },
    implementers: [
      { id: 'seat-alpha', agent: 'alpha', role: 'implementer' },
      { id: 'seat-beta', agent: 'beta', role: 'implementer' },
    ],
    maxAdvisorTurns: 10,
  })
  try {
    const run = relay.start('Keep the work moving.')
    const pause = await run.untilPause()
    assert.ok(pause)
    assert.equal(pause.reason, 'turn_incomplete')
    assert.equal(pause.verdictOf?.participant, 'advisor', 'the pause is about the ADVISOR turn')

    // The late Stop, arriving while the operator is deciding. The watch that matches it to this
    // pause is armed at the top of the turn, before anything in the turn can pause.
    lead.lateSignal(COMPLETED)
    const replacement = await until('the advisor pause to be marked superseded', () => run.pause?.superseded?.verdict)
    assert.equal(replacement.outcome, 'completed')
    // Surfaced, not decided: the run is still paused, exactly as it was before this change.
    assert.equal(run.state, 'paused')

    await run.continue()
    const outcome = await run.result()
    assert.equal(outcome.reason, 'done')

    const w = targetingReading(relay.targetingWatch).counts
    assert.equal(w.incompleteTurns, 0, 'the adapter says the turn ended; the record must not say otherwise')
    assert.equal(w.addressedTurns, 0, 'and it must not claim a dispatch either: nothing was admitted')
    assert.equal(w.unadmittedTurns, 1)
    assert.deepEqual(relay.targetingRecords(), [
      {
        turn: 1,
        addressed: true,
        targets: ['@seat seat-alpha'],
        outcome: 'unadmitted',
        unadmitted: 'verdict_superseded',
      },
    ])
    // A whole reply, read whole, that dispatched nothing: elicitation, on the same footing as a
    // ceiling-refused batch. So the run reads ELICITED and NOT inconclusive -- there is nothing
    // uncertain about a reply the parser accepted.
    assert.equal(targetingElicited(w), 1)
    const line = relay.targetingSummary() ?? ''
    assert.match(line, /the briefing ELICITED @seat\/@role/)
    assert.match(line, /valid and never admitted — turn 1: verdict_superseded \(@seat seat-alpha\)/)
    assert.doesNotMatch(line, /INCONCLUSIVE/)
    assert.doesNotMatch(line, /NONE/)
    // And the log says why the record and the pause disagree, rather than leaving a reader to
    // find that the turn they watched fail is filed as something else.
    const notes = relay.log.filter((m) => m.kind === 'note').map((m) => m.text)
    assert.ok(
      notes.some((t) => /advisor turn 1 was failed on a timed_out verdict that has since been withdrawn/.test(t)),
      notes.join('\n'),
    )
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('an addressed turn paused BEFORE its record exists reads as open, never as NONE, and lands exactly once', async () => {
  const repo = tempRepo()
  // The live half of the one-recording-site design, and the cost it was always going to have.
  // Recording once, on the turn's way out, is what makes the denominator honest -- but it also
  // makes the record LATE, and the gap it leaves open is not a millisecond. A `turn_incomplete`
  // pause suspends inside the turn, in front of a human, for as long as that human takes; and for
  // the whole of that pause the only turn that reached for `@seat` had no record, so every
  // surface answered from the turns that were over.
  //
  // Here that is one unaddressed turn, so the answer was `NONE ... used @seat/@role`: the finding
  // this instrument exists to make legible, printed as a finding, off one fallback turn, while
  // the turn holding `@seat seat-beta` was the one the operator had been stopped to look at. An
  // operator who acts on it rewrites a briefing that is working.
  //
  // So the open turn is reported, as an observation and not as evidence: it is in no count, it
  // settles nothing, and it suppresses the negative reading rather than replacing it with a
  // positive one. And when it ends it becomes exactly one record -- the property the rest of this
  // test is about, because a live view and a permanent record of the same turn is precisely the
  // two-stores shape this instrument spent three rounds removing.
  const lead = new FakeRotationSession('lead-1', 'lead', [
    // Turn 1: names nobody, and dispatches by fallback. This is the turn that used to answer for
    // the whole run while turn 2 was paused.
    'Add the parser tests.',
    // Turn 2: names a seat, and never finishes.
    '@seat seat-beta: Sweep the docs.',
    ...Array.from({ length: 6 }, () => 'DONE'),
  ])
  lead.delayMs = 10
  lead.endTurn = { index: 1, verdict: TIMED_OUT }
  const spare = (): string[] => ['ack', ...Array.from({ length: 8 }, () => 'Did it.'), 'NONE']
  const relay = await Relay.start({
    registry: registryOf({
      lead,
      alpha: new FakeRotationSession('alpha-1', 'alpha', spare()),
      beta: new FakeRotationSession('beta-1', 'beta', spare()),
    }),
    cwd: repo,
    lead: { id: 'advisor', agent: 'lead', role: 'advisor' },
    implementer: { id: 'seat-alpha', agent: 'alpha', role: 'implementer' },
    implementers: [
      { id: 'seat-alpha', agent: 'alpha', role: 'implementer' },
      { id: 'seat-beta', agent: 'beta', role: 'implementer' },
    ],
    maxAdvisorTurns: 10,
  })
  const id = newSessionId(Date.now(), process.pid)
  const recording = recordSession(relay, {
    repoRoot: repo,
    id,
    goal: 'Keep the work moving.',
    front: 'relay',
    startedAt: Date.now(),
    build: 'test',
  })
  try {
    const run = relay.start('Keep the work moving.')
    const pause = await run.untilPause()
    assert.ok(pause)
    assert.equal(pause.reason, 'turn_incomplete')
    assert.equal(pause.verdictOf?.participant, 'advisor', 'the pause is about the ADVISOR turn')

    // The state the whole fix rests on: turn 2 is OPEN and unrecorded, and turn 1 is the only
    // record there is. If this ever becomes two records the instrument is double-counting; if it
    // becomes zero pending the surfaces are back to answering from turn 1 alone.
    assert.deepEqual(relay.targeting().pending, { turn: 2, addressed: true, targets: ['@seat seat-beta'] })
    assert.equal(relay.targetingRecords().length, 1, 'the open turn has no record until it ends')
    const midReading = targetingReading(relay.targetingWatch)
    assert.equal(midReading.conclusion.kind, 'pending')
    // In NO count. Not the denominator, not elicitation, not the uncertainty bucket -- every one
    // of those is a length of a record array, and this turn has no record to be in.
    assert.equal(midReading.conclusion.turns, 1, 'the denominator is the settled turns')
    assert.equal(midReading.conclusion.elicited, 0)
    assert.equal(midReading.conclusion.uncertain, 0)
    assert.equal(midReading.conclusion.fellBack, 1, 'the one record is turn 1, and it is the fallback one')
    assert.equal(midReading.confirmed.turns + midReading.unsettled.turns, 0, 'the open turn is in neither evidence group')

    // Surface 1 and 2: the relay summary, which is the exact string the console prints.
    const midSummary = relay.targetingSummary() ?? ''
    assert.equal(midSummary, targetingSummary(relay.targetingWatch), 'the console writes this exact value')
    assert.match(midSummary, /NOT SETTLED YET/)
    assert.match(midSummary, /advisor turn 2 is still being taken and appears to name @seat seat-beta/)
    assert.doesNotMatch(midSummary, /NONE/, 'the finding, printed while the turn that contradicts it is open')
    assert.doesNotMatch(midSummary, /IS reaching the advisor/, 'and no certification off an unfinished turn either')

    // Surface 3: the block both documents carry. `report.ts` builds its own with this same call,
    // so asserting it here is asserting the report a run ending now would carry.
    const block = reportedTargeting(relay.targetingWatch)
    assert.equal(block?.conclusion, 'pending')
    assert.deepEqual(block?.pending, { turn: 2, addressed: true, targets: ['@seat seat-beta'] })
    assert.equal(block?.records.length, 1, 'the open turn is not serialized as a record')
    assert.equal(block?.unaddressedTurns, 1, 'and it is in none of the counters beside it')

    // Surface 4: the status document and the prose an operator reads mid-run, through the
    // recorder a real run writes with.
    await recording.refresh()
    const paused = readSession(repo, id)!
    assert.equal(paused.status.targeting?.conclusion, 'pending')
    const pausedProse = formatSession(paused, Date.now())
    assert.match(pausedProse, /targeting: .*NOT SETTLED YET: advisor turn 2 is still being taken/)
    assert.doesNotMatch(pausedProse, /NONE/, 'the status line is the surface this was found on')
    assert.doesNotMatch(pausedProse, /IS reaching the advisor/)

    // The late replacement, arriving while the operator is still deciding. The pause is amended --
    // that is the reconciliation this run already had -- and the turn is STILL open, because the
    // record is written when the turn ends and not when its verdict changes. A second recording
    // site here is exactly what the restructure removed, and it would produce two records.
    lead.lateSignal(COMPLETED)
    const replacement = await until('the advisor pause to be marked superseded', () => run.pause?.superseded?.verdict)
    assert.equal(replacement.outcome, 'completed')
    assert.equal(run.state, 'paused')
    assert.deepEqual(relay.targeting().pending, { turn: 2, addressed: true, targets: ['@seat seat-beta'] })
    assert.equal(relay.targetingRecords().length, 1, 'a replaced verdict does not record the turn early')
    assert.match(relay.targetingSummary() ?? '', /NOT SETTLED YET/)

    // Resolution. The turn finally ends, and the open observation becomes one record -- filed
    // against the adapter's last word, which is the reconciliation the surrounding tests pin.
    await run.continue()
    const outcome = await run.result()
    assert.equal(outcome.reason, 'done')
    assert.equal(relay.targetingWatch.pending, undefined, 'the open turn is closed exactly where it is recorded')
    assert.deepEqual(
      relay.targetingRecords().map((r) => ({ turn: r.turn, outcome: r.outcome, addressed: r.addressed })),
      [
        { turn: 1, outcome: 'admitted', addressed: false },
        { turn: 2, outcome: 'unadmitted', addressed: true },
      ],
    )
    const settled = targetingReading(relay.targetingWatch)
    assert.equal(settled.conclusion.turns, 2, 'the open turn became ONE record, not a second turn beside it')
    assert.equal(settled.conclusion.kind, 'elicited')
    const endSummary = relay.targetingSummary() ?? ''
    assert.match(endSummary, /the briefing ELICITED @seat\/@role/)
    assert.doesNotMatch(endSummary, /still being taken/, 'nothing is open once the run is over')
    assert.doesNotMatch(endSummary, /NOT SETTLED YET/)
    await recording.refresh()
    const ended = readSession(repo, id)!
    assert.equal(ended.status.targeting?.conclusion, 'elicited')
    assert.equal(ended.status.targeting?.pending, undefined, 'and the document stops carrying it')
  } finally {
    await recording.close()
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('an open turn is an observation on every surface: reported, in no count, and never a conclusion', () => {
  // The projection's half of the case above, driven directly so the shapes a run is awkward to
  // produce are covered too -- and so the four renderings can be read side by side. `pending` is
  // the relay's live view of a turn that has not finalized; these are the readings it must give.
  const seats = 2
  const fallback = { turn: 1, addressed: false, targets: [], outcome: 'admitted' as const }
  const openAddressed = { turn: 2, addressed: true, targets: ['@seat seat-beta'] }

  // 1. The case from the run above, at the projection: one fallback turn and an open addressed
  //    one. The negative reading is not available while the turn that could overturn it is open.
  const mixed = { applicable: true, seats, records: [fallback], pending: openAddressed }
  const mixedReading = targetingReading(mixed)
  assert.equal(mixedReading.conclusion.kind, 'pending')
  assert.equal(mixedReading.conclusion.turns, 1)
  assert.equal(mixedReading.conclusion.fellBack, 1)
  assert.deepEqual(mixedReading.pending, openAddressed)
  for (const [what, text] of [
    ['summary', targetingSummary(mixed) ?? ''],
    ['status line', targetingStatusLine(mixed) ?? ''],
  ] as const) {
    assert.match(text, /advisor turn 2 is still being taken and appears to name @seat seat-beta/, what)
    assert.doesNotMatch(text, /NONE/, `${what}: no finding off the turns that are over`)
    assert.doesNotMatch(text, /used @seat\/@role without dispatching/, `${what}: an open turn has used nothing yet`)
    assert.doesNotMatch(text, /IS reaching the advisor/, `${what}: and certifies nothing`)
  }
  assert.equal(reportedTargeting(mixed)?.conclusion, 'pending')

  // 2. Nothing recorded at all and a turn open. The status line says so rather than printing the
  //    vacuous `0 of 0`, and the summary must not call it "measured" or "not measured" -- the
  //    measurement is in progress.
  const first = { applicable: true, seats, records: [], pending: { turn: 1, addressed: true, targets: ['@role implementer'] } }
  assert.equal(targetingReading(first).conclusion.kind, 'pending')
  const firstLine = targetingStatusLine(first) ?? ''
  assert.match(firstLine, /^2 implementer seats — NOT SETTLED YET: advisor turn 1 is still being taken/)
  assert.doesNotMatch(firstLine, /0 of 0/)
  assert.match(targetingSummary(first) ?? '', /No turn has been recorded yet/)

  // 3. An open turn that named NOBODY suppresses nothing, and the asymmetry is the same one an
  //    unreadable record gets: `addressed` is fixed by the parser the moment the reply is read, so
  //    this turn can never become evidence of elicitation however it settles. The finding stands,
  //    and the open turn is still reported beside it.
  const silent = { applicable: true, seats, records: [fallback], pending: { turn: 2, addressed: false, targets: [] } }
  assert.equal(targetingReading(silent).conclusion.kind, 'none')
  const silentLine = targetingStatusLine(silent) ?? ''
  assert.match(silentLine, /NONE addressed/)
  assert.match(silentLine, /advisor turn 2 is still being taken and named nobody/)

  // 4. A run that already dispatched by name keeps that reading: it is a fact about a turn that is
  //    over, and an open turn does not withdraw it. The open turn is named beside it and added to
  //    nothing -- `1 of 1`, not `1 of 2`, because turn 2 has not been counted anywhere.
  const dispatched = {
    applicable: true,
    seats,
    records: [{ turn: 1, addressed: true, targets: ['@seat seat-alpha'], outcome: 'admitted' as const }],
    pending: openAddressed,
  }
  assert.equal(targetingReading(dispatched).conclusion.kind, 'dispatched')
  const dispatchedLine = targetingStatusLine(dispatched) ?? ''
  assert.match(dispatchedLine, /^1 of 1 instructing turns named a seat/)
  assert.match(dispatchedLine, /advisor turn 2 is still being taken/)

  // 5. And with no open turn at all, every reading above is exactly what it was: this field is
  //    absent from every serialized end-of-run document, and adding it changed no settled answer.
  const settled = { applicable: true, seats, records: [fallback] }
  assert.equal(targetingReading(settled).conclusion.kind, 'none')
  assert.equal(targetingReading(settled).pending, undefined)
  assert.equal(reportedTargeting(settled)?.pending, undefined)
  assert.doesNotMatch(targetingStatusLine(settled) ?? '', /still being taken/)
  assert.doesNotMatch(targetingSummary(settled) ?? '', /still being taken/)
})

test('a verdict withdrawn with NOTHING behind it leaves the turn open, and the record never quotes it — unattended', async () => {
  const repo = tempRepo()
  // The third state of `supersessionOf`, which the finalizer used to collapse into the first. A
  // revision can withdraw a `turn_end` and put nothing in its place: the adapter has retracted
  // its claim about how the turn ended and has not made another, so the turn has NO verdict.
  //
  // `?.replacement ?? attempt.end` read the withdrawn `turn_end` straight back out, so the record
  // was filed as `incomplete` carrying the very `timed_out` the adapter had taken back -- a
  // permanent claim that the advisor's reply could not be trusted, sourced to a claim nobody
  // stands behind any more. And `incompleteTurns` is the bucket that withholds the under-use
  // finding, so one retracted verdict went on suppressing a finding for the rest of the run.
  //
  // The pause raised over this turn already says the verdict was withdrawn with nothing put in
  // its place; this is the same fact reaching the permanent record. Unattended here: no operator,
  // so the halt ends the run and the turn unwinds through the finalizer on its way out.
  const { relay, outcome } = await twoSeatRun(repo, ['@seat seat-alpha: Add the parser tests.'], (lead) => {
    lead.endTurn = { index: 0, verdict: TIMED_OUT, withdraw: 'no_replacement' }
  })
  try {
    // EXACTLY one record, and it is the OPEN one: not `incomplete`, which would quote the
    // retracted verdict as though it still stood, and not `unadmitted`, which would say the
    // opposite of what is known -- that a whole valid reply had been established. No verdict
    // field at all, because there is no verdict to carry.
    assert.deepEqual(relay.targetingRecords(), [
      { turn: 1, addressed: true, targets: ['@seat seat-alpha'], outcome: 'withdrawn' },
    ])
    const block = reportedTargeting(relay.targetingWatch)
    assert.equal(block?.withdrawnTurns, 1)
    assert.equal(block?.incompleteTurns, 0, 'a withdrawn verdict is not an incomplete turn')
    assert.equal(block?.unadmittedTurns, 0, 'nor a whole valid reply the run stopped dispatching')
    assert.ok(
      !JSON.stringify(block).includes('timed_out'),
      `the withdrawn verdict must appear nowhere in the record: ${JSON.stringify(block)}`,
    )
    // And the reading that follows: NOTHING is established. The adapter's last word is that its
    // claim about how this turn ended was wrong, so the reply behind it certifies no more than a
    // reply nobody read to the end -- which is what filing it as `unadmitted` was doing, since
    // that outcome is confirmed evidence and counts as elicitation.
    const reading = targetingReading(relay.targetingWatch)
    assert.equal(reading.conclusion.kind, 'inconclusive')
    assert.equal(reading.conclusion.elicited, 0, 'an open turn certifies nothing')
    assert.equal(targetingElicited(reading.counts), 0)
    assert.equal(reading.conclusion.cutOff, 1, 'and it withholds the under-use finding too')
    assert.equal(reading.unsettled.turns, 1)
    const line = relay.targetingSummary() ?? ''
    assert.match(line, /INCONCLUSIVE/)
    assert.match(line, /left open by a verdict withdrawn with nothing put in its place — turn 1/)
    assert.doesNotMatch(line, /ELICITED/)
    assert.doesNotMatch(line, /NONE/)
    // The log says why the record and the pause disagree, and says which of the two withdrawals
    // this was -- a reader who found "replaced with undefined" would be reading the instrument
    // admitting it had not looked.
    const notes = relay.log.filter((m) => m.kind === 'note').map((m) => m.text)
    assert.ok(
      notes.some((t) => /advisor turn 1 was failed on a timed_out verdict that has since been withdrawn with nothing put in its place/.test(t)),
      notes.join('\n'),
    )
    assert.ok(!notes.some((t) => /replaced with undefined/.test(t)))
    // The RUN's ending is the halt's contemporaneous account and is untouched here: unattended,
    // the pause becomes the ending, and its detail still quotes the `timed_out` the guard read.
    // That is a different surface from the permanent record -- the guard writes what it believed
    // when it stopped, the finalizer writes what stands afterwards -- and only the second is what
    // this test is about. Pinned so that a later change to the first is a visible decision.
    assert.equal(outcome.reason, 'escalated')
    assert.match(outcome.detail ?? '', /advisor turn ended timed_out/)
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a verdict withdrawn with nothing behind it during the pause is reconciled when the OPERATOR aborts', async () => {
  const repo = tempRepo()
  // The other way out of that pause, and the one an operator actually takes: the withdrawal
  // arrives while they are reading it, and they end the run rather than resuming it. The turn
  // still unwinds through the finalizer as the released halt returns, so the record is written
  // once, on a run that ended by abort -- and it must be the reconciled one, not the retracted
  // verdict preserved for posterity because nobody resumed.
  const lead = new FakeRotationSession('lead-1', 'lead', [
    '@seat seat-alpha: Add the parser tests.',
    ...Array.from({ length: 6 }, () => 'DONE'),
  ])
  lead.delayMs = 10
  lead.endTurn = { index: 0, verdict: TIMED_OUT }
  const spare = (): string[] => ['ack', ...Array.from({ length: 8 }, () => 'Did it.'), 'NONE']
  const relay = await Relay.start({
    registry: registryOf({
      lead,
      alpha: new FakeRotationSession('alpha-1', 'alpha', spare()),
      beta: new FakeRotationSession('beta-1', 'beta', spare()),
    }),
    cwd: repo,
    lead: { id: 'advisor', agent: 'lead', role: 'advisor' },
    implementer: { id: 'seat-alpha', agent: 'alpha', role: 'implementer' },
    implementers: [
      { id: 'seat-alpha', agent: 'alpha', role: 'implementer' },
      { id: 'seat-beta', agent: 'beta', role: 'implementer' },
    ],
    maxAdvisorTurns: 10,
  })
  try {
    const run = relay.start('Keep the work moving.')
    const pause = await run.untilPause()
    assert.ok(pause)
    assert.equal(pause.reason, 'turn_incomplete')
    // Open, and visible as open: the turn has no record yet, and the live surfaces say so.
    assert.deepEqual(relay.targeting().pending, { turn: 1, addressed: true, targets: ['@seat seat-alpha'] })

    // The withdrawal, with nothing put in its place, arriving while the operator reads the pause.
    lead.lateSignal('none')
    await until('the advisor pause to be marked superseded', () => run.pause?.superseded)
    assert.equal(run.state, 'paused', 'surfaced, not decided: the operator still chooses')

    const outcome = await run.abort('the operator ended it')
    assert.equal(outcome.reason, 'stopped', 'an operator abort ends the run as `stopped`')
    assert.equal(relay.targetingWatch.pending, undefined, 'the open turn is closed where it is recorded')
    assert.deepEqual(relay.targetingRecords(), [
      { turn: 1, addressed: true, targets: ['@seat seat-alpha'], outcome: 'withdrawn' },
    ])
    const block = reportedTargeting(relay.targetingWatch)
    assert.equal(block?.withdrawnTurns, 1)
    assert.equal(block?.incompleteTurns, 0)
    assert.equal(block?.unadmittedTurns, 0)
    assert.ok(
      !JSON.stringify(block).includes('timed_out'),
      `the withdrawn verdict must appear nowhere in the record: ${JSON.stringify(block)}`,
    )
    const reading = targetingReading(relay.targetingWatch)
    assert.equal(reading.conclusion.kind, 'inconclusive')
    assert.equal(reading.conclusion.elicited, 0)
    assert.match(relay.targetingSummary() ?? '', /INCONCLUSIVE/)
    assert.doesNotMatch(relay.targetingSummary() ?? '', /ELICITED/)
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a refused reply that named NOBODY is in the denominator and credited to neither conclusion', async () => {
  const repo = tempRepo()
  // The asymmetry, asserted rather than left to be inferred. An empty reply is refused on the
  // unaddressed path, and it is not evidence about the briefing in either direction -- the
  // advisor said nothing at all. Counting it as `unaddressedTurns` would push the record toward
  // the briefing-failed reading on the strength of a turn that carried no instruction, which is
  // the same class of error as dropping the addressed refusals: a number that moves for a reason
  // it does not name.
  //
  // Dropping it ENTIRELY was the other error, and it is the one this used to make. The advisor
  // was asked for an instruction and spent a turn on it, so the turn belongs in the denominator
  // every ratio above is read against -- `1 of 1 addressed` on a run that took four turns to get
  // there describes a different run from the one that happened. So: recorded, counted in
  // `unaddressedFailedTurns`, credited to no conclusion, and visible per turn in `records`.
  const { relay, outcome } = await twoSeatRun(repo, [''])
  try {
    assert.equal(outcome.reason, 'escalated')
    const w = targetingReading(relay.targetingWatch).counts
    assert.equal(w.addressedTurns, 0)
    assert.equal(w.unaddressedTurns, 0, 'nothing went out by fallback, so the under-use counter must not move')
    assert.equal(w.invalidTurns, 0, 'and the elicitation counter must not move either: this reply named nobody')
    assert.equal(w.unaddressedFailedTurns, 1, 'it is in the denominator, where the turn was actually spent')
    assert.equal(targetingElicited(w), 0)
    assert.equal(targetingTurns(w), 1)
    assert.deepEqual(relay.targetingRecords(), [
      { turn: 1, addressed: false, targets: [], outcome: 'invalid', refusal: 'empty' },
    ])
    // So the summary resolves nothing. NONE would report a briefing as having failed on a run
    // where no reply was ever read that could have carried a directive, and ELICITED is not in
    // question -- nothing here reached for the syntax.
    const line = relay.targetingSummary() ?? ''
    assert.match(line, /INCONCLUSIVE — 1 instructing turn produced nothing that names a seat and nothing that dispatched/)
    assert.match(line, /named nobody and dispatched nothing — turn 1: empty/)
    assert.match(line, /evidence NEITHER that the briefing works NOR that it does not/)
    assert.doesNotMatch(line, /NONE/, 'a turn that said nothing is not an advisor that declined to address a seat')
    assert.doesNotMatch(line, /ELICITED/)
    assert.doesNotMatch(line, /IS reaching the advisor/)
    // The turn is not only counted, it is explained: the routing log has always carried it.
    assert.ok(
      relay.log.some((m) => m.from === 'orchestrator' && /produced no instruction/.test(m.text)),
      'the existing note is what reports an empty turn, and it still does',
    )
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('an UNADDRESSED batch a run ceiling refuses is counted too, and credited to nothing', async () => {
  const repo = tempRepo()
  // The other unaddressed failure, and the one that is genuinely real evidence: this reply was
  // written whole, `parseDecisions` accepted it, and it named nobody. It is still credited to
  // nothing -- `unaddressedTurns` means one instruction went out by fallback, and nothing went
  // out here -- so it errs toward "not measured" rather than toward a negative result the run
  // did not earn, which is the direction this instrument is required to fail in.
  //
  // Two instructions on one unaddressed reply is not possible, so the ceiling is driven the same
  // way the addressed case drives it: a queue of one is already at the limit.
  const { relay } = await twoSeatRun(repo, ['Add the parser tests.'], undefined, { maxQueueDepth: 0 })
  try {
    const w = targetingReading(relay.targetingWatch).counts
    assert.equal(w.unaddressedFailedTurns, 1, 'the batch was refused whole, so nothing went out by fallback')
    assert.equal(w.unaddressedTurns, 0)
    assert.equal(w.ceilingTurns, 0, 'that counter feeds the elicited sum, and this reply named nobody')
    assert.equal(targetingElicited(w), 0)
    assert.equal(targetingTurns(w), 1, 'and the turn is still in the denominator, where it was spent')
    assert.deepEqual(relay.targetingRecords(), [
      { turn: 1, addressed: false, targets: [], outcome: 'ceiling', ceiling: 'queue_depth' },
    ])
    const line = relay.targetingSummary() ?? ''
    assert.match(line, /INCONCLUSIVE/)
    assert.match(line, /named nobody and dispatched nothing — turn 1: queue_depth/)
    assert.doesNotMatch(line, /NONE/)
    assert.doesNotMatch(line, /ELICITED/)
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('the counters are a PARTITION of the records, so no turn is lost or counted twice', () => {
  // The structural claim the instrument now rests on, asserted rather than argued. There are no
  // counters any more -- `records` is the only store and every aggregate is a projection of it --
  // and the property that makes that safe is that the projection partitions: every record lands
  // in exactly one counter, so the denominator IS the number of turns recorded.
  //
  // This is what three revisions of held counters could not guarantee. Each repair added a
  // counter and threaded it through the recorder, two sums, the serializer and both prose
  // surfaces; the edit that gets forgotten is the one nothing fails on, and what it produced
  // every time was a denominator quietly smaller than the run. A bucket dropped from the
  // projection now fails here, on every shape at once.
  //
  // Every cell of the (addressed x outcome) grid, including the ones no run reaches today.
  const records = [
    { turn: 1, addressed: true, targets: ['@seat a'], outcome: 'admitted' as const },
    { turn: 2, addressed: false, targets: [], outcome: 'admitted' as const },
    { turn: 3, addressed: true, targets: ['@seat ghost'], outcome: 'invalid' as const, refusal: 'unknown_target' as const },
    { turn: 4, addressed: false, targets: [], outcome: 'invalid' as const, refusal: 'empty' as const },
    { turn: 5, addressed: true, targets: ['@seat a'], outcome: 'ceiling' as const, ceiling: 'queue_depth' as const },
    { turn: 6, addressed: false, targets: [], outcome: 'ceiling' as const, ceiling: 'queue_depth' as const },
    { turn: 7, addressed: true, targets: ['@seat b'], outcome: 'incomplete' as const, verdict: 'timed_out' as const },
    { turn: 8, addressed: false, targets: [], outcome: 'incomplete' as const, verdict: 'transport_lost' as const },
    { turn: 9, addressed: true, targets: ['@seat b'], outcome: 'unadmitted' as const, unadmitted: 'verdict_superseded' as const },
    { turn: 10, addressed: false, targets: [], outcome: 'unadmitted' as const, unadmitted: 'unclassified' as const },
    { turn: 11, addressed: true, targets: ['@seat b'], outcome: 'withdrawn' as const },
    { turn: 12, addressed: false, targets: [], outcome: 'withdrawn' as const },
  ]
  const reading = targetingReading({ applicable: true, seats: 2, records })

  // THE INVARIANTS, and they are about the reading rather than about the counters. The reading
  // is what every surface renders, so these are the properties that decide whether an operator
  // is told the truth about how much of the run was measured.
  //
  // The denominator is the record count ITSELF. It used to be `targetingTurns(counts)`, which
  // enumerates the outcomes that have a named counter -- so a sixth outcome would have landed in
  // its evidence bucket, been quoted in the prose, and been missing from the total: `1 of 1`
  // about a run that took two turns. A length cannot be made false by an omission.
  assert.equal(reading.conclusion.turns, records.length, 'the denominator IS the records')
  // The four buckets partition them, so no turn is lost between the reading's numbers and no
  // turn is counted in two of them.
  const buckets =
    reading.conclusion.dispatched +
    reading.conclusion.fellBack +
    reading.conclusion.elicitedUndispatched +
    reading.conclusion.uncertain
  assert.equal(buckets, records.length, 'dispatched + fallback + confirmed + unsettled is every record')
  // Elicitation is the two buckets a parser read to the end, and nothing else. Asserted against
  // the evidence group the prose quotes, so the number in the sentence and the number in the sum
  // cannot come apart -- which is the way this went wrong before, in prose rather than in
  // arithmetic.
  assert.equal(
    reading.conclusion.elicited,
    reading.conclusion.dispatched + reading.confirmed.turns,
    'elicited is exactly the dispatched turns plus the confirmed group',
  )
  assert.equal(reading.conclusion.elicitedUndispatched, reading.confirmed.turns)
  assert.equal(reading.conclusion.uncertain, reading.unsettled.turns)
  assert.equal(reading.conclusion.truncated + reading.conclusion.unreadable, reading.unsettled.turns)

  // And the WIRE FORMAT, which is a separate claim: the named counters a document carries are a
  // compatibility projection and an input to nothing, but they must still account for every
  // recorded turn. A sixth outcome has no field here, so this assertion is what forces that to
  // be a decision somebody makes rather than a gap a reader finds later by doing arithmetic on a
  // published document.
  const total = Object.values(reading.counts).reduce((a, b) => a + b, 0)
  assert.equal(total, records.length, 'the serialized counters still account for every turn')
  assert.equal(targetingTurns(reading.counts), records.length, 'as read back by a probe that has only them')
  assert.deepEqual(reading.counts, {
    addressedTurns: 1,
    unaddressedTurns: 1,
    invalidTurns: 1,
    ceilingTurns: 1,
    incompleteTurns: 1,
    unadmittedTurns: 1,
    withdrawnTurns: 1,
    // Every non-admitted turn that named nobody, whatever ended it. Five of them here, which is
    // the group that spans outcomes and the one a per-outcome counter could not have held -- and
    // the sixth outcome joined it without this line being the edit that made it work.
    unaddressedFailedTurns: 5,
  })
  // And the same answer through the compatibility helper a probe would use.
  assert.equal(targetingElicited(reading.counts), reading.conclusion.elicited)
  assert.equal(reading.conclusion.elicited, 4, 'the addressed admitted, invalid, ceiling and unadmitted turns')
  // The evidence split is the same classification, not a second one. Three confirmed kinds and
  // two unsettled groups, and no turn appears in both.
  assert.equal(reading.confirmed.turns, 3, 'invalid + ceiling + unadmitted, all addressed')
  assert.equal(
    reading.unsettled.turns,
    7,
    'the truncated turn, the withdrawn one, and the five that named nobody',
  )
  // And what a document carries is rendered from those same records at write time, so a
  // serialized count cannot disagree with the turn list beside it.
  const block = reportedTargeting({ applicable: true, seats: 2, records })
  assert.ok(block)
  assert.equal(block.records.length, records.length)
  assert.equal(block.addressedTurns, reading.counts.addressedTurns)
  assert.equal(block.unaddressedFailedTurns, reading.counts.unaddressedFailedTurns)
  assert.equal(block.conclusion, reading.conclusion.kind)
})

test('all four surfaces render ONE conclusion, and none quotes an uncertain turn as usage', async () => {
  // The defect this pins is not a wrong reading, it is two surfaces giving an operator opposite
  // readings of one run. The end-of-run summary was taught that truncated-only evidence settles
  // nothing; the live status line went on certifying "the syntax IS reaching the advisor" from
  // the same counters, because the rule had been written twice instead of once. Whichever of
  // them an operator happened to read decided whether they rewrote a briefing that works.
  //
  // So `targetingConclusion` decides, and the four surfaces render it: the run report, the
  // console summary, the relay summary and the status prose. The console and the relay summary
  // are the SAME string by construction -- both front-ends write `relay.targetingSummary()` and
  // nothing else -- which is asserted here as an identity; that the console then prints it is
  // pinned against a real console in src/repl/session.test.ts.
  for (const shape of [
    {
      what: 'truncated-only',
      replies: ['@seat seat-beta: Sweep the docs.'],
      script: (lead: FakeRotationSession) => {
        lead.endTurn = { index: 0, verdict: TIMED_OUT }
      },
      conclusion: 'inconclusive' as const,
      // The word the surfaces must agree on, and the words none of them may say.
      says: /INCONCLUSIVE/,
      alsoSays: /did not complete/,
      never: [/NONE/, /ELICITED/, /IS reaching the advisor/],
    },
    {
      what: 'mixed dispatched-plus-refused',
      replies: ['@seat seat-alpha: Add the parser tests.', '@seat ghost: Sweep the docs.'],
      script: undefined,
      conclusion: 'dispatched' as const,
      says: /1 of 2 instructing turns/,
      alsoSays: /used @seat\/@role without dispatching/,
      never: [/NONE/, /INCONCLUSIVE/],
    },
    {
      // The case both prose surfaces got wrong in the same way, and the reason this test says
      // "none quotes an uncertain turn as usage" rather than only "they agree". One turn
      // dispatched by name and one was cut off, and BOTH surfaces counted the cut-off turn into
      // `N used @seat/@role without dispatching` -- the summary in its tail, the status line in
      // the clause it then hung `so the syntax IS reaching the advisor` off. That is
      // `targetingElicited`'s exclusion being undone in prose: the arithmetic refused to certify
      // a reply nobody read to the end, and the sentence beside it certified it anyway.
      //
      // The reading is still `dispatched` -- a turn DID dispatch by name -- so this is not about
      // the conclusion being wrong. It is about the numbers quoted underneath it.
      what: 'mixed dispatched-plus-incomplete',
      replies: ['@seat seat-alpha: Add the parser tests.', '@seat seat-beta: Sweep the docs.'],
      script: (lead: FakeRotationSession) => {
        lead.endTurn = { index: 1, verdict: TIMED_OUT }
      },
      conclusion: 'dispatched' as const,
      says: /1 of 2 instructing turns/,
      // Reported, not dropped: the uncertain turn is named on every prose surface, in a clause
      // that claims nothing. Asserted positively so this case cannot be satisfied by the turn
      // vanishing from the prose, which would be the opposite failure -- and the one that let a
      // refused turn go unrecorded for three revisions of this instrument.
      alsoSays: /settled nothing/,
      never: [
        /NONE/,
        /INCONCLUSIVE/,
        // No count on any surface may describe the truncated turn as having used the syntax...
        /used @seat\/@role without dispatching/,
        // ...and nothing may certify the briefing off a count that contains it. The turn that
        // WAS read whole dispatched, and the leading count already says so.
        /IS reaching the advisor/,
      ],
    },
  ]) {
    const repo = tempRepo()
    const { relay, outcome } = await twoSeatRun(repo, shape.replies, shape.script)
    const id = newSessionId(Date.now(), process.pid)
    const recording = recordSession(relay, {
      repoRoot: repo,
      id,
      goal: 'Keep the work moving.',
      front: 'relay',
      startedAt: Date.now(),
      build: 'test',
    })
    try {
      // 1. The run report, where the reading is a FIELD rather than a sentence, so a probe reads
      //    it instead of re-implementing it.
      const report = await runReport(relay, {
        goal: 'Keep the work moving.',
        outcome,
        startedAt: Date.now(),
        build: 'test',
      })
      assert.equal(report.targeting?.conclusion, shape.conclusion, `${shape.what}: the run report`)

      // 2 and 3. The relay summary, and the console summary -- one string, asserted as one.
      const summary = relay.targetingSummary() ?? ''
      assert.equal(summary, targetingSummary(relay.targetingWatch), `${shape.what}: the console writes this exact value`)
      assert.match(summary, shape.says, `${shape.what}: the summary`)
      assert.match(summary, shape.alsoSays, `${shape.what}: the summary reports the rest of the run`)
      for (const forbidden of shape.never) {
        assert.doesNotMatch(summary, forbidden, `${shape.what}: the summary must not say ${forbidden}`)
      }

      // 4. The status prose, which is the one an operator reads WHILE the run is going and the
      //    one that used to disagree.
      recording.set('ended', { outcome })
      await recording.refresh()
      const status = readSession(repo, id)!
      assert.equal(status.status.targeting?.conclusion, shape.conclusion, `${shape.what}: status --json`)
      const prose = formatSession(status, Date.now())
      assert.match(prose, /targeting:/, `${shape.what}: the status line is printed at all`)
      assert.match(prose, shape.says, `${shape.what}: the status prose`)
      assert.match(prose, shape.alsoSays, `${shape.what}: the status prose reports the rest of the run`)
      for (const forbidden of shape.never) {
        assert.doesNotMatch(prose, forbidden, `${shape.what}: the status prose must not say ${forbidden}`)
      }
    } finally {
      await recording.close()
      await relay.stop()
      rmSync(repo, { recursive: true, force: true })
    }
  }
})

test('a cut-off turn that named nobody withholds NONE too, on every surface, and a whole-reply run still reports it', async () => {
  // The under-use finding is a claim about EVERY recorded turn -- `NONE of 2 instructing turns
  // used @seat/@role` -- so it may only be made when every one of them was read out whole. This
  // rule used to be written as "every ADDRESSED turn", and the two are indistinguishable on a
  // settled run: a whole reply that named nobody demonstrably did not use the syntax, and it was
  // on that ground that unaddressed failures were allowed to stand beside the finding.
  //
  // The ground does not hold for a turn that stopped mid-reply. `addressed` there is a fact about
  // the FRAGMENT that arrived, not about the reply the advisor was writing: a turn cut off after
  // "Right, let's" named nobody and was one clause from naming someone. So a run that fell back
  // once and lost one turn was reporting the finding this instrument exists to make legible --
  // NONE, go and rewrite the briefing -- on evidence that was one whole reply and one sentence
  // that stops.
  //
  // Both shapes are driven together because the pair IS the assertion: the same run minus the
  // cut-off turn must still report NONE. A rule that only ever says "inconclusive" would satisfy
  // half of this test and destroy the instrument.
  for (const shape of [
    {
      what: 'fallback plus a cut-off turn that named nobody',
      replies: ['Add the parser tests.', 'Now sweep the docs for the old flag name.'],
      script: (lead: FakeRotationSession) => {
        lead.endTurn = { index: 1, verdict: TIMED_OUT }
      },
      conclusion: 'inconclusive' as const,
      says: /INCONCLUSIVE/,
      // Asserted positively, so the fix cannot be satisfied by the run going quiet about either
      // half of what it saw: the fallback routing happened and the lost turn happened.
      alsoSays: [/went out by fallback/, /never reached a settled readable end|settled nothing/],
      never: [/NONE/, /ELICITED/, /IS reaching the advisor/],
    },
    {
      what: 'the same run with both replies read whole',
      replies: ['Add the parser tests.', 'Now sweep the docs for the old flag name.'],
      script: undefined,
      conclusion: 'none' as const,
      says: /NONE/,
      // The summary spells the fallback routing out and the one-line status surface says the
      // consequence instead ("nothing has dispatched concurrently"), which is the same finding at
      // two lengths -- so this matches either rather than pinning a wording neither owes.
      alsoSays: [/routed by fallback|nothing has dispatched concurrently/],
      never: [/INCONCLUSIVE/, /ELICITED/],
    },
  ]) {
    const repo = tempRepo()
    const { relay, outcome } = await twoSeatRun(repo, shape.replies, shape.script)
    const id = newSessionId(Date.now(), process.pid)
    const recording = recordSession(relay, {
      repoRoot: repo,
      id,
      goal: 'Keep the work moving.',
      front: 'relay',
      startedAt: Date.now(),
      build: 'test',
    })
    try {
      // The evidence both shapes rest on: two turns, neither of which named anyone, differing
      // only in whether the second one was read to the end.
      assert.deepEqual(
        relay.targetingRecords().map((r) => ({ addressed: r.addressed, outcome: r.outcome })),
        [
          { addressed: false, outcome: 'admitted' },
          { addressed: false, outcome: shape.conclusion === 'none' ? 'admitted' : 'incomplete' },
        ],
        shape.what,
      )

      // Serialized surface 1: the run report.
      const report = await runReport(relay, {
        goal: 'Keep the work moving.',
        outcome,
        startedAt: Date.now(),
        build: 'test',
      })
      assert.equal(report.targeting?.conclusion, shape.conclusion, `${shape.what}: the run report`)

      // Prose surface 1 and 2: the relay summary, which is the string the console writes.
      const summary = relay.targetingSummary() ?? ''
      assert.equal(summary, targetingSummary(relay.targetingWatch), `${shape.what}: the console writes this`)
      assert.match(summary, shape.says, `${shape.what}: the summary`)
      for (const also of shape.alsoSays) assert.match(summary, also, `${shape.what}: the summary reports the rest`)
      for (const forbidden of shape.never) {
        assert.doesNotMatch(summary, forbidden, `${shape.what}: the summary must not say ${forbidden}`)
      }

      // Serialized surface 2 and prose surface 3: the status document and the line drawn from it.
      recording.set('ended', { outcome })
      await recording.refresh()
      const status = readSession(repo, id)!
      assert.equal(status.status.targeting?.conclusion, shape.conclusion, `${shape.what}: status --json`)
      const prose = formatSession(status, Date.now())
      assert.match(prose, shape.says, `${shape.what}: the status prose`)
      for (const also of shape.alsoSays) assert.match(prose, also, `${shape.what}: the status prose reports the rest`)
      for (const forbidden of shape.never) {
        assert.doesNotMatch(prose, forbidden, `${shape.what}: the status prose must not say ${forbidden}`)
      }
    } finally {
      await recording.close()
      await relay.stop()
      rmSync(repo, { recursive: true, force: true })
    }
  }
})

test('a whole reply that named nobody is settled evidence of non-use, and does NOT withhold the finding', () => {
  // The other side of the rule, and the reason it is written as "was the reply read to the end"
  // rather than as "is the record in the unsettled bucket". That bucket is about USAGE evidence:
  // a reply that named nobody can never be quoted as having written @seat/@role, so `bucketOf`
  // puts every unaddressed failure in it -- including a whole reply the parser read and refused,
  // which is settled evidence of non-use and nothing like a fragment.
  //
  // Reading the rule off the bucket would therefore suppress the under-use finding on any run
  // whose advisor wrote one unparseable reply, which is the same mistake in the other direction:
  // an instrument that can no longer report the thing it exists to report.
  const seats = 2
  const fallback = { turn: 1, addressed: false, targets: [], outcome: 'admitted' as const }
  const refusedWhole = {
    turn: 2,
    addressed: false,
    targets: [],
    outcome: 'invalid' as const,
    refusal: 'empty_instruction' as const,
  }
  const readOut = { applicable: true, seats, records: [fallback, refusedWhole] }
  const readOutReading = targetingReading(readOut)
  assert.equal(readOutReading.conclusion.kind, 'none', 'both replies were read out; neither used the syntax')
  assert.equal(readOutReading.conclusion.cutOff, 0)
  assert.equal(readOutReading.unsettled.turns, 1, 'and the refused turn is still reported, claiming nothing')
  assert.match(targetingSummary(readOut) ?? '', /NONE of 2 instructing turns used @seat\/@role/)
  assert.match(targetingStatusLine(readOut) ?? '', /NONE addressed/)

  // The same run with that turn cut off instead of refused: same `addressed`, same targets, same
  // absence of a dispatch -- and the finding is no longer available, because the reply stops.
  const cutOff = {
    applicable: true,
    seats,
    records: [fallback, { turn: 2, addressed: false, targets: [], outcome: 'incomplete' as const, verdict: 'timed_out' as const }],
  }
  const cutOffReading = targetingReading(cutOff)
  assert.equal(cutOffReading.conclusion.kind, 'inconclusive')
  assert.equal(cutOffReading.conclusion.cutOff, 1)
  assert.equal(cutOffReading.conclusion.truncated, 0, 'it named nobody, so it is not a truncated DIRECTIVE')
  for (const text of [targetingSummary(cutOff) ?? '', targetingStatusLine(cutOff) ?? '']) {
    assert.match(text, /INCONCLUSIVE/)
    assert.match(text, /went out by fallback/, 'the fallback routing still happened and is still said')
    assert.doesNotMatch(text, /NONE/)
  }
  assert.equal(reportedTargeting(cutOff)?.conclusion, 'inconclusive')
})

test('each kind of unsettled turn is described as what it actually was, on both prose surfaces', () => {
  // The prose half of adding an outcome, and the half that does not fail a typecheck. The
  // `UNDISPATCHED` row made `withdrawn` land in the right bucket and count toward the right
  // things -- and both renderers went on EXPLAINING it in the truncated turn's words, because the
  // sentence around the clause had been written for the only unsettled outcome there used to be.
  // A run whose advisor's verdict was withdrawn was told its reply "was cut off", "never
  // finished", "stopped mid-reply": three claims about a reply nobody had said anything about.
  //
  // So the frame says only what the two kinds share -- no settled readable end, so nothing
  // establishes that the apparent directive was complete -- and WHICH kind a turn was stays in
  // the clause the table writes for it. Both halves are asserted here: the shared frame on both
  // surfaces, and the outcome-specific clause that keeps them distinguishable.
  const seats = 2
  const fallback = { turn: 9, addressed: false, targets: [], outcome: 'admitted' as const }
  // Every phrase that is true of a truncated reply and NOT of a withdrawn verdict. The frame may
  // use none of them; the incomplete turn's own clause is where truncation may be named.
  const truncationOnly = [/cut off/, /cut-off/, /stopped mid-reply/, /never finished/]
  for (const shape of [
    {
      what: 'a truncated addressed reply',
      record: {
        turn: 1,
        addressed: true,
        targets: ['@seat seat-beta'],
        outcome: 'incomplete' as const,
        verdict: 'timed_out' as const,
      },
      clause: /appeared to name a seat on a turn that did not complete — turn 1: timed_out \(@seat seat-beta\)/,
      why: /on a turn that did not complete/,
      otherClause: /withdrawn with nothing put in its place/,
    },
    {
      what: 'an addressed reply on a turn whose verdict was withdrawn with nothing behind it',
      record: { turn: 1, addressed: true, targets: ['@seat seat-beta'], outcome: 'withdrawn' as const },
      clause: /left open by a verdict withdrawn with nothing put in its place — turn 1: verdict withdrawn, no replacement \(@seat seat-beta\)/,
      why: /on a turn whose verdict was withdrawn with no replacement/,
      otherClause: /appeared to name a seat/,
    },
  ]) {
    // Alone, which is the branch that explains the whole run, and beside a fallback turn, which
    // is the other branch and the one that used to say "stopped mid-reply" in as many words.
    for (const where of ['alone', 'beside a fallback turn'] as const) {
      const watch = {
        applicable: true,
        seats,
        records: where === 'alone' ? [shape.record] : [fallback, shape.record],
      }
      const summary = targetingSummary(watch) ?? ''
      const line = targetingStatusLine(watch) ?? ''
      for (const [surface, text] of [
        ['summary', summary],
        ['status line', line],
      ] as const) {
        const at = `${shape.what}, ${where}: the ${surface}`
        assert.match(text, /INCONCLUSIVE/, at)
        // The shared frame, which claims only what both kinds support. Matched on the phrase and
        // not on a whole sentence: the branches lead into it differently ("not one of them",
        // "1 turn never"), and it is the CLAIM that has to be the same on every surface.
        assert.match(text, /reached a settled readable end/, at)
        // And the outcome-specific half, which is what keeps the two runs distinguishable to a
        // reader. Asserted positively so this cannot be satisfied by the prose going vague.
        assert.match(text, surface === 'summary' ? shape.clause : shape.why, at)
        assert.doesNotMatch(text, shape.otherClause, `${at} must not describe the other kind`)
      }
      // The frame itself names no truncation. The truncated turn's OWN clause may -- "on a turn
      // that did not complete" is what happened to it -- so this is asserted against the frame's
      // vocabulary, on the withdrawn shape, where none of it is true of anything.
      if (shape.record.outcome === 'withdrawn') {
        for (const forbidden of truncationOnly) {
          assert.doesNotMatch(summary, forbidden, `${shape.what}, ${where}: the summary`)
          assert.doesNotMatch(line, forbidden, `${shape.what}, ${where}: the status line`)
        }
      }
    }
  }
})

test('a one-seat run reports nothing about targeting: no counting, no note, no line, no key', async () => {
  const repo = tempRepo()
  const relay = await Relay.start({
    registry: registryOf({
      lead: new FakeRotationSession('lead-1', 'lead', ['Add the parser tests.', 'Now sweep the docs.', 'DONE']),
      impl: new FakeRotationSession('impl-1', 'impl', ['ack', 'Did it.', 'Did it.', 'NONE']),
    }),
    cwd: repo,
    lead: { id: 'advisor', agent: 'lead', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'impl', role: 'implementer' },
    maxAdvisorTurns: 4,
  })
  try {
    const outcome = await relay.run('Keep the work moving.')
    assert.equal(outcome.reason, 'done')
    const w = relay.targetingWatch
    assert.equal(w.applicable, false, 'one seat: there is no @seat to use and the advisor was never taught one')
    assert.equal(w.seats, 1)
    // Nothing counted, and that is not the same as "counted and found zero". A one-seat run's
    // advisor writes an unaddressed reply every turn BY CONSTRUCTION, so a counter that ticked
    // here would report maximal under-use on every default run conclave has ever done -- which
    // is how a line stops being read.
    //
    // Asserted on the RECORDS, which is where "nothing counted" now lives: the counters are a
    // projection of this array, so an empty array is the whole of the claim and there is no
    // second place a one-seat run could have been counted.
    assert.deepEqual(relay.targetingRecords(), [])
    const counts = targetingReading(w).counts
    assert.equal(counts.addressedTurns, 0)
    assert.equal(counts.unaddressedTurns, 0)
    assert.deepEqual(unaddressedNotes(relay.log), [], 'the default run must not gain a note per turn')
    assert.equal(relay.targetingSummary(), undefined, 'and neither front-end has a line to print')

    // And no key in either document. Not a block of zeros, not `applicable: false`: NOTHING,
    // which is what "a one-seat run must not pay for this" means once you follow it into the
    // documents. A reader who wants to know whether that absence is a one-seat run or an older
    // build settles it from `participants` in the same document, by counting the seats whose
    // role is `implementer` -- which is why this key can vanish where `ceilings` and `rotations`
    // cannot.
    const report = await runReport(relay, {
      goal: 'Keep the work moving.',
      outcome,
      startedAt: Date.now(),
      build: 'test',
    })
    assert.equal(report.targeting, undefined)
    assert.ok(!('targeting' in report), 'no key at all, not an undefined one JSON would drop silently')

    // Through the real recorder, because that is what `conclave status --json` reads and it is a
    // different serializer with the same rule to obey.
    const id = newSessionId(Date.now(), process.pid)
    const recording = recordSession(relay, {
      repoRoot: repo,
      id,
      goal: 'Keep the work moving.',
      front: 'relay',
      startedAt: Date.now(),
      build: 'test',
    })
    try {
      recording.set('ended', { outcome })
      await recording.refresh()
      const session = readSession(repo, id)
      assert.ok(session)
      assert.equal(session.status.targeting, undefined)
      assert.ok(!('targeting' in JSON.parse(formatSessionJson(session))), 'and none in the JSON a poller parses')
      assert.doesNotMatch(formatSession(session, Date.now()), /targeting:/, 'nor in the prose it prints')
    } finally {
      await recording.close()
    }
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a multi-seat run that instructed nothing still carries the block, so the instrument is demonstrably live', async () => {
  const repo = tempRepo()
  // The reading the omission rule must not take with it. This advisor ends the run on its first
  // reply, so there is nothing to measure -- and `{applicable: true, addressedTurns: 0}` on a run
  // with two seats is exactly the "armed, and the run ended before anything was assessed" state
  // #31 is about. Dropping the block here too would make it identical to a one-seat run, and the
  // negative result these counters exist to support would stop being citeable.
  const { relay, outcome } = await twoSeatRun(repo, [])
  try {
    assert.equal(outcome.reason, 'done')
    const report = await runReport(relay, {
      goal: 'Keep the work moving.',
      outcome,
      startedAt: Date.now(),
      build: 'test',
    })
    assert.deepEqual(report.targeting, {
      applicable: true,
      seats: 2,
      addressedTurns: 0,
      unaddressedTurns: 0,
      invalidTurns: 0,
      ceilingTurns: 0,
      incompleteTurns: 0,
      unadmittedTurns: 0,
      withdrawnTurns: 0,
      unaddressedFailedTurns: 0,
      conclusion: 'unmeasured',
      records: [],
    })
    // And the summary says which silence this is, rather than reporting a run that never
    // instructed anything as one whose advisor refused to address a seat.
    assert.match(relay.targetingSummary() ?? '', /0 turns produced an instruction, so nothing was measured/)
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('the counters reach conclave status --json, through the recorder a real run writes with', async () => {
  const repo = tempRepo()
  const { relay, outcome } = await twoSeatRun(repo, ['Add the parser tests.', '@seat seat-beta: Sweep the docs.'])
  const id = newSessionId(Date.now(), process.pid)
  const recording = recordSession(relay, {
    repoRoot: repo,
    id,
    goal: 'Keep the work moving.',
    front: 'relay',
    startedAt: Date.now(),
    build: 'test',
  })
  try {
    assert.equal(outcome.reason, 'done')
    // `set` is what a front-end calls at a lifecycle change, and it is where the document is
    // rewritten. The counters move DURING a run, so the projection has to be re-read on every
    // write -- a block composed once at construction would report `0 addressed` for the whole
    // life of a run whose advisor addressed every turn.
    recording.set('ended', { outcome })
    await recording.refresh()
    const status = readSession(repo, id)?.status
    assert.deepEqual(
      status?.targeting,
      {
        applicable: true,
        seats: 2,
        addressedTurns: 1,
        unaddressedTurns: 1,
        invalidTurns: 0,
        ceilingTurns: 0,
        incompleteTurns: 0,
        unadmittedTurns: 0,
        withdrawnTurns: 0,
        unaddressedFailedTurns: 0,
        conclusion: 'dispatched',
        records: [
          { turn: relay.targetingRecords()[0]!.turn, addressed: false, targets: [], outcome: 'admitted' },
          { turn: relay.targetingRecords()[1]!.turn, addressed: true, targets: ['@seat seat-beta'], outcome: 'admitted' },
        ],
      },
      'an operator polling a live run must be able to see the advisor is naming nobody',
    )
    // And the prose `conclave status` prints, because an operator at a terminal is asking the
    // same question as the poller. Only once there is something to say: a one-seat run's line
    // is absent for the reason `rotated:` is absent from a run that rotated nothing.
    assert.match(
      formatSession(readSession(repo, id)!, Date.now()),
      /targeting: 1 of 2 instructing turns named a seat \(@seat\/@role\), 2 implementer seats/,
    )
  } finally {
    await recording.close()
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a detached multi-seat run carries the block from the parent\'s first status, and a one-seat run does not', async () => {
  // The document an agent operator polls FIRST, and until now the emitting half of it was
  // executed by no test: the only `--detach` coverage spawns one seat, so it exercised the
  // omission branch and never the branch that writes anything. That branch is also the third
  // hand-written producer of this block -- the run report and the recorder are the other two --
  // which is why it now asks `reportedTargeting` the same question they do rather than
  // restating the rule. A rule about when a key exists, written three times, is one that gets
  // relaxed in two places and kept in the third.
  //
  // Driven as a real subprocess for the reason `ceilings.test.ts` gives at its own detach test:
  // the detach path re-executes `process.argv[1]`, which under `node --test` is THIS FILE, so
  // calling `main()` in-process would spawn the test file as a program and recurse.
  const bin = join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts')
  /** Both cases, so the presence and the absence are the same assertion run twice. */
  for (const [seats, expected] of [
    [
      ['--implementers', 'fake-impl,fake-impl'],
      {
        applicable: true,
        seats: 2,
        addressedTurns: 0,
        unaddressedTurns: 0,
        invalidTurns: 0,
        ceilingTurns: 0,
        incompleteTurns: 0,
        unadmittedTurns: 0,
        withdrawnTurns: 0,
        unaddressedFailedTurns: 0,
        conclusion: 'unmeasured',
        records: [],
      },
    ],
    [['--implementer', 'fake-impl'], undefined],
  ] as const) {
    const dir = tempRepo()
    let detached: number | undefined
    try {
      // The grandchild gets agent names no registry knows, so it fails at resolution and never
      // records a status of its own: what is read below is the PARENT's document.
      execFileSync(
        process.execPath,
        [bin, 'relay', 'Keep the work moving.', '--detach', '--advisor', 'fake-advisor', ...seats],
        { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
      )
      const sessions = listSessions(dir)
      assert.equal(sessions.length, 1)
      const status = sessions[0]!.status
      detached = status.pid
      assert.equal(status.state, 'starting', 'a placeholder in every other respect')
      assert.deepEqual(status.targeting, expected)
      // And through the JSON, because a key that is `undefined` in memory and a key that is
      // absent from the document are the same value to this test and different to a poller.
      const json = JSON.parse(formatSessionJson(sessions[0]!))
      assert.equal('targeting' in json, expected !== undefined)
    } finally {
      // Detaching means nothing here owns the child. It should already be gone -- the agents are
      // in no registry -- but that is not a reason to leave a detached process to chance.
      if (detached !== undefined) {
        try {
          process.kill(detached, 'SIGKILL')
        } catch {
          // Already gone, which is the other legitimate ending.
        }
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

/**
 * The summary's own cases, without a run.
 *
 * Two of these cannot be reached by driving a relay at all -- a run that ends before its
 * advisor instructs anything, and the exact wording each branch produces -- and the third is
 * the #31 distinction this instrument was built to preserve. A summary tested only through
 * runs is a summary whose "nothing was measured" branch is never read.
 */
test('the summary tells "nothing was measured", "never targeted" and "targeted, not dispatched" apart', () => {
  const base = {
    applicable: true,
    seats: 2,
    records: [],
  }
  assert.match(
    targetingSummary({ ...base }) ?? '',
    /0 turns produced an instruction, so nothing was measured; this is not a negative result/,
    'a run that ended before its advisor assigned anything is uninformative, not evidence',
  )
  const unaddressed = targetingSummary({
    ...base,
    records: [{ turn: 1, addressed: false, targets: [], outcome: 'admitted' }],
  }) ?? ''
  assert.match(unaddressed, /NONE of 1 instructing turn used/, 'one unaddressed turn IS a measurement')

  // Three readings, all with `addressedTurns === 0`, and the arithmetic alone cannot separate
  // them. This is the branch the instrument was missing: the counter says the same thing on a
  // briefing that failed and on a briefing that worked with the wrong seat names in it.
  const refused = targetingSummary({
    ...base,
    records: [
      { turn: 1, addressed: true, targets: ['@seat ghost'], outcome: 'invalid', refusal: 'unknown_target' },
      { turn: 2, addressed: false, targets: [], outcome: 'admitted' },
      { turn: 3, addressed: true, targets: ['@role nobody'], outcome: 'invalid', refusal: 'unknown_target' },
    ],
  }) ?? ''
  assert.match(refused, /the briefing ELICITED @seat\/@role — 2 of 3 instructing turns wrote it/)
  assert.match(refused, /refused by the parser — turn 1: unknown_target \(@seat ghost\); turn 3: unknown_target \(@role nobody\)/)
  assert.match(refused, /1 named nobody and went out by fallback/)
  assert.doesNotMatch(refused, /NONE/)
  assert.notEqual(refused, unaddressed, 'the two zero-addressed runs must not read the same')

  // And the third zero-addressed run: the syntax was written on turns that died. Grouped
  // separately from the refusals in the same line, because a reader is meant to weigh the two
  // differently and one number would let the weaker borrow the stronger's confidence.
  const both = targetingSummary({
    ...base,
    records: [
      { turn: 1, addressed: true, targets: ['@seat ghost'], outcome: 'invalid', refusal: 'unknown_target' },
      { turn: 2, addressed: true, targets: ['@seat seat-beta'], outcome: 'incomplete', verdict: 'timed_out' },
    ],
  }) ?? ''
  assert.match(both, /refused by the parser — turn 1: unknown_target \(@seat ghost\)/)
  assert.match(both, /on a turn that did not complete — turn 2: timed_out \(@seat seat-beta\); an UNCERTAIN reading/)
  assert.doesNotMatch(both, /NONE/)

  // And the mixed run, where some turns dispatched by name and others were refused. The leading
  // count stays what it was; the refused turns are a tail rather than a silence.
  const mixed = targetingSummary({
    ...base,
    records: [
      { turn: 1, addressed: true, targets: ['@seat seat-alpha'], outcome: 'admitted' },
      { turn: 2, addressed: true, targets: ['@seat ghost'], outcome: 'invalid', refusal: 'unknown_target' },
    ],
  }) ?? ''
  assert.match(mixed, /1 of 2 instructing turns addressed a seat/)
  assert.match(mixed, /1 further turn used @seat\/@role without dispatching/)

  // The batch a ceiling refused. Elicitation, and the least equivocal kind there is short of
  // admission -- the reply parsed and named real seats -- so it reads as ELICITED and points at
  // the ceiling rather than at the briefing or the seat names.
  const ceiling = targetingSummary({
    ...base,
    records: [
      { turn: 1, addressed: true, targets: ['@seat seat-alpha'], outcome: 'ceiling', ceiling: 'queue_depth' },
    ],
  }) ?? ''
  assert.match(ceiling, /the briefing ELICITED @seat\/@role — 1 of 1 instructing turn wrote it in a reply that was read whole/)
  assert.match(ceiling, /refused whole by a run ceiling before admission — turn 1: queue_depth \(@seat seat-alpha\)/)
  assert.doesNotMatch(ceiling, /NONE/)

  // The FOURTH zero-addressed run, and the one that used to be reported as the third. Nothing
  // here was read to the end, so nothing here settles anything: `ELICITED` would certify a
  // briefing on text that stopped at an arbitrary point, and `NONE` would condemn one on the
  // strength of a fragment that begins `@seat`. Both are conclusions; this run supports
  // neither, and the line has to say so in a word a reader can act on.
  const truncated = targetingSummary({
    ...base,
    records: [
      { turn: 1, addressed: true, targets: ['@seat seat-alpha'], outcome: 'incomplete', verdict: 'timed_out' },
      { turn: 2, addressed: true, targets: ['@seat seat-beta'], outcome: 'incomplete', verdict: 'transport_lost' },
    ],
  }) ?? ''
  assert.match(truncated, /INCONCLUSIVE — 2 of 2 instructing turns appear to have written @seat\/@role/)
  assert.match(truncated, /turn 1: timed_out \(@seat seat-alpha\); turn 2: transport_lost \(@seat seat-beta\)/)
  assert.match(truncated, /evidence NEITHER that the briefing works NOR that it does not/)
  assert.doesNotMatch(truncated, /NONE/, 'a fragment beginning @seat is not an advisor that never wrote it')
  assert.doesNotMatch(truncated, /ELICITED/, 'and text nobody read to the end does not certify a briefing')
  assert.doesNotMatch(truncated, /IS reaching the advisor/, 'which is the same certification in other clothes')
  assert.notEqual(truncated, unaddressed)
  assert.notEqual(truncated, refused)
  // The counters behind it: truncated turns are in the denominator and out of the numerator.
  const truncatedOnly = { addressedTurns: 0, unaddressedTurns: 0, invalidTurns: 0, ceilingTurns: 0, incompleteTurns: 2 }
  assert.equal(targetingElicited(truncatedOnly), 0)
  assert.equal(targetingTurns(truncatedOnly), 2)

  // Truncated turns beside turns that named nobody. The fallback count is a fact and is
  // reported as one; the truncated turns still resolve nothing, so the line stays INCONCLUSIVE
  // rather than rounding to the under-use finding it nearly is.
  const mostlyUnaddressed = targetingSummary({
    ...base,
    records: [
      { turn: 1, addressed: false, targets: [], outcome: 'admitted' },
      { turn: 2, addressed: true, targets: ['@seat seat-beta'], outcome: 'incomplete', verdict: 'timed_out' },
      { turn: 3, addressed: false, targets: [], outcome: 'admitted' },
    ],
  }) ?? ''
  assert.match(mostlyUnaddressed, /INCONCLUSIVE — 1 of 3 instructing turns appears to have written @seat\/@role/)
  assert.match(mostlyUnaddressed, /2 named nobody and went out by fallback/)
  assert.doesNotMatch(mostlyUnaddressed, /NONE/)

  assert.equal(
    targetingSummary({ ...base, applicable: false, seats: 1 }),
    undefined,
    'and a one-seat run has no line, whatever the counters say',
  )
})
