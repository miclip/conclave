/**
 * One place in the status document that says the run is waiting on somebody (#234).
 *
 * The defect was a shape, not a missing value: both blocking conditions WERE reported, in two
 * different parts of the document, and nothing said a reader had to watch both.
 *
 *   an escalation        `state: 'paused'`, with the whole pause
 *   a permission prompt  `state` stays `running` -- `paused` is only ever set alongside a
 *                        `RunPause` -- and the only trace is one participant's
 *                        `awaitingPermission`, several levels down a list
 *
 * Two agent operators wrote a watcher against the obvious condition and lost time to the other,
 * in that order, on different repos. The first watched `pause`: a permission prompt sat 42
 * minutes. The second answered prompts in 15 seconds and, having got that working, stopped
 * watching -- so the escalation that paused later sat instead, and an escalation is by
 * construction the pause a machine must not resolve.
 *
 * `blocked` is DERIVED on every write rather than stored, so the tests that matter most here are
 * the ones showing it cannot disagree with the fields it summarises.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { blockedFrom, type SessionStatus } from './sessionRecord.ts'
import type { RunPause } from '../relay/run.ts'

function doc(over: Partial<SessionStatus> = {}): Pick<SessionStatus, 'pause' | 'participants'> {
  return { participants: [], ...over }
}

function seat(id: string, awaiting?: { tool: string; since: number }): SessionStatus['participants'][number] {
  return {
    id,
    agent: 'claude',
    rank: 'implementer',
    role: 'implementer',
    launch: { args: [], model: null },
    turns: [],
    ...(awaiting ? { awaitingPermission: awaiting } : {}),
  }
}

function pause(over: Partial<RunPause> = {}): RunPause {
  return {
    reason: 'advisor_escalated',
    resolution: { reason: 'advisor_escalated', authority: 'operator', scope: { kind: 'conclave' } },
    detail: 'needs a human',
    evidence: [],
    options: [],
    atSeq: 0,
    at: 5_000,
    ...over,
  } as RunPause
}

test('#234 a permission prompt is reported even though the run is still `running`', () => {
  // The 42-minute incident, as a document. `state` is deliberately not consulted by
  // `blockedFrom` -- a reader keying off `state` is precisely the reader that missed this.
  const blocked = blockedFrom(doc({ participants: [seat('implementer', { tool: 'Bash', since: 1_000 })] }))
  assert.deepEqual(blocked, { kind: 'permission', since: 1_000, participant: 'implementer', tool: 'Bash' })
})

test('#234 an escalation is reported, with the reason and who may answer', () => {
  const blocked = blockedFrom(doc({ pause: pause() }))
  assert.deepEqual(blocked, { kind: 'pause', since: 5_000, reason: 'advisor_escalated', authority: 'operator' })
})

test('#234 a pause outranks a permission prompt when both are true at once', () => {
  // The pause stops the whole conclave and the prompt stops one seat, so the pause is the fact
  // about the RUN. Reporting the prompt here would tell a driver to answer /allow while the run
  // was waiting on a decision that /allow cannot resolve.
  const blocked = blockedFrom(
    doc({ pause: pause(), participants: [seat('implementer', { tool: 'Bash', since: 1_000 })] }),
  )
  assert.equal(blocked?.kind, 'pause')
})

test('#234 nothing blocked produces no block at all', () => {
  assert.equal(blockedFrom(doc({ participants: [seat('implementer')] })), undefined)
})

test('#234 the roll-up carries the pause reason verbatim, not a category of its own', () => {
  // Every reason, so this cannot quietly grow a taxonomy that disagrees with `PauseReason`.
  // A pause a machine must not answer and one it may are told apart by the reason and the
  // authority the pause already carries -- this block invents neither.
  for (const reason of ['advisor_escalated', 'merge_blocked', 'operator_requested'] as const) {
    const blocked = blockedFrom(doc({ pause: pause({ reason }) }))
    assert.equal(blocked?.kind === 'pause' && blocked.reason, reason)
  }
})

test('#234 the block says nothing about whether a machine may answer', () => {
  // Deliberate, and the README's argument is why: conclave does not know. A prompt for
  // `gh pr view` and one for `rm -rf` arrive here identically, and publishing a
  // `machineAnswerable` would be conclave asserting a safety property it cannot check.
  const blocked = blockedFrom(doc({ participants: [seat('implementer', { tool: 'Bash', since: 1 })] }))
  assert.ok(blocked !== undefined)
  assert.deepEqual(Object.keys(blocked).sort(), ['kind', 'participant', 'since', 'tool'])
})

test('#234 two blocked seats report one block, and the same one on every read', () => {
  // The block reports ONE; a reader needing every prompt reads the participant list, which is
  // where they all are. Participant order is stable across writes, so a driver polling this
  // does not see the answer flip between two equally blocked seats.
  const d = doc({
    participants: [seat('alpha', { tool: 'Bash', since: 9_000 }), seat('beta', { tool: 'Edit', since: 1_000 })],
  })
  const first = blockedFrom(d)
  assert.ok(first?.kind === 'permission')
  assert.equal(first.participant, 'alpha')
  assert.deepEqual(blockedFrom(d), first)
})
