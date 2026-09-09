/**
 * The checkpoint at the two operator surfaces: `--checkpoint` at launch and `/checkpoint` in
 * the console (#253).
 *
 *   node --test src/repl/checkpoint.test.ts
 *
 * `src/relay/checkpoint.test.ts` owns the mechanism -- the signal, the halt, the disarm, the
 * refused DONE. This file owns the two ways an operator reaches it, and the two things that go
 * wrong at a front-end rather than in a loop:
 *
 *   - a value that is missing or empty. Refused at both, and refused BEFORE anything is armed,
 *     because a checkpoint with no milestone would brief the advisor with a blank line and then
 *     stop the run at something nobody could state.
 *   - a `/checkpoint` with no run. There is no advisor turn to carry the notice, so a checkpoint
 *     accepted there would sit in a field nothing reads and the operator would find out by
 *     watching the run they started afterwards end on DONE.
 *
 * And the two places it has to be VISIBLE: `/state`, and the status document a driver polls.
 *
 * ## Why the stdin cases are driven through `script()` and not asserted structurally
 *
 * `--operator agent` is a console with a machine typing at it, and the whole of what makes that
 * work is that a command arriving on stdin is the same command as one typed at the prompt --
 * there is no second dispatcher. So the agent-operator claim is tested by writing the line into
 * the input stream, which is exactly what a fifo does, rather than by asserting that some
 * agent-specific branch exists. If `/checkpoint` ever grew one, these would keep passing and
 * they would be right to: the operator got what they typed.
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { PassThrough, Writable } from 'node:stream'
import test, { type TestContext } from 'node:test'
import type { AgentSession } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { tempDir } from '../testkit/tempDir.ts'
import { resolveSession } from '../workspace/sessionRecord.ts'
import { main } from '../../bin/conclave.ts'
import { HELP, runSession } from './session.ts'

const CONSOLE_COLUMNS = 100

function repo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-checkpoint-repl')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('sh', ['-c', 'printf ".conclave/\\n" > .gitignore && printf "export const a = 1\\n" > work.ts'], {
    cwd: dir,
  })
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

function registryOf(sessions: Record<string, AgentSession[]>): AgentRegistry {
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

/** Feed lines with a gap, so the run reaches the state each command is about. */
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

function collect(): { stream: Writable; text: () => string } {
  const chunks: string[] = []
  const stream = Object.assign(
    new Writable({
      write(c, _e, cb) {
        chunks.push(String(c))
        cb()
      },
    }),
    { columns: CONSOLE_COLUMNS },
  )
  return { stream, text: () => chunks.join('') }
}

/** The status document as a poller reads it, off the record the run actually wrote. */
function status(dir: string): Record<string, unknown> {
  const found = resolveSession(dir)
  assert.ok('session' in found, 'the run must have written a session record')
  return found.session.status as unknown as Record<string, unknown>
}

/** A participant whose turns take long enough for a console to be typed at. */
function slow(id: string, agent: string, replies: string[], ms = 250): FakeRotationSession {
  const s = new FakeRotationSession(id, agent, replies)
  s.delayMs = ms
  return s
}

/**
 * Wait for the console to have WRITTEN something, then act.
 *
 * Every test below that answers a pause uses this and a live `PassThrough` rather than
 * `script([...])`, and the first draft of this file is why. A timed script writes its line after
 * a fixed gap, and `/continue` that lands before the pause exists is answered with
 * `not paused (running)` and DROPPED -- so the run then sits at a pause nothing will ever answer
 * and the test hangs rather than failing. That is the sampling-instead-of-waiting fault #179
 * catalogued, and it is worse here than usual: the symptom is a suite that never finishes, which
 * reads as an environment problem rather than as a test that was written wrong.
 */
async function untilText(what: string, text: () => string, re: RegExp, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (re.test(text())) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}:\n${text()}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

// ---------------------------------------------------------------------------
// --checkpoint at launch.
// ---------------------------------------------------------------------------

test('--checkpoint arms the first run, and the run stops at the milestone rather than on DONE', async (t) => {
  const dir = repo(t)
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Build the parser.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 4,
    checks: [],
    checkpoint: 'the parser lands',
    registry: registryOf({
      // DONE first, so this also proves the refusal reaches a run armed from the FLAG and not
      // only one armed through the handle -- the two arming paths must not diverge.
      codex: [slow('advisor', 'codex', ['DONE', 'MILESTONE: the parser lands.', 'DONE'])],
      claude: [slow('impl', 'claude', ['ack'])],
    }),
    input,
    output: out.stream,
  })
  // `/continue` releases the checkpoint pause; the run then ends on the advisor's own DONE,
  // which is the release proved from the outside. Written only once the pause is on screen --
  // see `untilText`.
  await untilText('the checkpoint pause', out.text, /paused operator_checkpoint/)
  input.write('/continue\n')
  const code = await running
  assert.equal(code, 0)

  const text = out.text()
  // The console says what it armed, at launch, before the first turn -- an operator who typed a
  // flag and saw nothing has no way to know whether it was understood.
  assert.match(text, /checkpoint armed: the run stops when the advisor reports/)
  assert.match(text, /paused operator_checkpoint/)

  // And the RECORD says the checkpoint was reached, which is the whole reason the block survives
  // the release: a run that stopped and was let go must not read like one that never stopped.
  const doc = status(dir)
  const checkpoint = doc['checkpoint'] as {
    milestone: string
    state: string
    generation: number
    signalledAt?: number
    continuedAt?: number
  }
  assert.equal(checkpoint.milestone, 'the parser lands')
  assert.equal(checkpoint.generation, 1)
  assert.equal(checkpoint.state, 'continued')
  // BOTH stamps, and they are different facts: the advisor judged the milestone reached, and
  // then the operator accepted it. A document carrying only one of them cannot say which.
  assert.ok(typeof checkpoint.signalledAt === 'number', 'the advisor\'s signal is stamped')
  assert.ok(typeof checkpoint.continuedAt === 'number', 'and so is the operator accepting it')
  // The outcome carries no complaint: this checkpoint WAS reached.
  const outcome = doc['outcome'] as { reason: string; detail?: string } | undefined
  assert.equal(outcome?.reason, 'done')
  assert.doesNotMatch(outcome?.detail ?? '', /NOT reached/)
})

test('a run that ends without the signal says so in its outcome, rather than reading as finished', async (t) => {
  const dir = repo(t)
  const out = collect()
  // The advisor never signals and the round budget runs out. Every way a run can end has to say
  // this, and the budget is the one an unattended checkpoint most often meets.
  const code = await runSession({
    cwd: dir,
    goal: 'Build the parser.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 2,
    checks: [],
    checkpoint: 'the parser lands',
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['Do a thing.', 'Do another.', 'Do a third.'])],
      claude: [new FakeRotationSession('impl', 'claude', ['ack', 'Did it.', 'Did it.', 'Did it.'])],
    }),
    input: script([]),
    output: out.stream,
  })
  assert.equal(code, 0)

  const doc = status(dir)
  const outcome = doc['outcome'] as { reason: string; detail?: string } | undefined
  // THE SENTENCE, in the outcome itself. Without it this run's record is indistinguishable from
  // one whose checkpoint was reached and released, and the operator who armed one learns nothing.
  assert.match(
    outcome?.detail ?? '',
    /the operator's checkpoint was NOT reached: they armed "the parser lands"/,
    `the outcome must say the checkpoint never fired: ${JSON.stringify(outcome)}`,
  )
  // The reason is NOT rewritten. A run that spent its budget spent its budget; saying otherwise
  // would be the orchestrator overruling the ceiling that actually ended it.
  assert.equal(outcome?.reason, 'budget')
  // And the block is still there, still `armed`, so a reader has the fact as data too.
  assert.deepEqual(
    { milestone: (doc['checkpoint'] as { milestone: string }).milestone, state: (doc['checkpoint'] as { state: string }).state },
    { milestone: 'the parser lands', state: 'armed' },
  )
})

test('an aborted checkpoint pause keeps the signal, and the run makes no not-reached claim', async (t) => {
  const dir = repo(t)
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Build the parser.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 4,
    checks: [],
    checkpoint: 'the parser lands',
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['MILESTONE: the parser lands.', 'DONE'])],
      claude: [slow('impl', 'claude', ['ack'])],
    }),
    input,
    output: out.stream,
  })
  // ABORTED at the checkpoint's own pause. The advisor signalled and the operator ended the run
  // instead of accepting it -- which is not the same decision as continuing, and must not be
  // recorded as one.
  await untilText('the checkpoint pause', out.text, /paused operator_checkpoint/)
  input.write('/abort I want to look at this myself\n')
  const code = await running
  assert.equal(code, 0)

  const doc = status(dir)
  // SIGNALLED, not armed. The advisor DID report the milestone; the operator ended the run
  // rather than accepting it, which is a different thing from the milestone never arriving --
  // and it is the ordinary use of a checkpoint, so getting it wrong misreports the common case.
  assert.equal((doc['checkpoint'] as { state: string }).state, 'signalled', 'an abort accepts nothing')
  assert.ok(typeof (doc['checkpoint'] as { signalledAt?: number }).signalledAt === 'number')
  assert.doesNotMatch(
    (doc['outcome'] as { detail?: string } | undefined)?.detail ?? '',
    /NOT reached/,
    'a signalled milestone WAS reached; only a run that ended with nothing signalled may say otherwise',
  )
})

test('a session with no checkpoint produces the document it always produced', async (t) => {
  const dir = repo(t)
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
  const doc = status(dir)
  // ABSENT, not a record saying nothing. A machine reader asks whether the key is there, and a
  // block claiming `state: 'none'` on every run that never armed one would make the question
  // unanswerable in the direction that matters.
  assert.ok(!('checkpoint' in doc), `a run with no checkpoint must carry no checkpoint key: ${Object.keys(doc)}`)
  assert.doesNotMatch((doc['outcome'] as { detail?: string } | undefined)?.detail ?? '', /checkpoint/)
  // The console says nothing about one either. Matched on the LINES a checkpoint would produce
  // rather than on the bare word: the scratch directory this run works in has `checkpoint` in
  // its name, so a bare /checkpoint/ over the transcript passes or fails on the tempdir prefix
  // and not on the behaviour -- which is a test that reads like it is asserting something.
  assert.doesNotMatch(out.text(), /checkpoint armed/)
  assert.doesNotMatch(out.text(), /checkpoint: /)
})

// ---------------------------------------------------------------------------
// /checkpoint at the console, which is also how an agent operator arms one.
// ---------------------------------------------------------------------------

test('/checkpoint arms a run already going, and its DONE is then refused', async (t) => {
  const dir = repo(t)
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Build the parser.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 5,
    checks: [],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Write the parser.', 'DONE', 'MILESTONE: the parser lands.', 'DONE'])],
      claude: [slow('impl', 'claude', ['ack', 'Wrote it.'])],
    }),
    input,
    output: out.stream,
  })
  // Written into the input stream, which is what `--operator agent` does through a fifo: one
  // line, one command, and no second dispatcher between the two spellings. Armed once the run is
  // demonstrably going, which is the case this covers.
  await untilText('the run to be going', out.text, /advisor → implementer/)
  input.write('/checkpoint the parser lands\n')
  await untilText('the checkpoint pause', out.text, /paused operator_checkpoint/)
  input.write('/continue\n')
  const code = await running
  assert.equal(code, 0)

  const text = out.text()
  assert.match(text, /checkpoint armed: the run stops when the advisor reports/)
  // The advisor's DONE landed AFTER the arming and did not end the run: the pause it reached is
  // the checkpoint's.
  assert.match(text, /paused operator_checkpoint/)
  assert.equal((status(dir)['checkpoint'] as { state: string }).state, 'continued')
})

test('/checkpoint with no milestone is refused, and nothing is armed', async (t) => {
  const dir = repo(t)
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
      // The advisor's DONE must still end the run. That is the assertion: a refused
      // `/checkpoint` has to leave the run exactly as it found it, and a half-armed checkpoint
      // would show up here as a run that would not finish.
      codex: [slow('advisor', 'codex', ['Do it.', 'DONE'])],
      claude: [slow('impl', 'claude', ['ack', 'Did it.'])],
    }),
    input,
    output: out.stream,
  })
  await untilText('the run to be going', out.text, /advisor → implementer/)
  input.write('/checkpoint\n')
  input.write('/checkpoint    \n')
  await untilText('the refusal', out.text, /\/checkpoint needs a milestone/)
  const code = await running
  assert.equal(code, 0)
  assert.ok(!('checkpoint' in status(dir)), 'a refused /checkpoint arms nothing')
  assert.equal((status(dir)['outcome'] as { reason: string }).reason, 'done')
})

test('/checkpoint with no run is refused, and says how to arm one before a run', async (t) => {
  const dir = repo(t)
  const out = collect()
  // No goal, so the console waits and there is no run to stop. A checkpoint accepted here would
  // sit in a field nothing reads: the advisor learns about one from a notice on its next prompt,
  // and with no run there is no prompt.
  const code = await runSession({
    cwd: dir,
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'DONE'])],
      claude: [slow('impl', 'claude', ['ack', 'Did it.'])],
    }),
    input: script(['/checkpoint the parser lands', '/exit']),
    output: out.stream,
  })
  assert.equal(code, 0)
  const text = out.text()
  assert.match(text, /nothing is running/)
  // NAMING THE ALTERNATIVE, which is the part worth pinning: `--checkpoint` is not reachable from
  // this prompt, and an operator refused without being told where to go types it again.
  assert.match(text, /--checkpoint <milestone>/)
})

test('a second /checkpoint replaces the first, and says which it replaced', async (t) => {
  const dir = repo(t)
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Build the parser.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 6,
    checks: [],
    checkpoint: 'the parser lands',
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Write it.', 'MILESTONE: the tests pass.', 'DONE'])],
      claude: [slow('impl', 'claude', ['ack', 'Wrote it.'])],
    }),
    input,
    output: out.stream,
  })
  await untilText('the run to be going', out.text, /advisor → implementer/)
  input.write('/checkpoint the tests pass\n')
  await untilText('the checkpoint pause', out.text, /paused operator_checkpoint/)
  input.write('/continue\n')
  const code = await running
  assert.equal(code, 0)
  // Two armed checkpoints would need an order and a single MILESTONE: reply names neither, so
  // the second displaces the first -- and an operator not told that has a milestone they believe
  // is still armed and is not.
  assert.match(out.text(), /replaced the armed checkpoint: the parser lands/)
  assert.equal((status(dir)['checkpoint'] as { milestone: string }).milestone, 'the tests pass')
})

// ---------------------------------------------------------------------------
// Visibility.
// ---------------------------------------------------------------------------

test('/state reads armed, then signalled, then continued — three states, never one for another', async (t) => {
  const dir = repo(t)
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Build the parser.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 5,
    checks: [],
    checkpoint: 'the parser lands',
    registry: registryOf({
      // A THIRD instruction after the release, and it is what the second /state waits for. The
      // obvious wait -- "the run is going again" -- is satisfied by text the FIRST turn already
      // put on screen, so it returns instantly and the /state races the resume. The marker has
      // to be something that cannot exist until the loop has gone past the checkpoint.
      codex: [slow('advisor', 'codex', ['Write it.', 'MILESTONE: the parser lands.', 'Now the tests.', 'DONE'])],
      claude: [slow('impl', 'claude', ['ack', 'Wrote it.', 'Wrote the tests.'])],
    }),
    input,
    output: out.stream,
  })
  // THE ARMED READING FIRST, before the advisor has signalled anything. Without this the
  // `armed` arm of the renderer is never exercised, and a mutation that deleted it would prove
  // nothing -- which is the same "test that could not fail" this file exists to avoid.
  await untilText('the first instruction to be dispatched', out.text, /Write it\./)
  input.write('/state\n')
  await untilText('the armed reading', out.text, /armed; DONE will not end this run/)

  await untilText('the checkpoint pause', out.text, /paused operator_checkpoint/)
  input.write('/state\n')
  // The SIGNALLED reading: at this pause the advisor has reported and the operator has not
  // answered. Waiting for the `armed` line here would wait forever, which is the point -- the
  // two are different states and the console no longer prints one for the other.
  await untilText('the signalled reading', out.text, /the advisor says this is reached/)
  input.write('/continue\n')
  await untilText('the run to get past the checkpoint', out.text, /Now the tests\./)
  input.write('/state\n')
  await untilText('the continued reading', out.text, /continued; nothing is armed now/)
  const code = await running
  assert.equal(code, 0)
  const text = out.text()
  // BOTH readings, because they answer different questions an operator asks at this command:
  // "will this stop" before, and "did it stop and did I let it go" after. A line that appeared
  // only while armed would leave the second unanswered on exactly the run that had one.
  // THREE readings, and the middle one is the point. At the pause the advisor has signalled and
  // the operator has not answered; before it, nothing had been reported at all. A console that
  // showed the same line for both would tell an operator sitting at a decision point that
  // nothing had happened yet.
  const armedAt = text.indexOf('armed; DONE will not end this run')
  const signalled = text.indexOf('the advisor says this is reached')
  const continued = text.indexOf('continued; nothing is armed now')
  assert.ok(armedAt >= 0, `/state must name an armed checkpoint before anything signals it: ${text}`)
  assert.ok(signalled > armedAt, `/state must say the advisor has signalled: ${text}`)
  assert.ok(continued > signalled, `/state must say so once it is spent: ${text}`)
})

test('--checkpoint arms the FIRST run only, not every run the console later starts', async (t) => {
  const dir = repo(t)
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    // No goal, so BOTH runs are started by typing one -- which is the shape that exposes this.
    // A console outlives its runs, and a flag typed once at launch is a statement about the run
    // it launched rather than a standing policy over everything the operator does afterwards.
    lead: 'codex',
    implementer: 'claude',
    rounds: 4,
    checks: [],
    checkpoint: 'the parser lands',
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['MILESTONE: the parser lands.', 'DONE'])],
      claude: [slow('impl', 'claude', ['ack'])],
    }),
    input,
    output: out.stream,
  })
  await untilText('the console to be up', out.text, /type one to start/)
  input.write('Build the parser.\n')
  await untilText('the checkpoint pause', out.text, /paused operator_checkpoint/)
  input.write('/continue\n')
  const code = await running
  assert.equal(code, 0)
  // ARMED EXACTLY ONCE. The console announces an arming when it makes one, so a second
  // announcement is a second arming -- and a second run silently holding the first run's
  // milestone would refuse its DONE for work that milestone was never about.
  const armings = out.text().match(/checkpoint armed: the run stops/g) ?? []
  assert.equal(armings.length, 1, `the launch flag arms one run: ${armings.length} armings`)
  void t
})

/**
 * `main([...])` for the argv-level cases, with stdin already ended.
 *
 * The refusals below happen ABOVE anything that starts a run, so nothing needs to be scripted --
 * and the ended stdin means a regression that got past the refusal finishes instead of hanging
 * the suite, which is how `src/relay/goalFile.test.ts` drives the same surface.
 */
async function cli(dir: string, argv: string[]): Promise<{ code: number; text: string }> {
  const said: string[] = []
  let written = ''
  const beforeCwd = process.cwd()
  const [log, error] = [console.log, console.error]
  console.log = (...a: unknown[]) => void said.push(a.map(String).join(' '))
  console.error = (...a: unknown[]) => void said.push(a.map(String).join(' '))
  try {
    process.chdir(dir)
    const code = await main([...argv], {
      registry: registryOf({
        codex: [new FakeRotationSession('advisor', 'codex', ['DONE'])],
        claude: [new FakeRotationSession('impl', 'claude', ['ack'])],
      }),
      input: (() => {
        const s = new PassThrough()
        s.end()
        return s
      })(),
      output: new Writable({
        write(chunk, _e, cb) {
          written += String(chunk)
          cb()
        },
      }),
    })
    return { code, text: `${said.join('\n')}\n${written}` }
  } finally {
    process.chdir(beforeCwd)
    console.log = log
    console.error = error
  }
}

test('session --checkpoint with an empty value is refused, and nothing starts', async (t) => {
  const dir = repo(t)
  // `--checkpoint ""` typed on purpose. `flagReader` cannot catch this one -- the value is
  // present, it is just empty -- so the refusal has to be the command's own, and it has to
  // happen before a run is started: a checkpoint with no milestone would brief the advisor with
  // a blank line and then stop the run at something nobody could state.
  const empty = await cli(dir, ['session', 'Build the parser.', '--checkpoint', '', '--dry-run'])
  assert.equal(empty.code, 2, 'an empty milestone is refused')
  assert.match(empty.text, /--checkpoint needs a milestone/)
})

test('session --checkpoint without a value is refused by the shared reader, naming the flag', async (t) => {
  const dir = repo(t)
  // The OTHER shape, and a different mechanism: the value went missing entirely, which
  // `flagReader` refuses over the whole argv before the command reads anything. Both are pinned
  // because they are refused in different places and only one of them is this file's code.
  const bare = await cli(dir, ['session', 'Build the parser.', '--checkpoint', '--dry-run'])
  assert.equal(bare.code, 1, 'session must refuse --checkpoint without a value')
  assert.match(bare.text, /--checkpoint was given without a value/)
  // And it is a flag the command TAKES: the refusal is about the value, not about a flag nobody
  // declared, which is what an undeclared flag would produce instead (#172).
  assert.doesNotMatch(bare.text, /--checkpoint is not a flag this command takes/)
})

test('relay refuses --checkpoint outright, because it cannot hold the pause one arms', async (t) => {
  const dir = repo(t)
  // The declared divergence, asserted as behaviour rather than only as a DECLARED entry. relay
  // escalates and ENDS the run at every pause, so a checkpoint there would stop the run it was
  // meant to interrupt with nobody able to release it. Refused by name, as any undeclared flag
  // is, rather than accepted and ignored (#172).
  const ran = await cli(dir, ['relay', 'Build the parser.', '--checkpoint', 'the parser lands', '--dry-run'])
  assert.notEqual(ran.code, 0, 'relay must not accept --checkpoint')
  assert.match(ran.text, /--checkpoint/)
})

test('the help describes the checkpoint as one-shot and as refusing DONE', async (t) => {
  // Asserted on the string the console actually writes, for the reason `/rotate [reason]` is:
  // help that documents a rule the console does not follow is worse than no help, and the two
  // properties an operator would otherwise be surprised by are exactly these.
  assert.match(HELP, /\/checkpoint <milestone>/)
  assert.match(HELP, /DONE will not end the run/)
  assert.match(HELP, /One shot/)
  void t
})
