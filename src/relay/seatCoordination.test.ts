/**
 * What a seat is told about the OTHER seats, on every dispatch (#152).
 *
 * Two seats were given interacting work and each built its own version of the same bypass,
 * with incompatible signatures. The first thing that noticed was the integration merge, which
 * reports a textual conflict in two files -- the weakest possible signal for "one of these is a
 * design your colleague rejected an hour ago". The losing half was coherent, typechecked and
 * green, and nothing in the run marked it as the second implementation of a solved problem.
 *
 * The assertions here are made from the ROUTING LOG rather than from the prose sent to a child,
 * with one exception that ties the two together. The log is the only complete account of a
 * session -- no child's transcript holds what another child was told -- so "the seat was told
 * X" has to be answerable from it, and a notice delivered but not recorded would leave the one
 * fact this feature exists to establish unauditable. The exception is deliberate: one test
 * asserts the recorded text appears VERBATIM in what the child was actually sent, because two
 * separately-constructed strings are two strings that can drift.
 *
 * Three properties, and the third is why the notice is per dispatch rather than per briefing:
 *
 *   - **present** at N>1, listing each other seat's exact instruction and the stop-and-report
 *     rule.
 *   - **absent** at N=1, including a run whose second seat is a REVIEWER -- it writes nothing
 *     and cannot collide, so that run must keep paying nothing for this.
 *   - **live**: the same seat, dispatched twice, is told what the other seat holds AT THAT
 *     MOMENT. A notice frozen at briefing time would describe a schedule that has moved on.
 *
 *   node --test src/relay/seatCoordination.test.ts
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
import { Relay } from './relay.ts'
import type { RelayMessage } from './message.ts'

/** One agent per fake session, so a seat's id and the child behind it stay distinguishable. */
function registryOf(sessions: Record<string, FakeRotationSession[]>): AgentRegistry {
  const r = new AgentRegistry()
  for (const [agent, queue] of Object.entries(sessions)) {
    const remaining = [...queue]
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

/** A repository to run in: two seats mean real worktrees, and those need a real checkout. */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-coordination-'))
  execFileSync('git', ['init', '--quiet'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'README.md'), '# hello')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: dir })
  return dir
}

const LEAD = { id: 'advisor', agent: 'lead', role: 'advisor' } as const
const ALPHA = { id: 'seat-alpha', agent: 'alpha', role: 'implementer' } as const
const BETA = { id: 'seat-beta', agent: 'beta', role: 'implementer' } as const

/** Plenty, so a seat asked one more time than expected does not answer with silence. */
const SEAT_REPLIES = ['ack', 'Did it.', 'Did that too.', 'And that.', 'NONE', 'NONE']

/**
 * The coordination notices this seat was sent, oldest first.
 *
 * Keyed on `to` rather than on the prose, because "what was THIS seat told" is the question the
 * feature answers and matching on wording would pass a notice recorded for the wrong recipient.
 */
function noticesTo(relay: Relay, seatId: string): RelayMessage[] {
  return relay.log.filter((m) => m.kind === 'note' && m.to.length === 1 && m.to[0] === seatId && /IMPLEMENTER SEATS/.test(m.text))
}

async function twoSeatRun(
  repo: string,
  advisorReplies: string[],
  delays: { alpha?: number; beta?: number } = {},
): Promise<{ relay: Relay; alpha: FakeRotationSession; beta: FakeRotationSession }> {
  const lead = new FakeRotationSession('lead-1', 'lead', advisorReplies)
  const alpha = new FakeRotationSession('alpha-1', 'alpha', [...SEAT_REPLIES])
  const beta = new FakeRotationSession('beta-1', 'beta', [...SEAT_REPLIES])
  if (delays.alpha) alpha.delayMs = delays.alpha
  if (delays.beta) beta.delayMs = delays.beta
  const relay = await Relay.start({
    registry: registryOf({ lead: [lead], alpha: [alpha], beta: [beta] }),
    cwd: repo,
    lead: LEAD,
    implementer: ALPHA,
    implementers: [ALPHA, BETA],
    maxAdvisorTurns: 8,
  })
  return { relay, alpha, beta }
}

test('one reply naming two seats tells EACH of them what the other holds, verbatim', async () => {
  const repo = tempRepo()
  const { relay, alpha } = await twoSeatRun(repo, [
    '@seat seat-alpha: Extract withdrawnSeatAtPause(pause) and key the bypass on the pause record.\n' +
      '@seat seat-beta: Add the compaction guard inline in the console, keyed on the seat own events.',
    'DONE',
    'DONE',
  ])
  try {
    assert.equal((await relay.run('Keep the work moving.')).reason, 'done')

    const toAlpha = noticesTo(relay, 'seat-alpha')
    const toBeta = noticesTo(relay, 'seat-beta')
    assert.equal(toAlpha.length, 1, 'one dispatch to alpha, one notice')
    assert.equal(toBeta.length, 1, 'one dispatch to beta, one notice')

    // The other seat's instruction, exactly as the advisor wrote it. A summary is where the
    // detail that makes two tasks collide gets lost, so the assertion is on the whole string.
    assert.match(
      toAlpha[0]!.text,
      /=== seat-beta ===\nAdd the compaction guard inline in the console, keyed on the seat own events\./,
    )
    assert.match(
      toBeta[0]!.text,
      /=== seat-alpha ===\nExtract withdrawnSeatAtPause\(pause\) and key the bypass on the pause record\./,
    )
    // Neither is told its OWN instruction back: the notice is about what it cannot see.
    assert.doesNotMatch(toAlpha[0]!.text, /=== seat-alpha ===/)
    assert.doesNotMatch(toBeta[0]!.text, /=== seat-beta ===/)

    // Both halves of the notice, and the second is the decision-changing one. Mere visibility
    // would not have prevented #152 -- the repair genuinely had to touch the other seat's
    // guard, so a seat that could SEE the collision still had to be told what to do about it.
    for (const notice of [toAlpha[0]!, toBeta[0]!]) {
      assert.match(notice.text, /Do not independently implement anything that overlaps/)
      assert.match(notice.text, /STOP BEFORE YOU CHOOSE A DESIGN and report the overlap to the advisor/)
    }

    // Recorded immediately before the instruction it was delivered with, and attributed to the
    // orchestrator rather than to the advisor -- folding it into the instruction record would
    // put prose in the log under the name of a participant that did not write it.
    const alphaSeq = toAlpha[0]!.seq
    const nextForAlpha = relay.log.find((m) => m.seq > alphaSeq && m.to.includes('seat-alpha'))
    assert.equal(nextForAlpha?.kind, 'instruction')
    assert.equal(nextForAlpha?.from, 'advisor')
    assert.equal(toAlpha[0]!.from, 'orchestrator')
    assert.equal(toAlpha[0]!.visibility, 'internal')

    // The record and the delivery are one string, not two that can drift. `received[0]` is the
    // opening briefing, so the dispatch is the one after it.
    const dispatched = alpha.received.find((m) => m.includes('Extract withdrawnSeatAtPause'))
    assert.ok(dispatched, 'alpha was sent its instruction')
    assert.ok(dispatched.includes(toAlpha[0]!.text), 'what was recorded is what was sent, byte for byte')
    // Marked mechanical, and BEFORE the instruction so the instruction is still read last.
    assert.ok(dispatched.indexOf('[ORCHESTRATOR') < dispatched.indexOf('[FROM THE ADVISOR'))
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a single-seat run is told nothing, and its log gains no record', async () => {
  const repo = tempRepo()
  const lead = new FakeRotationSession('lead-1', 'lead', ['Write the answer.', 'DONE'])
  const impl = new FakeRotationSession('impl-1', 'alpha', ['ack', 'Wrote it.'])
  const relay = await Relay.start({
    registry: registryOf({ lead: [lead], alpha: [impl] }),
    cwd: repo,
    lead: LEAD,
    implementer: ALPHA,
    maxAdvisorTurns: 4,
  })
  try {
    assert.equal((await relay.run('Keep the work moving.')).reason, 'done')
    assert.equal(noticesTo(relay, 'seat-alpha').length, 0, 'nothing to coordinate with')
    // Not merely "no notice addressed to the seat": no record of one anywhere, and no seat
    // told about seats. The default run's log is the log it has always been.
    assert.equal(
      relay.log.some((m) => /IMPLEMENTER SEATS WORKING AT THE SAME TIME/.test(m.text)),
      false,
    )
    assert.equal(
      impl.received.some((m) => /overlaps what another seat holds/.test(m)),
      false,
    )
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a reviewer is not a seat that can collide, so a run with one implementer stays silent', async () => {
  const repo = tempRepo()
  const lead = new FakeRotationSession('lead-1', 'lead', ['Write the answer.', 'DONE'])
  const impl = new FakeRotationSession('impl-1', 'alpha', ['ack', 'Wrote it.'])
  const reviewer = new FakeRotationSession('rev-1', 'alpha', ['ack', 'ACCEPT', 'ACCEPT'])
  const relay = await Relay.start({
    registry: registryOf({ lead: [lead], alpha: [impl, reviewer] }),
    cwd: repo,
    lead: LEAD,
    implementer: ALPHA,
    reviewer: { id: 'reviewer', agent: 'alpha', role: 'reviewer' },
    maxAdvisorTurns: 4,
  })
  try {
    await relay.run('Keep the work moving.')
    // The reviewer IS in the seat table -- a review task is dispatched through the same
    // scheduler -- so a gate that counted dispatchable seats would fire here. It writes
    // nothing and has no worktree, so there is no overlap for it to have.
    assert.equal(
      relay.log.some((m) => /IMPLEMENTER SEATS WORKING AT THE SAME TIME/.test(m.text)),
      false,
    )
    assert.equal(noticesTo(relay, 'seat-alpha').length, 0)
    assert.equal(noticesTo(relay, 'reviewer').length, 0)
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('the reviewer in a MULTI-seat run is dispatched through the same path and still told nothing', async () => {
  const repo = tempRepo()
  const lead = new FakeRotationSession('lead-1', 'lead', ['@seat seat-alpha: Write the answer.', 'DONE', 'DONE', 'DONE'])
  const alpha = new FakeRotationSession('alpha-1', 'alpha', [...SEAT_REPLIES])
  const beta = new FakeRotationSession('beta-1', 'beta', [...SEAT_REPLIES])
  const reviewer = new FakeRotationSession('rev-1', 'rev', ['ack', 'ACCEPT', 'ACCEPT'])
  const relay = await Relay.start({
    registry: registryOf({ lead: [lead], alpha: [alpha], beta: [beta], rev: [reviewer] }),
    cwd: repo,
    lead: LEAD,
    implementer: ALPHA,
    implementers: [ALPHA, BETA],
    reviewer: { id: 'reviewer', agent: 'rev', role: 'reviewer' },
    maxAdvisorTurns: 6,
  })
  try {
    await relay.run('Keep the work moving.')
    // Two writing seats, so the gate that counts them is open — and the reviewer is dispatched
    // a review task through the very same `launch`. It writes nothing, so a rule about not
    // building overlapping work is advice for a seat that builds nothing.
    assert.ok(
      relay.tasks().some(({ task }) => task.purpose === 'review'),
      'the reviewer was actually dispatched, or this asserts nothing',
    )
    assert.equal(noticesTo(relay, 'reviewer').length, 0)
    assert.equal(
      reviewer.received.some((m) => /overlaps what another seat holds/.test(m)),
      false,
    )
    // The implementer that DID work is still told, so this is an exclusion and not the gate
    // having quietly closed for the whole run.
    assert.equal(noticesTo(relay, 'seat-alpha').length, 1)
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('the same seat, dispatched twice, is told what the other seat holds AT THAT MOMENT', async () => {
  const repo = tempRepo()
  // Beta is slow on its own turn, so it is still holding BETA ONE when alpha is dispatched the
  // second time -- otherwise "what beta holds" would be the same answer both times by accident.
  const { relay } = await twoSeatRun(
    repo,
    [
      '@seat seat-alpha: ALPHA ONE.',
      '@seat seat-beta: BETA ONE.\n@seat seat-alpha: ALPHA TWO.',
      'DONE',
      'DONE',
      'DONE',
    ],
    { beta: 1500 },
  )
  try {
    assert.equal((await relay.run('Keep the work moving.')).reason, 'done')

    const toAlpha = noticesTo(relay, 'seat-alpha')
    assert.equal(toAlpha.length, 2, 'alpha was dispatched twice, so it was told twice')

    // First dispatch: beta has nothing. Said out loud rather than omitted -- "that seat is
    // idle" and "the notice did not mention it" mean opposite things about what may arrive.
    assert.match(toAlpha[0]!.text, /=== seat-beta ===\n\(nothing in flight\)/)
    assert.doesNotMatch(toAlpha[0]!.text, /BETA ONE/)

    // Second dispatch, one advisor turn later: beta is holding work, and alpha is told which.
    assert.match(toAlpha[1]!.text, /=== seat-beta ===\nBETA ONE\./)
    assert.notEqual(toAlpha[0]!.text, toAlpha[1]!.text, 'a notice frozen at briefing time would be identical')

    // And the seat put to work alongside alpha in that same reply sees alpha's NEW task, not
    // the one it had finished. Both were assigned before either was sent, which is the whole
    // reason the second seat of a two-seat reply is not told it is working alone.
    const toBeta = noticesTo(relay, 'seat-beta')
    assert.equal(toBeta.length, 1)
    assert.match(toBeta[0]!.text, /=== seat-alpha ===\nALPHA TWO\./)
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})
