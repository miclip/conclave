/**
 * Telling a working child from an idle one.
 *
 *   node --test src/outcomes/liveness.test.ts
 */

import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import test from 'node:test'
import {
  describeLiveness,
  readingOf,
  reportsChildOnCpu,
  sampleLiveness,
  type ChildLiveness,
} from './liveness.ts'

test('a process doing nothing reads as idle, and a busy one does not', async () => {
  // Two real processes rather than a stub, because the thing under test is whether `ps`
  // says what we think it says — which is exactly the assumption a stub would enshrine.
  const idle = spawn('sleep', ['30'], { stdio: 'ignore' })
  const busy = spawn('sh', ['-c', 'while :; do :; done'], { stdio: 'ignore' })
  try {
    // Let them age before measuring. `%cpu` is CPU time over ELAPSED time, so a process a
    // few milliseconds old reads as busy on its startup cost alone -- a freshly spawned
    // `sleep` measured 0.8% on a CI runner and failed a release. The production caller
    // samples a child that has been silent for minutes; this reproduces that precondition
    // rather than pretending it does not exist.
    await new Promise((r) => setTimeout(r, 1_500))
    const [i, b] = await Promise.all([
      sampleLiveness(idle.pid!, { samples: 3, everyMs: 250 }),
      sampleLiveness(busy.pid!, { samples: 3, everyMs: 250 }),
    ])
    assert.equal(i.alive, true)
    assert.equal(i.idle, true, `a sleeping process must read idle; saw ${i.samples}`)
    assert.equal(b.alive, true)
    assert.equal(b.idle, false, `a spinning process must not read idle; saw ${b.samples}`)
  } finally {
    idle.kill('SIGKILL')
    busy.kill('SIGKILL')
  }
})

test('a process that is gone is reported as gone, not as idle', async () => {
  // The distinction that matters at a pause: "not computing" and "not there" want different
  // answers, and collapsing them would recreate the ambiguity this exists to remove.
  const p = spawn('sleep', ['30'], { stdio: 'ignore' })
  const pid = p.pid!
  p.kill('SIGKILL')
  await new Promise((r) => setTimeout(r, 300))
  const l = await sampleLiveness(pid, { samples: 2, everyMs: 50 })
  assert.equal(l.alive, false)
  assert.equal(l.idle, false, 'a dead process is not idle')
  assert.match(describeLiveness(l, 0), /is gone/)
})

test('the evidence line says what was measured, never what it means', async () => {
  // A child at 0% CPU may be waiting on a provider that stopped answering, so "idle" must
  // not read as "dead" — inventing a confident answer from a weak signal is the failure this
  // project keeps finding in its own diagnostics.
  const idle = describeLiveness({ pid: 1, alive: true, samples: [0, 0, 0], idle: true }, 0)
  assert.match(idle, /alive but not computing/)
  assert.match(idle, /Idle is not dead/)
  assert.match(idle, /nothing at all since the prompt/)

  // ...and a busy one names the consequence of continuing, which is the choice that cost a
  // real run.
  const busy = describeLiveness({ pid: 2, alive: true, samples: [42.5], idle: false }, 7)
  assert.match(busy, /still working/)
  assert.match(busy, /7 event\(s\) since the prompt/)
  assert.match(busy, /neither CLI accepts/)
})

/** The reading under test, spelled out rather than sampled, so the numbers are the point. */
const reading = (samples: number[]): ChildLiveness => ({
  pid: 18255,
  alive: true,
  samples,
  idle: samples.every((c) => c < 3),
})

test('the conservative idle rule is unchanged: one sample above the line is not idle', () => {
  // The asymmetry #83 explicitly keeps. A process between bursts of real work must not be
  // called idle, and a run was lost to the opposite mistake -- so the rule that decides
  // anything is untouched, and only what is SAID about the leftover case changed.
  assert.equal(readingOf(reading([0.3, 0.2, 2.9])), 'not_computing')
  assert.equal(readingOf(reading([0.3, 0.2, 3.0])), 'mixed', 'at the line is not below it')
  assert.equal(readingOf(reading([12.5, 15.0, 11.0])), 'working')
  assert.equal(readingOf({ pid: 1, alive: false, samples: [], idle: false }), 'gone')
})

test('the sample from #83 is not asserted to be a live turn', () => {
  // The numbers verbatim from the report: a rejected model doing nothing at all, two samples
  // at rest and one burst, announced to the operator as "still working" — which read as a true
  // report of a false thing, and is the entire bug.
  const line = describeLiveness(reading([0.3, 0.2, 7.2]), 3)
  assert.doesNotMatch(line, /still working/, 'a mixed sample is not evidence of a turn in flight')
  assert.match(line, /is barely running/)
  // Still a measurement: the values that produced the reading are all there, unrounded away.
  assert.match(line, /cpu 0\.3%, 0\.2%, 7\.2%/)
  assert.match(line, /3 event\(s\) since the prompt was sent/)
  assert.match(line, /2 below 3% and 1 at or above/)
  // The event count as an INPUT rather than a trailing clause, which is the half of the issue
  // that is easy to drop: three events is what makes "not making progress" the likelier read.
  assert.match(line, /little output the likelier reading is a child making no progress/)
  // And it stops short of the opposite assertion. "Barely running" is not "stalled", and the
  // operator is the one who decides -- inventing a confident answer from a weak signal is the
  // failure this file exists to avoid, in either direction.
  assert.match(line, /not proof of a stall/)
  assert.match(line, /Continuing still sends into whatever produced the high sample/)
})

test('a mixed sample that is mostly busy, with output still arriving, reads the other way', () => {
  // Same reading, opposite lean. One gap in three samples on a child that has emitted plenty
  // is a turn between chunks, and flattening this into the same sentence as the case above
  // would trade one confident wrong answer for another.
  const line = describeLiveness(reading([14.0, 0.4, 11.0]), 40)
  assert.match(line, /is working in bursts/)
  assert.match(line, /1 below 3% and 2 at or above/)
  assert.match(line, /Output is still arriving, so the low samples read as gaps between bursts/)
  assert.doesNotMatch(line, /still working/, 'the confident phrase belongs to the all-high reading')
})

test('no output count is said to be no output count, and not to be zero', () => {
  // The `/continue` guard samples the child fresh and has no count to pair with it. It passed
  // `0`, which rendered as "nothing at all since the prompt was sent" -- a measurement nobody
  // took, and now an input to the reading rather than a clause beside it.
  const line = describeLiveness(reading([0.3, 0.2, 7.2]), undefined)
  assert.match(line, /no output count was taken with this reading/)
  assert.doesNotMatch(line, /nothing at all since the prompt/)
  assert.match(line, /No output count was taken here, so the split is all there is to read/)
  assert.doesNotMatch(line, /likelier reading/, 'no count is no basis for leaning either way')
})

test('the pause menu offers `wait` on every reading that saw CPU, mixed included', () => {
  // Driven through `describeLiveness` rather than against the phrases, because the relay reads
  // the operator's own evidence line (`reportsChildOnCpu` at the `wait` option in relay.ts) and
  // a phrase that drifted apart from the matcher would take the non-destructive option off the
  // menu silently -- in the mixed case, which is where waiting is worth the most.
  for (const samples of [[12.5, 15.0], [0.3, 0.2, 7.2], [14.0, 0.4, 11.0]]) {
    const line = describeLiveness(reading(samples), 3)
    assert.equal(reportsChildOnCpu(line), true, `must offer wait for ${samples}`)
  }
  assert.equal(reportsChildOnCpu(describeLiveness(reading([0.1, 0.2]), 3)), false, 'idle offers no wait')
  assert.equal(
    reportsChildOnCpu(describeLiveness({ pid: 1, alive: false, samples: [], idle: false }, 3)),
    false,
    'a child that is gone is not waited for',
  )
})
