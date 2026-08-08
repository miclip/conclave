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
import type { AgentSession } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { runSession, withHeartbeat } from './session.ts'

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
  /** Observes the args a participant was launched with, which is otherwise invisible. */
  onLaunch?: (agent: string, args: string[] | undefined) => void,
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
      launch: { command: agent, baseArgs: [] },
      async create(resolved) {
        onLaunch?.(agent, resolved.spec.args)
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
  // The run was nowhere near its 20 rounds, so leaving has to abort it rather than wait.
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
  assert.match(replacement, /completed/, 'and the verdict that replaced it')
  assert.match(replacement, /still paused/, 'surfaced, not decided')

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
const caps = { readinessSignal: 'unknown', turnKeySource: 'prompt_id',
  outcomes: { completed: 'observed', cancelled: 'reasoned_but_unverified',
    permission_refused: 'reasoned_but_unverified', process_exited: 'reasoned_but_unverified',
    timed_out: 'reasoned_but_unverified', transport_lost: 'reasoned_but_unverified',
    unknown_abnormal_end: 'reasoned_but_unverified' } }
const registry = new AgentRegistry()
for (const [agent, session] of [['codex', new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])],
                                ['claude', new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])]]) {
  registry.register({ id: agent, displayName: agent, capabilities: { ...caps, agent },
    launch: { command: agent, baseArgs: [] }, async create() { return session } })
}
process.exit(await runSession({ cwd: ${JSON.stringify(dir)}, goal: 'Keep the work moving.',
  lead: 'codex', implementer: 'claude', rounds: 3, checks: [], registry, input: Readable.from([]) }))
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
  assert.match(first.text(), /resume with: conclave session/)

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
