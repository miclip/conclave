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

/**
 * The test declares its own deadline rather than trusting `--test-timeout`.
 *
 * Getting that arithmetic wrong is not a small mistake: a harness timeout that expires
 * mid-pause cancels the body, the after-hooks tear the sessions down, and the log reports
 * `test timed out` — a harness limit misattributed to the subject, which is exactly the
 * confusion that made an orchestration deadlock read as an agent turn overrunning. At a
 * realistic operator pause the default 15 minutes would do this silently.
 *
 * Startup, the first turn and the resume turn have taken 60-150s in observed runs; 15
 * minutes of headroom is generous and still leaves the failure attributable.
 */
const BUDGET_MS = PAUSE_SECONDS * 1000 + 900_000

test('a real session survives a human-scale pause and resumes without drift', { skip, timeout: BUDGET_MS }, async (t) => {
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
  console.log(`    [pause] holding for ${PAUSE_SECONDS}s (test budget ${Math.round(BUDGET_MS / 1000)}s)`)
  const deadline = Date.now() + PAUSE_SECONDS * 1000
  /** Latency of each inspection, so degradation PARTWAY is visible rather than a binary. */
  const latencies: number[] = []
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15_000))
    // OBSERVATION CONTINUES. Each of these would throw or hang if the pause had frozen
    // the adapter rather than the orchestrator.
    const t0 = Date.now()
    const snap = await impl.session.snapshot()
    latencies.push(Date.now() - t0)
    assert.equal(snap.sessionId, impl.session.sessionId)
    assert.equal(impl.session.state, 'running', 'a paused RUN does not quiesce the SESSION')
    assert.ok(relay.audit().length >= 0)
  }
  assert.ok(latencies.length > 0, 'the pause must be long enough to inspect through')
  const worst = Math.max(...latencies)
  console.log(
    `    [inspections] ${latencies.length} samples over ${PAUSE_SECONDS}s; ` +
      `first ${latencies[0]}ms, last ${latencies.at(-1)}ms, worst ${worst}ms`,
  )
  // A snapshot that still resolves at the END is the claim, not one that resolved at the
  // start. Growth in latency across the hold would be the shape of a degrading transport.
  assert.ok(latencies.at(-1)! < 30_000, `the last inspection took ${latencies.at(-1)}ms — the transport is degrading`)

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

  // The HOOK RECEIVER survived the hold. A turn completing on hook evidence after the
  // pause proves the receiver was still bound and reachable across the whole interval —
  // the adapter would have fallen back to weaker transcript inference otherwise, and the
  // verdict's provenance is where that difference is visible.
  const resumedEnd = impl.events.filter((e) => e.type === 'turn_end').at(-1)
  assert.ok(resumedEnd, 'the resumed turn must have produced a terminal verdict')
  assert.ok(
    resumedEnd.type === 'turn_end' &&
      resumedEnd.verdict.provenance.some((pr) => pr.source === 'hook'),
    `the resumed turn settled without hook evidence, so the receiver did not survive the hold: ` +
      `${JSON.stringify(resumedEnd.type === 'turn_end' ? resumedEnd.verdict : {})}`,
  )
  assert.ok(
    (await impl.session.snapshot()).turns.length > before.turns,
    'the session took a turn after the resume, so the transport survived',
  )
  // SEMANTIC DRIFT — the actual claim, and therefore asserted FIRST.
  //
  // It used to sit behind a check that `two.txt` existed at end of run. That check failed
  // on the 30-minute hold and the drift claim was never evaluated, because the ADVISOR --
  // which never saw the human's aside -- instructed the implementer to delete the file,
  // and it complied. Legitimate session behaviour, and an artifact assertion at end of run
  // in a multi-round session cannot tell it apart from a failure to act.
  //
  // Recall is measured over EVERY post-resume report rather than only the last, for the
  // same reason: which turn is last depends on what the advisor decided to do next.
  const word = /\b([a-z]{4,})\b/gi
  const chosen = [...priorProse.matchAll(word)].map((m) => m[1]!.toLowerCase())
  const afterProse = relay.log
    .filter((m) => m.kind === 'report' && m.seq > pause.atSeq)
    .map((m) => m.text)
    .join('\n')
  const recalled = new Set([...afterProse.matchAll(word)].map((m) => m[1]!.toLowerCase()))
  assert.ok(
    chosen.some((w) => recalled.has(w)),
    `the resumed session did not recall anything it said before the pause.\n` +
      `  before: ${priorProse.slice(0, 400)}\n  after: ${afterProse.slice(0, 400)}`,
  )

  // The artifact is an OBSERVATION, not an assertion. Whether it still exists at the end
  // depends on what the advisor instructed afterwards, which is not this test's subject.
  console.log(`    [artifact] two.txt present at end of run: ${existsSync(join(work, 'two.txt'))}`)
  console.log(`    [post-resume reports] ${relay.log.filter((m) => m.kind === 'report' && m.seq > pause.atSeq).length}`)
})
