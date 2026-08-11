/**
 * The REPL, driven by a scripted stdin.
 *
 * It is the user-facing surface, so it is the surface most likely to rot unnoticed: every
 * live run so far has gone through the library, not through this. The point of these tests
 * is not the rendering — it is that the console remains a CLIENT of `RunHandle` and holds
 * no lifecycle state of its own.
 *
 *   node --test src/repl/session.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { resolveSession } from '../workspace/sessionRecord.ts'
import { formatSessionJson } from '../workspace/sessionView.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import test from 'node:test'
import type { Verdict } from '../contract/outcome.ts'
import type { ChildLiveness } from '../outcomes/liveness.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import type { AgentSession } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { runSession, seatsToSampleAtPause, withHeartbeat } from './session.ts'
import type { ResolutionSubject } from '../relay/resolution.ts'
import { resolutionFor } from '../relay/resolution.ts'
import type { RunPause } from '../relay/run.ts'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-repl-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'work.ts'), 'export const a = 1\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

function registryOf(
  sessions: Record<string, AgentSession[]>,
  /**
   * Observes what a participant was launched with, which is otherwise invisible.
   *
   * The whole context rather than just `args`: the turn deadline travels the same path and
   * had never been checked, which is how `--turn-timeout` reached the console's option
   * object and was dropped before any adapter saw it.
   */
  onLaunch?: (agent: string, args: string[] | undefined, ctx?: { watchdogMs?: number | undefined }) => void,
): AgentRegistry {
  const r = new AgentRegistry()
  for (const [agent, queue] of Object.entries(sessions)) {
    const remaining = [...queue]
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
      async create(resolved, ctx) {
        onLaunch?.(agent, resolved.spec.args, ctx)
        const next = remaining.shift()
        if (!next) throw new Error(`no session left for ${agent}`)
        return next
      },
    })
  }
  return r
}

/** Feed lines with a small delay, so the run reaches a pause before the next command. */
function script(lines: string[], gapMs = 350): PassThrough {
  const s = new PassThrough()
  void (async () => {
    for (const l of lines) {
      await new Promise((r) => setTimeout(r, gapMs))
      s.write(`${l}\n`)
    }
  })()
  return s
}

/** A participant whose turns take long enough for a console to be typed at. */
function slow(id: string, agent: string, replies: string[], ms = 250): FakeRotationSession {
  const s = new FakeRotationSession(id, agent, replies)
  s.delayMs = ms
  return s
}

function collect(): { stream: Writable; text: () => string } {
  const chunks: string[] = []
  return {
    stream: new Writable({
      write(c, _e, cb) {
        chunks.push(String(c))
        cb()
      },
    }),
    text: () => chunks.join(''),
  }
}

test('a session runs to completion and reports the outcome', async () => {
  const dir = repo()
  const out = collect()
  const code = await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])],
      claude: [new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])],
    }),
    input: script([]),
    output: out.stream,
  })
  assert.equal(code, 0)
  assert.match(out.text(), /run ended: done/)
  // Without checks, rotation is refused rather than done unverified — and it says so.
  assert.match(out.text(), /pass --checks/)
})

test('a session registers its hooks in the project, for the CLIs it will actually launch', async () => {
  // Two Claudes is a real configuration. Writing a Codex sidecar for it would then demand
  // a Codex trust decision before anything reported ready — a setup step for a CLI this
  // session never launches.
  const dir = repo()
  const out = collect()
  const code = await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'claude',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    registry: registryOf({
      claude: [
        new FakeRotationSession('advisor', 'claude', ['Do it.', 'DONE']),
        new FakeRotationSession('impl', 'claude', ['ack', 'Did it.']),
      ],
    }),
    input: script([]),
    output: out.stream,
  })
  assert.equal(code, 0)
  assert.equal(existsSync(join(dir, '.claude', 'settings.json')), true, 'the project gets Claude hooks')
  assert.equal(existsSync(join(dir, '.codex', 'hooks.json')), false, 'and no sidecar for an unused CLI')

  // The registration points back at Conclave, so the project needs nothing installed.
  const settings = readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')
  assert.ok(settings.includes('hook_post.py'))
  assert.ok(!settings.includes(dir), 'a command must not point into the project being registered')
})

test('a bypass config reaches the launch, and the console says so', async () => {
  // The flags are the whole point — a config that parsed correctly and never reached the
  // child would look identical from here until a permission prompt appeared mid-run.
  const dir = repo()
  mkdirSync(join(dir, '.conclave'), { recursive: true })
  writeFileSync(join(dir, '.conclave', 'config.json'), '{"permissions":"bypass"}')

  const launched: Record<string, string[] | undefined> = {}
  const out = collect()
  const code = await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 2,
    checks: [],
    registry: registryOf(
      {
        codex: [slow('advisor', 'codex', ['DONE'])],
        claude: [slow('impl', 'claude', ['ack'])],
      },
      (agent, args) => {
        launched[agent] = args
      },
    ),
    input: script([]),
    output: out.stream,
  })
  assert.equal(code, 0)
  assert.deepEqual(launched['codex'], ['--dangerously-bypass-approvals-and-sandbox'])
  assert.deepEqual(launched['claude'], ['--dangerously-skip-permissions'])
  // Said while it runs, not only in a file configured weeks ago and not being looked at.
  assert.match(out.text(), /permission prompts bypassed for advisor \(codex\) and implementer \(claude\)/)
})

test('a pause is rendered with its evidence and the operator resumes it', async () => {
  const dir = repo()
  // Compacts deterministically on its second turn rather than on a timer.
  const impl = slow('impl', 'claude', ['ack', 'Did it.', 'And again.'])
  impl.compactOnTurn = 1
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 4,
    checks: ['true'],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'])],
      claude: [impl, slow('fresh', 'claude', [])],
    }),
    // Driven by the pause ARRIVING, not by a 900ms guess that it will have. `/state` typed
    // early reports `run: running` and the assertion below then reads as a bug in `/state`
    // -- which is how this failed a release on the slower Intel runner while passing
    // everywhere else. A test whose correctness depends on which machine runs it is not
    // testing what it claims to.
    input: input,
    output: out.stream,
  })
  await untilText('the pause to be rendered', out.text, /● paused rotation_candidate/)
  input.write('/state\n')
  await untilText('/state to answer', out.text, /run: paused|run: running/)
  input.write('/continue\n')
  assert.equal(await running, 0)

  const text = out.text()
  assert.match(text, /paused/)
  assert.match(text, /rotation_candidate/)
  assert.match(text, /compaction generation rose 0 → 1/)
  assert.match(text, /\/continue/, 'the options are offered')
  assert.match(text, /run: paused \(rotation_candidate\)/, '/state reports the handle, not a local copy')
  assert.match(text, /run ended: done/)
})

test('an addressed line is queued, restricted, and reported as such', async () => {
  const dir = repo()
  const impl = slow('impl', 'claude', ['ack', 'Did it.', 'And again.'])
  const out = collect()
  const code = await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 4,
    checks: [],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'])],
      claude: [impl],
    }),
    input: script(['>implementer touch nothing under src/adapters', '/audit'], 300),
    output: out.stream,
  })
  assert.equal(code, 0)
  const text = out.text()
  // Queued, not delivered mid-turn — the console says which, rather than implying the
  // participant is reading over the operator's shoulder.
  assert.match(text, /queued for implementer at the next exchange/)
  // No `withheld from advisor` line: `→ implementer` already says where it went, and on a
  // two-participant run the exclusion follows from that. The fact is not lost — `/audit`
  // is where it is asked for, and still answers.
  assert.ok(!/withheld from/.test(text), 'the exclusion must not be narrated on every line')
  assert.match(text, /excluded advisor/, '/audit shows the asymmetry')
  assert.ok(impl.received.some((m) => m.includes('src/adapters')), 'and it reaches the participant')
})

test('narration streams to the human, and only the report is shown going to the advisor', async () => {
  // The routing has to be legible: what was written for you, and what the other
  // participant actually received. The closing message is held back rather than streamed,
  // because the routed copy prints it a moment later and twice is harder to read.
  const dir = repo()
  const impl = slow('impl', 'claude', ['ack', 'IGNORED'])
  impl.narrate(["I'll start by finding the relevant code.", 'Now the guard report shape.'], 'Done. guard --json is in.')
  const out = collect()

  const code = await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'DONE'])],
      claude: [impl],
    }),
    input: script([]),
    output: out.stream,
  })
  assert.equal(code, 0)
  const text = out.text()

  assert.match(text, /implementer → you/, 'narration is addressed to the human')
  assert.match(text, /finding the relevant code/)
  assert.match(text, /Now the guard report shape/)
  assert.match(text, /implementer → advisor/, 'and the report is shown going to the advisor')
  assert.match(text, /Done\. guard --json is in\./)
  assert.equal(
    text.split('Done. guard --json is in.').length - 1,
    1,
    'the closing message is shown once, as the routed report — not streamed and repeated',
  )
})

test('the banner names the participants, the checks and the colour legend', async () => {
  const dir = repo()
  const out = collect()
  await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 2,
    checks: ['npm test'],
    version: '9.9.9',
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])],
      claude: [new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])],
    }),
    input: script([]),
    output: out.stream,
  })
  const text = out.text()
  assert.match(text, /conclave 9\.9\.9/)
  assert.match(text, /advisor codex/)
  assert.match(text, /implementer claude/)
  assert.match(text, /rotation:.*npm test/)
})

test('with no checks the console reads as a possible mistake, not a statement of fact', async () => {
  // A shell that splits a multi-line paste drops the flag entirely, which is
  // indistinguishable from never passing one. It has cost two sessions their rotation.
  const dir = repo()
  const out = collect()
  await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 2,
    checks: [],
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])],
      claude: [new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])],
    }),
    input: script([]),
    output: out.stream,
  })
  assert.match(out.text(), /pass --checks/)
})

test('typed instructions queue visibly and are listed on demand', async () => {
  // Nothing is delivered mid-turn, so the operator has to be able to see what is stacked
  // up. `/queue` reads back their own words, not the enveloped copy a participant gets.
  const dir = repo()
  const impl = slow('impl', 'claude', ['ack', 'Did it.', 'And again.'])
  const out = collect()
  await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'])],
      claude: [impl],
    }),
    input: script(['>implementer touch nothing under src/adapters', '/queue'], 200),
    output: out.stream,
  })
  const text = out.text()
  assert.match(text, /touch nothing under src\/adapters/)
  assert.match(text, /delivered at the next exchange/)
  assert.ok(
    !/FROM THE HUMAN[\s\S]{0,80}delivered at the next exchange/.test(text),
    '/queue reads back what was typed, not the enveloped copy',
  )
})

test('the console refuses to start while another session holds the lock', async () => {
  const dir = repo()
  const { acquire } = await import('../workspace/sessionLock.ts')
  acquire(dir, [{ id: 'implementer', agent: 'claude' }])
  const out = collect()
  const code = await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 2,
    checks: [],
    registry: registryOf({ codex: [], claude: [] }),
    input: script([]),
    output: out.stream,
  })
  // Overwriting the lock would destroy the other run's record of what was dirty before it
  // began, which is the thing that lets `conclave guard` tell their work from the operator's.
  assert.equal(code, 1)
  assert.match(out.text(), /refusing to start/)
})

test('a flag in the goal position is flags, not a goal named --lead', async () => {
  // `conclave session --lead codex` once started a session whose objective was the literal
  // string "--lead", picking the right agents by coincidence. The goal is optional now, so
  // that invocation is legitimate — what must not happen is the flag being eaten as a goal.
  //
  // Proven with an agent name that cannot resolve: reaching "unknown agent" means the flag
  // was parsed as a flag. It also means no session is spawned, which a test asserting on
  // the CLI must not do.
  const { execFileSync } = await import('node:child_process')
  const root = join(import.meta.dirname, '..', '..')
  let stderr = ''
  try {
    execFileSync(process.execPath, [join(root, 'bin/conclave.ts'), 'session', '--lead', 'nope'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })
  } catch (err) {
    stderr = (err as { stderr?: string }).stderr ?? ''
  }
  assert.match(stderr, /unknown agent 'nope'/, `--lead was not parsed as a flag; stderr was:\n${stderr}`)
})

test('an address and a path compose: >advisor read @path', async () => {
  // The address is consumed by the console; everything after it is forwarded verbatim, so
  // the participant's own CLI resolves `@path` exactly as it would if typed there. That is
  // the reason paths are references rather than inlined text — a reference survives the
  // hop, and pasted contents would go stale the moment either participant edited the file.
  const dir = repo()
  const impl = slow('impl', 'claude', ['ack', 'Did it.', 'And again.'])
  const advisor = slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'])
  const out = collect()
  await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    registry: registryOf({ codex: [advisor], claude: [impl] }),
    input: script(['>implementer read @src/relay/relay.ts and report'], 250),
    output: out.stream,
  })

  const sent = impl.received.find((m) => m.includes('read @src/relay/relay.ts'))
  assert.ok(sent, `the path should reach the participant intact:\n${impl.received.join('\n---\n')}`)
  assert.ok(!sent.includes('>implementer'), 'the address is consumed, not forwarded')
  // Restricted where it counts: the advisor never received it. Asserted on the participant
  // rather than on a sentence in the transcript, which is the stronger claim anyway.
  assert.ok(!advisor.received.some((m) => m.includes('read @src/relay/relay.ts')))
})

test('/exit ends the session, stopping the participants with it', async () => {
  const dir = repo()
  const advisor = slow('advisor', 'codex', ['Keep going.', 'Still going.', 'And on.'])
  const impl = slow('impl', 'claude', ['ack', 'Working.', 'Still working.'])
  const out = collect()
  const code = await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 20,
    checks: [],
    registry: registryOf({ codex: [advisor], claude: [impl] }),
    input: script(['/exit']),
    output: out.stream,
  })
  assert.equal(code, 0)
  // The run was nowhere near its 20 advisor turns, so leaving has to abort it rather than wait.
  assert.match(out.text(), /aborting the run and stopping participants/)
  assert.equal(advisor.state, 'terminated', 'a console that exits must not leave CLIs running')
  assert.equal(impl.state, 'terminated')
})

test('/abort ends the run but keeps the console, and says so when there is no run', async () => {
  // These were one command: `/abort` with nothing running used to exit. That made abort mean
  // two different things depending on state the operator could not see.
  const dir = repo()
  const out = collect()
  const code = await runSession({
    cwd: dir,
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Go.'])],
      claude: [slow('impl', 'claude', ['ack'])],
    }),
    // No goal, so no run — participants are up but nothing is in flight.
    input: script(['/abort', '/exit']),
    output: out.stream,
  })
  assert.equal(code, 0)
  assert.match(out.text(), /nothing is running — \/exit to leave/)
})


test('a delivered message becomes a turn in the transcript, not a note about one', async () => {
  // It was rendered as a grey `› hello — read by advisor`, which sat among the run's own
  // logging and read as more logging. The point of pinning a message while it waits is that
  // being read CHANGES it, and the change has to be visible.
  const dir = repo()
  const out = collect()
  await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'DONE'])],
      claude: [slow('impl', 'claude', ['ack', 'Did it.'])],
    }),
    input: script(['also check the error path']),
    output: out.stream,
  })
  // Piped input has no box, so the queue confirmation still appears...
  assert.match(out.text(), /queued for everyone/)
  // ...and the message itself lands as a speaker block once a participant takes it.
  assert.match(out.text(), /● you → /)
  assert.match(out.text(), /also check the error path/)
})

// ---------------------------------------------------------------------------------------
// A pause whose verdict the system withdraws while the operator is reading it. The relay
// amends the pause object and records a note; the console has already written the pause
// block to a terminal and cannot take it back, so the question here is whether what it
// writes NEXT tells the operator the decision in front of them has gone stale.
// ---------------------------------------------------------------------------------------

const TIMED_OUT: Verdict = {
  outcome: 'timed_out',
  confidence: 'uncertain',
  provenance: [{ source: 'orchestrator', detail: 'past the watchdog at 600s with no Stop' }],
}
const COMPLETED: Verdict = {
  outcome: 'completed',
  confidence: 'proven',
  provenance: [{ source: 'hook', detail: 'Stop' }],
}

const BUSY_LIVENESS: ChildLiveness = {
  pid: 1,
  alive: true,
  samples: [12.5, 15.0, 11.0],
  idle: false,
}
const IDLE_LIVENESS: ChildLiveness = {
  pid: 1,
  alive: true,
  samples: [0.0, 0.1, 0.0],
  idle: true,
}
/**
 * The reading from #83, verbatim: two samples at rest and one burst.
 *
 * Not idle by the conservative rule, and not a working child either — the case the guard used
 * to describe as "still working" while refusing the resume.
 */
const MIXED_LIVENESS: ChildLiveness = {
  pid: 1,
  alive: true,
  samples: [0.3, 0.2, 7.2],
  idle: false,
}

async function untilText(what: string, text: () => string, re: RegExp, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (re.test(text())) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}:\n${text()}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('a verdict withdrawn while the operator reads the pause is surfaced in the console', async () => {
  const dir = repo()
  const impl = slow('impl', 'claude', ['ack', 'Did it, slowly.', 'And again.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT }
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 4,
    checks: [],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'])],
      claude: [impl],
    }),
    input,
    output: out.stream,
  })

  await untilText('the pause to be printed', out.text, /paused/)
  // The late Stop the watchdog beat to it, arriving while the operator is at the prompt.
  impl.lateSignal(COMPLETED)
  await untilText('the replacement verdict to reach the console', out.text, /withdrawn and replaced/)

  const text = out.text()
  const pausedAt = text.indexOf('paused')
  const withdrawnAt = text.search(/withdrawn/)
  assert.ok(withdrawnAt > pausedAt, 'the withdrawal must follow the pause it invalidates')

  // Marked, not merely printed. Grey, it sat between `implementer turn: timed_out` and
  // `paused (turn_incomplete)` looking like more of the same background — and it is the
  // line that contradicts both. The `~` is what `renderPause` uses for a pause that was
  // already superseded when it printed; the operator should not have to know which of the
  // two arrival orders they got.
  const marked = text.split('\n').filter((l) => /^\s*~ /.test(l))
  const replacement = marked.find((l) => /withdrawn and replaced/.test(l))
  assert.ok(replacement, `the supersession must carry the ~ marker:\n${text.slice(-1200)}`)
  assert.match(replacement, /timed_out/, 'the verdict the pause rests on, by name')
  assert.match(replacement, /replaced with completed/, 'the replacement is terminal and the line says the turn ended')
  assert.match(replacement, /still paused/, 'surfaced, not decided')

  // ...and it reaches the STATUS FILE, which is where an operator outside the process reads
  // it. This is load-bearing operational advice: the run stays paused across a supersession
  // by design, so `state` is unchanged before and after and a watcher polling it is silent
  // through the one event a waiting operator is waiting for. `pause.superseded` is the
  // signal, and it only lands because the recorder re-serialises the LIVE pause object --
  // which `supersede()` mutates in place -- on the next event, and the supersession note is
  // itself an event. Asserted rather than reasoned, because someone is relying on it.
  const outside = resolveSession(dir)
  assert.ok('session' in outside, 'the session must be readable from outside')
  assert.ok(
    outside.session.status.pause?.superseded,
    `pause.superseded must reach the status file:\n${JSON.stringify(outside.session.status.pause, null, 2)}`,
  )

  input.write('/continue\n')
  assert.equal(await running, 0)
})

test('another timeout on the still-running turn is shown as the turn still running', async () => {
  const dir = repo()
  const impl = slow('impl', 'claude', ['ack', 'Did it, slowly.', 'And again.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT }
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 4,
    checks: [],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'])],
      claude: [impl],
    }),
    input,
    output: out.stream,
  })

  await untilText('the pause to be printed', out.text, /paused/)
  // The watchdog fires a second time on the same still-running turn. The line must say the
  // turn is still running, not sound like the Stop hook proved it ended.
  impl.lateSignal(TIMED_OUT)
  await untilText('the replacement verdict to reach the console', out.text, /withdrawn and replaced/)

  const text = out.text()
  const marked = text.split('\n').filter((l) => /^\s*~ /.test(l))
  const replacement = marked.find((l) => /withdrawn and replaced/.test(l))
  assert.ok(replacement, `the supersession must carry the ~ marker:\n${text.slice(-1200)}`)
  assert.match(replacement, /timed_out/, 'the verdict the pause rests on, by name')
  assert.match(replacement, /replaced with another timed_out/, 'the replacement is another timeout on the still-running turn')
  assert.doesNotMatch(replacement, /turn ended/, 'another timeout on the still-running turn does not say the turn ended')

  input.write('/continue\n')
  assert.equal(await running, 0)
})

/**
 * The setup heartbeat.
 *
 * Trusting Codex waits on a real TUI for the better part of a minute, and what the operator
 * saw for it was five stacked lines differing only in an elapsed count — which reads as a
 * stuck loop rather than as progress. It updates in place at a terminal now, and still
 * appends where there is no cursor to move, because a piped run losing progress entirely is
 * the worse failure.
 */
test('the setup heartbeat redraws one line at a terminal', async () => {
  const out = collect()
  await withHeartbeat(
    out.stream,
    'configuring',
    'waiting for Codex to show its trust prompts',
    () => new Promise((r) => setTimeout(r, 600)),
    { inPlace: true },
  )
  const text = out.text()
  assert.ok(text.includes('\r'), 'an in-place line must return the cursor')
  // The point of the change: however many times it drew, it occupied no rows.
  assert.equal(text.split('\n').length - 1, 0, `no rows may be appended:\n${JSON.stringify(text)}`)
  assert.match(text, /configuring/)
  assert.match(text, /waiting for Codex/)
  // Erased on the way out, so the result printed next starts on a clean row.
  assert.ok(text.endsWith('\r\x1b[2K'), 'the live line must be erased when the work ends')
})

test('the setup heartbeat appends when there is no cursor to move', async () => {
  const out = collect()
  await withHeartbeat(
    out.stream,
    'configuring',
    'waiting for Codex to show its trust prompts',
    // Long enough to outlast two beats: the appended path reports on a one-second
    // interval, so a shorter run would prove only that nothing printed in under a second.
    () => new Promise((r) => setTimeout(r, 2_400)),
    { everyMs: 100 },
  )
  const text = out.text()
  assert.ok(!text.includes('\r'), 'a piped run must write no cursor motion')
  assert.ok(
    text.split('\n').filter((l) => l.includes('configuring')).length >= 2,
    `progress must still be reported when appended:\n${JSON.stringify(text)}`,
  )
})

/**
 * Help, from every command.
 *
 * `conclave relay --help` once launched two real agent sessions and asked an advisor what
 * `--help` means; that was fixed in `relay` alone, so `conclave session --help` still read
 * the flag as "no goal, some flags" and opened a live console against real CLIs. The guard
 * lives before dispatch now, because a guard each command has to remember is a guard some
 * command will not.
 *
 * Asserted across the commands that SPAWN something, since those are the ones where being
 * wrong costs quota rather than a confusing message.
 */
test('--help is answered by every command, and starts nothing', () => {
  const root = join(import.meta.dirname, '..', '..')
  for (const argv of [
    ['session', '--help'],
    ['session', '-h'],
    ['relay', '--help'],
    ['demo', '--help'],
    ['guard', '--help'],
    ['config', 'check', '--help'],
    ['--help'],
  ]) {
    const stdout = execFileSync(process.execPath, [join(root, 'bin/conclave.ts'), ...argv], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })
    assert.match(stdout, /^conclave <command>/, `${argv.join(' ')} must print usage`)
    // The console prints its banner before it waits, so its absence is what proves nothing
    // was spawned -- exiting zero alone would not.
    assert.doesNotMatch(stdout, /joined as/, `${argv.join(' ')} must not start a session`)
  }
})

/**
 * The terminal tab.
 *
 * By default it shows the command line — `conclave session "build a website t…"` — which is
 * identical across tabs until the goal, truncated exactly where the goal starts, and never
 * changes. So a backgrounded session WAITING on a decision looks the same as one still
 * working, which is the only question a tab has to answer.
 *
 * Driven through `runSession` rather than against `titleSequence` alone, because the string
 * being right and the console never emitting it is the failure this codebase keeps finding.
 */
test('the terminal title tracks what the session wants from the operator', async () => {
  const dir = repo()
  const out = collect()
  // A title is only written to a real terminal; nothing else about this run is a TTY.
  ;(out.stream as unknown as { isTTY: boolean }).isTTY = true
  const code = await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])],
      claude: [new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])],
    }),
    input: script([]),
    output: out.stream,
  })
  assert.equal(code, 0)
  const titles = [...out.text().matchAll(/\x1b\]0;([^\x07]*)\x07/g)].map((m) => m[1] ?? '')
  assert.ok(titles.length > 0, 'the console must set a title at a terminal')
  assert.ok(
    titles.some((t) => t.startsWith('working — Keep the work moving')),
    `state first, then the goal: ${JSON.stringify(titles)}`,
  )
  assert.ok(
    titles.some((t) => t.startsWith('done')),
    `the outcome must reach the tab: ${JSON.stringify(titles)}`,
  )
  // Handed back on the way out, so a tab does not keep claiming to be a session that exited.
  assert.equal(titles.at(-1), '', `the title must be released last: ${JSON.stringify(titles)}`)
})

test('no title escape reaches a stream that is not a terminal', async () => {
  const dir = repo()
  const out = collect()
  await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])],
      claude: [new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])],
    }),
    input: script([]),
    output: out.stream,
  })
  assert.ok(!out.text().includes('\x1b]0;'), 'a piped run must not leak an OSC title sequence')
})

/**
 * A session outside a git repository.
 *
 * Two `git status --porcelain` calls inherited stderr, so in a plain directory git printed
 * `fatal: not a git repository` straight into the banner — unattributed, alarming, and for a
 * condition both call sites already handle by returning no paths. What the operator saw was
 * a session that looked broken while working exactly as designed.
 *
 * Run in a CHILD process, and the first version of this test was not: git writes to the
 * stderr the parent inherited, which the `output` stream never sees, so asserting on
 * collected output passed against the unfixed code. The stream under test is the process's,
 * and observing it means owning the process.
 */
test('a plain directory produces no raw git error', () => {
  const root = join(import.meta.dirname, '..', '..')
  const dir = mkdtempSync(join(tmpdir(), 'conclave-nogit-'))
  const driver = join(dir, 'driver.mjs')
  writeFileSync(
    driver,
    `
import { Readable } from 'node:stream'
import { runSession } from ${JSON.stringify(join(root, 'src/repl/session.ts'))}
import { AgentRegistry } from ${JSON.stringify(join(root, 'src/registry/registry.ts'))}
import { FakeRotationSession } from ${JSON.stringify(join(root, 'src/rotation/fakeSession.ts'))}
import { NO_DEADLINE_CLOCKS } from ${JSON.stringify(join(root, 'src/registry/types.ts'))}
const caps = { readinessSignal: 'unknown', turnKeySource: 'prompt_id',
  outcomes: { completed: 'observed', cancelled: 'reasoned_but_unverified',
    permission_refused: 'reasoned_but_unverified', process_exited: 'reasoned_but_unverified',
    timed_out: 'reasoned_but_unverified', transport_lost: 'reasoned_but_unverified',
    unknown_abnormal_end: 'reasoned_but_unverified' } }
const registry = new AgentRegistry()
for (const [agent, session] of [['codex', new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])],
                                ['claude', new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])]]) {
  registry.register({ id: agent, displayName: agent, capabilities: { ...caps, agent },
    deadlines: NO_DEADLINE_CLOCKS,
    launch: { command: agent, baseArgs: [] }, async create() { return session } })
}
process.exit(await runSession({ cwd: ${JSON.stringify(dir)}, goal: 'Keep the work moving.',
  lead: 'codex', implementer: 'claude', rounds: 3, checks: [], registry, input: Readable.from([]),
  // force: true, because the console REFUSES a plain directory now -- attribution, rotation
  // and undo are all meaningless without a repository. The property under test survives
  // that: when an operator overrides the refusal, git's own complaint must still not leak
  // into the banner.
  force: true }))
`,
  )
  // spawnSync rather than execFileSync, which returns stdout alone and surfaces stderr
  // only when the command FAILS -- and this one succeeds. The whole defect is a successful
  // run that printed something alarming.
  const r = spawnSync(process.execPath, [driver], { cwd: dir, encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, `a session outside a repository still runs:\n${r.stderr}`)
  assert.doesNotMatch(r.stderr, /not a git repository/i)
  assert.doesNotMatch(r.stdout, /not a git repository/i)
})

/**
 * The console's session, readable from outside the process.
 *
 * An agent driving Conclave launched runs into a background file and read them with `tail`,
 * grepped transcripts to reconstruct what a participant had done, and watched a rising clock
 * to guess whether a session was alive — because the console is a rendering with no
 * interface underneath it (#26). This is the interface.
 *
 * The ORDER matters and is the part that broke: `Relay.#end` emits the terminal `run_end`,
 * and `relay.stop()` is what calls it, so closing the recorder first detached before the
 * event existed and the recorded stream just stopped — with no line saying the run had
 * finished, which is the exact ambiguity these files exist to remove.
 */
test('a console session records a status and an event stream a stranger can read', async () => {
  const dir = repo()
  const out = collect()
  const code = await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])],
      claude: [new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])],
    }),
    input: script([]),
    output: out.stream,
  })
  assert.equal(code, 0)

  const found = resolveSession(dir)
  assert.ok('session' in found, `a session must have been recorded:\n${out.text().slice(-600)}`)
  const st = found.session.status
  assert.equal(st.front, 'session')
  assert.equal(st.state, 'ended')
  assert.equal(st.goal, 'Keep the work moving.')
  // The seats, by name and agent — what an operator had to grep a transcript for.
  assert.deepEqual(
    st.participants.map((p) => `${p.id}:${p.agent}`).sort(),
    ['advisor:codex', 'implementer:claude'],
  )
  // The id is printed where it can be copied, or it may as well not exist.
  assert.match(out.text(), new RegExp(`conclave status ${st.id}`))

  const events = readFileSync(st.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(events.length > 0, 'the event stream must not be empty')
  assert.equal(events.at(-1)?.type, 'run_end', `the stream must end with run_end:\n${events.slice(-3).map((e) => e.type).join(', ')}`)
})

test('the recorded session build matches the CLI version for this checkout', async () => {
  const dir = repo()
  const out = collect()
  const expected = execFileSync(process.execPath, [join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts'), 'version'], {
    encoding: 'utf8',
  }).trim()
  await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 2,
    checks: [],
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])],
      claude: [new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])],
    }),
    input: script([]),
    output: out.stream,
  })
  const found = resolveSession(dir)
  assert.ok('session' in found)
  // Deliberately NOT passed in. The first version handed `version: expected` to the session
  // and asserted it came back, which tests a round trip and not the thing that matters: the
  // record has to identify the build whether or not a caller remembered to say so, because
  // the caller that forgets is exactly the one whose record you end up trying to read.
  assert.equal(found.session.status.build, expected)
})

/**
 * What a finished console run leaves behind for someone who was not watching it.
 *
 * The console never writes a run report — `runReport` is wired into the relay front-end
 * alone — so until the status file carried graded turns, a console session that had ended
 * left NO machine-readable account of what its participants actually did. An operator
 * confirming the run was back to reading prose, or grepping a transcript, which is the
 * workaround #26 exists to remove.
 *
 * The turns must be there AFTER `state: ended`. The console reports `ended` on teardown and
 * the last turn is graded moments before it, so a recorder that stopped re-reading when the
 * state was reported would lose exactly the verdicts worth keeping.
 */
test('a finished console run leaves graded turns in its status, and in its JSON', async () => {
  const dir = repo()
  const out = collect()
  const code = await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])],
      claude: [new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])],
    }),
    input: script([]),
    output: out.stream,
  })
  assert.equal(code, 0)

  const found = resolveSession(dir)
  assert.ok('session' in found, `a session must have been recorded:\n${out.text().slice(-600)}`)
  const st = found.session.status
  assert.equal(st.state, 'ended')

  for (const p of st.participants) {
    assert.ok(p.turns.length > 0, `${p.id} ran turns and the record must say what came of them`)
    const turn = p.turns.at(-1)!
    assert.equal(typeof turn.key, 'string')
    assert.equal(turn.state, 'completed')
    // `completed/proven` and `completed/assumed` are not the same claim. A record that gave
    // the state without the grade would be the prose summary again, in JSON — which is the
    // thing this file exists instead of.
    assert.equal(turn.confidence, 'proven')
    assert.ok(
      (turn.provenance ?? []).length > 0,
      `${p.id}'s verdict must say what it is believed on the strength of`,
    )
    assert.equal(turn.provenance?.[0]?.source, 'hook')
  }

  // Through the rendering an agent operator actually reads: `conclave status <id> --json`.
  // The JSON is the whole record, not a hand-picked subset — a caller that had to fall back
  // to parsing the prose for one field will parse the prose for all of them.
  const asJson = JSON.parse(formatSessionJson(found.session))
  const impl = asJson.participants.find((p: { id: string }) => p.id === 'implementer')
  assert.ok(impl.turns.length > 0, 'the turns must survive serialisation, not just the object')
  assert.equal(impl.turns.at(-1).confidence, 'proven')
  assert.equal(impl.turns.at(-1).provenance[0].detail, 'Stop')
})

/**
 * The record of a session torn down while a run was still going.
 *
 * The path that matters most and the one that broke. When a run reaches its own end the
 * relay has already emitted `run_end` before teardown, so any ordering works and a test
 * built on a completed run proves nothing — the first version of this proved nothing.
 *
 * Tearing down MID-RUN is different: `Relay.#end` is what emits the terminal event, and
 * `relay.stop()` is what calls it. Closing the recorder first detached before the event
 * existed, and the recorded stream stopped on an ordinary `activity` line with nothing
 * saying the session was over. A reader then cannot tell a session that was killed from one
 * still running whose writer is merely quiet — the exact ambiguity these files remove.
 */
test('a session killed mid-run still records how it ended', async () => {
  const dir = repo()
  const out = collect()
  // Input closed immediately, participants slow enough that the run is unquestionably in
  // flight when the console tears down.
  await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 4,
    checks: [],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'], 800)],
      claude: [slow('impl', 'claude', ['ack', 'Did it.', 'Again.'], 800)],
    }),
    input: Readable.from([]),
    output: out.stream,
  })

  const found = resolveSession(dir)
  assert.ok('session' in found)
  const events = readFileSync(found.session.status.eventsPath, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  const last = events.at(-1)
  assert.equal(
    last?.type,
    'run_end',
    `the stream must end with run_end even when the run did not finish; ended with ` +
      `${events.slice(-3).map((e) => e.type).join(', ')}`,
  )
  // `stopped`, not `done`: the run was cut short and the record says which.
  assert.equal(last?.reason, 'stopped')
})

/**
 * An agent driving the console.
 *
 * `--operator agent` existed on `relay` and on nothing else, and the pair was actively
 * misleading: the only front-end that advertised an agent operator is the one that ENDS the
 * run at every pause, and the only one that holds a pause open had no way to say a machine
 * was driving. An agent reading the flags picked exactly wrong, and the run told it so four
 * times — "Nobody is attending this run, so it ends here" — while the flag it had passed
 * claimed somebody was.
 */
test('the console takes --operator agent, and reports it', async () => {
  const dir = repo()
  const out = collect()
  await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    operator: 'agent',
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])],
      claude: [new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])],
    }),
    input: script([]),
    output: out.stream,
  })
  const found = resolveSession(dir)
  assert.ok('session' in found)
  // Recorded, because it changes what an escalation MEANS: an agent operator may share the
  // participants' blind spots, so its answer is another opinion with authority rather than
  // independent confirmation. A reader auditing the run cannot recover that from the log.
  assert.equal(found.session.status.operator, 'agent')
})

test('a pause is held open for a piped driver, and resolvable from stdin', async () => {
  // The property `relay` does not have and cannot have: a call that returns an outcome has
  // nowhere to suspend to. Here the run suspends, the process stays alive, and the pause is
  // readable as DATA — reason, evidence, options — so an agent never scrapes the console.
  const dir = repo()
  const out = collect()
  const input = new PassThrough() // held open, as a driver would hold it
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 6,
    checks: [],
    operator: 'agent',
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'], 300)],
      claude: [slow('impl', 'claude', ['ack', 'Did it.', 'Again.'], 300)],
    }),
    input,
    output: out.stream,
  })

  const until = async (pred: (s: ReturnType<typeof resolveSession>) => boolean, ms = 10_000) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      const f = resolveSession(dir)
      if (pred(f)) return f
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`timed out; console said:\n${out.text().slice(-800)}`)
  }

  await new Promise((r) => setTimeout(r, 500))
  input.write('/pause\n')
  const paused = await until((f) => 'session' in f && f.session.status.state === 'paused')
  assert.ok('session' in paused)
  assert.equal(paused.session.status.pause?.reason, 'operator_requested')
  // The options are what an agent picks its next stdin line from.
  // No `rotate`: this run has no --checks, so rotation could not verify a replacement and
  // choosing it would do nothing. The options are what would actually change something now,
  // not a list of the methods that exist.
  assert.deepEqual(paused.session.status.pause?.options, ['continue', 'constrain', 'abort'])
  // And nobody died to produce the pause, which is the whole difference from relay.
  assert.equal(paused.session.alive, true)

  input.write('/continue\n')
  const resumed = await until((f) => 'session' in f && f.session.status.state === 'running')
  assert.ok('session' in resumed && resumed.session.status.pause === undefined)

  input.end()
  await running
})

/**
 * A pause on the event STREAM, not only in the status file.
 *
 * `status.json` says what is true now; a reader that arrives after the operator decided sees
 * a running session and no trace that it ever stopped. The stream is the account over time,
 * and until it carried these records a pause appeared there only as a `note` whose text began
 * "paused (" -- prose a consumer had to pattern-match, carrying none of the structure the
 * status file has always had. These are the acceptance for the pair being on the wire.
 */

/**
 * Complete, newline-terminated records only; any partial suffix is left for the next read.
 *
 * Both readers below need this and for the same reason from two directions: a file reader can
 * arrive between an append and its newline, and a pipe hands over whatever fitted in the chunk,
 * which is free to end mid-record. Parsing the fragment would throw inside a poll and fail the
 * test on a buffer boundary rather than on the behaviour under test.
 */
function ndjson(text: string): Record<string, any>[] {
  const cut = text.lastIndexOf('\n')
  if (cut < 0) return []
  return text
    .slice(0, cut)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

function eventRecords(path: string): Record<string, any>[] {
  if (!existsSync(path)) return []
  return ndjson(readFileSync(path, 'utf8'))
}

/** Poll for something produced asynchronously. Bounded, so a failure is a failure. */
async function untilValue<T>(what: string, f: () => T | undefined, detail: () => string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = f()
    if (v !== undefined) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}:\n${detail()}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** The session's own record, once the console has written one. Says nothing about its state. */
async function untilRecorded(dir: string, detail: () => string): Promise<{ id: string; eventsPath: string }> {
  return untilValue(
    'the console to record a session',
    () => {
      const f = resolveSession(dir)
      if (!('session' in f) || !existsSync(f.session.status.eventsPath)) return undefined
      return { id: f.session.status.id, eventsPath: f.session.status.eventsPath }
    },
    detail,
  )
}

test('an operator-requested pause reaches the event stream with its reason and its options', async () => {
  const dir = repo()
  const out = collect()
  const input = new PassThrough() // held open, as a driver would hold it
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 6,
    checks: [],
    operator: 'agent',
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'], 300)],
      claude: [slow('impl', 'claude', ['ack', 'Did it.', 'Again.'], 300)],
    }),
    input,
    output: out.stream,
  })

  const { eventsPath } = await untilRecorded(dir, () => out.text().slice(-800))
  input.write('/pause\n')

  const paused = await untilValue(
    'a pause record in the event stream',
    () => eventRecords(eventsPath).find((e) => e.type === 'pause'),
    () => out.text().slice(-800),
  )

  // The real reason, not a placeholder: a consumer picking its next move off this record has
  // nothing else to read, and `operator_requested` is what distinguishes a pause somebody
  // asked for from one the orchestrator raised.
  assert.equal(paused.pause.reason, 'operator_requested')
  assert.ok(typeof paused.pause.detail === 'string' && paused.pause.detail.length > 0)
  // What would actually change something, in the order the console offers them. `rotate` is
  // absent because this run has no --checks: rotation could not verify a replacement, so
  // offering it would spend the operator a turn to achieve nothing. The list used to be four
  // constants documented as "the methods exist regardless", and an operator elsewhere picked
  // `rotate` at an ADVISOR pause on that basis and got silence.
  assert.deepEqual(paused.pause.options, ['continue', 'constrain', 'abort'])
  assert.match(paused.pause.evidence.join('\n'), /no turn is in flight/)
  assert.equal(typeof paused.pause.atSeq, 'number', 'the point in the routing log the pause lines up with')
  assert.equal(typeof paused.seq, 'number')

  // Still suspended, so the record was written DURING the pause rather than reconstructed
  // from the log after the fact.
  const found = resolveSession(dir)
  assert.ok('session' in found && found.session.status.state === 'paused')
  assert.equal(
    eventRecords(eventsPath).some((e) => e.type === 'resume'),
    false,
    'nothing has resumed while the operator is still deciding',
  )

  input.write('/abort\n')
  input.end()
  await running
})

test('continuing that run puts the matching resume after the pause in the stream', async () => {
  const dir = repo()
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 6,
    checks: [],
    operator: 'agent',
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'], 300)],
      claude: [slow('impl', 'claude', ['ack', 'Did it.', 'Again.'], 300)],
    }),
    input,
    output: out.stream,
  })

  const { eventsPath } = await untilRecorded(dir, () => out.text().slice(-800))
  input.write('/pause\n')
  await untilValue(
    'a pause record in the event stream',
    () => eventRecords(eventsPath).find((e) => e.type === 'pause'),
    () => out.text().slice(-800),
  )

  input.write('/continue\n')
  await untilValue(
    'a resume record in the event stream',
    () => eventRecords(eventsPath).find((e) => e.type === 'resume'),
    () => out.text().slice(-800),
  )

  input.end()
  await running

  const records = eventRecords(eventsPath)
  const pauses = records.filter((e) => e.type === 'pause')
  const resumes = records.filter((e) => e.type === 'resume')
  assert.equal(pauses.length, 1, 'one pause was asked for, so one was recorded')
  assert.equal(resumes.length, 1)
  assert.ok(
    records.indexOf(resumes[0]!) > records.indexOf(pauses[0]!),
    'the resume follows the pause it ends, rather than standing alone',
  )
  // On disk the pair is two snapshots rather than one object, so identity is not available
  // here -- matching them means the payloads agree. In process they ARE the same object; that
  // is asserted in `src/relay/run.test.ts`.
  assert.deepEqual(resumes[0]!.pause, pauses[0]!.pause, 'the resume names the pause it is leaving')
  assert.equal(records.at(-1)?.type, 'run_end', 'and the stream still ends where it always did')
})

/**
 * The same pair, across the process boundary an agent operator actually uses.
 *
 * In-process assertions prove the events exist; they do not prove they are READABLE from
 * outside while the run is stopped, and that is the only property that matters to a driver
 * whose session is another process. The failure this rules out is a pause that reaches the
 * file only when the run moves again -- which would be invisible in every test above, and
 * would leave `--follow` silent for exactly as long as the operator was needed.
 */
test('conclave events --follow delivers the pause line while the session is still paused', async () => {
  const root = join(import.meta.dirname, '..', '..')
  const dir = repo()
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 6,
    checks: [],
    operator: 'agent',
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'], 300)],
      claude: [slow('impl', 'claude', ['ack', 'Did it.', 'Again.'], 300)],
    }),
    input,
    output: out.stream,
  })

  // Waited on for STARTUP only -- that the session exists and has a stream file to open.
  // Nothing here looks at whether the run is paused; doing so before spawning the follower
  // would be the test asserting the order it is meant to be proving.
  const { id, eventsPath } = await untilRecorded(dir, () => out.text().slice(-800))

  const cli = spawn(process.execPath, [join(root, 'bin/conclave.ts'), 'events', id, '--follow'], { cwd: dir })
  let stdout = ''
  let stderr = ''
  cli.stdout.setEncoding('utf8')
  cli.stderr.setEncoding('utf8')
  cli.stdout.on('data', (c: string) => (stdout += c))
  cli.stderr.on('data', (c: string) => (stderr += c))

  try {
    input.write('/pause\n')
    // The assertion: the follower's own stdout, not the file it reads.
    await untilValue(
      'the pause line to reach `conclave events --follow`',
      () => ndjson(stdout).find((e) => e.type === 'pause'),
      () => `stderr:\n${stderr}\nconsole:\n${out.text().slice(-800)}`,
    )

    // Only NOW is the run's state consulted. Reading it first and then waiting on stdout
    // would prove the line arrives after a pause is observable elsewhere, which is the
    // weaker claim and not the one being made.
    const found = resolveSession(dir)
    assert.ok('session' in found && found.session.status.state === 'paused', 'the line arrived mid-suspension')

    input.write('/continue\n')
    input.end()
    await running

    // `--follow` stops when the session does, rather than needing a Ctrl-C a script cannot
    // send -- so a driver can wait on it.
    const code = await untilValue('the follower to exit', () => cli.exitCode ?? undefined, () => stderr)
    assert.equal(code, 0)
    // Still whole records only. The follower has exited, so every record it wrote is
    // terminated by now -- but reading it the other way would work until the day a chunk
    // lands badly, and a test that is right by luck is not right.
    const streamed = ndjson(stdout)
    assert.ok(streamed.some((e) => e.type === 'resume'), 'the resume is followed through too')
    assert.equal(streamed.at(-1)?.type, 'run_end')
    assert.deepEqual(
      streamed.map((e) => e.seq),
      eventRecords(eventsPath).map((e) => e.seq),
      'the follower delivered the whole stream, not a subset of it',
    )
  } finally {
    if (cli.exitCode === null) cli.kill('SIGKILL')
  }
})

/**
 * A console run continued rather than re-described.
 *
 * The console had NEITHER half: it replayed nothing and it recorded nothing, so a console
 * run that crashed after three hours left no resumable account of itself while an unattended
 * one did — and the console is the front-end you leave running.
 *
 * It is also the better place to resume INTO. `relay` ends at every pause point, so a
 * resumed run that hits one immediately ends again; the four hand-resumes an agent operator
 * reported were each a manual reconstruction of state a held-open pause would have kept.
 */
test('a console run records a routing log it can be resumed from', async () => {
  const dir = repo()
  const log = join(dir, 'first.ndjson')
  const first = collect()
  await runSession({
    cwd: dir,
    goal: 'Make the parser handle inline tables.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    runLog: log,
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])],
      claude: [new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])],
    }),
    input: script([]),
    output: first.stream,
  })

  // Written as it happened, not assembled at the end -- a record written on exit is exactly
  // the record a crash destroys, and a crash is one of the endings a resume exists for.
  assert.ok(existsSync(log), 'the console must record a routing log')
  const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(lines.length > 0)
  assert.ok(lines.some((m) => m.kind === 'goal'), 'including the goal')
  // And the operator is told where it is, or it may as well not exist.
  // The label and the command are separate lines now: a path wrapped with a hanging indent
  // is pasted with the indent in it, and this is the one line whose purpose is being copied.
  assert.match(first.text(), /resume with:/)
  assert.match(first.text(), /conclave session "<goal>" --resume /)

  const second = collect()
  await runSession({
    cwd: dir,
    goal: 'Make the parser handle inline tables.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    resume: log,
    runLog: join(dir, 'second.ndjson'),
    registry: registryOf({
      codex: [new FakeRotationSession('advisor2', 'codex', ['Carry on.', 'DONE'])],
      claude: [new FakeRotationSession('impl2', 'claude', ['ack', 'Continued.'])],
    }),
    input: script([]),
    output: second.stream,
  })
  assert.match(second.text(), new RegExp(`resuming from ${log.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(second.text(), /messages replayed into both seats/)
})

test('a console refuses to start on a resume log that is not there', async () => {
  // Rather than starting fresh and looking like it resumed. A run that silently discards the
  // state it was asked to continue from is the failure `--resume` exists to prevent, dressed
  // as success.
  const dir = repo()
  const out = collect()
  const code = await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    resume: join(dir, 'nope.ndjson'),
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['DONE'])],
      claude: [new FakeRotationSession('impl', 'claude', ['ack'])],
    }),
    input: script([]),
    output: out.stream,
  })
  assert.equal(code, 1)
  assert.match(out.text(), /no run log at/)
})

test('a reply typed at a pause is delivered and resumes the run', async () => {
  // Reported after it happened: a reply typed at a pause sat queued with the run still
  // stopped, and a separate `/continue` was needed to make it count. That is the same
  // failure as a menu option that no-ops — the operator acted, something was recorded, and
  // nothing moved. Answering a pause IS the decision.
  const dir = repo()
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 6,
    checks: [],
    operator: 'agent',
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'], 300)],
      claude: [slow('impl', 'claude', ['ack', 'Did it.', 'Again.'], 300)],
    }),
    input,
    output: out.stream,
  })

  const until = async (pred: (f: ReturnType<typeof resolveSession>) => boolean, ms = 10_000) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      const f = resolveSession(dir)
      if (pred(f)) return f
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`timed out; console said:\n${out.text().slice(-700)}`)
  }

  await new Promise((r) => setTimeout(r, 500))
  input.write('/pause\n')
  await until((f) => 'session' in f && f.session.status.state === 'paused')

  // A reply, not a command. No `/continue` follows it.
  input.write('prefer the smaller change\n')
  const resumed = await until((f) => 'session' in f && f.session.status.state === 'running')
  assert.ok('session' in resumed && resumed.session.status.pause === undefined)
  assert.match(out.text(), /delivered, and resuming/)
  // ...and the reply actually reached the participants rather than being swallowed by the
  // resume, which is the failure the fix could easily have introduced.
  assert.match(out.text(), /prefer the smaller change/)

  input.end()
  await running
})

test('waiting at a pause is recorded, sends nothing, and leaves the run paused', async () => {
  // Reported by an operator who read the liveness evidence, judged the child healthy, and
  // correctly declined every option — then had no way to say so. Declining to answer and
  // choosing to wait were indistinguishable: the status file said `paused` either way, and
  // so did a monitor polling it. Worse, `state` never changes across the whole episode,
  // because the run stays paused through the supersession too — so a watcher observing
  // state alone is silent through exactly the event it is waiting for.
  const dir = repo()
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 6,
    checks: [],
    operator: 'agent',
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'], 300)],
      claude: [slow('impl', 'claude', ['ack', 'Did it.', 'Again.'], 300)],
    }),
    input,
    output: out.stream,
  })
  const until = async (pred: (f: ReturnType<typeof resolveSession>) => boolean, ms = 10_000) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      const f = resolveSession(dir)
      if (pred(f)) return f
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`timed out; console said:\n${out.text().slice(-700)}`)
  }

  await new Promise((r) => setTimeout(r, 500))
  input.write('/pause\n')
  await until((f) => 'session' in f && f.session.status.state === 'paused')

  const before = resolveSession(dir)
  assert.ok('session' in before && before.session.status.pause?.waiting === undefined)

  input.write('/wait 30\n')
  const waiting = await until((f) => 'session' in f && f.session.status.pause?.waiting !== undefined)
  assert.ok('session' in waiting)
  const w = waiting.session.status.pause!.waiting!
  // A decision an outside reader can see, which is the entire difference from silence.
  assert.equal(typeof w.at, 'number')
  assert.ok(w.until > w.at, 'a wait carries a deadline, so a dead turn is eventually caught')
  // ...and the run is STILL paused. Waiting is a decision to defer, not a decision.
  assert.equal(waiting.session.status.state, 'paused')
  assert.match(out.text(), /waiting 30m/)

  input.write('/continue\n')
  await until((f) => 'session' in f && f.session.status.state === 'running')
  input.end()
  await running
})

test('--turn-timeout reaches the relay from the console, not just the argv parser', async () => {
  // It never did. `bin/conclave.ts` has parsed `--turn-timeout` into `{ turnWatchdogMs }`
  // since it was written, inside a conditional spread — which slips past TypeScript's
  // excess-property check — and `SessionOptions` had no field to receive it. Constructed,
  // passed, dropped.
  //
  // Found by a conclave session reading further than I had. The morning's parity guard
  // declared this a session-only capability that `relay` lacked, on my reading of the CLI;
  // the guard compares which flags EXIST, not whether they arrive anywhere, so it agreed.
  //
  // So this asserts on ARRIVAL rather than on the source text. A test that grepped either
  // file would have passed against the broken version, which is how it survived.
  const dir = repo()
  const out = collect()
  let seen: number | undefined
  await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    turnWatchdogMs: 4242,
    registry: registryOf(
      {
        codex: [new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])],
        claude: [new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])],
      },
      // The registry sees what each participant was actually launched with.
      (_agent, _args, ctx) => {
        if (typeof ctx?.watchdogMs === 'number') seen = ctx.watchdogMs
      },
    ),
    input: script([]),
    output: out.stream,
  })
  assert.equal(seen, 4242, 'the console must hand the configured deadline to the adapters')
})

test('a refusal to continue re-samples, so it can lift', async () => {
  // The deadlock. The first version matched the liveness line in `pause.evidence` — a string
  // captured when the pause was RAISED — so the check deciding "is it safe NOW" was made
  // from a snapshot of the past and could never change its mind. An operator sat on it for
  // nearly four hours: the child had long gone idle, the stale evidence still said it was
  // working, `/continue` refused every time, and the process never exited to break the tie.
  //
  // A guard that cannot lift is not a guard, it is a wall. This asserts the lifting, which
  // is the half that was missing — the refusing half was already tested and was never the
  // problem.
  const dir = repo()
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 6,
    checks: [],
    // In-memory doubles: no child process at all, so `childPid` is undefined and no sample
    // is possible. That is the case the old code got wrong in the other direction — it
    // refused on a STRING, which a fake could carry without ever having a process.
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'], 300)],
      claude: [slow('impl', 'claude', ['ack', 'Did it.', 'Again.'], 300)],
    }),
    input,
    output: out.stream,
  })
  const until = async (pred: (f: ReturnType<typeof resolveSession>) => boolean, ms = 10_000) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      const f = resolveSession(dir)
      if (pred(f)) return f
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`timed out; console said:\n${out.text().slice(-700)}`)
  }

  await new Promise((r) => setTimeout(r, 500))
  input.write('/pause\n')
  await until((f) => 'session' in f && f.session.status.state === 'paused')

  input.write('/continue\n')
  // It must actually resume. Nothing here is working, so nothing may stand in the way.
  await until((f) => 'session' in f && f.session.status.state === 'running')
  assert.doesNotMatch(out.text(), /not continuing/, 'an idle seat must not be treated as busy')

  input.end()
  await running
})

// ---------------------------------------------------------------------------------------
// Child liveness at the console resume path.
//
// The sampler protects against sending into a live turn, but the verdict the pause was raised
// on can be superseded. A completed replacement means the Stop hook proved the turn ended, so
// the child may still be alive but process liveness is irrelevant; a withdrawal without a
// replacement verdict leaves the original concern in place.
// ---------------------------------------------------------------------------------------

test('a completed replacement verdict bypasses child liveness sampling on /continue', async () => {
  // The pause rests on a timed_out verdict, but the child later proves it completed. The
  // sampler must not be asked: the replacement Stop verdict is the authority on whether the
  // turn ended, and the child may still be alive without that meaning a turn is in flight.
  // A busy reading would falsely refuse a resumption the evidence has already cleared.
  // The replacement is emitted AFTER the pause is raised, so the pause actually exists.
  const dir = repo()
  const impl = slow('impl', 'claude', ['ack', 'Did it, slowly.', 'And again.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT }
  impl.childPid = 1
  const out = collect()
  const input = new PassThrough()
  let sampled = false
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 6,
    checks: [],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'], 300)],
      claude: [impl],
    }),
    liveness: async () => {
      sampled = true
      return BUSY_LIVENESS
    },
    input,
    output: out.stream,
  })
  const until = async (pred: (f: ReturnType<typeof resolveSession>) => boolean, ms = 10_000) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      const f = resolveSession(dir)
      if (pred(f)) return f
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`timed out; console said:\n${out.text().slice(-700)}`)
  }

  await until((f) => 'session' in f && f.session.status.state === 'paused')
  impl.lateSignal(COMPLETED)
  await until(
    (f) => 'session' in f && f.session.status.pause?.superseded?.verdict?.outcome === 'completed',
  )
  input.write('/continue\n')
  const resumed = await until((f) => 'session' in f && f.session.status.state === 'running')
  assert.ok('session' in resumed)
  assert.equal(sampled, false, 'liveness must not be sampled when the replacement is completed')
  assert.doesNotMatch(out.text(), /not continuing/, 'the run must resume without refusing')

  input.end()
  await running
})

test('a withdrawal with no replacement still samples child liveness before /continue', async () => {
  // The verdict is gone and the turn is open again, but the concern the sampler guards --
  // "is the child still working?" -- is unchanged. So sampling still runs, and a busy
  // child still refuses the continue.
  const dir = repo()
  const impl = slow('impl', 'claude', ['ack', 'Did it, slowly.', 'And again.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT, withdraw: 'no_replacement' }
  impl.childPid = 1
  const out = collect()
  const input = new PassThrough()
  let sampled = false
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 6,
    checks: [],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'], 300)],
      claude: [impl],
    }),
    liveness: async () => {
      sampled = true
      return BUSY_LIVENESS
    },
    input,
    output: out.stream,
  })
  const until = async (pred: (f: ReturnType<typeof resolveSession>) => boolean, ms = 10_000) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      const f = resolveSession(dir)
      if (pred(f)) return f
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`timed out; console said:\n${out.text().slice(-700)}`)
  }

  await until((f) => 'session' in f && f.session.status.state === 'paused')
  await until(
    (f) =>
      'session' in f &&
      f.session.status.pause?.superseded !== undefined &&
      f.session.status.pause?.superseded?.verdict === undefined,
  )
  input.write('/continue\n')
  await new Promise((r) => setTimeout(r, 300))
  const found = resolveSession(dir)
  assert.ok('session' in found)
  assert.equal(found.session.status.state, 'paused', 'the run must stay paused')
  assert.equal(sampled, true, 'liveness must be sampled when the verdict is withdrawn without replacement')
  assert.match(out.text(), /not continuing/, 'the busy child must refuse the continue')

  input.end()
  await running
})

test('a refusal to continue is recorded on the paused session status', async () => {
  // The run stays paused, so `state` alone cannot tell an outside reader that a decision was
  // attempted and rejected. The refusal must be on the pause record, rewritten to disk, so
  // `conclave status --json` can observe it without scraping the console.
  const dir = repo()
  const impl = slow('impl', 'claude', ['ack', 'Did it, slowly.', 'And again.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT, withdraw: 'no_replacement' }
  impl.childPid = 1
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 6,
    checks: [],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'], 300)],
      claude: [impl],
    }),
    liveness: async () => BUSY_LIVENESS,
    input,
    output: out.stream,
  })
  const until = async (pred: (f: ReturnType<typeof resolveSession>) => boolean, ms = 10_000) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      const f = resolveSession(dir)
      if (pred(f)) return f
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`timed out; console said:\n${out.text().slice(-700)}`)
  }

  await until((f) => 'session' in f && f.session.status.state === 'paused')
  await until(
    (f) =>
      'session' in f &&
      f.session.status.pause?.superseded !== undefined &&
      f.session.status.pause?.superseded?.verdict === undefined,
  )
  input.write('/continue\n')
  const found = await until((f) => 'session' in f && f.session.status.pause?.refusal !== undefined)
  assert.ok('session' in found)
  const refusal = found.session.status.pause!.refusal!
  assert.equal(typeof refusal.at, 'number')
  assert.equal(refusal.liveness.pid, 1)
  assert.equal(refusal.liveness.idle, false)
  assert.match(refusal.reason, /still working/)
  // Readable through the JSON rendering, not only in-process.
  const asJson = JSON.parse(formatSessionJson(found.session))
  assert.equal(asJson.pause.refusal.liveness.idle, false)

  input.end()
  await running
})

test('a mixed sample still refuses the continue, and is not described as a working child', async () => {
  // Both halves of #83 on the path that acts: the refusal is CONSERVATIVE and stays — one
  // sample above the line may be a turn, and continuing sends into it — while the sentence the
  // operator reads before choosing `force` says what was measured instead of asserting a live
  // turn. The old code refused with "the child is working right now" over 0.3%, 0.2%, 7.2%,
  // which is how a barely-running child held a run paused on evidence for the opposite.
  const dir = repo()
  const impl = slow('impl', 'claude', ['ack', 'Did it, slowly.', 'And again.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT, withdraw: 'no_replacement' }
  impl.childPid = 1
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 6,
    checks: [],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'], 300)],
      claude: [impl],
    }),
    liveness: async () => MIXED_LIVENESS,
    input,
    output: out.stream,
  })
  const until = async (pred: (f: ReturnType<typeof resolveSession>) => boolean, ms = 10_000) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      const f = resolveSession(dir)
      if (pred(f)) return f
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`timed out; console said:\n${out.text().slice(-700)}`)
  }

  await until((f) => 'session' in f && f.session.status.state === 'paused')
  await until(
    (f) =>
      'session' in f &&
      f.session.status.pause?.superseded !== undefined &&
      f.session.status.pause?.superseded?.verdict === undefined,
  )
  input.write('/continue\n')
  const found = await until((f) => 'session' in f && f.session.status.pause?.refusal !== undefined)
  assert.ok('session' in found)
  assert.equal(found.session.status.state, 'paused', 'a mixed sample must still refuse the resume')
  const refusal = found.session.status.pause!.refusal!
  assert.equal(refusal.liveness.idle, false)
  assert.deepEqual(refusal.liveness.samples, [0.3, 0.2, 7.2], 'the measured values are still reported')
  assert.doesNotMatch(refusal.reason, /still working/)
  assert.match(refusal.reason, /is barely running \(cpu 0\.3%, 0\.2%, 7\.2%\)/)
  // The guard has no output count to pair with a sample it took just now, and says so rather
  // than passing the `0` that used to render as "nothing at all since the prompt was sent".
  assert.match(refusal.reason, /no output count was taken with this reading/)
  // ...and the console line above it, which is what an operator actually looks at.
  assert.match(out.text(), /not continuing/)
  assert.doesNotMatch(out.text(), /the child is working right now/)
  assert.match(out.text(), /the child is not clearly idle/)
  assert.match(out.text(), /\/continue force to send anyway/, 'the way past it is still named')

  input.end()
  await running
})

// ---------------------------------------------------------------------------------------
// WHICH children the resume guard samples, and it is the pause's scope that says.
//
// The guard used to read `pause.verdictOf.participant` and fall back to a rank scan for every
// pause that field was empty on -- which is every pause except the two `turn_incomplete` halts,
// `verdictOf` being set at exactly those (src/relay/relay.ts:4149, src/relay/relay.ts:4535).
// So a pause naming ONE seat could refuse a continue because a DIFFERENT seat was mid-turn, and
// a pause naming no seat at all measured whichever children happened to be implementers.
//
// The rule now: a `participant` scope samples that participant and nobody else; a `conclave` or
// `workstream` scope samples nobody. The unit tests below are over the rule, built from real
// `resolutionFor` output rather than hand-written scopes -- so a reason whose scope changes in
// `resolution.ts` changes what these assert -- and the two console tests after them drive the
// same rule through `/continue` with a child the sampler would have called busy.
// ---------------------------------------------------------------------------------------

/** A pause as the halt sites build one: the scope derived, never declared. See `resolutionFor`. */
function pauseFor(subject: ResolutionSubject, verdictOf?: { participant: string; endSeq: number }): RunPause {
  return {
    reason: subject.reason,
    resolution: resolutionFor(subject, { rotationArmed: false }),
    detail: 'a fixture pause',
    evidence: [],
    options: ['continue', 'abort'],
    ...(verdictOf ? { verdictOf } : {}),
    atSeq: 1,
    at: 0,
  }
}

/** Two implementer seats and an advisor, which is the shape the rank scan got wrong. */
const THREE_SEATS = [
  { id: 'implementer', rank: 'implementer' as const },
  { id: 'implementer-2', rank: 'implementer' as const },
  { id: 'advisor', rank: 'advisor' as const },
]

const sampled = (pause: RunPause | undefined): string[] =>
  seatsToSampleAtPause(pause, THREE_SEATS).map((p) => p.id)

test('a participant-scoped pause samples that seat and no other, at every reason that carries one', () => {
  // `turn_incomplete` is the one reason that also sets `verdictOf`, so it is the one case the
  // old code got right; it is here to pin that the change did not lose it.
  assert.deepEqual(
    sampled(pauseFor({ reason: 'turn_incomplete', participant: 'implementer-2' }, { participant: 'implementer-2', endSeq: 4 })),
    ['implementer-2'],
  )
  // The four that name a seat in their SCOPE and set no `verdictOf`. Every one of these used to
  // be answered by a rank scan, so at N>1 each could refuse on a seat the pause never mentioned.
  assert.deepEqual(sampled(pauseFor({ reason: 'merge_blocked', participant: 'implementer-2' })), ['implementer-2'])
  assert.deepEqual(sampled(pauseFor({ reason: 'review_blocked', participant: 'implementer-2' })), ['implementer-2'])
  assert.deepEqual(sampled(pauseFor({ reason: 'rotation_candidate', participant: 'implementer-2' })), ['implementer-2'])
  assert.deepEqual(sampled(pauseFor({ reason: 'implementer_unanswered', participant: 'implementer-2' })), ['implementer-2'])
  // The ADVISOR is a participant like any other, and its own bad turn pauses the run
  // (src/relay/relay.ts:4146). A rank scan for implementers sampled the wrong child here too.
  assert.deepEqual(
    sampled(pauseFor({ reason: 'turn_incomplete', participant: 'advisor' }, { participant: 'advisor', endSeq: 2 })),
    ['advisor'],
  )
})

test('a conclave- or workstream-scoped pause samples nobody, with no fall back to rank', () => {
  // Both conclave-scoped reasons. Resuming an `advisor_escalated` pause sends to the ADVISOR
  // (src/relay/relay.ts:4248), so measuring implementer children was never the question; and
  // `operator_requested` is consumed at an advisor-turn boundary that states no turn is in
  // flight. Neither has anything for this guard to sample.
  assert.deepEqual(sampled(pauseFor({ reason: 'advisor_escalated' })), [])
  assert.deepEqual(sampled(pauseFor({ reason: 'operator_requested' })), [])
  // Workstream scope, and the id deliberately COLLIDES with a seat id -- at N=1 the workstream
  // is named after the seat carrying the instruction (src/relay/relay.ts:4312), which is exactly
  // the coincidence a guard could read as "so sample that seat". A workstream is not a seat.
  assert.deepEqual(sampled(pauseFor({ reason: 'authority_conflict', workstream: 'implementer' })), [])
})

test('a scope naming a seat that is gone samples nobody rather than falling back', () => {
  // A seat rotated out from under the pause, and the same answer as a missing pid: no reading.
  assert.deepEqual(sampled(pauseFor({ reason: 'merge_blocked', participant: 'implementer-9' })), [])
  // No pause at all is unreachable from `resumeRun`, which returns unless the run is paused.
  // Asserted anyway, because the old fallback would have scanned here.
  assert.deepEqual(sampled(undefined), [])
})

test('a rotation_candidate pause on one seat resumes while the OTHER seat is genuinely mid-turn', async (t) => {
  // The production shape of the N>1 case the rank scan got wrong, and the reason it has to be
  // this shape: `rotation_candidate` carries NO `verdictOf` -- that field is set at two halt
  // sites, both turn_incomplete (src/relay/relay.ts:4149, src/relay/relay.ts:4535) -- so under
  // the old expression this pause fell through to the rank scan and sampled EVERY implementer.
  // A simpler `turn_incomplete` fixture cannot show that: it populates the field, takes the
  // named-seat branch, and passes against the code being replaced.
  //
  // So: two seats, real concurrent dispatch, one instruction each from one advisor reply.
  // `implementer`'s work turn is HELD OPEN by this test for as long as it needs, rather than
  // running against a clock. `implementer-2` compacts on its work turn, which is what `assess`
  // reads as degradation (src/rotation/degradation.ts), and with checks configured a degraded
  // seat is a rotation CANDIDATE that pauses rather than a run that ends. The pause names
  // `implementer-2`; the child that measures busy is `implementer`, the seat the pause is not
  // about.
  const dir = repo()
  // Two seats mean linked worktrees, and those are cut from a COMMIT -- so the console refuses
  // to start with anything uncommitted (`requireCleanBase`). Starting the console installs hook
  // files for the agents it was named, which land untracked in this fixture, so they are
  // ignored and committed before the run rather than tripping a guard this test is not about.
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n.claude/\n.codex/\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'ignore agent hook files'], { cwd: dir })
  // One reply, two seats, addressed by the ids the console constructs -- `seatIdFor(0)` and
  // `(1)`. The only way to put two seats to work from one advisor turn, and the same form
  // src/repl/session.tty.test.ts drives its two-seat console with.
  const assignment = '@seat implementer: rebuild the parser\n@seat implementer-2: rewrite the docs'
  // Its work turn is HELD open until this test releases it, rather than given a delay long
  // enough to outlast the pause. A timer would make the assertions below true only for as long
  // as the guess held; the gate makes "this seat is still inside its turn" a fact the test
  // controls. Turn 0 is the briefing and ends normally; turn 1 is the dispatched work.
  const busySeat = new FakeRotationSession('alpha', 'alpha', ['ack', 'Did it.', 'NONE', 'NONE'])
  busySeat.holdTurn = 1
  busySeat.childPid = 11
  const degrading = slow('beta', 'beta', ['ack', 'Rewrote the docs.', 'NONE', 'NONE'], 300)
  degrading.childPid = 22
  // Turn 0 is the briefing, so turn 1 is the first turn that does work. Compaction there is
  // the whole degradation signal -- the prose says nothing about being spent, so this seat is
  // degraded on evidence rather than on its own complaint.
  degrading.compactOnTurn = 1
  const out = collect()
  const input = new PassThrough()
  const asked: number[] = []
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'alpha',
    // Distinct agents, one per seat, so which fake is which seat is not a matter of queue order.
    implementers: [
      { agent: 'alpha', args: [] },
      { agent: 'beta', args: [] },
    ],
    rounds: 6,
    // ARMS ROTATION, which is what makes degradation a pause instead of an ended run
    // (src/relay/relay.ts:2827-2833). A command that exits 0 immediately: what the checks DO is
    // not what this test is about, only that a replacement would have something to reproduce.
    checks: ['true'],
    registry: registryOf({
      codex: [slow('advisor', 'codex', [assignment, 'DONE', 'DONE', 'DONE'], 300)],
      alpha: [busySeat],
      beta: [degrading],
    }),
    liveness: async (pid) => {
      asked.push(pid)
      // The busy child is the seat the pause is NOT about. If the guard samples by rank it
      // finds this one and refuses; if it samples by scope it never asks.
      return pid === 11 ? BUSY_LIVENESS : IDLE_LIVENESS
    },
    input,
    output: out.stream,
  })
  // WHATEVER happens below, the held turn is released and the console is closed. A held turn is
  // the one fixture in this file that cannot be left behind: an assertion that throws before the
  // release would leave a turn nothing is ever going to finish and a session promise nobody
  // settles, so the failure stops being a failing test and becomes a hung suite -- which is what
  // the first version of this test did when it was run against the mutation it exists to catch.
  t.after(async () => {
    if (busySeat.holding) busySeat.releaseTurn()
    input.end()
    await running
  })
  const until = async (pred: (f: ReturnType<typeof resolveSession>) => boolean, ms = 30_000) => {
    const started = Date.now()
    while (Date.now() - started < ms) {
      const f = resolveSession(dir)
      if (pred(f)) return f
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`timed out; console said:\n${out.text().slice(-1200)}`)
  }

  const paused = await until(
    (f) => 'session' in f && f.session.status.state === 'paused' && f.session.status.pause?.reason === 'rotation_candidate',
  )
  assert.ok('session' in paused)
  const pause = paused.session.status.pause!
  assert.deepEqual(
    pause.resolution.scope,
    { kind: 'participant', participantId: 'implementer-2' },
    'the pause must be scoped to the degraded seat',
  )
  assert.equal(pause.verdictOf, undefined, 'and it must carry no verdictOf -- which is why the old fallback fired here')

  // The other seat is in flight according to the DISPATCHER, read out of the status document
  // rather than inferred from the sampler this test is measuring. `running` with a task id is
  // the scheduler saying it sent work and has not seen it come back (`SeatExecution`).
  const other = paused.session.status.participants.find((p) => p.id === 'implementer')
  assert.ok(other?.seat, 'the two-seat status document must carry a seat block')
  assert.equal(other.seat.state, 'running', 'the other seat must be mid-turn, not idle')
  // The task block exists ONLY between dispatch and release, so its presence is half the proof
  // on its own; `state: 'running'` is the other half — the instruction was sent and no report
  // has come back. Both are asserted rather than either alone.
  assert.match(other.seat.task?.instruction ?? '', /rebuild the parser/, 'holding the task it was dispatched')
  assert.equal(other.seat.task?.state, 'running', 'and that task must be in flight, not reported')
  // The child's side of the same fact, and the reason it is not a timing accident: two sends --
  // its briefing and this instruction -- and its second turn is being HELD, so no `turn_end` for
  // it can exist until this test allows one. Deliberately NOT asserted through `session.state`,
  // which reads `running` whether or not a turn is in flight.
  assert.equal(busySeat.received.length, 2, 'the busy seat was sent work it has not answered')
  assert.equal(busySeat.holding, true, 'and its turn is held open, not merely slow')

  input.write('/continue\n')
  await until((f) => 'session' in f && f.session.status.state === 'running')
  assert.doesNotMatch(out.text(), /not continuing/, 'a busy seat the pause is not about must not refuse')
  assert.deepEqual(asked, [22], 'only the seat the pause names may be sampled')

  // Everything this test is about has been observed. The release and the shutdown are in
  // `t.after` above rather than here, so they run on the failing path too.
})

test('an operator-requested pause samples nobody, even with a busy implementer child', async () => {
  // Conclave scope: the operator stopped the run and the operator is starting it again, and no
  // participant is named. The rank scan used to sample the implementer here, so a child that
  // measured busy refused the resumption of a pause that was never about it -- and resuming
  // this pause sends nothing, it drops back into the advisor turn boundary it was taken at.
  const dir = repo()
  const impl = slow('impl', 'claude', ['ack', 'Did it.', 'Again.'], 300)
  impl.childPid = 7
  const out = collect()
  const input = new PassThrough()
  let asked = 0
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 6,
    checks: [],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'], 300)],
      claude: [impl],
    }),
    liveness: async () => {
      asked++
      return BUSY_LIVENESS
    },
    input,
    output: out.stream,
  })
  const until = async (pred: (f: ReturnType<typeof resolveSession>) => boolean, ms = 10_000) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      const f = resolveSession(dir)
      if (pred(f)) return f
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`timed out; console said:\n${out.text().slice(-700)}`)
  }

  await new Promise((r) => setTimeout(r, 500))
  input.write('/pause\n')
  const paused = await until((f) => 'session' in f && f.session.status.state === 'paused')
  assert.ok('session' in paused)
  assert.deepEqual(paused.session.status.pause!.resolution.scope, { kind: 'conclave' })

  input.write('/continue\n')
  await until((f) => 'session' in f && f.session.status.state === 'running')
  assert.equal(asked, 0, 'a pause that names no participant has nothing to sample')
  assert.doesNotMatch(out.text(), /not continuing/, 'and nothing to refuse on')

  input.end()
  await running
})

test('a busy child that goes idle lets /continue resume on retry', async () => {
  // The guard re-samples rather than remembering the past. A child that was busy the first
  // time and idle the second time must resume, or the guard is a wall again.
  const dir = repo()
  const impl = slow('impl', 'claude', ['ack', 'Did it, slowly.', 'And again.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT, withdraw: 'no_replacement' }
  impl.childPid = 1
  const out = collect()
  const input = new PassThrough()
  let calls = 0
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 6,
    checks: [],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'], 300)],
      claude: [impl],
    }),
    liveness: async () => {
      calls++
      return calls === 1 ? BUSY_LIVENESS : IDLE_LIVENESS
    },
    input,
    output: out.stream,
  })
  const until = async (pred: (f: ReturnType<typeof resolveSession>) => boolean, ms = 10_000) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      const f = resolveSession(dir)
      if (pred(f)) return f
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`timed out; console said:\n${out.text().slice(-700)}`)
  }

  await until((f) => 'session' in f && f.session.status.state === 'paused')
  await until(
    (f) =>
      'session' in f &&
      f.session.status.pause?.superseded !== undefined &&
      f.session.status.pause?.superseded?.verdict === undefined,
  )
  input.write('/continue\n')
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(calls, 1)
  assert.match(out.text(), /not continuing/)

  input.write('/continue\n')
  await until((f) => 'session' in f && f.session.status.state === 'running')
  assert.equal(calls, 2, 'liveness must be re-sampled on retry')

  input.end()
  await running
})
