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

/**
 * A fixed measurement time, so the provenance sentence #101 adds is assertable.
 *
 * A real `Date.now()` here would make every line under test carry a stamp nothing could check,
 * which is one step from not checking the stamp at all -- and the stamp is the fix.
 */
const MEASURED_AT = Date.UTC(2026, 7, 13, 21, 4, 11)

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
  const idle = describeLiveness({ pid: 1, alive: true, samples: [0, 0, 0], idle: true, measuredAt: MEASURED_AT }, 0)
  assert.match(idle, /alive but not computing/)
  assert.match(idle, /Idle is not dead/)
  assert.match(idle, /nothing at all since the prompt/)

  // ...and a busy one names the consequence of continuing, which is the choice that cost a
  // real run.
  const busy = describeLiveness({ pid: 2, alive: true, samples: [42.5], idle: false, measuredAt: MEASURED_AT }, 7)
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
  measuredAt: MEASURED_AT,
})

test('the conservative idle rule is unchanged: one sample above the line is not idle', () => {
  // The asymmetry #83 explicitly keeps. A process between bursts of real work must not be
  // called idle, and a run was lost to the opposite mistake -- so the rule that decides
  // anything is untouched, and only what is SAID about the leftover case changed.
  assert.equal(readingOf(reading([0.3, 0.2, 2.9])), 'not_computing')
  assert.equal(readingOf(reading([0.3, 0.2, 3.0])), 'mixed', 'at the line is not below it')
  assert.equal(readingOf(reading([12.5, 15.0, 11.0])), 'working')
  assert.equal(readingOf({ pid: 1, alive: false, samples: [], idle: false, measuredAt: MEASURED_AT }), 'gone')
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

test('every reading says when it was measured, including the one that found nothing', () => {
  // The half of #101 that stands on its own. An operator can discount a measurement they can
  // see the age of; they cannot discount one that looks current, and every line in this file
  // used to look current forever.
  const stamp = '2026-08-13T21:04:11Z'
  for (const line of [
    describeLiveness(reading([0.1, 0.2, 0.1]), 0),
    describeLiveness(reading([12.5, 15.0, 11.0]), 40),
    describeLiveness(reading([0.3, 0.2, 7.2]), 3),
    describeLiveness({ pid: 1, alive: false, samples: [], idle: false, measuredAt: MEASURED_AT }, 3),
  ]) {
    assert.match(line, new RegExp(`Measured ${stamp}`), `no measurement time on: ${line}`)
  }
  // Seconds, not milliseconds: `ps` does not resolve finer, and three digits that mean nothing
  // are three digits a reader has to decide to ignore.
  assert.doesNotMatch(describeLiveness(reading([0.1]), 0), /\.\d{3}Z/)
})

test('a refreshed reading says so, and a reading that has stopped refreshing says that instead', () => {
  // The bound is only safe because reaching it is visible. A refresher that went quiet at its
  // limit would leave a number that looks live and is not, which is the defect this whole
  // change is about, one turn of the screw later.
  const fresh = describeLiveness(reading([12.5, 15.0, 11.0]), 40, { count: 0 })
  assert.match(fresh, /re-measured while the pause lasts/)
  assert.doesNotMatch(fresh, /no longer updates/)

  const running = describeLiveness(reading([12.5, 15.0, 11.0]), 40, { count: 7 })
  assert.match(running, /re-measured 7 time\(s\) since the pause was raised/)
  assert.doesNotMatch(running, /no longer updates/)

  const done = describeLiveness(reading([12.5, 15.0, 11.0]), 40, {
    count: 60,
    final: 're-measuring has reached its limit of 60',
  })
  assert.match(done, /re-measured 60 time\(s\)/)
  assert.match(done, /re-measuring has reached its limit of 60/)
  assert.match(done, /no longer updates and only ages from here/)

  // And no refresher at all is SILENT about refreshing rather than claiming zero. The
  // `/continue` guard samples once on demand and has no loop behind it; telling the operator it
  // has been re-measured zero times would promise updates nothing is going to deliver.
  const once = describeLiveness(reading([12.5, 15.0, 11.0]), undefined)
  assert.doesNotMatch(once, /re-measured/)
  assert.match(once, /Measured 2026-08-13T21:04:11Z\.$/)
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
    reportsChildOnCpu(describeLiveness({ pid: 1, alive: false, samples: [], idle: false, measuredAt: MEASURED_AT }, 3)),
    false,
    'a child that is gone is not waited for',
  )
})
