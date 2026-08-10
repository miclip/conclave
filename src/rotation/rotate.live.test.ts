/**
 * LIVE — question 2: can the full transaction rotate a real implementer?
 *
 * Separate from `relay/pause.live.test.ts` on purpose. That one asks whether a real session
 * survives a human-scale pause; this one asks whether the transaction works at all. Run
 * together, a fast successful rotation would hide unreliable long pauses, and a transport
 * failure during a long pause would be blamed on rotation.
 *
 *   quiesce → advisor authors the handoff → replacement starts → the replacement
 *   demonstrates it reproduces the record → old session terminates
 *
 * Rotation is triggered by the operator rather than by compaction, because compaction is
 * the *policy* question and this is the *mechanism* question. Waiting for a real compaction
 * would make this test depend on the proxy it is not testing.
 *
 * Three things the offline suite cannot reach, in the order they are likely to bite:
 *
 *   1. does a real advisor emit the seven headings?
 *   2. does a real replacement emit `CHECK n: exit <code>`?
 *   3. does promotion hold — does the relay carry on with the replacement?
 *
 * A rollback here is a RESULT, not a test failure, and the assertions say which of the
 * three broke. The only outright failure is a rotation that reports success while leaving
 * the wrong session running.
 *
 *   ORCH_LIVE_ROTATE=1 node --test src/rotation/rotate.live.test.ts
 *
 * Spawns three real sessions and uses real quota. NEVER RUN — written before its first run,
 * so the assertions are what the design predicts rather than what it was seen to do.
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { defaultRegistry } from '../registry/builtin.ts'
import { Relay } from '../relay/relay.ts'
import type { RunOutcome } from '../relay/run.ts'
import { parseHandoff } from './handoff.ts'

const skip =
  process.env.ORCH_LIVE_ROTATE === '1'
    ? false
    : 'set ORCH_LIVE_ROTATE=1 (spawns three real sessions, uses quota)'

test('a real implementer is replaced and the replacement proves it can continue', { skip }, async (t) => {
  const repo = join(import.meta.dirname, '..', '..')
  const work = join(repo, '.conclave', 'scratch-rotate')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  t.after(() => rmSync(work, { recursive: true, force: true }))

  const relay = await Relay.start({
    registry: defaultRegistry(),
    cwd: repo,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 5,
    rotation: {
      // Cheap, deterministic, and genuinely dependent on the repository — a check the
      // replacement can only reproduce by being in the right tree.
      checks: ['npx tsc --noEmit'],
      checkTimeoutMs: 300_000,
    },
  })
  t.after(() => relay.stop())

  const run = relay.start(
    `Work only inside ${work}. Create adder.js exporting a function that adds two numbers, ` +
      `then wait for the next instruction. Touch nothing outside that directory.`,
  )

  // Wait for real work before rotating. `requestPause()` is honoured at the next advisor
  // boundary, and the first of those precedes any instruction — so pausing immediately
  // rotates an implementer that has done nothing but acknowledge its briefing, and the
  // handoff describes an empty directory. The first live run did exactly that: the advisor
  // wrote "neither the target directory nor file produced any result", which is a true
  // handoff of no work at all.
  const armed = Date.now() + 420_000
  while (Date.now() < armed && !relay.log.some((m) => m.kind === 'report')) {
    await new Promise((r) => setTimeout(r, 250))
  }
  assert.ok(
    relay.log.some((m) => m.kind === 'report'),
    'the implementer should have reported before the rotation, or there is no state to transfer',
  )

  const pause = await run.requestPause('rotating to test the transaction')
  assert.ok(pause, 'the run should reach a pause rather than finishing first')

  const impl = relay.participants.find((p) => p.rank === 'implementer')!
  const retiring = impl.session
  const result = await run.rotateImplementer('mechanism test: replacing a healthy implementer')

  // --- 1. did the advisor produce a usable handoff? ---------------------------------
  if (result.status === 'rolled_back' && result.reason === 'handoff_incomplete') {
    assert.fail(
      `the advisor did not produce the seven headings: ${result.detail}\n` +
        `This is recoverable by construction — the original is back in service — but it ` +
        `makes rotation unusable in practice until the prompt is fixed.`,
    )
  }
  assert.ok(result.handoff, 'a handoff should have been authored')
  const reparsed = parseHandoff(result.handoff.narrative.raw)
  assert.deepEqual(reparsed.missing, [], 'the handoff must round-trip through its own parser')
  // The advisor cannot see files or tests, so the record is the orchestrator's.
  assert.ok(result.handoff.record.head, 'the record should carry HEAD')
  assert.equal(result.handoff.record.checks.length, 1)

  // --- 2. did the replacement demonstrate rather than assert? -----------------------
  if (result.status === 'rolled_back') {
    // A rollback is a result. Say which kind, and prove the transaction still held.
    console.log(`\n    [rolled back] ${result.reason}: ${result.detail}`)
    console.log(`    [claimed] ${JSON.stringify(result.acceptance?.claimed ?? [])}`)
    console.log(`    [prose]\n${(result.acceptance?.prose ?? '').slice(0, 800)}`)
    assert.equal(impl.session, retiring, 'a rollback must leave the original as the implementer')
    assert.equal(retiring.state, 'running', 'and it must be back in service, not stranded')
    // The work is not lost, which is the property the rollback exists to keep.
    await run.continue()
    const outcome = await run.result()
    assert.notEqual(outcome.reason, 'escalated', `the restored session could not continue: ${outcome.detail}`)
    return
  }

  assert.equal(result.status, 'rotated')
  assert.ok(
    result.acceptance.claimed.length > 0,
    `the replacement reported no exit codes in a comparable form. Its prose was:\n` +
      result.acceptance.prose.slice(0, 800),
  )
  assert.deepEqual(result.acceptance.claimMismatches, [])
  // A replacement that reports a discrepancy has performed a SUCCESSFUL transfer -- the
  // first live run's replacement caught the advisor claiming a directory did not exist
  // when it did. Surfaced rather than buried, because it is the behaviour worth having.
  console.log(`\n    [replacement report]\n${result.acceptance.prose.split('\n').slice(0, 20).map((l) => `      ${l}`).join('\n')}`)

  // --- 3. did promotion hold? -------------------------------------------------------
  assert.notEqual(impl.session, retiring, 'the participant should now hold the replacement')
  assert.equal(impl.id, 'implementer', 'the identity every log entry refers to must survive')
  assert.equal(retiring.state, 'terminated', 'the old session is given up only after the proof')
  assert.equal(impl.session.state, 'running')

  // And the session actually continues — the point of rotating rather than stopping.
  const turnsBefore = (await impl.session.snapshot()).turns.length
  run.injectConstraint('Add a subtract function to the same file.', { only: 'implementer' })
  await run.continue()

  // Drive pauses rather than awaiting only `result()`. The first live run of this test
  // deadlocked exactly there: promotion succeeded, the loop paused again, and nothing was
  // listening -- so a 25-minute harness timeout reported an orchestration deadlock as an
  // agent turn overrunning, with both agents idle and nothing scheduled.
  const pauses: string[] = []
  let outcome: RunOutcome
  for (;;) {
    const s = await run.settled()
    if (s.kind === 'ended') {
      outcome = s.outcome
      break
    }
    pauses.push(`${s.pause.reason}: ${s.pause.detail}`)
    console.log(`\n    [paused after promotion] ${s.pause.reason}: ${s.pause.detail}`)
    for (const e of s.pause.evidence) console.log(`      evidence: ${e}`)
    // A post-promotion pause is a legitimate result, not a hang. Resume once and let the
    // run reach a terminal state so the assertions below mean something.
    if (pauses.length > 3) {
      await run.abort('too many pauses to be a working session')
      break
    }
    await run.continue()
  }

  assert.notEqual(outcome!.reason, 'escalated', `the rotated session could not continue: ${outcome!.detail}`)
  assert.ok(
    (await impl.session.snapshot()).turns.length > turnsBefore,
    'the replacement took real turns after promotion',
  )
  const rotationNote = relay.log.find((m) => m.text.includes('rotated into'))
  assert.ok(rotationNote, 'the rotation should be in the routing log')
  assert.ok(
    relay.log.some((m) => m.from === 'implementer' && m.kind === 'report' && m.seq > rotationNote.seq),
    'the replacement reports under the promoted identity, not under an audition name',
  )
})
