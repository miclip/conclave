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
  parseProcessTable,
  readingOf,
  reportsChildOnCpu,
  sampleLiveness,
  treeSnapshotOf,
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
  const idle = describeLiveness(reading([0, 0, 0], { pid: 1 }), 0)
  assert.match(idle, /alive but not computing/)
  assert.match(idle, /Idle is not dead/)
  assert.match(idle, /nothing at all since the prompt/)

  // ...and a busy one names the consequence of continuing, which is the choice that cost a
  // real run.
  const busy = describeLiveness(reading([42.5], { pid: 2 }), 7)
  assert.match(busy, /still working/)
  assert.match(busy, /7 event\(s\) since the prompt/)
  assert.match(busy, /neither CLI accepts/)
})

/**
 * The reading under test, spelled out rather than sampled, so the numbers are the point.
 *
 * `samples` is the TREE aggregate since #111, and with no descendants declared the tree is the
 * pid: `selfSamples` mirrors it, which is exactly what `sampleLiveness` produces for a child
 * that has not shelled out to anything.
 */
const reading = (
  samples: number[],
  over: Partial<ChildLiveness> = {},
): ChildLiveness => ({
  pid: 18255,
  alive: true,
  samples,
  selfSamples: samples,
  descendants: 0,
  workingDescendants: 0,
  idle: samples.every((c) => c < 3),
  measuredAt: MEASURED_AT,
  ...over,
})

/** A child that is not there. Every field a gone reading has, in one place. */
const GONE: ChildLiveness = reading([], { pid: 1, alive: false, idle: false })

test('the conservative idle rule is unchanged: one sample above the line is not idle', () => {
  // The asymmetry #83 explicitly keeps. A process between bursts of real work must not be
  // called idle, and a run was lost to the opposite mistake -- so the rule that decides
  // anything is untouched, and only what is SAID about the leftover case changed.
  assert.equal(readingOf(reading([0.3, 0.2, 2.9])), 'not_computing')
  assert.equal(readingOf(reading([0.3, 0.2, 3.0])), 'mixed', 'at the line is not below it')
  assert.equal(readingOf(reading([12.5, 15.0, 11.0])), 'working')
  assert.equal(readingOf(GONE), 'gone')
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
    describeLiveness(GONE, 3),
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
    reportsChildOnCpu(describeLiveness(GONE, 3)),
    false,
    'a child that is gone is not waited for',
  )
})

/**
 * A quiet parent in front of a spinning descendant, with real processes.
 *
 * The whole of #111 in one shape: `sh` waiting on a background `sh` that is burning a core is
 * what a seat that shelled out to `go test` looks like from the process table, and the reading
 * this file used to take was of the waiting one. Two real processes rather than a stub, for the
 * same reason the idle/busy test above uses them -- the thing under test is whether the walk
 * finds the grandchild `ps` actually reports, which is exactly what a stub would assume.
 */
test('a quiet parent with a working descendant is reported as working, not as idle', async () => {
  // Detached so the spinner is in its own process group and can be killed with it. It also puts
  // the parent in a new session, which is the case `ps -Ao` was chosen for: Linux's `-a` drops
  // session leaders, so `-axo` could omit this very process on the Ubuntu half of CI.
  const parent = spawn('sh', ['-c', 'sh -c "while :; do :; done" & wait'], {
    stdio: 'ignore',
    detached: true,
  })
  const pid = parent.pid!
  try {
    // Aged before measuring, for the reason the first test in this file explains at length.
    await new Promise((r) => setTimeout(r, 1_500))
    const l = await sampleLiveness(pid, { samples: 3, everyMs: 250 })
    assert.equal(l.alive, true)
    assert.ok(
      l.selfSamples.every((c) => c < 3),
      `the parent itself must read quiet, which is the premise of the bug; saw ${l.selfSamples}`,
    )
    assert.ok(l.descendants >= 1, `the walk must find the spinner; saw ${l.descendants} descendant(s)`)
    assert.ok(
      l.workingDescendants >= 1,
      `the spinner must count as working; saw ${l.workingDescendants} of ${l.descendants}`,
    )
    assert.ok(
      l.samples.every((c) => c >= 3),
      `the tree aggregate must carry the spinner; saw ${l.samples}`,
    )
    assert.equal(l.idle, false, 'a seat with a busy grandchild is not an idle seat')
    assert.equal(readingOf(l), 'working')
    // And the operator's line leads with the fact they were running `pgrep` to get.
    const line = describeLiveness(l, 3)
    assert.match(line, /child pid \d+ quiet, \d+ descendants? working \(cpu /)
    assert.doesNotMatch(line, /is barely running/, 'the old line was true about the wrong process')
    assert.equal(reportsChildOnCpu(line), true, 'a busy tree must still offer `wait`')
  } finally {
    // The group, not the pid: killing the waiting parent leaves the spinner running forever.
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      parent.kill('SIGKILL')
    }
  }
})

test('the walk reaches a grandchild, and a table that appears to loop does not loop it', () => {
  // Depth is the part a one-level check would get wrong: `claude` -> `bash` -> `go test` -> `z3`
  // is four deep, and only the last of them is doing anything.
  const rows = parseProcessTable(['100 1 0.2', '200 100 0.1', '300 200 97.4', '400 1 55.0'].join('\n'))
  const t = treeSnapshotOf(rows, 100)!
  assert.equal(t.self, 0.2)
  assert.equal(t.tree, 97.7, 'the grandchild is in the aggregate; the unrelated pid 400 is not')
  assert.equal(t.descendants, 2)
  assert.equal(t.working, 1, 'the idle intermediate shell is a descendant, not a working one')

  // `ps` reads its rows at slightly different instants, so a table can describe a cycle that was
  // never true. A walk with no memory would follow it until the process ran out of stack.
  const looped = parseProcessTable(['100 300 0.1', '200 100 0.1', '300 200 0.1'].join('\n'))
  const c = treeSnapshotOf(looped, 100)!
  assert.equal(c.descendants, 2)
  assert.equal(c.tree, 0.3)

  assert.equal(treeSnapshotOf(rows, 999), undefined, 'a pid the table does not contain is gone')
})

test('a row that does not parse is dropped rather than counted as zero', () => {
  // A dropped row loses a process from the aggregate; a defaulted one puts a number nobody
  // measured into it. `ps` runs under LC_ALL=C so the decimal-comma case below cannot arise
  // from a differently-configured runner -- this pins what happens if it ever does.
  const rows = parseProcessTable(['100 1 0.5', '  ', 'nonsense', '200 100 0,5', '300 100 1.5'].join('\n'))
  assert.deepEqual(
    rows.map((r) => r.pid),
    [100, 300],
  )
  assert.equal(treeSnapshotOf(rows, 100)!.tree, 2)
})

/** A parent that has shelled out: quiet itself, with the work one level down. */
const SHELLED_OUT: ChildLiveness = reading([98.5, 99.1, 98.8], {
  selfSamples: [0.4, 0.2, 0.3],
  descendants: 1,
  workingDescendants: 1,
  idle: false,
})

test('the evidence leads with the descendant, and prints both halves of the measurement', () => {
  const line = describeLiveness(SHELLED_OUT, 3)
  // The sentence the issue asks for, in as many words.
  assert.match(line, /child pid 18255 quiet, 1 descendant working/)
  // Both numbers, because the operator's next move is to go and look at one of these processes
  // and they need to know which. Neither is rounded away.
  assert.match(line, /\(cpu 0\.4%, 0\.2%, 0\.3% self; 98\.5%, 99\.1%, 98\.8% tree\)/)
  assert.match(line, /3 event\(s\) since the prompt was sent/)
  assert.match(line, /Continuing sends into a live turn/)
  assert.doesNotMatch(line, /alive but not computing/)
  assert.doesNotMatch(line, /is barely running/)

  // Plural agrees, and the matcher agrees with the builder -- the coupling `reportsChildOnCpu`
  // exists to hold, now that the head has a number in it and cannot be matched by `includes`.
  const many = describeLiveness({ ...SHELLED_OUT, workingDescendants: 4, descendants: 9 }, 3)
  assert.match(many, /quiet, 4 descendants working/)
  for (const line of [describeLiveness(SHELLED_OUT, 3), many]) {
    assert.equal(reportsChildOnCpu(line), true, `must offer wait for: ${line}`)
  }
})

test('a reading with no descendants says nothing about descendants', () => {
  // The head of every pre-#111 line is byte-identical, which is what keeps the #83 and #101
  // assertions above meaningful -- and a `0.3% self; 0.3% tree` clause would spend words on a
  // distinction that does not exist when the tree is one process.
  const line = describeLiveness(reading([0.3, 0.2, 7.2]), 3)
  assert.match(line, /\(cpu 0\.3%, 0\.2%, 7\.2%\)/)
  assert.doesNotMatch(line, /self;/)
  assert.doesNotMatch(line, /descendant/)
})

test('descendants that exist and do nothing are reported as exactly that', () => {
  // The falsifier for the `pgrep` workaround the issue quotes: on the machine this was written
  // on, ten idle `sinesync mcp start` helpers sit under long-lived parents at 0.0%. "Has
  // descendants" would call every one of those a working child, so the count of descendants
  // that EXIST is never allowed to stand in for the count that is computing.
  const helpers = reading([0.6, 0.4, 0.5], {
    selfSamples: [0.2, 0.1, 0.2],
    descendants: 10,
    workingDescendants: 0,
  })
  const line = describeLiveness(helpers, 2)
  assert.equal(readingOf(helpers), 'not_computing')
  assert.match(line, /is alive but not computing/)
  assert.match(line, /10 descendant\(s\) exist and none of them is computing/)
  assert.match(line, /not evidence of work, only a place work could be/)
  assert.doesNotMatch(line, /descendant working/)
  assert.equal(reportsChildOnCpu(line), false, 'idle helpers are not something to wait for')
})

test('a quiet tree that is still producing output says so instead of reading as an idle seat', () => {
  // The case the aggregate cannot explain and must not paper over: nothing on the CPU anywhere
  // in the tree, and events still arriving. That is a turn generating at the provider, and
  // "alive but not computing" on its own invites the operator to treat it as a free seat.
  const generating = reading([0.4, 0.3, 0.4], {
    selfSamples: [0.2, 0.2, 0.3],
    descendants: 2,
    workingDescendants: 0,
  })
  const line = describeLiveness(generating, 40)
  assert.match(line, /is alive but not computing/)
  assert.match(line, /Nothing in this tree is computing — not the pid and not one of its 2 descendant\(s\)/)
  assert.match(line, /40 event\(s\) have arrived since the prompt was sent/)
  assert.match(line, /generating at the provider, not a seat with nothing to do/)
  // And it is said once. The "descendants exist and none is computing" note says the same thing
  // at less length, so it stands down here rather than reading as a second finding.
  assert.doesNotMatch(line, /exist and none of them is computing/)

  // With no descendants at all the same sentence still holds, and says which it is.
  const bare = describeLiveness(reading([0.1, 0.2, 0.1]), 40)
  assert.match(bare, /not the pid and it has no descendants/)

  // And it is not claimed where there is no output to claim it about. Near-silence with a quiet
  // tree is the ordinary idle reading, and inventing a provider turn under it would be the same
  // confident-answer-from-a-weak-signal this file exists to avoid, pointed the other way.
  const quiet = describeLiveness(reading([0.1, 0.2, 0.1]), 0)
  assert.doesNotMatch(quiet, /Nothing in this tree is computing/)
  assert.match(quiet, /nothing at all since the prompt was sent/)
})
