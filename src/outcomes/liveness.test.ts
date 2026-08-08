/**
 * Telling a working child from an idle one.
 *
 *   node --test src/outcomes/liveness.test.ts
 */

import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { describeLiveness, sampleLiveness } from './liveness.ts'

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
