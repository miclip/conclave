/**
 * `RelayOptions.maxAdvisorTurns`: the flag that sets it, and the words the operator sees.
 *
 * The option used to be called `maxRounds`, and both front-ends' `--rounds` flag now feeds it
 * under its new name. A rename that quietly stops populating the bound does not fail loudly --
 * the run simply falls through to the default of 6, which looks like a working relay to anyone
 * not counting turns. So the flag is asserted BEHAVIOURALLY, at two different values, through
 * `main()` and its argv parsing rather than around it: only a wire that is actually connected
 * makes the count follow the number.
 *
 * The second half is vocabulary. The pause a human reads carries the bound's ordinal, and that
 * sentence is the operator-facing name of this concept -- if it still says "round" then the
 * rename touched the code and not the product.
 *
 * The third is the deprecated `maxRounds` alias, kept so a caller that builds `RelayOptions`
 * by hand survives the rename. An alias nobody exercises is an alias that rots: it stays
 * compilable while quietly ceasing to reach the loop, and the caller it exists for finds out
 * by running six advisor turns where it asked for two. So the alias is asserted the same way
 * the flag is -- by counting turns -- and its precedence against the new name is pinned here
 * rather than left to be inferred from a `??`.
 *
 *   node --test src/relay/advisorTurns.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import { main } from '../../bin/conclave.ts'
import type { AgentSession } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { listSessions, recordSession } from '../workspace/sessionRecord.ts'
import { advisorTurnsLeftNotice } from './guardrails.ts'
import { boundOf, DEFAULT_ADVISOR_TURNS, Relay, type RelayOptions } from './relay.ts'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-advisor-turns-'))
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

async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const [log, error] = [console.log, console.error]
  console.log = () => {}
  console.error = () => {}
  try {
    return await work()
  } finally {
    console.log = log
    console.error = error
  }
}

function sink(): NodeJS.WritableStream {
  return new Writable({
    write(_c, _e, cb) {
      cb()
    },
  })
}

/**
 * An advisor that never stops steering, so the run can only end on the bound.
 *
 * Deliberately over-supplied: an exhausted `FakeRotationSession` replies with an empty string,
 * which the relay treats as a failure to instruct and halts on. That halt would end the run at
 * a turn count of its own, and the test would then be measuring the empty-reply guard while
 * appearing to measure the bound.
 */
function tirelessAdvisor(id: string, agent: string): FakeRotationSession {
  return new FakeRotationSession(
    id,
    agent,
    Array.from({ length: 40 }, (_, i) => `Do step ${i + 1}.`),
  )
}

function busyImplementer(id: string, agent: string): FakeRotationSession {
  return new FakeRotationSession(
    id,
    agent,
    Array.from({ length: 40 }, (_, i) => `Did step ${i + 1}.`),
  )
}

/**
 * Instructions the implementer was dispatched under `--rounds n`, via the given command.
 *
 * The implementer's first `send` is its briefing, which no advisor turn paid for; everything
 * after it is one dispatch, and one dispatch is one advisor turn. Counting on the implementer
 * rather than the advisor is the sharper measure: the advisor is asked once BEFORE the loop
 * starts, so its own tally is off by one from the thing being bounded.
 */
async function dispatchesUnder(command: 'relay' | 'session', n: number): Promise<number> {
  const dir = repo()
  const before = process.cwd()
  const advisor = tirelessAdvisor('advisor-1', 'fake-advisor')
  const impl = busyImplementer('impl-1', 'fake-impl')
  const registry = registryOf({ 'fake-advisor': [advisor], 'fake-impl': [impl] })
  try {
    // Both commands read `process.cwd()` as the run cwd and take no flag for it.
    process.chdir(dir)
    const code = await quietly(() =>
      main(
        [command, 'Keep the work moving.', '--advisor', 'fake-advisor', '--implementer', 'fake-impl', '--rounds', String(n)],
        command === 'session' ? { registry, input: new PassThrough(), output: sink() } : { registry },
      ),
    )
    assert.equal(code, 0, `conclave ${command} --rounds ${n} must succeed`)
  } finally {
    process.chdir(before)
    rmSync(dir, { recursive: true, force: true })
  }
  return impl.received.length - 1
}

/**
 * The same count, for a caller that builds `RelayOptions` by hand.
 *
 * No flag reaches the deprecated alias, so this is the only way to exercise it: the front-ends
 * deliberately do not populate it, and a test that went through `main()` could not distinguish
 * a working alias from an unread one.
 */
async function dispatchesWithOptions(over: Partial<RelayOptions>): Promise<number> {
  const dir = repo()
  const advisor = tirelessAdvisor('advisor-1', 'codex')
  const impl = busyImplementer('impl-1', 'claude')
  const relay = await Relay.start({
    registry: registryOf({ codex: [advisor], claude: [impl] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    ...over,
  })
  try {
    const outcome = await relay.run('Keep the work moving.')
    assert.equal(outcome.reason, 'budget', 'the run must end on the bound, not on some other condition')
  } finally {
    relay.stop()
    rmSync(dir, { recursive: true, force: true })
  }
  return impl.received.length - 1
}

test('--rounds still sets the bound, now under its new name, on `conclave relay`', async () => {
  // Two values, not one. A single number is satisfied by a hard-coded default that happens to
  // match; only a count that MOVES with the flag proves the flag is what is being read.
  const two = await dispatchesUnder('relay', 2)
  const four = await dispatchesUnder('relay', 4)
  assert.equal(two, 2, '--rounds 2 must buy exactly two advisor turns')
  assert.equal(four, 4, '--rounds 4 must buy exactly four advisor turns')
  assert.notEqual(four, 6, 'a bound of 6 is the default, which means the flag was dropped on the floor')
})

test('--rounds still sets the bound, now under its new name, on `conclave session`', async () => {
  // The console is the front-end this codebase has forgotten eight times; see
  // frontEndParity.test.ts. It reaches the same option by a different route --
  // `SessionOptions.rounds` -> `maxAdvisorTurns` -- so the rename could land on one and not
  // the other, and nothing else here would notice.
  const two = await dispatchesUnder('session', 2)
  const four = await dispatchesUnder('session', 4)
  assert.equal(two, 2, '--rounds 2 must buy exactly two advisor turns')
  assert.equal(four, 4, '--rounds 4 must buy exactly four advisor turns')
})

test('the pause a human reads counts advisor turns, not rounds', async (t) => {
  const dir = repo()
  const advisor = tirelessAdvisor('advisor-1', 'codex')
  const impl = busyImplementer('impl-1', 'claude')
  // Slow turns, so `requestPause()` lands while a turn is in flight and is honoured at the
  // next dispatch boundary -- the only place the loop can honour it, and the only place the
  // ordinal in the evidence is meaningful.
  advisor.delayMs = 20
  impl.delayMs = 20
  const relay = await Relay.start({
    registry: registryOf({ codex: [advisor], claude: [impl] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 5,
  })
  t.after(() => {
    relay.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  const run = relay.start('Keep the work moving.')
  const pause = await run.requestPause('the operator asked to pause')
  assert.ok(pause, 'requesting a pause must produce one')

  const evidence = pause.evidence.join('\n')
  // The bound the operator set is quoted back at them, so "how much run is left" is readable
  // from the pause without going to the flags they typed an hour ago.
  assert.match(
    evidence,
    /advisor turn \d+ of 5; no turn is in flight/,
    'the pause must say which advisor turn it stopped on, and out of how many',
  )
  assert.doesNotMatch(evidence, /\bround\b/i, 'no operator-facing text may still call an advisor turn a round')
  await run.abort()
})

// ---------------------------------------------------------------------------------------
// The deprecated `maxRounds` alias.
// ---------------------------------------------------------------------------------------

test('boundOf resolves the two fields, and the alias loses to the new name', () => {
  assert.equal(boundOf({ maxAdvisorTurns: 3 }), 3, 'the supported field is read')
  assert.equal(boundOf({ maxRounds: 3 }), 3, 'the alias is read when it is the only one given')
  assert.equal(
    boundOf({ maxAdvisorTurns: 2, maxRounds: 9 }),
    2,
    'a caller that sets both has added the new name over an old one it did not notice',
  )
  assert.equal(boundOf({}), DEFAULT_ADVISOR_TURNS, 'neither field means the default')
  // The pair the precedence rule is actually about. Written as its own assertion because
  // reversing the `??` operands still satisfies every case above where the values differ in
  // the other direction -- this is the one that catches it.
  assert.equal(boundOf({ maxAdvisorTurns: 9, maxRounds: 2 }), 9, 'precedence is by field, not by which value is smaller')
})

test('the deprecated maxRounds alias still reaches the dispatcher', async () => {
  // Behavioural, not a unit test of `boundOf`. The alias could resolve correctly in a helper
  // nothing calls; what the compatibility promise is worth is whether the LOOP honours it.
  // Two values again, for the same reason as the flag tests above.
  assert.equal(await dispatchesWithOptions({ maxRounds: 2 }), 2, 'maxRounds 2 must still buy two advisor turns')
  assert.equal(await dispatchesWithOptions({ maxRounds: 3 }), 3, 'maxRounds 3 must still buy three advisor turns')
})

test('maxAdvisorTurns wins over maxRounds in a real run', async () => {
  const turns = await dispatchesWithOptions({ maxAdvisorTurns: 2, maxRounds: 5 })
  assert.equal(turns, 2, 'the supported field decides the bound when both are supplied')
})

test('neither front-end populates the deprecated alias', () => {
  // The alias is a shim for external callers and must not become a second supported path
  // inside the product. Asserted against the source rather than behaviour: a front-end that
  // sets BOTH fields consistently would pass every behavioural test here while making the
  // deprecation undeletable, which is precisely the drift worth catching early.
  for (const path of [join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts'), join(import.meta.dirname, '..', 'repl', 'session.ts')]) {
    const source = readFileSync(path, 'utf8')
    assert.doesNotMatch(
      source,
      /\bmaxRounds\s*:/,
      `${basename(path)} must feed --rounds into maxAdvisorTurns, never into the deprecated alias`,
    )
    assert.match(source, /\bmaxAdvisorTurns\s*:/, `${basename(path)} must populate maxAdvisorTurns`)
  }
})

// ---------------------------------------------------------------------------------------
// What the ending SAYS. `budget` alone was one word for several different limits (#119).
// ---------------------------------------------------------------------------------------

/**
 * The whole outcome of a run that can only end by spending its advisor turns.
 *
 * Recorded as well as returned. The returned outcome is what an embedder reads and the status
 * document is what `conclave status --json` serves, and they are two different surfaces: the
 * detail is built in the dispatcher and carried to the record by `recording.set('ended', ...)`,
 * so a change that reached one and not the other is exactly the shape of defect this helper
 * has to be able to see. One run for both readings, for the reason `ceilings.test.ts` gives:
 * two runs could report a banner from one process and a document from another.
 */
async function budgetOutcomeAt(n: number): Promise<{ reason: string; detail: string; recorded: string }> {
  const dir = repo()
  const relay = await Relay.start({
    registry: registryOf({ codex: [tirelessAdvisor('advisor-1', 'codex')], claude: [busyImplementer('impl-1', 'claude')] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: n,
  })
  const recording = recordSession(relay, { repoRoot: dir, id: `budget-${n}`, goal: 'g', front: 'relay', startedAt: Date.now(), build: 'test-build' })
  try {
    const outcome = await relay.run('Keep the work moving.')
    recording.set('ended', { outcome })
    await recording.close()
    const sessions = listSessions(dir)
    assert.equal(sessions.length, 1, 'the run must have recorded exactly one session')
    return { reason: outcome.reason, detail: outcome.detail ?? '', recorded: sessions[0]!.status.outcome?.detail ?? '' }
  } finally {
    relay.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('an exhausted advisor budget says which ceiling it was and what it was set to', async () => {
  // #119: the run ended `budget` at 8 advisor turns nobody had chosen, and `budget` is the same
  // word a run gets when it exhausts a ceiling the operator set deliberately -- so the report
  // read as normal operation. For `--operator agent` the cost is higher still: an agent sees
  // one word and concludes the work was too large.
  //
  // Two values, not one, for the reason the flag tests above use two: a detail that hard-coded
  // a number would satisfy a single case while saying nothing true.
  const two = await budgetOutcomeAt(2)
  const five = await budgetOutcomeAt(5)

  // The REASON is unchanged and must stay unchanged: every caller keys on it, `relay` exits on
  // it, and a resource ceiling has its own reason (`ceiling`) that this must not become.
  assert.equal(two.reason, 'budget')
  assert.equal(five.reason, 'budget')

  assert.match(two.detail, /advisor turn budget spent: 2 of a maximum 2/)
  assert.match(five.detail, /advisor turn budget spent: 5 of a maximum 5/)
  // No flag is named. The relay does not know which front-end started it, and an embedder that
  // sets `maxAdvisorTurns` directly has no `--rounds` to raise; the launch banner owns flags.
  assert.doesNotMatch(five.detail, /--/)
  // And the same vocabulary rule the pause evidence is held to: this is operator-facing text.
  assert.doesNotMatch(five.detail, /\bround\b/i, 'no operator-facing text may still call an advisor turn a round')
})

/**
 * ...and whether anything was still being worked on when it ran out (#190).
 *
 * `budget` says the run stopped because its advisor turns were spent. It does not say whether
 * that happened with every report in hand or with a seat mid-turn, and those are two different
 * findings: the first is a run that used its allowance, the second is a run that was cut off
 * while work was still moving and whose last reports were drained on the way out. An operator
 * deciding whether to raise the budget and resume is deciding between exactly those two, and
 * before this the ending read identically for both.
 *
 * The question can only be asked at the boundary. Everything after it drains to nothing
 * outstanding before the run may end, so a detail composed at `#end` would answer "nothing was
 * in flight" on every run that has ever existed -- which is the failure mode this pins.
 */
test('an exhausted budget says whether work was still in flight when it ran out', async () => {
  // One seat, and the advisor is only asked once the report is back and processed -- so at the
  // boundary nothing is outstanding. The drained case is driven in concurrentDispatch.test.ts,
  // where two seats make "still working" a state a run can actually be in.
  const two = await budgetOutcomeAt(2)

  // `status --json` FIRST, and that ordering is deliberate. It is the surface an operator
  // actually polls, it is the one the returned outcome cannot speak for -- the detail is built
  // in the dispatcher and reaches the record only by being carried there -- and asserting it
  // ahead of the outcome is what makes a broken phrase fail HERE, where the message names the
  // document, rather than being masked by an identical claim about the return value.
  assert.match(
    two.recorded,
    /no work was in flight: every turn sent had been reported/,
    'status --json on a run that ended with every report in hand must say so, not leave it to be assumed',
  )
  assert.doesNotMatch(two.recorded, /was drained/, 'and status --json must not claim a drain that did not happen')
  // And the string an embedder is handed is that same string, so the two surfaces cannot drift.
  assert.equal(two.detail, two.recorded, 'the returned outcome and the recorded status must carry one detail, not two')
})

// ---------------------------------------------------------------------------------------
// What the advisor is TOLD about the bound, on the turn it is being asked to spend (#190).
// ---------------------------------------------------------------------------------------

/**
 * Every message the ADVISOR was sent on a run bounded at `n` advisor turns.
 *
 * `received[0]` is the opening briefing and goal, which the advisor answers as advisor turn 1;
 * `received[k]` is the message it answers as turn `k + 1`. Read off the fake rather than
 * reconstructed from the routing log, because the log records what was ROUTED and this is a
 * claim about the bytes the child was handed.
 */
async function advisorPromptsAt(n: number, replies?: string[]): Promise<string[]> {
  const dir = repo()
  const advisor = replies ? new FakeRotationSession('advisor-1', 'codex', replies) : tirelessAdvisor('advisor-1', 'codex')
  const relay = await Relay.start({
    registry: registryOf({ codex: [advisor], claude: [busyImplementer('impl-1', 'claude')] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: n,
  })
  try {
    await relay.run('Keep the work moving.')
    return [...advisor.received]
  } finally {
    relay.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The words, and this is the only test that quotes them.
 *
 * A bare number cannot carry this. "1 left" reads as "this turn" to one reader and "one more
 * after this" to another, and an advisor that guesses wrong either hands over a turn early or
 * is cut off mid-plan -- so both sentences state the convention rather than leaving it to be
 * inferred. Two bounds, not one, for the reason every other test in this file uses two: a
 * sentence hard-coded for a single case would satisfy it while saying nothing true.
 */
test('the opening prompt says in words which of the last two advisor turns this is', async () => {
  const one = await advisorPromptsAt(1)
  const two = await advisorPromptsAt(2)

  assert.match(one[0]!, /This is your last advisor turn\./, 'a run with one advisor turn must be told that turn is its last')
  assert.doesNotMatch(one[0]!, /2 advisor turns left/, 'and must not be offered a turn it does not have')

  assert.match(
    two[0]!,
    /You have 2 advisor turns left, including this one\./,
    'a run with two must be told the count AND that this turn is one of the two',
  )
  assert.doesNotMatch(two[0]!, /This is your last advisor turn\./, 'the first of two turns is not the last one')
})

/**
 * Above the threshold, nothing -- and asserted as byte identity rather than as an absence.
 *
 * A test that only grepped for the sentences would pass on a block that said "you have 3
 * advisor turns left", which is the failure this is guarding: the default run must be briefed
 * exactly as it always was, and the only way to say "exactly" is to compare it with one.
 * Three against six, because three is the first bound above the threshold and six is the
 * default -- if the two prompts are the same string, no bound below the threshold leaked.
 */
test('above the threshold the advisor is told nothing at all, byte for byte', async () => {
  const three = await advisorPromptsAt(3)
  const six = await advisorPromptsAt(6)

  assert.equal(three[0], six[0], 'a run three turns from its bound must be briefed exactly as one six turns from it')
  assert.doesNotMatch(three[0]!, /turns? left|last advisor turn/i, 'and no ceiling may be mentioned at all')
})

/**
 * WHICH turn the count is about: the one the reply will be spent on, not the one that asked.
 *
 * The hand-back at the end of an advisor turn is what the NEXT turn answers, so a count taken
 * from the turn doing the asking is off by one and the warning lands a turn late -- which on a
 * two-turn threshold means it lands on the final turn, where it is too late to be useful.
 *
 * Asserted against `advisorTurnsLeftNotice` rather than against the quoted sentences, and that
 * is deliberate: this test is about the arithmetic and the wiring, so rewording the sentences
 * must not fail it. The test above owns the words.
 */
test('the warning arrives on the turn before the last, counted as the turn the reply becomes', async () => {
  const at3 = await advisorPromptsAt(3)
  const twoLeft = advisorTurnsLeftNotice(2, 3)
  const lastTurn = advisorTurnsLeftNotice(3, 3)
  assert.notEqual(twoLeft, '', 'the fixture is only meaningful if turn 2 of 3 is inside the threshold')
  assert.notEqual(lastTurn, '', 'and if turn 3 of 3 is the final one')
  assert.ok(at3.length >= 3, `the advisor must have been asked at least three times, was asked ${at3.length}`)

  assert.ok(at3[1]!.includes(twoLeft), 'the message answered as turn 2 of 3 must carry the two-turn warning')
  assert.ok(!at3[1]!.includes(lastTurn), 'and must not already call it the last')
  assert.ok(at3[2]!.includes(lastTurn), 'the message answered as turn 3 of 3 must say it is the last')
})

/**
 * A re-ask is not a turn, and must not be counted as one.
 *
 * A reply that was only a NOTE is asked again for the instruction that goes with it, inside the
 * same advisor turn and at no cost to the bound. If that re-ask carried the next turn's count
 * the advisor would be told it was on its last turn while it still had two, and would hand over
 * a turn early -- the exact failure the threshold exists to prevent, produced by the fix for it.
 */
test("a re-ask inside an advisor turn carries that turn's count, not the next turn's", async () => {
  const prompts = await advisorPromptsAt(2, ['NOTE: worth recording.', ...Array.from({ length: 8 }, (_, i) => `Do step ${i + 1}.`)])
  const reask = prompts.find((p) => /Your note is recorded for the operator/.test(p))
  assert.ok(reask, 'the note-only reply must have been re-asked for an instruction')

  const turnOne = advisorTurnsLeftNotice(1, 2)
  assert.notEqual(turnOne, '', 'the fixture is only meaningful if turn 1 of 2 is inside the threshold')
  assert.ok(reask.includes(turnOne), 'the re-ask belongs to advisor turn 1, so it must carry turn 1 of 2')
  assert.ok(!reask.includes(advisorTurnsLeftNotice(2, 2)), 'and must not have advanced the count by re-asking')
})

/**
 * WHICH turn a re-ask belongs to is not one answer for all four of them (#190).
 *
 * Three of the four re-asks end with a bare `continue`, which goes round the labelled `advisor`
 * loop and increments the counter BEFORE the reply they fetched is read -- so those replies are
 * spent on `advisorTurn + 1`. The fourth, the NOTE-only re-ask, falls through and is read inside
 * the same iteration, so it is spent on `advisorTurn`. Reading them all as "the same turn" put
 * three of them one turn behind, which on a two-turn threshold is the difference between an
 * advisor being told to plan a hand-over and being told it has one more turn than it has.
 *
 * Every bound here is 2 and every halt lands on advisor turn 1, so the two sentences are BOTH
 * in range and the wrong count is a different sentence rather than an absent one: an off-by-one
 * shows up as "you have 2 left" where "this is your last" belongs, which no absence test could
 * tell from a notice that simply failed to be attached.
 */
async function promptsAcrossAPause(n: number, replies: string[]): Promise<{ prompts: string[]; pause: string }> {
  const dir = repo()
  const advisor = new FakeRotationSession('advisor-1', 'codex', replies)
  const relay = await Relay.start({
    registry: registryOf({ codex: [advisor], claude: [busyImplementer('impl-1', 'claude')] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: n,
  })
  try {
    const run = relay.start('Keep the work moving.')
    const settled = await run.settled()
    assert.equal(settled.kind, 'paused', `the run must pause for the operator, got ${JSON.stringify(settled)}`)
    const pause = settled.kind === 'paused' ? settled.pause.reason : ''
    await run.continue()
    await run.settled()
    return { prompts: [...advisor.received], pause }
  } finally {
    await relay.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the re-ask after a turn that produced no instruction counts the turn its reply is spent on', async () => {
  const { prompts, pause } = await promptsAcrossAPause(2, ['', ...Array.from({ length: 8 }, (_, i) => `Do step ${i + 1}.`)])
  assert.ok(pause !== '', 'the empty reply must have raised a pause for the operator')
  const reask = prompts.find((p) => /Your previous turn produced no instruction/.test(p))
  assert.ok(reask, `the resumed run must have asked again: ${JSON.stringify(prompts.map((p) => p.slice(0, 40)))}`)

  // The halt was on advisor turn 1, the `continue` after this re-ask makes its reply turn 2, and
  // 2 of 2 is the last turn. Asserted as the presence of one sentence and the absence of the
  // other, because an off-by-one here produces a sentence rather than a silence.
  assert.ok(reask.includes(advisorTurnsLeftNotice(2, 2)), 'the reply is spent on turn 2 of 2, so it must be told that turn is its last')
  assert.ok(!reask.includes(advisorTurnsLeftNotice(1, 2)), 'and must not be offered the two-turn count it has already spent one of')
})

test('the re-ask after a resumed escalation counts the turn its reply is spent on', async () => {
  const { prompts, pause } = await promptsAcrossAPause(2, ['ESCALATE: I need a human.', ...Array.from({ length: 8 }, (_, i) => `Do step ${i + 1}.`)])
  assert.equal(pause, 'advisor_escalated', 'the escalation must be what stopped the run')
  const reask = prompts.find((p) => /The human has seen your escalation/.test(p))
  assert.ok(reask, `the resumed run must have asked again: ${JSON.stringify(prompts.map((p) => p.slice(0, 40)))}`)

  assert.ok(reask.includes(advisorTurnsLeftNotice(2, 2)), 'the reply is spent on turn 2 of 2, so it must be told that turn is its last')
  assert.ok(!reask.includes(advisorTurnsLeftNotice(1, 2)), 'and must not be offered a turn the escalation already spent')
})

test('the re-ask after DONE over an outstanding human instruction counts the turn its reply is spent on', async () => {
  // No pause on this path: the human outranks the advisor, so a DONE that would strand a human
  // message does not end the run -- the seat is asked, its answer is handed over, and the loop
  // goes round. The `continue` that does so is what makes the reply the next turn's.
  const dir = repo()
  const advisor = new FakeRotationSession('advisor-1', 'codex', ['DONE', ...Array.from({ length: 8 }, (_, i) => `Do step ${i + 1}.`)])
  // A distinguishable answer to the human, because the advisor receives two reports on this run
  // and the one under test is the FIRST -- the seat answering the human before the loop goes
  // round -- which no generic "Did step 1." could be told apart from the ordinary dispatch after.
  const impl = new FakeRotationSession('impl-1', 'claude', ['ack', 'ANSWERED THE HUMAN', ...Array.from({ length: 8 }, (_, i) => `Did step ${i + 1}.`)])
  const relay = await Relay.start({
    registry: registryOf({ codex: [advisor], claude: [impl] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 2,
  })
  try {
    relay.say('Also check the README before you finish.', { only: 'implementer' }, 'aside')
    await relay.run('Keep the work moving.')
    const handover = advisor.received.find((p) => /ANSWERED THE HUMAN/.test(p))
    assert.ok(
      handover,
      `the seat's answer to the human must have reached the advisor: ${JSON.stringify(advisor.received.map((p) => p.slice(0, 40)))}`,
    )
    assert.ok(handover.includes(advisorTurnsLeftNotice(2, 2)), 'the reply is spent on turn 2 of 2, so it must be told that turn is its last')
    assert.ok(!handover.includes(advisorTurnsLeftNotice(1, 2)), 'and must not be offered the count of a turn DONE already spent')
  } finally {
    relay.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
