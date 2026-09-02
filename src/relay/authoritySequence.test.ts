/**
 * #171 as the run actually experienced it: one aside, four advisor instructions, three pauses.
 *
 * `authorityReconciliation.test.ts` proves the RULES against a `RestrictedOrigin` built by
 * hand. That is the right level for the rules and the wrong level for the complaint, which is
 * about a run: the operator answered a pause, the run went on, and the same origin stopped it
 * again. Nothing at the record level can fail if the relay never calls the record, never
 * carries the mutation across the pause boundary, or keys its adjudication in a way that makes
 * the second pause impossible for a reason unrelated to reconciliation.
 *
 * So this drives the real loop, with fake children and a real git repository, through the
 * whole sequence in one run:
 *
 *   1. an aside to the implementer alone, and an advisor instruction that reverses it  -> PAUSE
 *   2. `/continue`, then a DIFFERENTLY WORDED instruction against the same origin       -> PAUSE
 *   3. the operator broadcasts the aside in full through the paused operator path
 *   4. a third instruction, matching the same origin as squarely as the first two       -> none
 *   5. a NEW aside, and an instruction reversing that one                               -> PAUSE
 *
 * Step 2 is what says `/continue` disarms nothing, and it has to be differently worded: the
 * relay records an adjudication as `originSeq:instruction`, so repeating the instruction
 * verbatim would be quiet for a reason that has nothing to do with the origin. Step 5 is the
 * falsifier for step 4 -- without it, "no pause" is equally consistent with a detector that
 * has been switched off.
 *
 * THE FALSIFIER STEP 4 ACCEPTS. After a full delivery the origin goes silent for EVERY later
 * instruction, including one that genuinely reverses the work. That is a real loss of
 * detection and it is taken deliberately: the mechanism guards HIDDEN AUTHORITY -- an advisor
 * undoing what it was never allowed to see -- not the judgment of an advisor that has now been
 * shown the message. An informed advisor proposing to undo human-originated work is ordinary
 * disagreement, which §5c says the orchestrator must not adjudicate; the aside's author is in
 * the room, has just quoted it to both seats, and is reading the instruction. Suppressing on
 * an UNINFORMED advisor's overlap would be the false negative that matters. This one is a
 * pause the human already answered by hand.
 *
 *   node --test src/relay/authoritySequence.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { Relay } from './relay.ts'
import type { RunPause } from './run.ts'

/** A real repository, because `dirtyPaths` runs against the root on every restricted message. */
function tempRepo(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-authority-seq-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  execFileSync('git', ['init', '--quiet'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'README.md'), '# hello')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: dir })
  return dir
}

function registryOf(advisor: FakeRotationSession, impl: FakeRotationSession): AgentRegistry {
  const r = new AgentRegistry()
  for (const [agent, session] of [
    ['codex', advisor],
    ['claude', impl],
  ] as const) {
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

/** The aside, and the four instructions that meet it. Each is quoted once. */
const ASIDE = 'Also write the word into two.txt, and leave it there.'
const REVERSE_1 = 'Remove two.txt and wait.'
const REVERSE_2 = 'Delete two.txt now — it should never have been created.'
const REVERSE_3 = 'Discard two.txt entirely and move on.'
const SECOND_ASIDE = 'Now write the same word into three.txt as well.'
const REVERSE_SECOND = 'Remove three.txt, it is clutter.'

/**
 * The whole message, inside the sentence an operator types at a pause.
 *
 * Through `run.injectConstraint(text, 'all')`, which IS the console's paused path: a reply
 * typed at a pause reaches `answerPause`, which calls `inject(text, 'all')` and then resumes
 * (src/repl/session.ts:1621). Nothing here is a shortcut around the front end.
 */
const BROADCAST =
  `Both of you, for the record — this is what I sent the implementer earlier, in full: ` +
  `${ASIDE} That is the entire message. The advisor has it now.`

test('one aside, three pauses, and the broadcast that ends them (#171)', async (t) => {
  const repo = tempRepo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'Get started.',
    REVERSE_1,
    REVERSE_2,
    REVERSE_3,
    REVERSE_SECOND,
    'DONE',
  ])
  const impl = new FakeRotationSession('impl', 'claude', [
    'Starting.',
    'Wrote two.txt.',
    'Acknowledged.',
    'Acknowledged.',
    'Acknowledged.',
    'Acknowledged.',
  ])
  const relay = await Relay.start({
    registry: registryOf(advisor, impl),
    cwd: repo,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxRounds: 8,
  })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const asideMsg = relay.say(ASIDE, { only: 'implementer' }, 'aside')
  const origin = relay.restrictedOrigins[0]!
  assert.equal(origin.seq, asideMsg.seq)
  assert.deepEqual(origin.excluded, ['advisor'], 'armed against the advisor')

  /** Every pause the run raised, in order, with the instruction that caused it. */
  const pauses: RunPause[] = []
  const conflictAt = (p: RunPause) => {
    assert.equal(p.reason, 'authority_conflict', `expected an authority_conflict, got ${p.reason}`)
    return p.conflict!
  }

  // --- 1. the first reversal pauses -------------------------------------------------
  let step = await run.settled()
  assert.equal(step.kind, 'paused')
  pauses.push(step.pause)
  const first = conflictAt(step.pause)
  assert.equal(first.instruction, REVERSE_1)
  assert.equal(first.origin.seq, origin.seq)
  assert.deepEqual(first.matched, ['two.txt'])
  assert.deepEqual(first.origin.reconciled, [], 'nothing has been handed over')

  // --- 2. `/continue` alone, then a differently worded reversal of the SAME origin ---
  await run.continue()
  step = await run.settled()
  assert.equal(step.kind, 'paused', 'continuing answers one pause and disarms no origin')
  pauses.push(step.pause)
  const second = conflictAt(step.pause)
  assert.equal(second.instruction, REVERSE_2, 'and the wording differs, so this is not the adjudication key')
  assert.equal(second.origin.seq, origin.seq, 'the same aside, cited again')
  assert.deepEqual(relay.restrictedOrigins[0]!.excluded, ['advisor'], 'still withheld after a continue')

  // --- 3. the operator broadcasts the message in full, through the paused path -------
  const delivery = run.injectConstraint(BROADCAST, 'all')
  const reconciled = relay.restrictedOrigins[0]!
  assert.deepEqual(reconciled.excluded, [], 'the advisor is no longer in the dark')
  assert.deepEqual(reconciled.informed, ['implementer', 'advisor'])
  assert.deepEqual(reconciled.reconciled, [{ participant: 'advisor', seq: delivery.seq }])

  // --- 4. a third reversal, matching as squarely as the first two, does not pause ----
  //
  // And it is a GENUINE reversal, not a relay of the aside: `discard two.txt` opposes "write
  // the word into two.txt, and leave it there" as plainly as `remove` did. This is the
  // falsifier the file header records -- the detection really is given up, on the ground that
  // an advisor holding the message is disagreeing rather than acting on an asymmetry.
  await run.continue()
  const secondAside = relay.say(SECOND_ASIDE, { only: 'implementer' }, 'aside')

  // --- 5. a NEW restricted message is armed exactly as the first was ----------------
  step = await run.settled()
  assert.equal(step.kind, 'paused', 'a new asymmetry still stops the run')
  pauses.push(step.pause)
  const third = conflictAt(step.pause)
  assert.equal(third.instruction, REVERSE_SECOND)
  assert.equal(third.origin.seq, secondAside.seq, 'the NEW aside, not the reconciled one')
  assert.deepEqual(third.matched, ['three.txt'])

  await run.continue()
  const outcome = await run.result()
  assert.equal(outcome.reason, 'done', `the run finished: ${outcome.detail ?? ''}`)

  // --- what the run as a whole did --------------------------------------------------
  assert.equal(pauses.length, 3, 'three pauses, and REVERSE_3 is the one that is missing')
  assert.deepEqual(
    pauses.map((p) => p.conflict!.instruction),
    [REVERSE_1, REVERSE_2, REVERSE_SECOND],
    'the reconciled origin raised nothing after the broadcast, and only it went quiet',
  )
  // The routing log is untouched by any of it: what happened at that seq is that it was
  // withheld, and `audit()` is defined over the log. Both asides are still reported as
  // withheld from the advisor, the reconciled one included.
  const withheldAt = new Map(relay.audit().map((a) => [a.seq, a.excluded]))
  assert.deepEqual(withheldAt.get(asideMsg.seq), ['advisor'], 'the reconciled aside is still in the audit')
  assert.deepEqual(withheldAt.get(secondAside.seq), ['advisor'])
  // Only the two asides are ORIGINS. The adjudications the relay sends after each continue are
  // human messages to one participant, so the log marks them restricted and the audit lists
  // them -- and `#adjudicate` deliberately registers none of them, or answering one conflict
  // would arm the next.
  assert.deepEqual(
    relay.restrictedOrigins.map((o) => o.seq),
    [asideMsg.seq, secondAside.seq],
    'an adjudication is not work, so nothing can be detected as reversing it',
  )
  // And the run says the reconciliation happened, once, naming the seat.
  const notes = relay.log.filter(
    (m) => m.kind === 'note' && m.text.includes(`reproduced restricted message #${origin.seq}`),
  )
  assert.equal(notes.length, 1)
  assert.ok(notes[0]!.text.includes('advisor'))
})

test('the delivery a reader sees carries the record it caused, and the note follows it (#171)', async (t) => {
  // Two orders, and they are not the same order.
  //
  // The MUTATION has to be visible by the time the delivery reaches `onLog` and the event
  // stream, because that is where a front end, the session record and `relay --json` all read
  // the world from, and each can reach `restrictedOrigins` synchronously while handling the
  // message. Reconciling after them published one frame in which the delivery had happened and
  // the record still said the advisor had never seen it -- and a reader that snapshots on the
  // message would persist that frame as the last word.
  //
  // The NOTE has to arrive after the delivery, because a note explaining a message cannot
  // precede it in the log a human reads back.
  const repo = tempRepo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', ['DONE'])
  const impl = new FakeRotationSession('impl', 'claude', [])

  /** What the record said at the moment each message was published. */
  const seen: { seq: number; kind: string; excluded: string[]; reconciled: number }[] = []
  // `onLog` fires during `Relay.start` -- the join notices are logged before it returns -- so
  // the callback cannot close over the binding it is being passed to. It reads through a
  // holder instead, which is empty for exactly those boot messages and set for every message
  // this test is about.
  let ref: Relay | undefined
  const relay = await Relay.start({
    registry: registryOf(advisor, impl),
    cwd: repo,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxRounds: 2,
    onLog: (m) => {
      const o = ref?.restrictedOrigins[0]
      seen.push({
        seq: m.seq,
        kind: m.kind,
        excluded: [...(o?.excluded ?? [])],
        reconciled: o?.reconciled.length ?? 0,
      })
    },
  })
  ref = relay
  t.after(() => relay.stop())

  const asideMsg = relay.say(ASIDE, { only: 'implementer' }, 'aside')
  assert.deepEqual(relay.restrictedOrigins[0]!.excluded, ['advisor'], 'withheld before the delivery')

  const delivery = relay.say(`For the record, both of you: ${ASIDE} That is all of it.`, 'all')

  // Not asserted at the ASIDE's own frame, and the difference is worth naming: `say` pushes
  // the origin AFTER `#record` returns, so an observer handling the aside itself sees no
  // origin for it yet. That is how it has always been and this change does not touch it --
  // what this change is about is the frame in which a message RETIRES an origin that already
  // exists, where a reader really can read a stale record for one that is already live.
  const atDelivery = seen.find((s) => s.seq === delivery.seq)!
  assert.deepEqual(atDelivery.excluded, [], 'the delivery publishes with the record already moved')
  assert.equal(atDelivery.reconciled, 1, 'and with the hand-over already recorded')

  // The note is a separate, LATER message. Same rule, stated as an ordering rather than as a
  // property of one entry, because it is the half that the mutation-first change could have
  // broken by hoisting the note with it.
  const after = seen.filter((s) => s.seq > delivery.seq)
  assert.equal(after.length, 1, 'exactly one message follows the delivery')
  assert.equal(after[0]!.kind, 'note')
  assert.equal(
    relay.log.find((m) => m.seq === after[0]!.seq)!.text.includes(`reproduced restricted message #${asideMsg.seq}`),
    true,
  )
  assert.deepEqual(
    seen.map((s) => s.seq),
    relay.log.map((m) => m.seq),
    'and nothing was reordered: onLog still sees the log in log order',
  )
})

test('handing the aside to the advisor alone settles it, and arms nothing new (#171)', async (t) => {
  // The operator's other move, and the one that says the relay must NAME the advisor when it
  // asks the detector. The implementer already has the message, so there is only one seat to
  // tell -- and a human message to one participant is itself restricted, which registers a
  // SECOND origin whose excluded list is the implementer.
  //
  // Both origins must then be quiet for the advisor's next instruction, for two different
  // reasons: the first because the advisor has now been given it, the second because the
  // advisor was never excluded from it. A detector that asked "is anybody still excluded"
  // rather than "is the ADVISOR" would pass the first and pause on the second -- an advisor
  // stopped for withholding a message from the implementer that the operator sent to the
  // advisor at the advisor's own request.
  const repo = tempRepo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', ['Get started.', REVERSE_1, REVERSE_2, 'DONE'])
  const impl = new FakeRotationSession('impl', 'claude', [
    'Starting.',
    'Wrote two.txt.',
    'Acknowledged.',
    'Acknowledged.',
  ])
  const relay = await Relay.start({
    registry: registryOf(advisor, impl),
    cwd: repo,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxRounds: 6,
  })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const asideMsg = relay.say(ASIDE, { only: 'implementer' }, 'aside')

  const first = await run.settled()
  assert.equal(first.kind, 'paused')
  assert.equal(first.pause.conflict!.origin.seq, asideMsg.seq)

  // To the advisor alone. This is `>advisor <text>` at the prompt, which is `inject(rest,
  // { only: who })` (src/repl/session.ts:2559).
  const delivery = run.injectConstraint(BROADCAST, { only: 'advisor' })
  assert.equal(delivery.visibility, 'restricted', 'a human message to one seat is restricted')
  assert.deepEqual(delivery.excluded, ['implementer'], 'and the implementer is the one left out of it')

  const [reconciled, second] = relay.restrictedOrigins
  assert.deepEqual(reconciled!.excluded, [], 'the aside is settled')
  assert.deepEqual(reconciled!.reconciled, [{ participant: 'advisor', seq: delivery.seq }])
  assert.equal(second!.seq, delivery.seq, 'and the delivery itself is now an origin')
  assert.deepEqual(second!.excluded, ['implementer'], 'with a non-empty excluded list')
  assert.ok(second!.tokens.includes('two.txt'), 'quoting the aside, so it matches everything the aside did')

  await run.continue()
  const outcome = await run.result()
  assert.equal(outcome.reason, 'done', `no second pause: ${outcome.detail ?? ''}`)
  assert.equal(
    relay.log.filter((m) => m.text.startsWith('paused (authority_conflict')).length,
    1,
    'one pause in the whole run, and REVERSE_2 was not it',
  )
})
