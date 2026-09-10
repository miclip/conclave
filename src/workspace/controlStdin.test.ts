/**
 * Whether the control channel is still there, and whether the advice for holding it open expires.
 *
 * #252, which is two defects with one cause. A detached run is steered by writing lines into a
 * fifo, and the fifo needs a process holding its write end. Nothing reported whether that holder
 * was still alive, so the first evidence of its death was the run ending -- which reads exactly
 * like the run finishing. And the holder conclave itself recommended was `sleep 86400`, which
 * exits after exactly a day: guaranteed failure for any run that outlives one, at a moment
 * nothing announces. Runs measured on this project have gone twelve hours.
 *
 * So the tests below come in two halves. The record has to say `held`, `closed` or
 * `not_attached` and keep ABSENCE meaning "not reported"; and every place conclave prints the
 * recipe has to print a holder with no timer.
 *
 * A third half, added by #259, because the first was not carrying its own weight. `held` and
 * `not_attached` are the two arms of one ternary in the console, and BOTH were checked by
 * handing the value straight to `recordSession` -- so the file asserted what a caller passed
 * and never what the console decides. The console derives it from the real process (`interactive`
 * is stdin being a terminal), and a fixture that supplies the RESULT of that decision cannot
 * fail when the decision changes. `#259 the console decides ...` below runs the console itself,
 * once under a pty and once over a pipe, and reads the two values back off disk.
 *
 *   node --test src/workspace/controlStdin.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { PtyProcess } from '../process/pty.ts'
import { RelayEventStream } from '../relay/observe.ts'
import { tempDir } from '../testkit/tempDir.ts'
import {
  newSessionId,
  readSession,
  recordSession,
  SessionRecorder,
  sessionDir,
  type RecordableRelay,
  type SessionRecording,
  type SessionStatus,
} from './sessionRecord.ts'
import { formatSession, formatSessionJson } from './sessionView.ts'

const ROOT = join(import.meta.dirname, '..', '..')

/**
 * A relay-shaped stand-in that answers nothing optional.
 *
 * Deliberately the MINIMUM `RecordableRelay`: the point of this file is a field no relay
 * supplies, so a double that answered `ceilings`, `rotations` or `targeting` would only add
 * keys that have nothing to do with the claim. Structural, so no `Relay` is constructed.
 */
function stubRelay(): RecordableRelay & { stream: RelayEventStream } {
  const stream = new RelayEventStream()
  return {
    stream,
    cwd: '/tmp/project',
    operator: 'agent',
    get stopped() {
      return stream.closed
    },
    whenObservable: () => stream.whenReopened(),
    participants: [
      {
        id: 'advisor',
        rank: 'advisor',
        role: 'advisor',
        launch: { args: [], model: null },
        session: {
          agent: 'codex',
          async snapshot() {
            return { turns: [] }
          },
        },
      },
    ],
    log: [],
    permissionsPending: () => [],
    observe: (o) => stream.observe(o),
  }
}

/**
 * One recorded session in a temporary project, closed before the test returns.
 *
 * Closed HERE rather than in a `t.after`, and that is not tidiness. `tempDir` registers its own
 * `after` first, so a recorder closed in a later hook writes its final refresh into a directory
 * that has already been removed -- which is harmless (the recorder survives a failed write by
 * design) and prints a full ENOENT warning per test to a suite where a real one would then be
 * unreadable. The label avoids the string `stdin` for a smaller reason of the same kind: it
 * lands in the `events:` path the prose prints, and one assertion here is that the prose says
 * nothing about stdin.
 */
async function withRecord(
  t: TestContext,
  stdin: 'held' | 'closed' | 'not_attached' | undefined,
  fn: (r: { root: string; id: string; recording: SessionRecording }) => void | Promise<void>,
): Promise<void> {
  const root = tempDir(t, 'ctl-channel')
  const relay = stubRelay()
  const id = newSessionId(Date.now(), process.pid)
  const recording = recordSession(relay, {
    repoRoot: root,
    id,
    goal: 'a goal',
    front: 'session',
    startedAt: Date.now(),
    build: 'test',
    ...(stdin ? { stdin } : {}),
  })
  try {
    await fn({ root, id, recording })
  } finally {
    relay.stream.close()
    await recording.close()
  }
}

function statusOf(root: string, id: string): SessionStatus {
  const read = readSession(root, id)
  assert.ok(read, 'the record must be readable')
  return read.status
}

test('#252 a run driven through a fifo records its control channel as held', async (t) => {
  await withRecord(t, 'held', ({ root, id }) => {
    assert.equal(statusOf(root, id).stdin, 'held', 'the first document already carries it')
  })
})

/**
 * A git repository to run a console in, because it refuses to start outside one.
 *
 * `.conclave/` is ignored so the run's own record does not dirty the tree it is attributing
 * work by. Nothing else is written here -- the driver below lives in its own directory, off
 * to one side, for the same reason.
 */
function consoleRepo(t: TestContext): string {
  const dir = tempDir(t, 'ctl-stdin-repo')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i'], { cwd: dir })
  return dir
}

/**
 * One console over fake participants, started with NO goal so it records and then waits.
 *
 * The goal is what starts a run, and a run is not what is under test here: the field is
 * written by `recordSession` during startup, before the console has read a byte. So the
 * driver's whole job is to get `runSession` as far as its first document and then sit
 * still, which also means the two transports below differ in exactly one thing -- what
 * stdin is -- and in nothing about what the run did.
 *
 * Written OUTSIDE the repository it runs in: a driver dropped into the checkout is an
 * untracked file in a tree the session is about to attribute work by diffing.
 */
function consoleDriver(t: TestContext, dir: string): string {
  const path = join(tempDir(t, 'ctl-stdin-driver'), 'driver.mjs')
  writeFileSync(
    path,
    `
import { runSession } from ${JSON.stringify(join(ROOT, 'src/repl/session.ts'))}
import { AgentRegistry } from ${JSON.stringify(join(ROOT, 'src/registry/registry.ts'))}
import { FakeRotationSession } from ${JSON.stringify(join(ROOT, 'src/rotation/fakeSession.ts'))}
import { NO_DEADLINE_CLOCKS } from ${JSON.stringify(join(ROOT, 'src/registry/types.ts'))}

const caps = {
  readinessSignal: 'unknown', turnKeySource: 'prompt_id',
  outcomes: { completed: 'observed', cancelled: 'reasoned_but_unverified',
    permission_refused: 'reasoned_but_unverified', process_exited: 'reasoned_but_unverified',
    timed_out: 'reasoned_but_unverified', transport_lost: 'reasoned_but_unverified',
    unknown_abnormal_end: 'reasoned_but_unverified' },
}
const registry = new AgentRegistry()
for (const [agent, id] of [['codex', 'advisor'], ['claude', 'impl']]) {
  registry.register({
    id: agent, displayName: agent, capabilities: { ...caps, agent },
    deadlines: NO_DEADLINE_CLOCKS,
    launch: { command: agent, baseArgs: [] },
    async create() { return new FakeRotationSession(id, agent, []) },
  })
}

const code = await runSession({
  cwd: ${JSON.stringify(dir)},
  lead: 'codex', implementer: 'claude', rounds: 6, checks: [], registry,
})
process.exit(code)
`,
  )
  return path
}

/**
 * The `stdin` the console wrote into its own record, polled off disk.
 *
 * Polled rather than read once: the console is a separate process and the document appears
 * partway through its startup. Read from the DIRECTORY rather than from a session id scraped
 * out of the banner, because under a pty the banner is dim-coloured and reflowed at whatever
 * width the terminal was given -- parsing it would make this a test of the renderer.
 */
async function recordedStdin(dir: string, output: () => string, timeoutMs = 30_000): Promise<unknown> {
  const root = join(dir, '.conclave', 'sessions')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ids = existsSync(root) ? readdirSync(root) : []
    const doc = ids
      .map((id) => join(root, id, 'status.json'))
      .filter((f) => existsSync(f))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>
        } catch {
          // A torn read of a file another process is writing. Not an answer; look again.
          return undefined
        }
      })
      .find((d) => d !== undefined)
    if (doc) return doc['stdin']
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.fail(`the console wrote no session record within ${timeoutMs}ms. Its output was:\n${output()}`)
}

test('#259 the console decides the control-stdin state from the real process, not the caller', async (t) => {
  // The claim #252 made and #259 found unevidenced. `interactive` is derived at startup from
  // whether stdin is a terminal, and every earlier test in this file handed `recordSession` the
  // ANSWER -- so the console's ternary was asserted by nothing, and both arms would have stayed
  // green with it rewritten to a constant.
  //
  // So: one driver, two transports, and the difference between the two recorded values IS the
  // evidence. A pty is a real terminal (`process.stdin.isTTY`), which is an operator at a
  // keyboard and no channel anyone can drop; a pipe is a channel being HELD until it reaches
  // EOF, and is what a detached run steered through a fifo actually has.
  //
  // Both arms are checked here rather than only the missing one. Splitting them would put the
  // two halves of a single decision in two fixtures again, and `held` supplied by hand is
  // exactly the coverage this test exists to replace.
  const ptyRepo = consoleRepo(t)
  const pty = await PtyProcess.spawn({
    file: process.execPath,
    args: [consoleDriver(t, ptyRepo)],
    cwd: ptyRepo,
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? ptyRepo, TERM: 'xterm-256color' },
  })
  t.after(() => void pty.terminate())

  const pipeRepo = consoleRepo(t)
  let piped = ''
  const pipe = spawn(process.execPath, [consoleDriver(t, pipeRepo)], {
    cwd: pipeRepo,
    // stdin a PIPE and deliberately never ended. Closing it is EOF, which the console reports
    // as `closed` on the spot (the test below this one) -- so an ended pipe would overwrite the
    // very value being read back and the fixture would assert its own teardown.
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? pipeRepo },
  })
  pipe.stdout.on('data', (d) => (piped += d))
  pipe.stderr.on('data', (d) => (piped += d))
  t.after(() => void pipe.kill('SIGKILL'))

  assert.equal(
    await recordedStdin(ptyRepo, () => pty.output),
    'not_attached',
    'a console whose stdin is a real terminal has no control channel to lose',
  )
  assert.equal(
    await recordedStdin(pipeRepo, () => piped),
    'held',
    'and the same console over a pipe is holding one, from the first document',
  )
})

test('#252 the closure is published immediately, with the run still running', async (t) => {
  // The timing is the whole feature. Stdin reaches EOF while nothing about the run's state has
  // changed -- still `running`, possibly mid-turn -- so there is no lifecycle transition to
  // carry it. A field that waited for the next `set` would appear at the moment the run ended,
  // which is the moment the issue says is already too late.
  await withRecord(t, 'held', ({ root, id, recording }) => {
    recording.set('running')
    assert.equal(statusOf(root, id).stdin, 'held')

    recording.stdin('closed')

    const after = statusOf(root, id)
    assert.equal(after.stdin, 'closed', 'the record says so on the write it caused')
    assert.equal(after.state, 'running', 'and nothing else moved: this is not a lifecycle change')
  })
})

test('#252 a producer that reports no control channel writes no key at all', async (t) => {
  // The compatibility half, and the reason the field is optional rather than defaulted. `relay`
  // reads no commands, and an older build wrote no such field -- neither has said a channel is
  // missing. A `stdin: null` or a defaulted `closed` would make both of them look like the
  // condition this issue exists to raise the alarm about.
  await withRecord(t, undefined, ({ root, id }) => {
    const status = statusOf(root, id)
    assert.equal('stdin' in status, false, 'absent, not null')
    assert.equal(
      JSON.parse(readFileSync(join(sessionDir(root, id), 'status.json'), 'utf8'))['stdin'],
      undefined,
      'and absent on disk, which is what a jq-wielding operator reads',
    )
  })
})

test('#252 a record written before the field existed still reads, and reports nothing', (t) => {
  // The other direction of the same compatibility claim, driven through a document this build
  // did not write. `readSession` parses whatever is on disk, so a checkout upgraded mid-flight
  // meets exactly this: a live run's record from the previous build.
  const root = tempDir(t, 'legacy-record')
  const id = 'legacy-1'
  const recorder = new SessionRecorder(root, {
    id,
    pid: process.pid,
    cwd: '/tmp/project',
    goal: 'a goal',
    front: 'session',
    operator: 'agent',
    state: 'running',
    startedAt: Date.now(),
    messages: 0,
    participants: [],
    build: 'older',
  })
  // Rewritten by hand rather than trusted: the constructor above is THIS build's, so asserting
  // on its output would be asserting that this build omits a key it was not given -- a weaker
  // claim than the one being made, which is about a file written elsewhere.
  const doc = JSON.parse(readFileSync(recorder.statusPath, 'utf8')) as Record<string, unknown>
  delete doc['stdin']
  writeFileSync(recorder.statusPath, `${JSON.stringify(doc, null, 2)}\n`)

  const read = readSession(root, id)
  assert.ok(read, 'the record still parses')
  assert.equal(read.status.stdin, undefined)
  assert.doesNotMatch(formatSession(read, Date.now()), /stdin|STDIN/, 'and the prose invents nothing')
})

test('#252 status --json carries the value verbatim, and the prose says it in words', async (t) => {
  // Both surfaces, from one document, because they are read by different operators and the
  // prose one has no fallback: an operator reading `conclave status` should not have to be told
  // to add --json to learn the run is unsteerable.
  const now = Date.now()
  for (const [value, expected] of [
    ['held', /stdin:\s+held/],
    ['closed', /STDIN CLOSED/],
    ['not_attached', /stdin:\s+not attached/],
  ] as const) {
    await withRecord(t, value, ({ root, id }) => {
      const read = readSession(root, id)
      assert.ok(read)
      assert.equal(JSON.parse(formatSessionJson(read, now))['stdin'], value, `${value} reaches --json`)
      assert.match(formatSession(read, now), expected, `${value} reaches the prose`)
    })
  }
})

test('#252 the prose shouts about a closed channel and says what it costs', async (t) => {
  // Not merely present. A closed channel is a warning about every other line on the page -- the
  // run looks perfectly healthy and cannot be steered -- so it is shaped like the STALE block
  // above it rather than like another fact beside it.
  await withRecord(t, 'closed', ({ root, id }) => {
    const read = readSession(root, id)
    assert.ok(read)
    const prose = formatSession(read, Date.now())
    assert.match(prose, /STDIN CLOSED/, 'unmissable to someone scanning')
    assert.match(prose, /no further command can arrive/, 'and it says what that means')
    assert.match(prose, /pause .*can never be answered/, 'including the consequence the issue is about')
  })
})

/**
 * The holder each user-facing recipe names, taken from the recipe rather than from the source.
 *
 * `sleep 86400` was correct-looking advice with a 24-hour fuse, printed to an operator at their
 * worst moment -- the EOF warning fires when a run has JUST died of this, so it is read by
 * someone recovering and followed exactly. Pinning the property rather than the string: what
 * must not come back is a holder that exits on a timer, whatever it is spelled.
 */
function holderLine(text: string, where: string): string {
  // A HOLDER, not merely a line that writes to the fifo. The first version took the first
  // `> ctl` in the file, which conflated two different things: a holder keeps the write end
  // open for the life of the run and is backgrounded, while `echo '/continue' > ctl` opens,
  // writes and closes. Adding a documented WRITE ahead of the holder recipe made this guard
  // fail on a line that was never a holder -- and the tempting repair, rewording the docs
  // until the pattern stopped matching, would have left the guard checking whichever `> ctl`
  // happened to come first.
  //
  // `&` is the discriminator and it is not incidental: a holder that is not backgrounded
  // blocks the shell that started it, so the session never launches.
  const lines = text.split('\n')
  const holder = lines.find((l) => l.includes('> ctl') && /&\s*(#.*)?$/.test(l))
  assert.ok(holder, `${where} must still document how to hold the fifo open`)
  return holder
}

function usage(): string {
  const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'conclave.ts'), 'help'], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.equal(r.status, 0, 'conclave help must succeed')
  return r.stdout
}

test('#252 no printed recipe holds the fifo open with a timer', () => {
  // Both printed surfaces, RENDERED rather than read as source: the README is what an operator
  // copies, and `conclave help` is what the CLI actually prints. The third -- the EOF warning
  // the console writes -- is rendered by a real run and asserted in `repl/session.test.ts`,
  // where a run can be provoked.
  for (const [where, text] of [
    ['README.md', readFileSync(join(ROOT, 'README.md'), 'utf8')],
    ['conclave help', usage()],
  ] as const) {
    const line = holderLine(text, where)
    assert.doesNotMatch(
      line,
      /\bsleep\b|\btimeout\b/,
      `${where} must not hold the fifo with a command that exits on a timer (#252): ${line}`,
    )
    assert.match(line, /tail -f \/dev\/null/, `${where} must name the holder with no timer: ${line}`)
  }
})

test('#252 the recommended holder does not exit on its own', async () => {
  // The claim the recipe makes, checked against the binary on this machine rather than restated
  // from memory -- the house rule about comments describing another program. `tail -f` on an
  // empty file that never grows is the whole trick, and a `tail` that treated /dev/null as a
  // finished file would exit at once and put the fuse straight back.
  const child = spawn('tail', ['-f', '/dev/null'], { stdio: 'ignore' })
  try {
    const exited = await Promise.race([
      new Promise<'exited'>((r) => child.once('exit', () => r('exited'))),
      new Promise<'still there'>((r) => setTimeout(() => r('still there'), 500).unref()),
    ])
    assert.equal(exited, 'still there', 'tail -f /dev/null must not exit on its own')
  } finally {
    child.kill('SIGKILL')
  }
})
