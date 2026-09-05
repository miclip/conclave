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
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
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

test('#231 an ENDED run is idle too, which is why a bound has to gate on `state`', async (t) => {
  // Pinned as a decision rather than left to be discovered. A run that drained and stopped IS
  // idle, and stays idle in the directory forever -- so a driver checking `idle` and a duration
  // without also checking `state` would report every finished run as wedged. Reported honestly
  // and documented on the type; the alternative, blanking the block at the close, would lose
  // what the run was doing when it stopped from the one reader asking why it stopped.
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
  assert.equal(status?.progress?.state, 'idle', 'an ended run reads idle')
  assert.equal(status?.state, 'ended', 'and `state` is what tells a reader not to alarm on it')

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
