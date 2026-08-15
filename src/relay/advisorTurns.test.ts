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

/** The whole outcome of a run that can only end by spending its advisor turns. */
async function budgetOutcomeAt(n: number): Promise<{ reason: string; detail: string }> {
  const dir = repo()
  const relay = await Relay.start({
    registry: registryOf({ codex: [tirelessAdvisor('advisor-1', 'codex')], claude: [busyImplementer('impl-1', 'claude')] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: n,
  })
  try {
    const outcome = await relay.run('Keep the work moving.')
    return { reason: outcome.reason, detail: outcome.detail ?? '' }
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
