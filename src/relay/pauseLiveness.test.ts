/**
 * A paused run's liveness evidence is measured again, and says when it was measured.
 *
 *   node --test src/relay/pauseLiveness.test.ts
 *
 * The defect (#101) is not that the liveness verdict was wrong. It is that the SAMPLES behind
 * it were taken once and replayed: a pause raised while the child was busy went on asserting
 * busy long after it had gone quiet, and `conclave status --json` -- the only surface an agent
 * operator has -- reported it as though it were current. The operator waited out a turn that
 * was already over, twice in one day, and then aborted a run they could have continued.
 *
 * So the assertions here are about MOVEMENT, over the recorded file rather than over the
 * in-memory object. The pause is written to `status.json` and read back from disk, because the
 * whole failure is on the far side of that file: an in-process assertion would pass on a
 * refresh that never reached a reader.
 *
 * The seam is `RelayOptions.liveness`. An in-memory fake has no child process, so the injected
 * sampler is what lets a reading CHANGE between measurements on demand -- which is the one
 * thing a real `ps` cannot be asked to do inside a test.
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Verdict } from '../contract/outcome.ts'
import type { AgentSession } from '../contract/session.ts'
import type { ChildLiveness } from '../outcomes/liveness.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { newSessionId, recordSession, sessionDir } from '../workspace/sessionRecord.ts'
import { Relay, type RelayOptions } from './relay.ts'
import type { RunPause } from './run.ts'

const TIMED_OUT: Verdict = {
  outcome: 'timed_out',
  confidence: 'uncertain',
  provenance: [{ source: 'orchestrator', detail: 'past the watchdog at 600s with no Stop' }],
}

/** The pid the fake claims. Never sampled: the injected reader answers for it. */
const CHILD_PID = 66247

/** The reading from the issue, verbatim: the line that told an operator not to continue. */
const WORKING: ChildLiveness = {
  pid: CHILD_PID,
  alive: true,
  samples: [3.3, 5.1, 3.5],
  // The pid alone, and no descendants: the child in the report was a CLI doing its own work,
  // and the tree aggregate #111 added is the same three numbers where nothing hangs off it.
  selfSamples: [3.3, 5.1, 3.5],
  busiestDescendant: [],
  descendants: 0,
  workingDescendants: 0,
  idle: false,
  measuredAt: 0,
}

/** What the same child was actually doing seconds later, also from the issue. */
const QUIET: ChildLiveness = {
  pid: CHILD_PID,
  alive: true,
  samples: [0.2, 0.7, 0.2],
  selfSamples: [0.2, 0.7, 0.2],
  busiestDescendant: [],
  descendants: 0,
  workingDescendants: 0,
  idle: true,
  measuredAt: 0,
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-pause-liveness-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'work.ts'), 'export const answer = 42\n')
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

function registryOf(queues: Record<string, AgentSession[]>): AgentRegistry {
  const r = new AgentRegistry()
  for (const [agent, sessions] of Object.entries(queues)) {
    const remaining = [...sessions]
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
      // An in-memory double: no child process, so no clock of either kind.
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

async function relayOf(
  cwd: string,
  advisor: FakeRotationSession,
  implementers: FakeRotationSession[],
  over: Partial<RelayOptions> = {},
): Promise<Relay> {
  return Relay.start({
    registry: registryOf({ codex: [advisor], claude: implementers }),
    cwd,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 4,
    ...over,
  })
}

/** Poll for something the run does on a timer. Bounded, so a failure is a failure. */
async function until<T>(what: string, f: () => T | undefined, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = f()
    if (v !== undefined) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** The pause as an outside reader sees it: parsed from the file, never from the handle. */
function recordedPause(root: string, id: string): RunPause | undefined {
  const raw = readFileSync(join(sessionDir(root, id), 'status.json'), 'utf8')
  return (JSON.parse(raw) as { pause?: RunPause }).pause
}

/** The liveness line, found the way a reader finds it rather than by index. */
function livenessLine(p: RunPause | undefined): string | undefined {
  return p?.evidence.find((e) => e.startsWith(`child pid ${CHILD_PID} `))
}

test('the evidence a paused run publishes changes when the child does', async (t) => {
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it, slowly.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT }
  impl.childPid = CHILD_PID
  // Busy for the reading the pause is raised on, quiet for every reading after it -- which is
  // exactly the sequence the issue reports: the turn ended while the operator was reading.
  let reads = 0
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']), [impl], {
    liveness: async () => ({ ...(++reads === 1 ? WORKING : QUIET), measuredAt: Date.now() }),
    livenessRefreshMs: 30,
    // Small, so the bound is REACHED inside the test. A limit only ever exercised in production
    // is a limit nobody has seen work, and the whole argument for bounding it is that the stop
    // is visible.
    livenessRefreshLimit: 3,
  })
  t.after(() => relay.stop())

  const id = newSessionId(Date.now(), process.pid)
  const recording = recordSession(relay, {
    repoRoot: dir,
    id,
    goal: 'Keep the work moving.',
    front: 'session',
    startedAt: Date.now(),
    build: 'test',
  })
  t.after(() => recording.close())

  const run = relay.start('Keep the work moving.')
  const pause = await run.untilPause()
  assert.ok(pause)
  assert.equal(pause.reason, 'turn_incomplete')
  // What the console does at a pause, and the only reason the pause is in the file at all.
  recording.set('paused', { pause })

  // The reading the pause was raised on: the issue's own numbers, and its own wrong advice.
  const first = recordedPause(dir, id)
  const firstLine = livenessLine(first)
  assert.ok(firstLine, `no liveness line in ${JSON.stringify(first?.evidence)}`)
  assert.match(firstLine, /is still working \(cpu 3\.3%, 5\.1%, 3\.5%\)/)
  assert.match(firstLine, /Continuing sends into a live turn/)
  // Timestamped from the first line onwards, which is half of the fix on its own: a reader can
  // discount an old measurement and cannot discount one that looks current.
  assert.match(firstLine, /Measured \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/)
  assert.match(firstLine, /re-measured while the pause lasts/)
  assert.equal(first?.liveness?.participant, 'implementer')
  assert.equal(first?.liveness?.reading, 'working')
  assert.equal(first?.liveness?.refreshes, 0)
  assert.equal(first?.liveness?.final, undefined)
  assert.deepEqual(first?.liveness?.sample.samples, [3.3, 5.1, 3.5])
  assert.equal(first.evidence[first.liveness!.index], firstLine, 'index names its own line')

  // THE ASSERTION THIS FILE EXISTS FOR. The child went quiet; the published evidence follows.
  const second = await until('the recorded evidence to be re-measured', () => {
    const p = recordedPause(dir, id)
    return p?.liveness && p.liveness.refreshes > 0 ? p : undefined
  })
  const secondLine = livenessLine(second)!
  assert.match(secondLine, /is alive but not computing \(cpu 0\.2%, 0\.7%, 0\.2%\)/)
  assert.doesNotMatch(secondLine, /is still working/, 'the replayed claim is gone')
  assert.doesNotMatch(secondLine, /Continuing sends into a live turn/)
  assert.match(secondLine, /re-measured \d+ time\(s\) since the pause was raised/)
  assert.equal(second.liveness!.reading, 'not_computing')
  assert.ok(
    second.liveness!.sample.measuredAt > first.liveness!.sample.measuredAt,
    'the measurement is newer than the one it replaced',
  )
  assert.equal(second.liveness!.firstAt, first.liveness!.sample.measuredAt, 'the original reading is still dated')
  assert.notEqual(secondLine, firstLine)

  // The bound, and the fact that reaching it is SAID. A refresher that fell silent here would
  // leave a number that looks live and is not -- #101 again, with newer digits in it.
  const last = await until('re-measuring to reach its bound', () => {
    const p = recordedPause(dir, id)
    return p?.liveness?.final ? p : undefined
  })
  assert.equal(last.liveness!.refreshes, 3)
  assert.match(livenessLine(last)!, /re-measuring has reached its limit of 3/)
  assert.match(livenessLine(last)!, /no longer updates and only ages from here/)

  // `wait` travels with the line that justifies it. It was offered on the working reading and
  // is withdrawn once the child has gone quiet, because waiting is only the right answer while
  // there is something to wait for -- the coupling `reportsChildOnCpu` exists to hold, now that
  // the evidence it reads can move underneath it (#83).
  assert.ok(first.options.includes('wait'), 'a working child is worth waiting for')
  assert.ok(!last.options.includes('wait'), 'a quiet one is not')
  assert.deepEqual(
    last.options.filter((o) => o !== 'wait'),
    first.options.filter((o) => o !== 'wait'),
    'and nothing else about the menu moves: a CPU sample says nothing about the other options',
  )

  // Nothing about a refresh DECIDES anything. The run is still paused, on the same pause object,
  // and no refreshed reading resumed it. Continuing is the console's `/continue`, which samples
  // the child itself at the moment of the decision and refuses on anything not clearly idle
  // (#43) -- it does not read any of this. See src/repl/session.test.ts.
  assert.equal(run.state, 'paused')
  assert.equal(run.pause, pause, 'refreshing amends the pause, it does not raise another')

  await run.abort()
})

test('a pause on a seat with no child pid carries no liveness block at all', async (t) => {
  // The other half of "best effort". An adapter that exposes no child leaves the pause reading
  // exactly as it did before, rather than gaining an empty block a reader would have to
  // interpret -- and nothing schedules a refresher for a measurement that was never taken.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it, slowly.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT }
  let sampled = 0
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']), [impl], {
    liveness: async () => {
      sampled++
      return { ...WORKING, measuredAt: Date.now() }
    },
    livenessRefreshMs: 20,
  })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const pause = await run.untilPause()
  assert.ok(pause)
  assert.equal(pause.reason, 'turn_incomplete')
  assert.equal(pause.liveness, undefined)
  assert.equal(livenessLine(pause), undefined)
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(sampled, 0, 'no pid is no reading, and nothing was invented to refresh')
  assert.ok(!pause.options.includes('wait'), 'no measurement is no grounds for offering a wait')

  await run.abort()
})

test('a sampling failure keeps the last reading rather than blanking the line', async (t) => {
  // A `ps` that throws mid-pause must not cost the operator the line they are deciding on. The
  // count still advances to the bound, so the evidence ends up saying it has stopped updating --
  // which is the honest report of a refresher that ran and learnt nothing.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it, slowly.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT }
  impl.childPid = CHILD_PID
  let reads = 0
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']), [impl], {
    liveness: async () => {
      if (++reads > 1) throw new Error('ps: no such process table')
      return { ...WORKING, measuredAt: Date.now() }
    },
    livenessRefreshMs: 20,
    livenessRefreshLimit: 2,
  })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const pause = await run.untilPause()
  assert.ok(pause)
  const raised = livenessLine(pause)!
  assert.match(raised, /is still working \(cpu 3\.3%, 5\.1%, 3\.5%\)/)

  await until('the bound to be reached despite the failures', () => (pause.liveness?.final ? true : undefined))
  const line = livenessLine(pause)!
  assert.match(line, /is still working \(cpu 3\.3%, 5\.1%, 3\.5%\)/, 'the reading survived')
  assert.equal(pause.liveness!.sample.measuredAt, pause.liveness!.firstAt, 'and it is still dated to when it was taken')
  // THE LINE IS STILL REWRITTEN, from that same unchanged sample. Keeping the reading and
  // leaving the sentence alone would publish `final` as data while the prose beside it went on
  // saying "re-measured while the pause lasts" -- a promise of updates that will never arrive,
  // which is the defect this change exists to remove, in the one place nobody would look for it.
  assert.notEqual(line, raised)
  assert.match(line, /re-measuring has reached its limit of 2/)
  assert.match(line, /no longer updates and only ages from here/)
  assert.doesNotMatch(line, /re-measured while the pause lasts/)

  await run.abort()
})

test('a run torn down at a pause stops re-measuring, rather than sampling a closed session', async (t) => {
  // `relay.stop()` ends the run WITHOUT resolving the pause, so `#halt` stays suspended and the
  // `finally` that stops the refresher never runs. A console reaching the end of a piped stdin
  // takes exactly that path. Left unguarded the timer sampled a closed session's pid for the
  // rest of its bound and emitted into a closed stream, which counts refusals as an alarm.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it, slowly.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT }
  impl.childPid = CHILD_PID
  let reads = 0
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']), [impl], {
    liveness: async () => {
      reads++
      return { ...WORKING, measuredAt: Date.now() }
    },
    livenessRefreshMs: 20,
    livenessRefreshLimit: 200,
  })

  const run = relay.start('Keep the work moving.')
  const pause = await run.untilPause()
  assert.ok(pause)
  await until('at least one refresh before teardown', () => (pause.liveness!.refreshes > 0 ? true : undefined))

  await relay.stop()
  assert.equal(run.state, 'paused', 'the premise: stop() does not resolve the pause')
  const afterStop = reads
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(reads, afterStop, 'nothing was sampled after the run was torn down')
  t.diagnostic(`${afterStop} samples taken before teardown`)
})

test('a limit of zero means no refresher at all, not one measurement', async (t) => {
  // The bound is tested AFTER a reading is taken, so a zero that reached the timer would sample
  // once and then announce it had reached a limit of none.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Did it, slowly.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT }
  impl.childPid = CHILD_PID
  let reads = 0
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']), [impl], {
    liveness: async () => {
      reads++
      return { ...WORKING, measuredAt: Date.now() }
    },
    livenessRefreshMs: 10,
    livenessRefreshLimit: 0,
  })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const pause = await run.untilPause()
  assert.ok(pause)
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(reads, 1, 'the reading the pause was raised on, and no other')
  assert.equal(pause.liveness!.refreshes, 0)
  assert.equal(pause.liveness!.final, undefined)

  await run.abort()
})
