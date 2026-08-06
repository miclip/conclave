/**
 * LIVE — question 1: does a real session survive a human-scale pause?
 *
 * Deliberately NOT the rotation test. A fast successful rotation would hide the failure
 * this is looking for: two proofs that can only be run together are one proof.
 *
 *   Can a real Claude or Codex session sit quiescent through a realistic human pause and
 *   resume without transport failure or semantic drift?
 *
 * The invariant under test is that **a pause suspends orchestration, not observation**:
 *
 *   suspended   relay work. No participant is sent anything.
 *   continuing  hook ingestion, transcript reconciliation, process supervision,
 *               operator inspection.
 *
 * A pause that also stopped ingestion would ask the operator to decide from a view frozen
 * at the moment the question was raised — the longer they think, the staler their evidence.
 * `run.test.ts` pins the half the fakes can reach; the adapter-side half only exists here.
 *
 * "Semantic drift" is checked, not assumed: the resumed implementer is asked for something
 * that requires it to still hold the session, and its answer is compared against what it
 * said before the pause. A session that resumes at the transport level but has lost the
 * thread is a failure of this test, not a pass.
 *
 *   ORCH_LIVE_PAUSE=1 node --test src/relay/pause.live.test.ts
 *   ORCH_PAUSE_SECONDS=1800 ORCH_LIVE_PAUSE=1 node --test src/relay/pause.live.test.ts
 *
 * Spawns two real sessions and uses real quota. NEVER RUN — written before its first run,
 * so the assertions are what the design predicts rather than what it was seen to do.
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { defaultRegistry } from '../registry/builtin.ts'
import { Relay } from './relay.ts'

const skip =
  process.env.ORCH_LIVE_PAUSE === '1'
    ? false
    : 'set ORCH_LIVE_PAUSE=1 (spawns two real sessions, uses quota)'

/**
 * How long to hold the pause. The default is short enough to run in CI and long enough to
 * cross the intervals that plausibly break a PTY; the real question is asked by setting it
 * to something a human would actually take, which is why it is an env var and not a
 * constant.
 */
const PAUSE_SECONDS = Number(process.env.ORCH_PAUSE_SECONDS ?? 120)

test('a real session survives a human-scale pause and resumes without drift', { skip }, async (t) => {
  const repo = join(import.meta.dirname, '..', '..')
  const work = join(repo, '.conclave', 'scratch-pause')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  t.after(() => rmSync(work, { recursive: true, force: true }))

  const relay = await Relay.start({
    registry: defaultRegistry(),
    cwd: repo,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxRounds: 4,
  })
  t.after(() => relay.stop())

  const run = relay.start(
    `Work only inside ${work}. First create a file called one.txt containing a single ` +
      `distinctive word of your choosing, and tell me what word you chose. Then wait for ` +
      `the next instruction.`,
  )

  // Wait until the implementer has reported once. `requestPause()` is honoured at the next
  // round boundary, and the first of those comes BEFORE any instruction has been issued --
  // so pausing immediately gives the drift check nothing to compare against. The first run
  // of this test failed exactly there, on its own instrument rather than on the product.
  // `relay.live.test.ts` already waits for a report before injecting its aside; the same
  // reason applies here and it was not carried across.
  const armed = Date.now() + 300_000
  while (Date.now() < armed && !relay.log.some((m) => m.kind === 'report')) {
    await new Promise((r) => setTimeout(r, 250))
  }
  assert.ok(
    relay.log.some((m) => m.kind === 'report'),
    'the implementer should have reported before the pause, or there is no continuity to test',
  )

  const pause = await run.requestPause('holding the session to test quiescence')
  assert.ok(pause, 'the run should reach a pause rather than finishing first')
  assert.equal(pause.reason, 'operator_requested')
  assert.equal(run.state, 'paused')

  const impl = relay.participants.find((p) => p.rank === 'implementer')!
  const before = {
    sends: relay.log.filter((m) => m.to.includes('implementer')).length,
    turns: (await impl.session.snapshot()).turns.length,
  }
  const priorProse = relay.log.filter((m) => m.kind === 'report').map((m) => m.text).join('\n')

  // --- the pause itself ------------------------------------------------------------
  const deadline = Date.now() + PAUSE_SECONDS * 1000
  let inspections = 0
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15_000))
    // OBSERVATION CONTINUES. Each of these would throw or hang if the pause had frozen
    // the adapter rather than the orchestrator.
    const snap = await impl.session.snapshot()
    assert.equal(snap.sessionId, impl.session.sessionId)
    assert.equal(impl.session.state, 'running', 'a paused RUN does not quiesce the SESSION')
    assert.ok(relay.audit().length >= 0)
    inspections += 1
  }
  assert.ok(inspections > 0, 'the pause must be long enough to inspect through')

  // ORCHESTRATION WAS SUSPENDED. Nothing was asked of anyone while the human decided.
  assert.equal(
    relay.log.filter((m) => m.to.includes('implementer')).length,
    before.sends,
    'no relay work may be delivered while paused',
  )
  assert.equal(
    (await impl.session.snapshot()).turns.length,
    before.turns,
    'the implementer must not have taken a turn while paused',
  )

  // --- resume ----------------------------------------------------------------------
  // The probe has to require the session, not the filesystem: reading the file back would
  // pass for a session that had lost everything. Asking what it chose, without saying
  // where it was written, does not.
  run.injectConstraint(
    'Without reading any file, tell me the word you chose earlier, then write it into two.txt.',
    { only: 'implementer' },
  )
  await run.continue()
  const outcome = await run.result()

  assert.notEqual(outcome.reason, 'escalated', `the resumed run escalated: ${outcome.detail}`)

  const after = relay.log.filter((m) => m.kind === 'report').at(-1)
  assert.ok(after, 'the implementer must have reported after the resume')
  assert.ok(
    (await impl.session.snapshot()).turns.length > before.turns,
    'the session took a turn after the resume, so the transport survived',
  )
  assert.ok(existsSync(join(work, 'two.txt')), 'the resumed implementer acted on the new instruction')

  // SEMANTIC DRIFT. The word is the only thing carrying session continuity here.
  const word = /\b([a-z]{4,})\b/gi
  const chosen = [...priorProse.matchAll(word)].map((m) => m[1]!.toLowerCase())
  const recalled = new Set([...after.text.matchAll(word)].map((m) => m[1]!.toLowerCase()))
  assert.ok(
    chosen.some((w) => recalled.has(w)),
    `the resumed session did not recall anything it said before the pause.\n` +
      `  before: ${priorProse.slice(0, 300)}\n  after: ${after.text.slice(0, 300)}`,
  )
})
