/**
 * The check lane's mechanism, tested directly — which is the whole of what it is kept for.
 *
 * Both stations are real since per-seat rotation landed (#78): a merge boundary at N>1, and a
 * rotation in one seat's tree at any N. What the lane protects is not CPU — both check runners
 * are `spawnSync` in one process, so the commands already serialise — but the WINDOW a rotation
 * verifies across, which a merge would otherwise move underneath it. The lane's own definition
 * carries the argument, including how narrowly a WAIT is reachable: the dispatcher processes one
 * completion at a time, so the loop cannot overlap its own two stations, and only a rotation
 * started from outside the loop can queue behind a boundary.
 *
 * That narrowness is why this file still drives the class directly rather than a run. Acquire,
 * release, release-on-failure, the refusal to acquire twice and the wait notification are each
 * asserted here rather than inferred from a run that would exercise them only by luck of
 * interleaving. Everything below is a property of the class; nothing below claims the run does
 * it — `checkLaneRun.test.ts` is where a real run's use of the lane is asserted.
 *
 *   node --test src/relay/checkLane.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { CheckLane, type LaneClaim } from './checkLane.ts'

/** A claim, spelled out once so the tests read as scheduling rather than object literals. */
const claim = (seat: string, station: 'rotation' | 'integration' = 'integration'): LaneClaim => ({
  seat,
  station,
  detail: `${seat}-work`,
})

/** A promise with its resolver, so a test can hold a section open deliberately. */
function gate(): { held: Promise<void>; open: () => void } {
  let open!: () => void
  const held = new Promise<void>((resolve) => (open = resolve))
  return { held, open }
}

test('acquire: the section runs with the lane held, and the holder names it', async () => {
  const lane = new CheckLane()
  assert.equal(lane.held(), undefined, 'a fresh lane holds nothing')
  let seen: LaneClaim | undefined
  const result = await lane.run(claim('seat-a', 'rotation'), () => {
    seen = lane.held()
    return 'ran'
  })
  assert.equal(result, 'ran', 'the section runs and its value reaches the caller')
  assert.equal(seen?.seat, 'seat-a')
  assert.equal(seen?.station, 'rotation', 'and the lane knows which station is holding it')
})

test('release: the lane is free again afterwards, and takes the next section', async () => {
  const lane = new CheckLane()
  await lane.run(claim('seat-a'), () => undefined)
  assert.equal(lane.held(), undefined, 'released')
  assert.equal(await lane.run(claim('seat-b'), () => 'ran'), 'ran', 'and usable')
  assert.deepEqual(lane.history().map((r) => r.seat), ['seat-a', 'seat-b'], 'both are recorded')
})

test('one slot: a second section does not start until the first has finished', async () => {
  const lane = new CheckLane()
  const order: string[] = []
  const first = gate()

  const a = lane.run(claim('seat-a'), async () => {
    order.push('a in')
    await first.held
    order.push('a out')
  })
  const b = lane.run(claim('seat-b'), () => void order.push('b in'))

  // Long enough for anything not actually held back to have run. `b` has not.
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(order, ['a in'], 'the second section must not have started')
  assert.equal(lane.held()?.seat, 'seat-a')

  first.open()
  await Promise.all([a, b])
  assert.deepEqual(order, ['a in', 'a out', 'b in'], 'it runs only after the first ends')
  assert.equal(lane.held(), undefined)
})

test('FIFO: a section arriving during a handover does not overtake one already queued', async () => {
  const lane = new CheckLane()
  const admitted: string[] = []
  const first = gate()

  const a = lane.run(claim('seat-a'), () => first.held)
  const b = lane.run(claim('seat-b'), () => void admitted.push('b'))
  const c = lane.run(claim('seat-c'), () => void admitted.push('c'))
  // Arrives while the queue is draining, which is the window a lane that merely cleared its
  // holder would let it jump: `seat-b` has been admitted but has not yet re-entered its own
  // `run`, so a naive implementation sees a free slot.
  first.open()
  const d = lane.run(claim('seat-d'), () => void admitted.push('d'))

  await Promise.all([a, b, c, d])
  assert.deepEqual(admitted, ['b', 'c', 'd'], 'admitted in the order they asked')
})

test('release on throw: a section that fails frees the lane, and the failure is its own', async () => {
  const lane = new CheckLane()
  await assert.rejects(
    lane.run(claim('seat-a'), () => {
      throw new Error('the check runner exploded')
    }),
    /the check runner exploded/,
    'the caller must see its own failure, not a lane error',
  )
  assert.equal(lane.held(), undefined, 'a fault must not strand the lane for the rest of the run')
  assert.equal(await lane.run(claim('seat-b'), () => 'ran'), 'ran', 'proved by using it, not by reading it')
  assert.deepEqual(lane.history().map((r) => r.seat), ['seat-a', 'seat-b'], 'the failed section is recorded too')
})

test('release on throw: a queued section is admitted rather than stranded behind the failure', async () => {
  const lane = new CheckLane()
  const first = gate()
  const a = lane.run(claim('seat-a'), async () => {
    await first.held
    throw new Error('exploded while seat-b waited')
  })
  const b = lane.run(claim('seat-b'), () => 'ran')
  first.open()
  await assert.rejects(a, /exploded/)
  assert.equal(await b, 'ran', 'the queue drains through a failure, or one fault stops the run')
})

test('a synchronous section is awaited, because both of the check runners are spawnSync', async () => {
  const lane = new CheckLane()
  // The failure this rules out: a `run` that returned before a synchronous section finished
  // would release the lane while `spawnSync` still held the process, and the lane would be a
  // decoration. Asserted by the value, which exists only once the section has run.
  assert.equal(await lane.run(claim('seat-a'), () => 41 + 1), 42)
  assert.equal(lane.history()[0]?.station, 'integration')
})

test('already held: a seat cannot acquire twice, and is told rather than deadlocked', async () => {
  const lane = new CheckLane()
  // The failure being ruled out is a run that stops with no error and no ending. `integrate.ts`
  // runs the configured checks itself, so a caller that wrapped BOTH the boundary and those
  // checks would take a one-slot lane twice and wait for itself forever.
  await assert.rejects(
    lane.run(claim('implementer', 'rotation'), () =>
      lane.run(claim('implementer', 'integration'), () => 'unreachable'),
    ),
    /already holds the check lane/,
    'a nested acquire must say so rather than hang',
  )
  // And the outer section's slot is still released, so the refusal costs one boundary and not
  // the rest of the run.
  assert.equal(lane.held(), undefined)
  assert.equal(await lane.run(claim('implementer'), () => 'ran'), 'ran')
})

test('the refusal names both stations, because the fix is knowing which two nested', async () => {
  const lane = new CheckLane()
  await assert.rejects(
    lane.run(claim('implementer-2', 'integration'), () =>
      lane.run(claim('implementer-2', 'rotation'), () => 'unreachable'),
    ),
    (e: Error) =>
      /already holds the check lane for its integration section/.test(e.message) &&
      /its rotation section would wait for itself/.test(e.message),
  )
})

test('two different seats hold and queue independently, which is what the lane is for', async () => {
  const lane = new CheckLane()
  const hold = gate()
  const a = lane.run(claim('implementer', 'rotation'), () => hold.held)
  const b = lane.run(claim('implementer-2', 'integration'), () => 'merged')
  await new Promise((r) => setImmediate(r))
  assert.equal(lane.held()?.seat, 'implementer', 'the rotation holds it')
  hold.open()
  await Promise.all([a, b])
  assert.deepEqual(
    lane.history().map((r) => `${r.seat}/${r.station}`),
    ['implementer/rotation', 'implementer-2/integration'],
    'the boundary ran after the rotation rather than inside it, which is the hazard the lane ' +
      'exists for: a merge landing inside a rotation’s verification window is read as the ' +
      'repository diverging',
  )
})

test('a section that waits is announced, with the claim it is waiting behind', async () => {
  // The wait is minutes long when it happens — a rotation holds this across a whole agent turn —
  // and neither station narrates the other, so without this the log has a gap in it with nothing
  // to explain the gap. Silent by construction: the uncontended case below emits nothing, which
  // is the condition under which reporting it is honest rather than decorative.
  const lane = new CheckLane()
  const waits: string[] = []
  lane.onWait = (waiting, holder) => waits.push(`${waiting.seat}/${waiting.station} <- ${holder.seat}/${holder.station}`)

  await lane.run(claim('implementer', 'rotation'), () => 'done')
  assert.deepEqual(waits, [], 'an uncontended section waits for nothing and says nothing')

  const hold = gate()
  const first = lane.run(claim('implementer', 'rotation'), () => hold.held)
  const second = lane.run(claim('implementer-2', 'integration'), () => 'merged')
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(
    waits,
    ['implementer-2/integration <- implementer/rotation'],
    'announced when the wait BEGINS: a note that arrives when it ends explains a silence after it',
  )
  hold.open()
  await Promise.all([first, second])
  assert.equal(waits.length, 1, 'and once, not again on admission')
})
