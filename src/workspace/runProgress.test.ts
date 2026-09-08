/**
 * What the RUN is doing, as distinct from what a seat is doing (#231).
 *
 * Both existing clocks measure a TURN. The silence clock is armed against a specific turn and
 * disarmed when it ends, so with nothing in flight there is no armed timer. The ceilings are
 * evaluated at turn boundaries, so a run that never reaches another boundary never evaluates
 * `--max-minutes`. Neither is wrong; neither answers "the RUN is alive".
 *
 * Two operators independently wrote a watch on the log file's mtime to cover it. This is that
 * reading, taken from something conclave knows, and it is REPORTED rather than acted on --
 * nothing here ends anything.
 *
 * The state worth the tests is `idle`: no turn in flight, no pause open. That is the one
 * nothing else measures.
 *
 * And its twin at the end of a run: an ended run reads `idle` if its last turn completed and
 * `abandoned` if one was still in flight. `abandoned` is terminal evidence -- the run was cut
 * off mid-turn -- and never a claim that work is still happening.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readSession, recordSession } from './sessionRecord.ts'
import { tempDir } from '../testkit/tempDir.ts'
import { RelayEventStream } from '../relay/observe.ts'
import { waitFor } from '../testkit/waitFor.ts'

const settle = () => new Promise((r) => setTimeout(r, 30))

/** The smallest relay this recorder will follow: one seat, a stream, nothing else. */
function stubRelay(): { stream: RelayEventStream } & Record<string, unknown> {
  const stream = new RelayEventStream()
  return {
    stream,
    cwd: '/tmp',
    operator: 'agent' as const,
    get stopped() {
      return stream.closed
    },
    whenObservable: () => new Promise<void>(() => {}),
    participants: [
      {
        id: 'implementer',
        rank: 'implementer',
        role: 'implementer',
        launch: { args: [], model: null },
        session: { agent: 'claude', snapshot: async () => ({ turns: [] }) },
      },
    ],
    log: [],
    permissionsPending: () => [],
    observe: (o?: { replay?: boolean }) => stream.observe(o),
  }
}

function start(t: Parameters<typeof tempDir>[0], id: string) {
  const root = tempDir(t, 'conclave-progress')
  const relay = stubRelay()
  const recording = recordSession(relay as never, {
    repoRoot: root,
    id,
    goal: 'g',
    front: 'relay',
    startedAt: 1_000,
    build: 'test-build',
  })
  return { root, relay, recording }
}

const turn = (type: 'turn_start' | 'turn_end', seq: number) => ({
  type: 'activity' as const,
  participant: 'implementer',
  rank: 'implementer',
  event: { type, seq, at: seq, ...(type === 'turn_end' ? { state: 'completed' } : { prompt: 'x' }) },
})

test('#231 a run between turns reports `idle`, and says since when', async (t) => {
  // The unmeasured state, and the whole issue: the seat is alive, its last turn completed, and
  // nothing is scheduled. No watchdog is armed and no boundary is coming.
  const { root, relay, recording } = start(t, 'idle')
  relay.stream.emit(turn('turn_start', 1) as never)
  await settle()
  assert.equal(readSession(root, 'idle')?.status.progress?.state, 'in_turn', 'in a turn first')

  relay.stream.emit(turn('turn_end', 2) as never)
  await settle()
  const p = readSession(root, 'idle')?.status.progress
  assert.equal(p?.state, 'idle', 'and idle once the turn has ended')
  assert.ok(p !== undefined)

  relay.stream.close()
  await recording.close()
})

test('#231 `since` moves when the state changes and not when the record is rewritten', async (t) => {
  // The property the whole field turns on. `updatedAt` already moves on every write -- it is a
  // heartbeat -- which is exactly why it could not answer this and why two operators went to
  // the log file's mtime instead.
  const { root, relay, recording } = start(t, 'sticky')
  relay.stream.emit(turn('turn_start', 1) as never)
  relay.stream.emit(turn('turn_end', 2) as never)
  await settle()
  const first = readSession(root, 'sticky')?.status
  assert.equal(first?.progress?.state, 'idle')

  // Something happens that is NOT a state change: another event, another write.
  await new Promise((r) => setTimeout(r, 25))
  relay.stream.emit({ type: 'activity', participant: 'implementer', rank: 'implementer', event: { type: 'error', seq: 3, at: 3, message: 'noise' } } as never)
  await settle()

  const later = readSession(root, 'sticky')?.status
  assert.equal(later?.progress?.state, 'idle', 'still idle')
  assert.equal(later?.progress?.since, first?.progress?.since, 'and still idle SINCE the same moment')
  assert.ok((later?.updatedAt ?? 0) > (first?.updatedAt ?? 0), 'while the heartbeat did move, which is the contrast')

  relay.stream.close()
  await recording.close()
})

test('#231 a second turn_start on one seat does not wedge the run in `in_turn`', async (t) => {
  // Why a Set and not a counter. A duplicated start against a counter leaves the run reading
  // `in_turn` forever after its turn_end, which would hide exactly the state this reports.
  const { root, relay, recording } = start(t, 'dup')
  relay.stream.emit(turn('turn_start', 1) as never)
  relay.stream.emit(turn('turn_start', 2) as never)
  relay.stream.emit(turn('turn_end', 3) as never)
  await settle()
  assert.equal(readSession(root, 'dup')?.status.progress?.state, 'idle')

  relay.stream.close()
  await recording.close()
})

test('#231 an ended run whose turn COMPLETED is idle, which is why a bound has to gate on `state`', async (t) => {
  // One of the two endings, and the clean one. A run that drained and stopped IS idle, and stays
  // idle in the directory forever -- so a driver checking `idle` and a duration without also
  // checking `state` would report every finished run as wedged. Reported honestly and documented
  // on the type; the alternative, blanking the block at the close, would lose what the run was
  // doing when it stopped from the one reader asking why it stopped.
  //
  // The contrast with the next test is the point: both runs are `state === 'ended'`, and what
  // separates them is whether a turn was still in flight when the ending was written.
  const { root, relay, recording } = start(t, 'ended')
  relay.stream.emit(turn('turn_start', 1) as never)
  relay.stream.emit(turn('turn_end', 2) as never)
  await settle()
  recording.set('ended')
  await waitFor(() => readSession(root, 'ended')?.status.state === 'ended', {
    within: 2_000,
    describe: 'the ended state to reach the record',
  })

  const status = readSession(root, 'ended')?.status
  assert.equal(status?.progress?.state, 'idle', 'an ended run whose turn finished reads idle')
  assert.equal(status?.state, 'ended', 'and `state` is what tells a reader not to alarm on it')

  relay.stream.close()
  await recording.close()
})

test('an ended run with a turn STILL IN FLIGHT reports `abandoned`', async (t) => {
  // The other ending. The seat opened a turn and never closed it, and then the run stopped --
  // a teardown, a kill, a crash the recorder outlived. Before this both endings wrote `idle`,
  // so a run cut off mid-turn was indistinguishable in the record from one that finished its
  // work, which is the single most useful thing a reader of a dead run wants to know.
  //
  // `abandoned` is TERMINAL EVIDENCE, not ongoing work. It never means a seat is busy: it is
  // only ever reached from `state === 'ended'`, so nothing is going to finish that turn and
  // nothing should wait for it. That is why it is a fourth value rather than leaving the ended
  // run reading `in_turn`, which would say the opposite -- that work is still happening -- to
  // every poller in the directory, forever.
  const { root, relay, recording } = start(t, 'abandoned')
  relay.stream.emit(turn('turn_start', 1) as never)
  await settle()
  const inTurn = readSession(root, 'abandoned')?.status.progress
  assert.equal(inTurn?.state, 'in_turn', 'in a turn while the run lives')

  // No `turn_end`. The unfinished turn is the evidence, which is why teardown must not clear it.
  recording.set('ended')
  await waitFor(() => readSession(root, 'abandoned')?.status.state === 'ended', {
    within: 2_000,
    describe: 'the ended state to reach the record',
  })

  const status = readSession(root, 'abandoned')?.status
  assert.equal(status?.progress?.state, 'abandoned', 'the ending plus the unfinished turn')
  assert.equal(status?.state, 'ended', 'and the run really did end')
  // `since` is a REAL transition here, not a carried-over one. `abandoned` is a state the run
  // entered at the moment it was torn down, and the field's whole contract is that `now - since`
  // is how long it has been in the state it is in -- so a reader asking when this run was cut off
  // must get the ending, not the moment the turn opened. Carrying the `in_turn` timestamp forward
  // would answer a different question than the one the field claims to answer, and would do it
  // silently, since both values are plausible timestamps from the same run.
  assert.ok(
    (status?.progress?.since ?? 0) > (inTurn?.since ?? 0),
    `entering abandoned must advance since: in_turn at ${inTurn?.since}, abandoned at ${status?.progress?.since}`,
  )

  relay.stream.close()
  await recording.close()
})

test('an ended run that was PAUSED mid-turn still reports `abandoned`, not `paused`', async (t) => {
  // The transition, not a precedence rule -- `state` holds one lifecycle value, so `ended` and
  // `paused` can never race and no mutation to their order in `progressOf` can fail a test. What
  // this pins is that nothing carries the previous reading forward: a run torn down while waiting
  // for a person reports the ending, because the block is recomputed from the state being
  // written. The unfinished turn survives the pause untouched, so the ending reads it and says
  // `abandoned` -- terminal evidence again, not a wait anyone should keep watching.
  const { root, relay, recording } = start(t, 'paused-abandoned')
  relay.stream.emit(turn('turn_start', 1) as never)
  await settle()
  recording.set('paused', {
    pause: {
      reason: 'advisor_escalated',
      resolution: { reason: 'advisor_escalated', authority: 'operator', scope: { kind: 'conclave' } },
      detail: 'needs a human',
      evidence: [],
      options: [],
      atSeq: 0,
      at: 9_000,
    } as never,
  })
  await waitFor(() => readSession(root, 'paused-abandoned')?.status.progress?.state === 'paused', {
    within: 2_000,
    describe: 'the paused state to reach the record',
  })

  recording.set('ended')
  await waitFor(() => readSession(root, 'paused-abandoned')?.status.state === 'ended', {
    within: 2_000,
    describe: 'the ended state to reach the record',
  })
  assert.equal(readSession(root, 'paused-abandoned')?.status.progress?.state, 'abandoned')

  relay.stream.close()
  await recording.close()
})

test('#231 a paused run reports `paused`, not `idle`', async (t) => {
  // The distinction that keeps this from being a stick to beat a waiting run with. A pause is
  // deliberately unclocked -- it is waiting for a person -- and a driver bounding `idle` must
  // not have that fire on a run that is correctly waiting.
  const { root, relay, recording } = start(t, 'paused')
  relay.stream.emit(turn('turn_start', 1) as never)
  relay.stream.emit(turn('turn_end', 2) as never)
  await settle()
  assert.equal(readSession(root, 'paused')?.status.progress?.state, 'idle')

  recording.set('paused', {
    pause: {
      reason: 'advisor_escalated',
      resolution: { reason: 'advisor_escalated', authority: 'operator', scope: { kind: 'conclave' } },
      detail: 'needs a human',
      evidence: [],
      options: [],
      atSeq: 0,
      at: 9_000,
    } as never,
  })
  await waitFor(() => readSession(root, 'paused')?.status.progress?.state === 'paused', {
    within: 2_000,
    describe: 'the paused state to reach the record',
  })

  relay.stream.close()
  await recording.close()
})

test('#244 a freshly written record carries every field the README tells an operator to read', async (t) => {
  // The half `contract/livenessDocs.test.ts` cannot check. It resolves the README's field paths
  // against whatever `status --json` returns, and that is the last RECORDED document — which an
  // older build may have written, so a field the current code stopped emitting still resolves
  // there. This produces a record now.
  //
  // The fields are read out of the README rather than restated, so the two cannot drift: if the
  // documented command changes, this checks the new fields.
  const readme = readFileSync(join(import.meta.dirname, '..', '..', 'README.md'), 'utf8')
  const at = readme.indexOf('tail -f /dev/null > ctl &')
  assert.notEqual(at, -1, 'the README must still document the fifo recipe')
  const section = readme.slice(at, readme.indexOf('\n#', at))
  const documented = [...section.matchAll(/\.(state|alive|progress\.state)\b/g)].map((m) => m[0])
  assert.ok(documented.length >= 3, `the recipe must document the liveness fields: ${JSON.stringify(documented)}`)

  const { root, relay, recording } = start(t, 'readme')
  relay.stream.emit(turn('turn_start', 1) as never)
  await settle()
  recording.set('running')
  await waitFor(() => readSession(root, 'readme')?.status.progress !== undefined, {
    within: 2_000,
    describe: 'the record to be written',
  })

  const read = readSession(root, 'readme')
  assert.ok(read, 'the record must be readable')
  // `alive` is added by the READER, `state` and `progress` by the recorder — all three are what
  // the documented command prints, so all three are checked against one document.
  const doc = { ...read.status, alive: read.alive } as Record<string, unknown>
  for (const field of new Set(documented)) {
    let cur: unknown = doc
    for (const key of field.slice(1).split('.')) cur = (cur as Record<string, unknown> | undefined)?.[key]
    assert.notEqual(cur, undefined, `the README tells an operator to read ${field}; a fresh record has no such field (#244)`)
  }

  relay.stream.close()
  await recording.close()
})
