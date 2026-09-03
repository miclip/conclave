/**
 * What a DONE run says is still outstanding (#131).
 *
 * Every `FLAG:` line was lifted as it went past, and the closing question's answer was then
 * APPENDED to the same list with nothing compared. A seat that answered the closing question
 * honestly -- restating the two items that still stood -- ended the run reporting four, two of
 * them the same two, and the count an operator reads off the last three lines of a DONE was
 * inflated by exactly the diligence it was meant to reward.
 *
 * The fix routes the judgement to the only participant that can make it: the seat is shown its
 * own accumulated flags and asked which still stand. So these tests drive a real relay across
 * several turns and assert two things every time -- what `flagSummary()` REPORTS, and what the
 * record RETAINS. They are not the same claim, and the second one is why superseding is not
 * deletion: `NONE` from a seat that fixed everything and `NONE` from a seat that ran out of
 * context are the same four characters.
 *
 *   node --test src/relay/flagReconciliation.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { AgentRegistry } from '../registry/registry.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { tempDir } from '../testkit/tempDir.ts'
import { Relay } from './relay.ts'
import { runReport } from './report.ts'

const BUILD = 'test-build'

function repo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-flags')
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })
  return dir
}

function registryOf(sessions: Record<string, FakeRotationSession[]>): AgentRegistry {
  const r = new AgentRegistry()
  for (const [agent, queue] of Object.entries(sessions)) {
    const remaining = [...queue]
    r.register({
      id: agent,
      displayName: agent,
      // Declared rather than defaulted, because the registry refuses a default: a clock
      // reported here that the adapter does not run would be a deadline nobody keeps.
      deadlines: {
        absolute: { supported: true, defaultMs: 2_700_000 },
        silence: { supported: true, defaultMs: 720_000 },
      },
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

/**
 * A relay whose advisor and implementer are both scripted turn by turn.
 *
 * The implementer's first reply answers the BRIEFING, so a script that means "two working
 * turns and then a closing statement" is four replies long. Getting that wrong is the easiest
 * way to write a test that passes because the flag it was about never got raised.
 */
async function run(
  t: TestContext,
  advisorReplies: string[],
  implReplies: string[],
  over: { failImplSendOnTurn?: number } = {},
) {
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', advisorReplies)
  const impl = new FakeRotationSession('impl', 'claude', implReplies)
  if (over.failImplSendOnTurn !== undefined) impl.failSendOnTurn = over.failImplSendOnTurn
  const relay = await Relay.start({
    registry: registryOf({ codex: [advisor], claude: [impl] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: advisorReplies.length + 2,
  })
  const outcome = await relay.run('a goal')
  const report = await runReport(relay, { goal: 'a goal', outcome, startedAt: Date.now(), build: BUILD })
  await relay.stop()
  return { relay, report, outcome, impl, advisor }
}

const AUDITION_FLAG = 'the replacement could not verify the predecessor’s last claim.'

const HANDOFF = `## BRIEF\nKeep the work moving.\n\n## STATE\nHalf done.\n\n## DECISIONS\n- none\n\n## EVIDENCE\nThe implementer says the check passes.\n\n## FILES\n- work.ts\n\n## DISAGREEMENT\n- none\n\n## NEXT\nCarry on.`

const UNRUN = 'conformance.sh remains unrun; inherited reasoning, not confirmed.'
const GOLDENS = 'the goldens were regenerated, not reviewed.'

test('the closing question shows the seat the flags it is being asked to settle (#131)', async (t) => {
  // The judgement asked for is "which of THESE still stand", and a seat cannot make it against
  // a list it was never shown -- fifteen turns earlier is exactly where the items it raised
  // have gone. The prompt has to carry them.
  const { impl } = await run(t,
    ['do the thing', 'DONE'],
    ['ack', `Did it.\nFLAG: ${UNRUN}\nFLAG: ${GOLDENS}`, 'NONE'],
  )

  const asked = impl.received.at(-1)!
  assert.match(asked, /is anything unresolved, unverified, or unanswered/, 'the original question survives')
  assert.match(asked, /You raised these during the run/)
  assert.ok(asked.includes(UNRUN) && asked.includes(GOLDENS), `both items must be shown:\n${asked}`)
  assert.match(asked, /your answer REPLACES it/, 'and it must say what the answer will do')
  assert.match(asked, /word for word/, 'restating verbatim is what makes a restatement recognisable')
})

test('a closing statement that restates an earlier flag reports one item, not two (#131)', async (t) => {
  // The defect, exactly. A conscientious seat restates what still stands, and the restatement
  // used to arrive as a SECOND flag beside the one it was repeating.
  const { relay, report } = await run(t,
    ['do the thing', 'DONE'],
    ['ack', `Did it.\nFLAG: ${UNRUN}`, `FLAG: ${UNRUN}`],
  )

  assert.equal(relay.outstandingFlags().length, 1, 'one concern, raised twice, is one item')
  assert.equal(relay.supersededFlags().length, 0, 'and it was restated, so nothing was retired')
  const summary = relay.flagSummary()
  assert.match(summary[0]!, /^1 flagged item carried:/)
  assert.match(summary[1]!, /implementer .*conformance\.sh remains unrun/)

  // What the record retains: the collapse must not hide that it was raised on two occasions.
  assert.equal(report.flags.length, 1)
  assert.equal(report.flags[0]!.restated.length, 1, 'the closing restatement is kept as a position')
  assert.ok(
    report.flags[0]!.restated[0]! > report.flags[0]!.seq,
    'the restatement is later in the log than the raise it repeats',
  )
  assert.deepEqual(report.supersededFlags, [])
})

test('a closing statement that raises something new retires what it did not restate (#131)', async (t) => {
  // The seat's own judgement is the only thing that can say the turn-two concern was settled by
  // turn four. It says so by leaving it out, and by naming the thing that replaced it.
  const { relay, report } = await run(t,
    ['do the first thing', 'do the second thing', 'DONE'],
    [
      'ack',
      `Rewrote the normaliser.\nFLAG: ${UNRUN}`,
      `Ran it.\nFLAG: ${GOLDENS}`,
      'FLAG: the fixture repo has no upstream, so the push path is untested.',
    ],
  )

  assert.deepEqual(
    relay.outstandingFlags().map((f) => f.text),
    ['the fixture repo has no upstream, so the push path is untested.'],
  )
  assert.deepEqual(
    relay.supersededFlags().map((f) => f.text),
    [UNRUN, GOLDENS],
    'both earlier items were retired by the statement that did not restate them',
  )

  const closing = relay.log.filter((m) => m.kind === 'note' && m.text.startsWith('closing statement:')).at(-1)!
  for (const f of relay.supersededFlags()) {
    assert.equal(f.supersededBy, closing.seq, 'each names the message that retired it')
  }

  const summary = relay.flagSummary()
  assert.match(summary[0]!, /^1 flagged item carried:/)
  assert.match(summary[1]!, /push path is untested/)
  assert.match(summary[2]!, /2 earlier items superseded at the close/)
  assert.ok(
    summary.slice(3).join('\n').includes(UNRUN),
    `the retired items are still printed:\n${summary.join('\n')}`,
  )

  assert.equal(report.flags.length, 1, 'the report field an operator reads as "unresolved" means that')
  assert.equal(report.supersededFlags.length, 2, 'and the retired ones are still in the record')
})

test('a stale flag whose subject was removed goes quiet while its neighbour stands (#131)', async (t) => {
  // The case the reconciliation exists for: two concerns, one of them fixed later in the run.
  // Nothing outside the seat can read that off the text -- the flag says the same words it said
  // when it was true -- and guessing it would be the same class of error as the defect.
  const { relay } = await run(t,
    ['delete the dead adapter', 'now check the rest', 'DONE'],
    [
      'ack',
      `Looked at it.\nFLAG: ${GOLDENS}\nFLAG: opencode.ts still holds the abandoned retry loop.`,
      'Deleted opencode.ts, so the retry loop is gone.',
      `FLAG: ${GOLDENS}`,
    ],
  )

  const outstanding = relay.outstandingFlags()
  assert.deepEqual(outstanding.map((f) => f.text), [GOLDENS], 'only the one restated still stands')
  assert.deepEqual(
    relay.supersededFlags().map((f) => f.text),
    ['opencode.ts still holds the abandoned retry loop.'],
    'the flag about the deleted file is retired, not deleted',
  )
  // The surviving item keeps the position it was RAISED at, not the position it was restated
  // at: "found on turn two, still true at the close" is the fact, and pointing an operator at
  // the closing statement would send them to the one message that adds no context.
  const closing = relay.log.filter((m) => m.kind === 'note' && m.text.startsWith('closing statement:')).at(-1)!
  assert.ok(outstanding[0]!.seq < closing.seq - 1, 'the surviving flag points at its raise, not the close')
  // Within one message of the closing statement, which is where a lifted flag lands: they are
  // stamped with the log length as the turn is read, and the statement itself is recorded just
  // after. Asserted loosely on purpose -- that stamping convention predates this and is not
  // what this test is about, but "the restatement happened at the close" is.
  assert.equal((outstanding[0]!.restated ?? []).length, 1)
  assert.ok((outstanding[0]!.restated ?? [])[0]! >= closing.seq - 1, 'and the close is where it was restated')
})

test('NONE after earlier flags retires them and the summary still says so (#131)', async (t) => {
  // The failure that replacement alone would introduce. A seat that answers NONE because it
  // fixed everything and a seat that answers NONE because it was truncated produce the same
  // four characters, so the summary must not go quiet on either. Noisy beats silent.
  const { relay, report } = await run(t,
    ['do the thing', 'DONE'],
    ['ack', `Did it.\nFLAG: ${UNRUN}\nFLAG: ${GOLDENS}`, 'NONE'],
  )

  assert.deepEqual(relay.outstandingFlags(), [], 'the seat says nothing is outstanding')
  assert.equal(relay.supersededFlags().length, 2, 'and the record keeps what it was asked about')

  const summary = relay.flagSummary()
  assert.ok(summary.length > 0, 'a run that raised flags and then said NONE does NOT print nothing')
  assert.match(summary[0]!, /^nothing outstanding, but 2 earlier items superseded at the close/)
  assert.ok(summary.join('\n').includes(UNRUN))
  assert.ok(summary.join('\n').includes(GOLDENS))

  assert.deepEqual(report.flags, [])
  assert.deepEqual(report.supersededFlags.map((f) => f.text), [UNRUN, GOLDENS])
})

test('the same flag raised verbatim on three turns is one carried item (#131)', async (t) => {
  // Repetition is how a participant says "still", and counting it is how a summary says
  // something false about how much is outstanding. Collapsed on exact text from the same
  // participant, and only exact text -- anything looser is reading the words for meaning.
  const { relay, report } = await run(t,
    ['first', 'second', 'DONE'],
    ['ack', `Still going.\nFLAG: ${UNRUN}`, `Still going.\nFLAG: ${UNRUN}`, `FLAG: ${UNRUN}`],
  )

  assert.equal(relay.flags.length, 1, 'the record holds one entry, not three')
  assert.equal(relay.outstandingFlags().length, 1)
  const summary = relay.flagSummary()
  assert.match(summary[0]!, /^1 flagged item carried:/)
  assert.match(summary[1]!, /\(raised again at msg \d+, \d+\)/, 'both repeats are shown, not hidden')

  assert.equal(report.flags[0]!.restated.length, 2, 'the record retains where it was raised again')
})

test('a near-duplicate is a distinct item, because deciding otherwise is reading the words (#131)', async (t) => {
  // The boundary, stated on purpose. Two differently worded flags MIGHT be the same concern,
  // and a machine that ruled on that would be making exactly the judgement #131 says belongs to
  // the participant. A seat that wants them treated as one restates one of them verbatim.
  const { relay } = await run(t,
    ['do the thing', 'DONE'],
    ['ack', `Did it.\nFLAG: ${UNRUN}`, 'FLAG: conformance.sh is still unrun.'],
  )

  assert.deepEqual(relay.outstandingFlags().map((f) => f.text), ['conformance.sh is still unrun.'])
  assert.deepEqual(relay.supersededFlags().map((f) => f.text), [UNRUN])
  const summary = relay.flagSummary()
  assert.match(summary[0]!, /^1 flagged item carried:/)
  assert.match(summary[2]!, /1 earlier item superseded at the close/)
})

test('an unstructured closing answer still supersedes, and is still carried whole (#38, #131)', async (t) => {
  // #38: an answer without the marker is a real answer and is carried. #131: it is also a
  // judgement about what still stands, so it reconciles like any other.
  const { relay } = await run(t,
    ['do the thing', 'DONE'],
    ['ack', `Did it.\nFLAG: ${UNRUN}`, 'I never ran the conformance script and I did not check the goldens.'],
  )

  assert.deepEqual(
    relay.outstandingFlags().map((f) => f.text),
    ['I never ran the conformance script and I did not check the goldens.'],
  )
  assert.deepEqual(relay.supersededFlags().map((f) => f.text), [UNRUN])
})

test('a closing question that cannot be asked leaves every historical flag standing (#131)', async (t) => {
  // Nothing was reconciled because nothing was answered. Retiring a flag on the strength of a
  // send that threw would be the machine making the judgement, with no participant involved at
  // all -- which is worse than the defect, because it looks like an answer.
  const { relay, report, outcome } = await run(t,
    ['do the thing', 'DONE'],
    ['ack', `Did it.\nFLAG: ${UNRUN}`, 'NONE'],
    // 0 is the briefing and 1 is the working turn, so the closing question is send 2.
    { failImplSendOnTurn: 2 },
  )

  assert.equal(outcome.reason, 'done', 'a closing question is worth one turn, never a verdict')
  assert.deepEqual(relay.outstandingFlags().map((f) => f.text), [UNRUN])
  assert.deepEqual(relay.supersededFlags(), [])
  assert.equal(report.flags.length, 1)
  assert.deepEqual(report.supersededFlags, [])
  assert.ok(
    relay.log.some((m) => m.kind === 'note' && m.text.startsWith('closing question not asked')),
    'and the record says why it was not reconciled',
  )
})

test('an empty closing answer is not a judgement, so it retires nothing (#131)', async (t) => {
  // A seat that says nothing has not said everything is fine. The existing behaviour records
  // `(no reply)` and carries on; what it must not now do is read the silence as NONE.
  const { relay } = await run(t, ['do the thing', 'DONE'], ['ack', `Did it.\nFLAG: ${UNRUN}`, ''])

  assert.deepEqual(relay.outstandingFlags().map((f) => f.text), [UNRUN])
  assert.deepEqual(relay.supersededFlags(), [])
  assert.ok(
    relay.log.some((m) => m.kind === 'note' && m.text === 'closing statement: (no reply)'),
    'the empty answer is still on the record',
  )
})

test('a flag raised while auditioning belongs to the seat once the audition is promoted (#131)', async (t) => {
  // The route by which #131's own defect reappears inside the fix for it, found by an
  // independent review rather than by a test -- there was no coverage of a flag raised during
  // an audition, and this is it.
  //
  // `#raiseFlag` stores whichever id the participant had when it spoke, and an auditioning
  // replacement is `implementer~replacement`. Promotion rewrites the participant object's id but
  // not the strings already recorded, and the closing question selects a seat's flags by the
  // stable id -- so an audition flag was shown to nobody, superseded by nothing, and if the
  // promoted seat happened to restate it at the close it became a SECOND outstanding entry
  // saying the same thing. Inflated duplicates, which is the whole complaint.
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', [HANDOFF])
  const old = new FakeRotationSession('old', 'claude')
  const fresh = new FakeRotationSession('fresh', 'claude', [
    `CHECK 1: exit 0\n\nRead the tree and ran the check. It matches.\nFLAG: ${AUDITION_FLAG}`,
  ])
  const relay = await Relay.start({
    registry: registryOf({ codex: [advisor], claude: [old, fresh] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 2,
    rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000, onDegradation: 'automatic' },
  })
  try {
    assert.equal((await relay.rotateImplementer('context exhausted')).status, 'rotated')

    // Under the SEAT, not under the audition. Asserted on the id rather than only on the count,
    // because a filter at the read site would also make a count look right while leaving the
    // record saying a participant that no longer exists raised it.
    assert.deepEqual(
      relay.flags.map((f) => [f.participant, f.text]),
      [['implementer', AUDITION_FLAG]],
      'a promoted audition IS this seat, retrospectively, and the flag record has to say so',
    )
    // And it is therefore reachable by the thing that settles flags at all.
    assert.deepEqual(relay.outstandingFlags().map((f) => f.participant), ['implementer'])
  } finally {
    await relay.stop()
  }
})

test("one seat's closing statement does not retire another participant's flags (#131)", async (t) => {
  // The question asked is "what are YOU still carrying". An advisor that flagged something is
  // never asked it, and answering on its behalf would silently drop the one flag in the run
  // that nobody was in a position to settle.
  const { relay } = await run(t,
    ['do the thing\nFLAG: the goal names a file this repo does not have.', 'DONE'],
    ['ack', `Did it.\nFLAG: ${UNRUN}`, 'NONE'],
  )

  assert.deepEqual(
    relay.outstandingFlags().map((f) => [f.participant, f.text]),
    [['advisor', 'the goal names a file this repo does not have.']],
    "the advisor's flag stands: it was never asked, so nothing it said retired it",
  )
  assert.deepEqual(relay.supersededFlags().map((f) => f.participant), ['implementer'])
})
