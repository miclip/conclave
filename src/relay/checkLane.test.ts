/**
 * The check lane: one run, one queue, and a wait that is not a block (#64).
 *
 * Two claims are under test and they are different in kind. The first is mechanical -- slots,
 * order, release on failure -- and is asserted here against the lane itself. The second is
 * about what a wait MEANS to the rest of the run: a seat queued behind another seat's checks
 * still holds its task, and `merge_blocked` / `failed` are answers to different questions.
 * That one is asserted through a real two-seat run in `checkLaneRun.test.ts`, because it is a
 * claim about the dispatcher rather than about this class.
 *
 *   node --test src/relay/checkLane.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { CheckLane, type LaneClaim } from './checkLane.ts'

/** A claim, spelled out once so the tests read as scheduling rather than as object literals. */
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

test('one slot by default: a second section does not start until the first has finished', async () => {
  const lane = new CheckLane()
  assert.equal(lane.concurrency, 1)
  const order: string[] = []
  const first = gate()

  const a = lane.run(claim('seat-a'), async () => {
    order.push('a in')
    await first.held
    order.push('a out')
  })
  const b = lane.run(claim('seat-b'), () => {
    order.push('b in')
  })

  // Long enough for anything not actually blocked to have run. `b` has not.
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(order, ['a in'], 'the second section must not have started')
  assert.deepEqual(lane.held().map((c) => c.seat), ['seat-a'])
  assert.deepEqual(lane.queued().map((c) => c.seat), ['seat-b'], 'and must be visible as queued')

  first.open()
  await Promise.all([a, b])
  assert.deepEqual(order, ['a in', 'a out', 'b in'], 'the second section runs only after the first ends')
  assert.deepEqual(lane.held(), [], 'and the lane is free again')
})

test('the lane is FIFO: a section arriving during a handover does not overtake one already queued', async () => {
  const lane = new CheckLane()
  const admitted: string[] = []
  const first = gate()

  const a = lane.run(claim('seat-a'), () => first.held)
  const b = lane.run(claim('seat-b'), () => void admitted.push('b'))
  const c = lane.run(claim('seat-c'), () => void admitted.push('c'))
  // Arrives while the queue is draining, which is the window a lane that merely decremented a
  // counter would let it jump: `seat-b` has been admitted but has not yet re-entered its own
  // `run`, so a naive implementation sees a free slot.
  first.open()
  const d = lane.run(claim('seat-d'), () => void admitted.push('d'))

  await Promise.all([a, b, c, d])
  assert.deepEqual(admitted, ['b', 'c', 'd'], 'admitted in the order they asked')
})

test('a section that throws releases the lane, and the failure reaches its own caller', async () => {
  const lane = new CheckLane()
  await assert.rejects(
    lane.run(claim('seat-a'), () => {
      throw new Error('the check runner exploded')
    }),
    /the check runner exploded/,
    'the caller must see its own failure, not a lane error',
  )
  assert.deepEqual(lane.held(), [], 'a fault must not strand the lane for the rest of the run')
  // The proof that it is usable, rather than merely reported as empty.
  assert.equal(await lane.run(claim('seat-b'), () => 'ran'), 'ran')
  assert.deepEqual(lane.history().map((r) => r.seat), ['seat-a', 'seat-b'], 'both sections are recorded')
})

test('a synchronous section is awaited, because both of the check runners are spawnSync', async () => {
  const lane = new CheckLane()
  // The failure this rules out: a `run` that returned before a synchronous section finished
  // would release the lane while `spawnSync` was still holding the process, and the lane would
  // be a decoration. Asserted by the value, which only exists once the section has run.
  assert.equal(await lane.run(claim('seat-a'), () => 41 + 1), 42)
  assert.equal(lane.history()[0]?.station, 'integration')
})

test('--check-concurrency raises the slot count, and the slots are real', async () => {
  const lane = new CheckLane({ concurrency: 2 })
  const inside: string[] = []
  const hold = gate()

  const a = lane.run(claim('seat-a'), async () => {
    inside.push('a')
    await hold.held
  })
  const b = lane.run(claim('seat-b'), async () => {
    inside.push('b')
    await hold.held
  })
  const c = lane.run(claim('seat-c'), () => void inside.push('c'))

  await new Promise((r) => setImmediate(r))
  assert.deepEqual(inside, ['a', 'b'], 'two sections hold the lane at once')
  assert.deepEqual(lane.queued().map((x) => x.seat), ['seat-c'], 'the third waits behind them')

  hold.open()
  await Promise.all([a, b, c])
  assert.deepEqual(inside, ['a', 'b', 'c'])
})

test('a slot count that is not a whole number of slots is refused rather than guessed at', () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => new CheckLane({ concurrency: bad }),
      /at least 1/,
      `${String(bad)} must be refused: a lane comparing a live count against it stops meaning anything`,
    )
  }
  // Absent is not a value, and is the default rather than a refusal.
  assert.equal(new CheckLane({ concurrency: undefined }).concurrency, 1)
})

test('a wait is announced, once, and only when it is real', async () => {
  const waits: string[] = []
  const lane = new CheckLane({
    onWait: (c, holders) => waits.push(`${c.seat} behind ${holders.map((h) => h.seat).join('+')}`),
  })
  // Uncontended: the whole of a default run, and it must produce nothing to read.
  await lane.run(claim('seat-a'), () => undefined)
  assert.deepEqual(waits, [], 'an uncontended lane must not narrate itself')

  const hold = gate()
  const a = lane.run(claim('seat-a'), () => hold.held)
  const b = lane.run(claim('seat-b', 'rotation'), () => undefined)
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(waits, ['seat-b behind seat-a'], 'a real wait is announced with what is holding')
  hold.open()
  await Promise.all([a, b])
})

test('the record separates waiting from working, so a queue is not read as a slow check', async () => {
  // A fake clock: the assertion is about which interval each figure measures, and sleeping
  // through real ones would make the test slow and the numbers approximate.
  let clock = 0
  const tick = () => (clock += 10)
  const lane = new CheckLane({ now: () => clock })
  const hold = gate()

  const a = lane.run(claim('seat-a'), async () => {
    tick()
    await hold.held
    tick()
  })
  const b = lane.run(claim('seat-b'), () => tick())
  await new Promise((r) => setImmediate(r))
  tick() // time passing while seat-b is queued and seat-a works
  hold.open()
  await Promise.all([a, b])

  const [first, second] = lane.history()
  assert.equal(first?.seat, 'seat-a')
  assert.equal(first?.waitedMs, 0, 'the first section waited for nothing')
  assert.ok((first?.heldMs ?? 0) > 0, 'and held the lane for the time it ran')
  assert.equal(second?.seat, 'seat-b')
  assert.ok((second?.waitedMs ?? 0) > 0, 'the second section waited, and the wait is its own figure')
})

test('a seat cannot queue behind itself: nesting is refused rather than deadlocked', async () => {
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
  assert.deepEqual(lane.held(), [])
  assert.equal(await lane.run(claim('implementer'), () => 'ran'), 'ran')
})

test('two different seats may hold and queue independently, which is the whole point', async () => {
  const lane = new CheckLane()
  const hold = gate()
  const a = lane.run(claim('implementer', 'rotation'), () => hold.held)
  const b = lane.run(claim('implementer-2', 'integration'), () => 'merged')
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(lane.queued().map((c) => `${c.seat}/${c.station}`), ['implementer-2/integration'])
  hold.open()
  await Promise.all([a, b])
  assert.deepEqual(
    lane.history().map((r) => `${r.seat}/${r.station}`),
    ['implementer/rotation', 'implementer-2/integration'],
    'the rotation went first and the boundary followed it, rather than running inside it',
  )
})
