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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolveSession } from '../workspace/sessionRecord.ts'
import { acquire as acquireLock, lockPath } from '../workspace/sessionLock.ts'
import { formatSessionJson } from '../workspace/sessionView.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import test from 'node:test'
import type { Verdict } from '../contract/outcome.ts'
import type { ChildLiveness } from '../outcomes/liveness.ts'
import { IDLE_CPU_PERCENT } from '../outcomes/liveness.ts'
import { NO_DEADLINE_CLOCKS, type DeadlineSupport } from '../registry/types.ts'
import type { AgentSession } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { HELP, runSession, seatsToSampleAtPause, withHeartbeat } from './session.ts'
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
  onLaunch?: (
    agent: string,
    args: string[] | undefined,
    ctx?: { watchdogMs?: number | undefined; idleMs?: number | undefined },
  ) => void,
  /**
   * What each agent's adapter DECLARES, where a test needs the distinction.
   *
   * Defaults to `NO_DEADLINE_CLOCKS` below, which is the honest answer for an in-memory
   * double and what every existing caller relies on. Overridden only by the tests that need
   * a seat which HAS a clock beside one that does not -- the mixed run is the case
   * `--silence-timeout` is decided by, and it cannot be built out of doubles that all
   * declare the same thing.
   */
  deadlines?: Record<string, DeadlineSupport>,
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
      // An in-memory double: no child process, so no clock of either kind, unless this test
      // declared otherwise.
      deadlines: deadlines?.[agent] ?? NO_DEADLINE_CLOCKS,
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

/**
 * The rule these two helpers exist to enforce (#109).
 *
 *   **Content reads the record. Presentation pins the width. Rendered output never stands in
 *   for content.**
 *
 * `markdown()` and `summaryLine()` put every message through `wrap()`, which splits on `/\s+/`
 * and rejoins at the terminal width. So the console is a LOSSY view of what was sent: runs of
 * spaces collapse, line breaks vanish into the flow, and a phrase can be broken across a row
 * mid-word. Three consequences, each of which has produced a test that could not fail:
 *
 *   1. An assertion that greps the console for a message's wording cannot see a whitespace or
 *      line-break change in that message. Measured, not assumed: a routed message altered from
 *      `Blank lines survive.` to `Blank   lines   survive.` left every console assertion about
 *      it green. Use `routed()`.
 *   2. A NEGATIVE assertion against the console -- "this phrase was not printed" -- is satisfied
 *      whenever a wrap happens to fall inside the phrase. Assert the ABSENCE OF A RECORD instead.
 *   3. A claim about presentation is only meaningful at a known width, so `collect()` pins one
 *      rather than inheriting whatever the stream happens to report.
 *
 * A console assertion is still the right tool for a console-only notice -- a hint, a refusal, a
 * banner -- because no record carries those. Say so where you write one, so the next reader can
 * tell a deliberate rendering claim from a content claim that went to the wrong place.
 */

/**
 * The width every test here renders at.
 *
 * Pinned rather than inherited. `runSession` takes `Math.min(100, columns ?? 100)`, so an
 * unadorned stream already produced 100 -- but by accident, invisibly, and identically whether
 * or not anyone had thought about it. Written down, a rendering assertion says which width it
 * holds at, and a change to the default becomes a visible edit here instead of a silent shift
 * under every assertion in the file.
 */
const CONSOLE_COLUMNS = 100

/** The console as a reader sees it: rendered, wrapped, and lossy. Presentation claims only. */
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
  return {
    stream,
    text: () => chunks.join(''),
  }
}

/**
 * A message as it was ROUTED, off the run log, rather than as the console drew it.
 *
 * The record, in the sense of the rule above: verbatim, addressed, and unwrapped. Every
 * assertion about what a message SAID, or about who it went to, has to come from here.
 */
function routed(dir: string, needle: string): RoutedRecord | undefined {
  return routedAll(dir).find((e) => typeof e.text === 'string' && e.text.includes(needle))
}

interface RoutedRecord {
  readonly text: string
  readonly from: string
  readonly fromRank: string
  readonly to: readonly string[]
  readonly kind: string
}

/** Every routed record, in order. For counting messages, which the console cannot be asked. */
function routedAll(dir: string): RoutedRecord[] {
  const runs = join(dir, '.conclave', 'runs')
  return readdirSync(runs)
    .flatMap((f) => readFileSync(join(runs, f), 'utf8').split('\n'))
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RoutedRecord)
}

/**
 * The observation stream a stranger reads: pauses, resumes, supersessions, the run's end.
 *
 * The other half of the record. `routed()` answers what was SAID; this answers what HAPPENED,
 * and it is where a pause's reason, evidence and options live as fields rather than as prose.
 */
function events(dir: string): Record<string, any>[] {
  const found = resolveSession(dir)
  if (!('session' in found)) return []
  return readFileSync(found.session.status.eventsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>)
}


/**
 * Drive the child to be OBSERVED starting a turn, and wait until that observation has landed.
 *
 * The fixture the #66 guard tests need. A withdrawal on its own no longer refuses -- it is a
 * deleted record, not an observation, and `activeTurn` marks the turn it reopens as `withdrawn`
 * so the console can tell the two apart. What still refuses is the child SEEN beginning a turn,
 * which clears that mark.
 *
 * Waits on the SESSION RECORD rather than on console text. Not the same as waiting for the
 * console to have drawn anything -- it has not necessarily -- but it is the stronger wait for
 * what this is for: the relay appends to the participant's events before it broadcasts, and the
 * recorder appends synchronously on that broadcast, so an entry in the file means the list the
 * guard folds over already holds the `turn_start`.
 */
async function observedTurn(impl: FakeRotationSession, dir: string, seat = 'implementer'): Promise<void> {
  const seen = (): number =>
    events(dir).filter((e) => e.type === 'activity' && e.participant === seat && e.event?.type === 'turn_start')
      .length
  const before = seen()
  impl.startTurnLate()
  await untilValue(
    `${seat}'s turn start to reach the session record`,
    () => (seen() > before ? true : undefined),
    () => `still ${before} turn_start event(s) for ${seat}`,
  )
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
  // CONTENT off the record: the run ended, and on what. The `=== run ended: done` line is drawn
  // through `summaryLine`, which wraps — so a console grep for it is a claim about the render
  // that reads like a claim about the outcome.
  const end = events(dir).at(-1)
  assert.equal(end?.['type'], 'run_end')
  assert.equal(end?.['reason'], 'done')
  // PRESENTATION, at CONSOLE_COLUMNS: the outcome reaches the operator as a summary line.
  assert.match(out.text(), /=== run ended: done/)
  // Console-only advice — nothing records that it was given. Without checks, rotation is refused
  // rather than done unverified, and it says so.
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
  // CONTENT off the record. `untilText` above waits on `● paused rotation_candidate`, and that
  // string CONTAINS both `paused` and `rotation_candidate` — so console greps for those two words
  // could not fail here, and mutating either killed the wait rather than the assertion. The pause
  // event carries the same facts as fields, where a change to one of them is visible.
  const paused = events(dir).find((e) => e.type === 'pause')
  assert.ok(paused, 'the pause must reach the event stream')
  assert.equal(paused['pause'].reason, 'rotation_candidate')
  assert.ok(
    (paused['pause'].evidence as string[]).some((e) => e.includes('compaction generation rose 0 → 1')),
    `the evidence the pause rests on, by name: ${JSON.stringify(paused['pause'].evidence)}`,
  )
  assert.ok((paused['pause'].options as string[]).includes('continue'), 'the options are offered')
  // PRESENTATION, at CONSOLE_COLUMNS: `/state` answers from the live handle rather than a local
  // copy. Asserted on the console because `/state` IS console-only — no record carries a reply to
  // a REPL command — and the claim is about what the operator was shown.
  assert.match(text, /run: paused \(rotation_candidate\)/, '/state reports the handle, not a local copy')
  // CONTENT: the run ended, and on what.
  const end = events(dir).at(-1)
  assert.equal(end?.['type'], 'run_end')
  assert.equal(end?.['reason'], 'done')
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

  // PRESENTATION, at CONSOLE_COLUMNS. Narration is streamed to the console and never routed —
  // `routed()` finds nothing for it — so the console is the only place it exists, and these are
  // rendering claims by necessity rather than content claims in the wrong place. Anchored to the
  // rows BETWEEN the two headings instead of matched anywhere in the buffer, so "it was narrated"
  // cannot be satisfied by the report that follows.
  const rows = text.split('\n')
  const narratedAt = rows.findIndex((l) => /● implementer → you/.test(l))
  const reportedAt = rows.findIndex((l) => /● implementer → advisor/.test(l))
  assert.ok(narratedAt >= 0, 'narration is addressed to the human')
  assert.ok(reportedAt > narratedAt, 'and the report follows it, addressed to the advisor')
  const narrated = rows.slice(narratedAt, reportedAt).join('\n')
  assert.match(narrated, /finding the relevant code/)
  assert.match(narrated, /Now the guard report shape/)
  assert.equal(
    text.split('Done. guard --json is in.').length - 1,
    1,
    'the closing message is drawn once — not streamed and then repeated as the routed copy',
  )

  // CONTENT off the record: the report as it was sent, verbatim and addressed. The console
  // cannot answer this — it reflows what it draws — and a grep for the wording passed under a
  // whitespace change to the very message it claims to pin.
  const report = routed(dir, 'guard --json is in')
  assert.ok(report, 'the closing report must be in the run log')
  assert.equal(report.text, 'Done. guard --json is in.')
  assert.ok(report.to.includes('advisor'), 'and it went to the advisor')
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

test('the banner says what bounds the run, between the cwd and the rotation line', async () => {
  // #119: a run ended at an advisor budget of 8 with four files of uncommitted work in the
  // tree, because `--max-turns` was passed to raise it and `--rounds` is what raises it. The
  // banner already prints the seats, the cwd and the rotation checks; the bound was the one
  // thing it did not say, and it is the thing that decides when the run stops.
  const dir = repo()
  const out = collect()
  await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    // The two the issue is about, together: the one that bounds the advisor and the one an
    // operator reaches for believing it does.
    ceilings: { maxTurns: 40 },
    checks: [],
    version: '9.9.9',
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])],
      claude: [new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])],
    }),
    input: script([]),
    output: out.stream,
  })
  const text = out.text()
  const ceilings = text.split('\n').find((l) => l.includes('ceilings:'))
  assert.ok(ceilings, 'the banner must carry a ceilings line')
  // The value the run was actually given, not a constant: `--rounds 3` here, and the
  // `--max-turns 40` that does not raise it sitting next to it where the mismatch is visible.
  assert.match(ceilings, /--rounds 3\b/)
  assert.match(ceilings, /--max-turns 40\b/)
  assert.match(ceilings, /--max-minutes none/)

  // IN the banner, not appended after it. A line that drifted below the rule would be read
  // after the operator has already stopped reading -- the banner is three lines they take in
  // before the run starts, which is the whole reason this belongs there.
  const cwdAt = text.indexOf(dir)
  const ceilingsAt = text.indexOf('ceilings:')
  const rotationAt = text.indexOf('rotation:')
  assert.ok(cwdAt > 0 && ceilingsAt > cwdAt, 'the ceilings line comes after the cwd')
  assert.ok(rotationAt > ceilingsAt, 'and before the rotation line')
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
  //
  // ## Why it runs in a fixture repository rather than in this checkout
  //
  // The BINARY is this checkout's, by absolute path; the working directory is a scratch repo.
  // Run in the checkout itself, the session lock refuses to start while participants are live
  // (`src/workspace/sessionLock.ts`) -- and this project is developed BY conclave sessions in
  // this very repository, so a legitimate live session made the CLI exit before it ever looked
  // at `--lead`, and the test failed reporting a parsing defect that did not exist. The lock is
  // correct and its ordering is deliberately untouched: a refusal that arrives before agent
  // resolution is the point of it. What was wrong was asserting on argument parsing from a
  // directory whose state is someone else's business.
  const { execFileSync } = await import('node:child_process')
  const root = join(import.meta.dirname, '..', '..')
  let stderr = ''
  let stdout = ''
  try {
    execFileSync(process.execPath, [join(root, 'bin/conclave.ts'), 'session', '--lead', 'nope'], {
      cwd: repo(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })
  } catch (err) {
    stderr = (err as { stderr?: string }).stderr ?? ''
    stdout = (err as { stdout?: string }).stdout ?? ''
  }
  // `stdout` in the message, not just `stderr`: the failure this comment is about printed its
  // refusal on stdout and left stderr empty, so the report said only "stderr was:" and nothing
  // after it -- which is the least useful thing a failing assertion can say.
  assert.match(
    stderr,
    /unknown agent 'nope'/,
    `--lead was not parsed as a flag; stderr was:\n${stderr}\nstdout was:\n${stdout}`,
  )
})

/**
 * A scratch project whose `.conclave/session.lock` is live and belongs to THIS process.
 *
 * `read()` in sessionLock.ts decides liveness with `process.kill(pid, 0)` and `acquire()` writes
 * `process.pid`, so the test runner IS the live session as far as any CLI shelled out below is
 * concerned. That is the whole reason the state is manufactured rather than produced: the
 * condition under test is the lock, and a genuine live session would have to bring a genuine
 * pair of agent CLIs with it — real processes, real quota — to assert something about a JSON
 * file and one `kill(pid, 0)`.
 *
 * The participants named in it are the ones #130 was reported against, so a refusal quoted in a
 * failure message here reads the same as the one the issue quotes.
 */
function lockedRepo(): string {
  const dir = repo()
  acquireLock(dir, [
    { id: 'advisor', agent: 'codex' },
    { id: 'implementer', agent: 'claude' },
  ])
  return dir
}

/** The real binary by absolute path, in a scratch project — never in this checkout. */
function runCli(cwd: string, argv: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const root = join(import.meta.dirname, '..', '..')
  const r = spawnSync(process.execPath, [join(root, 'bin/conclave.ts'), ...argv], {
    cwd,
    encoding: 'utf8',
    // stdin ignored rather than inherited: `session` without a goal opens a console and reads
    // lines, and a test that handed it the runner's stdin would hang on a change that stopped
    // refusing.
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

test('a live lock does not preempt an unknown agent name (#130)', () => {
  // The open half of #130. `--lead nope` is a PURE VALIDATION invocation: the spelling is wrong
  // whatever else is happening in the tree, and no run is going to start either way — so the
  // lock has nothing to protect there, and answering the operator's actual mistake is strictly
  // more useful than reporting somebody else's live participants.
  //
  // The isolation half is already fixed (see the test above, which now shells out into a temp
  // directory), so this is not about the suite being runnable. It is about the CLI's answer to
  // an operator who typed a name that does not exist while a session runs in their checkout:
  // today they are told about the session and not about the name.
  const r = runCli(lockedRepo(), ['session', '--lead', 'nope'])
  const said = `${r.stdout}${r.stderr}`
  assert.equal(r.status, 1, `an unresolvable agent must be refused; output was:\n${said}`)
  // Combined rather than stderr alone, deliberately. The existing test above pins the stream
  // because that is where `main`'s catch writes; a validation refusal raised earlier in the
  // `session` block would legitimately be a `console.error` OR a console line, and which one it
  // is is not what this test is about.
  assert.match(said, /unknown agent 'nope'/, `the name is what was wrong; output was:\n${said}`)
  assert.ok(
    !/participants are live/.test(said),
    `the live session is not the operator's problem here; output was:\n${said}`,
  )
})

test('every seat is checked before the lock, not just the advisor (#130)', () => {
  // `--lead` is the spelling the issue was reported against, and pinning only that would leave
  // the fix half-applied in exactly the way this codebase keeps rediscovering: a capability
  // wired into one seat and not its neighbours. Every seat a run can name is resolved together
  // — the advisor, the default implementer, each entry of a seat LIST, and the opt-in reviewer.
  //
  // The seat list matters most of the three. `--implementers "claude,nope"` is valid up to its
  // last entry, so it is the case where a check that stopped after the first seat would look
  // like it worked.
  for (const argv of [
    ['session', 'a goal', '--implementer', 'nope'],
    ['session', 'a goal', '--implementers', 'claude,nope'],
    ['session', 'a goal', '--reviewer', 'nope'],
  ]) {
    const r = runCli(lockedRepo(), argv)
    const said = `${r.stdout}${r.stderr}`
    assert.equal(r.status, 1, `${argv.join(' ')}: output was:\n${said}`)
    assert.match(said, /unknown agent 'nope'/, `${argv.join(' ')}: output was:\n${said}`)
    assert.ok(!/participants are live/.test(said), `${argv.join(' ')}: output was:\n${said}`)
  }
})

test('a run-starting session is still refused by a live lock (#130)', () => {
  // The control, and the reason the two tests above are safe to want. Whatever moves ahead of
  // the lock check, an invocation that WOULD start participants must still be stopped by it —
  // otherwise the fix for a validation wart has quietly disabled the guard that keeps two runs
  // out of one tree, which is the failure sessionLock.ts exists for.
  //
  // Nothing here is stubbed, so this is also the test that would spawn real agent CLIs if the
  // refusal ever stopped happening. That is the honest shape of the assertion — the refusal is
  // the only thing standing between this argv and two live children — and the timeout in `runCli`
  // bounds it.
  const r = runCli(lockedRepo(), ['session', 'Keep the work moving.'])
  const said = `${r.stdout}${r.stderr}`
  assert.equal(r.status, 1, `a live lock refuses a run; output was:\n${said}`)
  assert.match(said, /refusing to start/, `output was:\n${said}`)
  assert.match(said, /participants are live/, `and says who is live; output was:\n${said}`)
  assert.ok(!/joined as/.test(said), `no participant may start; output was:\n${said}`)
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
  // PRESENTATION. The queue confirmation is a console-only notice — nothing records that the
  // operator was told — so it is asserted where it is drawn, at CONSOLE_COLUMNS.
  assert.match(out.text(), /queued for everyone/)
  // ...and the delivered message is drawn as a SPEAKER BLOCK rather than as a grey log line,
  // which is the whole point of this test and is a claim about rendering.
  assert.match(out.text(), /● you → /)

  // CONTENT off the record: what was delivered, verbatim and to whom. Asserted here rather than
  // by grepping the console, which normalises whitespace on the way to the screen and so passes
  // whether or not the message survived intact.
  const sent = routed(dir, 'also check the error path')
  assert.ok(sent, 'the message must be in the run log')
  assert.equal(sent.text, 'also check the error path')
  assert.deepEqual([...sent.to].sort(), ['advisor', 'implementer'], 'delivered to everyone')
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
  selfSamples: [12.5, 15.0, 11.0],
  busiestDescendant: [],
  descendants: 0,
  workingDescendants: 0,
  idle: false,
  measuredAt: Date.UTC(2026, 7, 13, 21, 4, 11),
}
const IDLE_LIVENESS: ChildLiveness = {
  pid: 1,
  alive: true,
  samples: [0.0, 0.1, 0.0],
  selfSamples: [0.0, 0.1, 0.0],
  busiestDescendant: [],
  descendants: 0,
  workingDescendants: 0,
  idle: true,
  measuredAt: Date.UTC(2026, 7, 13, 21, 4, 11),
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
  selfSamples: [0.3, 0.2, 7.2],
  busiestDescendant: [],
  descendants: 0,
  workingDescendants: 0,
  idle: false,
  measuredAt: Date.UTC(2026, 7, 13, 21, 4, 11),
}
/**
 * The reading #124 was refused on, verbatim: `cpu 0.1%, 3.6%, 0.8%`.
 *
 * The same shape as the #83 reading above and a different report, kept separate because the
 * issue is about THESE numbers — a child that was idle throughout, held paused for over an hour
 * on one 3.6% blip in a three-sample window.
 */
const BLIP_LIVENESS: ChildLiveness = {
  pid: 1,
  alive: true,
  samples: [0.1, 3.6, 0.8],
  selfSamples: [0.1, 3.6, 0.8],
  busiestDescendant: [],
  descendants: 0,
  workingDescendants: 0,
  idle: false,
  measuredAt: Date.UTC(2026, 7, 13, 21, 4, 11),
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

  // CONTENT off the record: which verdict was withdrawn, and what the note says about what
  // replaced it. The note is the record's own prose, so its wording belongs here rather than on
  // the console, where it arrives reflowed and where `timed_out` appears more than once.
  const superseded = events(dir)
    .filter((e) => e.type === 'supersede')
    .at(-1)
  assert.ok(superseded, 'the supersession must reach the event stream')
  // `superseded.verdict` is the REPLACEMENT — the verdict that now stands. The withdrawn one is
  // named in the note, which is why both are asserted.
  assert.equal(superseded['pause'].superseded.verdict.outcome, 'completed', 'a terminal verdict now stands')
  const note = superseded['pause'].superseded.note as string
  assert.match(note, /timed_out verdict .* was withdrawn/, 'the verdict the pause rested on, by name')
  assert.match(note, /replaced with completed/, 'the replacement is terminal and the note says the turn ended')
  assert.match(note, /still paused/, 'surfaced, not decided')

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

test('the console prints the targeting reading, and on truncated-only evidence it is INCONCLUSIVE', async (t) => {
  const dir = repo()
  // The CONSOLE renderer of the shared targeting conclusion (#79). Both front-ends write
  // `relay.targetingSummary()` and nothing else, and this is where that string is pinned as
  // something an operator actually sees.
  //
  // Truncated-only evidence, because that is the reading the surfaces used to disagree about:
  // the advisor's one instructing turn wrote `@seat` and then did not complete, so `ELICITED`
  // would certify a briefing on text nobody read to the end and `NONE` would condemn one on the
  // strength of a fragment. An operator told either at the end of a run acts on it.
  // Two seats mean linked worktrees cut from a COMMIT, so the console refuses to start with
  // anything uncommitted. The hook files it installs land untracked in this fixture, so they are
  // ignored and committed before the run rather than tripping a guard this test is not about.
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n.claude/\n.codex/\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'ignore agent hook files'], { cwd: dir })
  // Addressed by the ids the console constructs for a named seat list: `implementer` and
  // `implementer-2`.
  const advisor = slow('advisor', 'codex', ['@seat implementer-2: Sweep the docs.', 'DONE', 'DONE', 'DONE'], 200)
  advisor.endTurn = { index: 0, verdict: TIMED_OUT }
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'alpha',
    // Two seats, because targeting is silent at N=1 by design: there is no second seat to
    // address, the advisor is never taught the syntax, and no line is printed at all.
    implementers: [
      { agent: 'alpha', args: [] },
      { agent: 'beta', args: [] },
    ],
    rounds: 6,
    checks: [],
    registry: registryOf({
      codex: [advisor],
      alpha: [slow('alpha', 'alpha', ['ack', 'Did it.', 'Did it.', 'NONE'], 50)],
      beta: [slow('beta', 'beta', ['ack', 'Did it.', 'Did it.', 'NONE'], 50)],
    }),
    input,
    output: out.stream,
  })
  t.after(async () => {
    input.end()
    await running
  })

  await untilText('the pause on the advisor turn', out.text, /paused/)
  input.write('/continue\n')
  assert.equal(await running, 0)

  // PRESENTATION, at CONSOLE_COLUMNS: this is a console-only line -- no record carries the
  // summary -- so the claim belongs here. The word is short enough that no wrap can fall inside
  // it, which is what makes the negative assertions below meaningful at this width.
  const text = out.text()
  assert.match(text, /advisor targeting: INCONCLUSIVE/, text.slice(-2000))
  assert.doesNotMatch(text, /the briefing ELICITED/, 'text nobody read to the end does not certify a briefing')
  assert.doesNotMatch(text, /NONE of/, 'and a fragment beginning @seat is not an advisor that never wrote it')
  assert.doesNotMatch(text, /IS reaching the advisor/, 'which is the same certification in other clothes')
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

  // CONTENT off the record: which verdict was withdrawn and what replaced it. `timed_out` appears
  // TWICE on the drawn line — once as the withdrawn verdict and once in `replaced with another
  // timed_out` — so a console grep for it could not be falsified on its own; killing either
  // occurrence left the other satisfying it.
  const superseded = events(dir)
    .filter((e) => e.type === 'supersede')
    .at(-1)
  assert.ok(superseded, 'the supersession must reach the event stream')
  // `superseded.verdict` is the REPLACEMENT — here, another timeout on the same running turn.
  assert.equal(superseded['pause'].superseded.verdict.outcome, 'timed_out', 'the replacement is another timeout')
  // The note IS the record's own prose, so its wording is asserted HERE and not on the console,
  // where the same words arrive reflowed and `timed_out` appears twice on one line.
  const note = superseded['pause'].superseded.note as string
  assert.match(note, /timed_out verdict .* was withdrawn/, 'the verdict the pause rested on, by name')
  assert.match(note, /replaced with another timed_out/, 'and the replacement is named as another timeout')
  assert.doesNotMatch(note, /turn ended/, 'and a still-running turn is not described as ended')

  // PRESENTATION, at CONSOLE_COLUMNS: it is MARKED, not merely printed, and it must not say the
  // turn ended — the line has to fit on one drawn row for the `~` prefix to mean anything.
  const text = out.text()
  const marked = text.split('\n').filter((l) => /^\s*~ /.test(l))
  const replacement = marked.find((l) => /withdrawn and replaced/.test(l))
  assert.ok(replacement, `the supersession must carry the ~ marker:\n${text.slice(-1200)}`)
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
test('both help surfaces say what /rotate does with the reason you type (#75)', () => {
  // Neither help string was asserted by anything before this. That is how `/rotate [reason]` came
  // to be documented as an optional, unconditional argument while it was neither: a reason is
  // REQUIRED for an operator-initiated rotation and is REFUSED, and at a rotation candidate the
  // one you type is deliberately not recorded because accepting a candidate is agreement and the
  // record has to carry the proxy's words.
  //
  // Both of those surprise an operator in the moment they are deciding something, which is the
  // worst time to be surprised -- and the console's own notice is only a remedy for the second of
  // them, and only once you have already typed it.
  //
  // Asserted on the console's HELP verbatim and on the CLI's real stdout, because they are two
  // separately-maintained strings describing one behaviour, and the pair drifting is likelier than
  // either being wrong alone.
  assert.match(HELP, /\/rotate/)
  assert.match(HELP, /REQUIRED/, 'the console help must say a reason is required')
  assert.match(HELP, /rotation candidate/, 'and that the candidate case is different')
  assert.match(HELP, /PROXY'S words|proxy's own words|proxy's words/i)

  const root = join(import.meta.dirname, '..', '..')
  const stdout = execFileSync(process.execPath, [join(root, 'bin/conclave.ts'), 'session', '--help'], {
    cwd: mkdtempSync(join(tmpdir(), 'conclave-help-')),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  })
  assert.match(stdout, /REQUIRES a reason/, 'the CLI help must say a reason is required')
  assert.match(stdout, /rotation candidate/)
  assert.match(stdout, /proxy's own\s+words/, 'and whose words the record keeps')
})

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
 * One answer is one message, however many lines it took to write (#102).
 *
 * The reported case, and the worst one: an agent operator answering an
 * `implementer_unanswered` pause, which is the pause whose answer is longest because the
 * seat stopped precisely to ask something that needed reasoning about. Seven physical lines
 * became seven messages. Three separate things went wrong with that, and only the first is
 * the one the title mentions:
 *
 *   - `messages` in `status --json` moved seven times, and that number is what an external
 *     observer polls to tell whether a run is progressing. One answer read as activity.
 *   - only the FIRST line carried the `>implementer` prefix, so the remaining six lines of a
 *     deliberately restricted answer were routed to both seats.
 *   - a bare line at a pause resumes the run, so one of the middle lines resumed it and the
 *     tail of the answer arrived after the implementer had already acted on the fragment.
 *
 * All three are asserted below, because a fix that only merged the lines would still leave
 * the routing and the resume keyed to whichever fragment happened to arrive first.
 */
test('a <<EOF block written to a paused session is one message, addressed once', async () => {
  const dir = repo()
  const out = collect()
  const input = new PassThrough() // held open, as the FIFO and its background `sleep` do
  const asked = 'Started.\n\nUNANSWERED: Should the new framing be opt-in or the default?'
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 8,
    checks: [],
    operator: 'agent',
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'], 200)],
      claude: [slow('impl', 'claude', [asked, asked, asked, 'Did it.'], 200)],
    }),
    input,
    output: out.stream,
  })

  const until = async (pred: (s: ReturnType<typeof resolveSession>) => boolean, ms = 20_000) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      const f = resolveSession(dir)
      if (pred(f)) return f
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`timed out; console said:\n${out.text().slice(-1500)}`)
  }

  const paused = await until(
    (f) => 'session' in f && f.session.status.pause?.reason === 'implementer_unanswered',
  )
  assert.ok('session' in paused)
  const before = paused.session.status.messages

  // Written as ONE write of several lines, which is what `printf ... > "$fifo"` does. The
  // blank lines are load-bearing: they are the paragraph breaks that made the operator want
  // more than one line in the first place.
  input.write(
    [
      '>implementer <<EOF',
      'Answered: make it opt-in.',
      '',
      'Every existing driver writes bare lines today, so a change of default',
      'would silently reinterpret input that is already correct.',
      '',
      'One correction: the reason is implementer_unanswered, not turn_incomplete.',
      'EOF',
      '',
    ].join('\n'),
  )

  await untilText('the block to be delivered', out.text, /Answered: make it opt-in/)
  const after = await until((f) => 'session' in f && f.session.status.messages > before)
  assert.ok('session' in after)
  assert.equal(
    after.session.status.messages - before,
    1,
    'six lines of prose are one message, not six — this is the counter an observer polls',
  )

  // CONTENT off the record: the whole answer as it was SENT, paragraph breaks and all, and the
  // seat it was addressed to. The console flattens the breaks and collapses the spacing, so a
  // grep of `out.text()` for this wording holds whether or not the block survived intact — and
  // the addressee assertions that used to sit here could not be falsified on their own, because
  // every way to make `● you → advisor, implementer` appear also broke the counter below.
  const answer = routed(dir, 'Answered: make it opt-in')
  assert.ok(answer, 'the answer must be in the run log')
  assert.equal(
    answer.text,
    [
      'Answered: make it opt-in.',
      '',
      'Every existing driver writes bare lines today, so a change of default',
      'would silently reinterpret input that is already correct.',
      '',
      'One correction: the reason is implementer_unanswered, not turn_incomplete.',
    ].join('\n'),
    'six lines of prose, verbatim, as one message',
  )
  // Addressed ONCE and honoured for all of it. `>implementer` appeared on the opening line
  // only, and the rest of a restricted answer must not fall back to everyone.
  assert.deepEqual([...answer.to], ['implementer'], 'restricted to the seat it was addressed to')

  // PRESENTATION, at CONSOLE_COLUMNS. From the pause onward, so the goal — which is itself a
  // `you →` block — is not counted.
  const text = out.text()
  const since = text.slice(text.indexOf('● paused implementer_unanswered'))
  assert.equal(
    since.match(/● you → /g)?.length,
    1,
    'one speaker block for one answer; every extra one is a fragment',
  )

  input.end()
  await running.catch(() => {})
})

test('input that ends inside an unterminated block says so, and delivers nothing', async () => {
  // The one thing that cannot be done honestly here: stdin closing is what ends the
  // session, so a flushed half-message would be racing teardown and whether any of it
  // reached a seat would come down to timing. Naming what was buffered is always true.
  const dir = repo()
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    operator: 'agent',
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'DONE'], 150)],
      claude: [slow('impl', 'claude', ['ack', 'Did it.'], 150)],
    }),
    input,
    output: out.stream,
  })

  input.write('>implementer <<EOF\nhalf an answer\nand no terminator\n')
  input.end()
  await running.catch(() => {})

  // PRESENTATION, at CONSOLE_COLUMNS. The diagnostic is console-only — nothing records that the
  // operator was warned — so it is asserted where it is drawn.
  const text = out.text()
  assert.match(text, /input ended inside <<EOF/)
  assert.match(text, /2 buffered line\(s\) were NOT delivered/)
  assert.match(text, /a line reading exactly EOF/, 'it says what would have closed it')

  // CONTENT, and specifically an ABSENCE — so it is the RECORD that must be empty, not the
  // screen. `assert.doesNotMatch(text, /half an answer/)` was the version this replaces, and it
  // is satisfied whenever a wrap happens to fall inside the phrase: padding the line before it
  // so `half` ends a row and `an answer` begins the next left the assertion green with the words
  // plainly on screen. Nothing was routed, and that is checkable rather than inferable.
  assert.equal(routed(dir, 'half an answer'), undefined, 'the buffered lines were not routed anywhere')
  assert.equal(routed(dir, 'and no terminator'), undefined, 'neither of them')
  assert.deepEqual(
    routedAll(dir)
      .filter((m) => m.fromRank === 'human' && m.to.length > 0)
      .map((m) => m.kind),
    ['goal'],
    'the goal is the only thing the human addressed — the block became no message at all',
  )
})

/**
 * What the framing must NOT do, which is the half a feature like this is judged on.
 *
 * Every assertion here describes input that works today and has to keep working identically.
 * A permissive opener -- any line ending in `<<word` -- would swallow the next several lines
 * of a `/rotate` reason or a message about C++ into a block the operator never opened, and
 * the console would show nothing routed while they kept typing. So an opener has a shape
 * nobody reaches by accident -- nothing, or `>` and at least one more character, then the tag
 * and nothing else -- the terminator is an exact match, and an unframed line keeps the
 * whitespace normalisation it has always had rather than inheriting the verbatim treatment a
 * block needs.
 */
test('framing changes nothing about the lines that were already legal', async () => {
  const dir = repo()
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    // ROUNDS AND REPLIES SIZED TO OUTLIVE THE TYPING, which is not decoration. The run's pace
    // is wall-clock -- `slow()` delays a fake turn by a timer -- while the input sequence below
    // is gated on console output, which is CPU-bound. Under `--test-concurrency=4` the console
    // slows and the timers do not, so a three-turn run reached `DONE` before the last lines were
    // submitted; the session tore down, they were never processed, and the wait for their output
    // timed out. Reproduced 1 in 3 concurrent runs of this file. The seats now hold far more
    // replies than the run can use, so the run ends where this test says it does: at `input.end()`.
    rounds: 25,
    checks: [],
    operator: 'agent',
    registry: registryOf({
      codex: [slow('advisor', 'codex', [...Array(24).fill('Keep going.'), 'DONE'], 250)],
      claude: [slow('impl', 'claude', [...Array(24).fill('Did it.'), 'Done here.'], 250)],
    }),
    input,
    output: out.stream,
  })

  // A bare line is one message, and still exactly one.
  input.write('>implementer a plain single line\n')
  await untilText('the bare line', out.text, /a plain single line/)

  // A message that merely ENDS in `<<word`. Not an opener: it is routed now, not buffered.
  input.write('>advisor prefer a<<b over shifting twice\n')
  await untilText('the shift-operator message', out.text, /prefer a<<b over shifting twice/)

  // A slash command ending the same way. `/rotate` takes a free-text reason, so this is the
  // realistic collision — and it must reach the command, not open a block. Matched on what
  // /rotate ITSELF answers, because the word "rotation" is also in the startup banner and an
  // assertion that the banner satisfies proves nothing.
  input.write('/rotate the seat is stuck <<HERE\n')
  await untilText('the rotate command to answer', out.text, /pause first: \/pause, then \/rotate/)

  // Whitespace inside an ordinary line is normalised exactly as it always was. This is the
  // legacy path, and it is asserted so a later change cannot quietly move it onto the
  // verbatim one that blocks use.
  input.write('>implementer two  spaces   collapse\n')
  await untilText('the spaced line', out.text, /two spaces collapse/)

  // A BARE CHEVRON against the tag, with and without a space. Neither opens a block: `>` alone
  // names no seat, so there is nothing for it to be the prefix OF, and both were ordinary
  // lines before framing existed. The head pattern matched the empty rest for a while and
  // turned both into openers -- silently, since an opener draws no speaker block, so the only
  // symptom was everything typed afterwards disappearing into a block nobody asked for.
  //
  // They differ in what an ordinary line means for each. `><<EOF` is address-SHAPED -- `>` and
  // something -- so it is held to naming a seat and refused by name. `> <<EOF` is not, so it
  // is routed like any other text. The claim they share is the one asserted below: neither
  // swallowed the lines that came after it.
  input.write('><<EOF\n')
  await untilText('the bare chevron to be refused rather than buffered', out.text, /no seat named <<EOF/)
  input.write('> <<EOF\n')
  // Waited on the QUEUE confirmation, not on the text: the renderer draws a leading `> ` as a
  // blockquote glyph, so an assertion against the drawn line would be an assertion about
  // presentation. What it was routed as is checked against the record at the end.
  await untilText('the spaced bare chevron to be routed as text', out.text, /queued for everyone/)

  const text = out.text()
  // The load-bearing one, and the reason the last line is sent at all: had any line above
  // opened a block, everything after it would have been buffered into that block instead of
  // routed, and nothing since would have appeared at all.
  assert.equal(
    text.match(/● you → /g)?.length,
    5,
    'the goal and four routed messages — /rotate is a command and `><<EOF` is a refusal, so ' +
      'neither draws a speaker block, and a line swallowed into an accidental block would be ' +
      'a missing one',
  )

  input.end()
  await running.catch(() => {})

  // Asserted on what was ROUTED, not on what was drawn. The console reflows a message to the
  // terminal width, so runs of spaces collapse on screen whether or not they collapsed on the
  // way in — an assertion against `out.text()` here passes under either behaviour and proves
  // neither. Caught by mutation: switching the legacy path to verbatim left it green.
  assert.equal(
    routed(dir, 'spaces')?.text,
    'two spaces collapse',
    'an unframed line keeps the whitespace normalisation it has always had',
  )
  assert.equal(
    routed(dir, 'shifting twice')?.text,
    'prefer a<<b over shifting twice',
    'and a message merely ending in <<word is routed as itself',
  )
  // The bare chevron, on the record rather than on the screen. Routed as ITSELF -- the whole
  // line, tag and all, as one ordinary message to everyone -- which is only true if it never
  // became an opener: an opener contributes no message of its own and its tag never appears in
  // any text.
  const chevron = routed(dir, '<<EOF')
  assert.equal(chevron?.text, '> <<EOF', 'a bare > before the tag is a line, not an opener')
  assert.deepEqual([...(chevron?.to ?? [])], ['advisor', 'implementer'])
  // And the address-shaped one reached nobody at all, by the same reading.
  assert.ok(
    routedAll(dir).every((r) => r.text !== '><<EOF'),
    '`><<EOF` names no seat, so it is refused rather than routed',
  )
})

/**
 * A block ends where its terminator says, and the next line is read as a fresh one (#102).
 *
 * The failure this rules out is the one that makes an unterminated block dangerous: a
 * `/continue` typed after the answer being eaten as content, leaving the operator with a
 * message they think they sent, a pause they think they cleared, and a console that says
 * neither. It also pins the ordering the docs promise for answering a pause -- the block is
 * the answer, `/continue` is the decision, and the second is a command and not text.
 */
test('a command after a block is a command, and clears the pause the block answered', async () => {
  const dir = repo()
  const out = collect()
  const input = new PassThrough()
  const asked = 'Started.\n\nUNANSWERED: opt-in or default?'
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 8,
    checks: [],
    operator: 'agent',
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'], 200)],
      claude: [slow('impl', 'claude', [asked, asked, 'Did it.', 'Again.'], 200)],
    }),
    input,
    output: out.stream,
  })

  const until = async (pred: (s: ReturnType<typeof resolveSession>) => boolean, ms = 20_000) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      const f = resolveSession(dir)
      if (pred(f)) return f
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`timed out; console said:\n${out.text().slice(-1500)}`)
  }

  await until((f) => 'session' in f && f.session.status.pause?.reason === 'implementer_unanswered')

  // The block and the command in ONE write, which is how a driver sends them and the only
  // ordering under which "the command was swallowed" is possible.
  input.write(['>implementer <<EOF', 'Opt-in.', '', 'Blank lines survive.', 'EOF', '/continue', ''].join('\n'))

  const resumed = await until((f) => 'session' in f && f.session.status.state === 'running')
  assert.ok('session' in resumed)
  assert.equal(resumed.session.status.pause, undefined, 'the /continue was obeyed, not collected')

  // CONTENT off the record. Exact equality rather than a grep, because the whole question here
  // is which characters were part of the message: the terminator and the command that followed
  // it are protocol, not payload, and the blank line between the two sentences is the operator's.
  // The console answers none of that — `wrap()` collapses the blank line and normalises the
  // spacing — and a grep of the rendered text stayed green when the payload was altered.
  const sent = routed(dir, 'Blank lines survive')
  assert.ok(sent, 'the block must be in the run log')
  assert.equal(sent.text, 'Opt-in.\n\nBlank lines survive.', 'verbatim, terminator and command excluded')
  assert.deepEqual([...sent.to], ['implementer'], 'the block stayed addressed')

  input.end()
  await running.catch(() => {})
})

test('only a line equal to the tag closes a block; a padded one is content', async () => {
  // Exact, with no trim, and the trade is deliberate: `  EOF  ` closing would make the rule
  // "the tag, roughly", which is not a rule a driver can generate against — and it would
  // make a line of an answer that merely mentions the tag able to end the message early.
  // The cost is that a stray trailing space fails to close, which is loud rather than
  // silent: the block stays open, the hint row says so, and stdin closing names it.
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
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'], 250)],
      claude: [slow('impl', 'claude', ['ack', 'Did it.', 'Again.'], 250)],
    }),
    input,
    output: out.stream,
  })

  input.write(['>implementer <<END', 'first', '  END  ', 'last', 'END', ''].join('\n'))
  await untilText('the block to be delivered', out.text, /queued for implementer/)

  // CONTENT off the record, and exact: the padded `  END  ` is CONTENT, so it has to still be in
  // the message, between the two lines it sits between. `assert.match(text, /first/)` was the
  // version this replaces — it could not see the padding at all, since the console collapses the
  // spacing before drawing, and `first` and `last` are too common to anchor anything.
  const sent = routed(dir, 'first')
  assert.ok(sent, 'the block must be in the run log')
  assert.equal(sent.text, 'first\n  END  \nlast', 'the padded line is content, kept verbatim')
  assert.deepEqual([...sent.to], ['implementer'])

  // PRESENTATION, at CONSOLE_COLUMNS: one speaker block, not two. A padded terminator that
  // closed the block would draw a second.
  const text = out.text()
  assert.equal(
    text.match(/● you → /g)?.length,
    2,
    'the goal and ONE message — a padded terminator that closed would make two',
  )

  input.end()
  await running.catch(() => {})
})

test('a block keeps its leading and trailing blank lines', async () => {
  // Verbatim means verbatim. The operator's spacing is the message, and a framing that
  // tidies its own payload is one they have to reason about instead of use.
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
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'], 250)],
      claude: [slow('impl', 'claude', ['ack', 'Did it.', 'Again.'], 250)],
    }),
    input,
    output: out.stream,
  })

  input.write(['>implementer <<T', '', 'MIDDLE', '', 'T', ''].join('\n'))
  await untilText('the block to be delivered', out.text, /queued for implementer/)

  input.end()
  await running.catch(() => {})

  // Off the run log, not the console: the console trims and reflows for display, so the
  // blank lines this test is about are invisible there under either behaviour.
  const sent = routed(dir, 'MIDDLE')
  assert.ok(sent, 'the block should be in the run log')
  assert.equal(sent.text, '\nMIDDLE\n', "the blank lines either side of it are the operator's")
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
  // PRESENTATION, at CONSOLE_COLUMNS. The operator is told where the log is, or it may as well
  // not exist — and this is the one line whose purpose is being COPIED, so the contract is that
  // the whole command lands on a SINGLE rendered row: a path wrapped with a hanging indent is
  // pasted with the indent in it. Asserted as a whole row rather than as two greps, which held
  // even when the line was broken differently underneath them.
  //
  // Note what a rendering assertion CANNOT pin here, so nobody adds one expecting it to: the
  // producer's own spacing. `summaryLine` wraps through `wrap()`, which normalises runs of
  // whitespace, so doubling the spaces in the source line changes nothing on screen. The drawn,
  // collapsed form IS the contract; there is no verbatim form of a console-only notice.
  const resumeRow = first
    .text()
    .split('\n')
    .find((l) => l.includes('--resume '))
  assert.ok(
    resumeRow !== undefined && /resume with: conclave session "<goal>" --resume \S+\s*$/.test(resumeRow),
    `the resume command must be one unbroken, pasteable row, got:\n${first
      .text()
      .split('\n')
      .filter((l) => l.includes('resume'))
      .join('\n')}`,
  )

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
  // PRESENTATION, at CONSOLE_COLUMNS: the notice is console-only, so it is asserted where it is
  // drawn.
  assert.match(out.text(), /delivered, and resuming/)
  // CONTENT off the record: the reply actually REACHED the participants rather than being
  // swallowed by the resume, which is the failure the fix could easily have introduced. Read from
  // the run log — the console draw is a reflowed copy and stayed green when the reply's spacing
  // was altered underneath it.
  const reply = routed(dir, 'prefer the smaller change')
  assert.ok(reply, 'the reply must be in the run log')
  assert.equal(reply.text, 'prefer the smaller change')
  assert.ok(reply.to.length > 0, 'and it was addressed to somebody')

  input.end()
  await running
})

test('/continue carries a message, delivered at human rank before the run resumes', async () => {
  // The same decision as the test above, said the other way round. A pause draws a menu of
  // slash commands with "or type a message" beside it, and an operator with something to say
  // who reaches for the command they were just shown used to lose every word of it:
  // `/continue prefer the smaller change` resumed, silently, having discarded the sentence.
  // Both spellings now go through `answerPause`, so neither can start meaning something the
  // other does not.
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

  input.write('/continue prefer the smaller change\n')
  const resumed = await until((f) => 'session' in f && f.session.status.state === 'running')
  assert.ok('session' in resumed && resumed.session.status.pause === undefined, 'the decision was taken')

  // CONTENT off the record, which is where the failure this fixes was invisible: the console
  // printed nothing about the dropped text, so only the routing log can say whether the words
  // survived. Verbatim, at human rank, and addressed — a resume that swallowed the message
  // would leave every console assertion green.
  const said = routed(dir, 'prefer the smaller change')
  assert.ok(said, 'the message must be in the run log')
  assert.equal(said.text, 'prefer the smaller change')
  assert.equal(said.fromRank, 'human', 'delivered at human rank, as typing it alone would be')
  // To EVERYONE, which is what a line with no address prefix means everywhere else in this
  // console. `/continue` carries no address, so narrowing the audience here would invent one.
  assert.deepEqual([...said.to].sort(), ['advisor', 'implementer'], 'delivered to everyone')
  // The command word is not part of what was said.
  assert.ok(!said.text.includes('/continue'), 'the command is not carried into the message')

  input.end()
  await running
})

test('/continue force is the whole word: force with text after it is a message, not an override', async () => {
  // The ambiguity this shape has to resolve, resolved in the direction whose failure is
  // recoverable. `/continue force it through` could be read as a forced resume carrying a
  // note; it is read as a MESSAGE. Guessing the other way sends into a live turn — the
  // run-ending failure #117 exists to prevent — to save the operator a keystroke, and a
  // command does not get to make that trade on their behalf. Guessing this way costs a
  // refusal they can see, with their words already delivered, and `/continue force` next.
  //
  // The child is put mid-turn for real below, rather than left resting on a withdrawn verdict:
  // a bare withdrawal is a resumption now (#66), and a fixture that resumed would prove nothing
  // about whether `force it through` was read as an override.
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
    liveness: async () => IDLE_LIVENESS,
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
  await observedTurn(impl, dir)

  input.write('/continue force it through\n')
  // Refused, because it was not a force: the guard ran and the child is mid-turn. Read off the
  // pause's own refusal field rather than the screen, so a reflow cannot decide this.
  const refused = await until((f) => 'session' in f && f.session.status.pause?.refusal !== undefined)
  assert.ok('session' in refused)
  assert.equal(refused.session.status.state, 'paused', 'a message-carrying continue is never forced')
  // ...and the words were delivered anyway, BEFORE the guard refused. That ordering is the
  // reason the refusal is recoverable: nothing the operator typed has to be typed again.
  const said = routed(dir, 'force it through')
  assert.ok(said, 'the message must be in the run log even though the resume was refused')
  assert.equal(said.text, 'force it through')
  assert.equal(said.fromRank, 'human')

  input.write('/continue force\n')
  const resumed = await until((f) => 'session' in f && f.session.status.state === 'running')
  assert.ok('session' in resumed && resumed.session.status.pause === undefined, 'the exact word still overrides')
  // The override is not also a message. `force` alone must never reach a participant as
  // something the operator said — that is the half of this rule the delivery path could break
  // without any test above noticing.
  assert.equal(
    routedAll(dir).filter((e) => e.fromRank === 'human' && e.text.trim() === 'force').length,
    0,
    'the override word is consumed by the command, not spoken',
  )

  input.end()
  await running
})

test('a force that overrode a right refusal records refusedFirst: true and the live turn evidence', async () => {
  // The ledger exists so a reader can separate "the operator was refused and forced anyway" from
  // "the operator forced blind". This case is the first population: the child is genuinely
  // mid-turn, `/continue` is refused, and `/continue force` records that refusal plus the guard's
  // reading at the moment of the force.
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
    liveness: async () => IDLE_LIVENESS,
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
  await observedTurn(impl, dir)

  input.write('/continue\n')
  const refused = await until((f) => 'session' in f && f.session.status.pause?.refusal !== undefined)
  assert.ok('session' in refused)
  const refusedReason = refused.session.status.pause?.reason

  input.write('/continue force\n')
  const resumed = await until((f) => 'session' in f && f.session.status.state === 'running')
  assert.ok('session' in resumed && resumed.session.status.pause === undefined, 'the pause is cleared on resume')

  const after = resolveSession(dir)
  assert.ok('session' in after)
  const forces = after.session.status.forces
  assert.ok(forces, 'forces is present on the record')
  assert.equal(forces.length, 1, 'one force recorded')
  const entry = forces[0]!
  assert.equal(entry.refusedFirst, true, 'the operator was refused before forcing')
  assert.equal(entry.followedBy, null, 'followedBy is spelled null while the run is still alive')
  assert.equal(typeof entry.turnsTakenAtForce, 'number', 'turnsTakenAtForce is a number')
  assert.equal(entry.pause.reason, refusedReason, 'the entry names the pause the force answered')
  assert.equal(entry.overrode.length, 1, 'one sampled seat')
  assert.equal(entry.overrode[0]!.seat, 'implementer')
  assert.ok(entry.overrode[0]!.turn !== null, 'the seat was mid-turn when the force was applied')
  assert.ok(typeof entry.overrode[0]!.turn === 'string', 'the turn description is a string')

  input.end()
  await running
})

test('a force into a held turn ends peer_busy, and the send is recorded as expired', async () => {
  // The death-side population of #125: the same `/continue force` command, the same record
  // shape, but the run dies in the only attributable window. The mirror test ended normally with
  // a `sent` record and further turns completed; here the entry reads `send.outcome === 'expired'`
  // and the run ends `peer_busy`. No causal label separates a justified force from a fatal one —
  // the send's own fate and the outcome distance do.
  const dir = repo()
  const out = collect()
  const input = new PassThrough()
  const impl = slow('impl', 'claude', ['ack', 'Did it.'])
  // The first work turn times out but is withdrawn, leaving the child genuinely mid-turn; the
  // observed turn is the one the forced resume tries to send into and which never ends.
  impl.endTurn = { index: 1, verdict: TIMED_OUT, withdraw: 'no_replacement' }
  impl.holdTurn = 2
  impl.childPid = 1
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 6,
    checks: [],
    operator: 'agent',
    sendPreconditionMs: 300,
    liveness: async () => IDLE_LIVENESS,
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'], 300)],
      claude: [impl],
    }),
    input,
    output: out.stream,
  })
  const until = async (pred: (f: ReturnType<typeof resolveSession>) => boolean, ms = 25_000) => {
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
  // The bare withdrawal is a resumption now (#66), so the guard must be given a real observation:
  // the child is seen beginning a turn after the withdrawal.
  await observedTurn(impl, dir)

  input.write('/continue\n')
  const refused = await until((f) => 'session' in f && f.session.status.pause?.refusal !== undefined)
  assert.ok('session' in refused)
  const refusedReason = refused.session.status.pause?.reason

  input.write('/continue force\n')
  await until((f) => 'session' in f && f.session.status.state === 'running')

  // The forced send waits briefly, then the run ends because the target is still mid-turn.
  await running
  const ended = resolveSession(dir)
  assert.ok('session' in ended, 'session is still readable after the run ends')
  assert.equal(ended.session.status.state, 'ended', 'status is ended after the run ends')
  assert.equal(ended.session.status.outcome?.reason, 'peer_busy', 'the run ended peer_busy')

  const forces = ended.session.status.forces
  assert.ok(forces, 'forces is present on the final record')
  assert.equal(forces.length, 1, 'one force recorded')
  const entry = forces[0]!
  assert.equal(entry.refusedFirst, true, 'this was the refused-first population')
  assert.equal(entry.pause.reason, refusedReason, 'the entry names the turn_incomplete pause the force answered')
  assert.notEqual(entry.send, null, 'the send is stamped because the force produced a send attempt')
  assert.equal(entry.send!.outcome, 'expired', 'the overridden seat was still mid-turn, so the send expired in the precondition')
  assert.equal(entry.send!.seat, 'implementer', 'the send was to the overridden seat')
  assert.ok(entry.send!.waitMs < 5_000, 'the wait is bounded by the short send precondition')
  assert.notEqual(entry.followedBy, null, 'followedBy is stamped when the run ends')
  assert.equal(entry.followedBy!.outcome, 'peer_busy', 'followedBy names the peer_busy outcome')
  // The unchanged loop re-asks the advisor before the failed send, so turnsCompleted is not the
  // separator between the two populations; the send's own fate is.
  assert.ok(entry.followedBy!.turnsCompleted >= 0, 'turnsCompleted is a bare distance fact, not a causal claim')
  assert.ok(
    entry.followedBy!.ms < 5_000,
    'distance in milliseconds is bounded by the short send precondition, not the 5-minute default',
  )
})

test('a blind force records refusedFirst: false and null turns when no sampled seat is mid-turn', async () => {
  // The second population: no refusal happened, the operator forced anyway, and the guard found
  // no open turn. The ledger must record the explicit absence of a turn, not omit the field.
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
  const paused = await until((f) => 'session' in f && f.session.status.state === 'paused')
  assert.ok('session' in paused)
  assert.equal(paused.session.status.pause?.reason, 'operator_requested')
  assert.equal(paused.session.status.pause?.refusal, undefined, 'no refusal preceded the force')

  input.write('/continue force\n')
  const resumed = await until((f) => 'session' in f && f.session.status.state === 'running')
  assert.ok('session' in resumed && resumed.session.status.pause === undefined, 'the pause is cleared on resume')

  const after = resolveSession(dir)
  assert.ok('session' in after)
  const forces = after.session.status.forces
  assert.ok(forces, 'forces is present on the record')
  assert.equal(forces.length, 1, 'one force recorded')
  const entry = forces[0]!
  assert.equal(entry.refusedFirst, false, 'no refusal preceded this force')
  assert.equal(entry.followedBy, null, 'followedBy is spelled null while the run is still alive')
  assert.equal(typeof entry.turnsTakenAtForce, 'number', 'turnsTakenAtForce is a number')
  assert.equal(entry.pause.reason, 'operator_requested', 'the entry names the pause the force answered')
  assert.ok(
    entry.overrode.every((o) => o.turn === null),
    'every sampled seat recorded an explicit null turn',
  )

  input.end()
  await running
})

test('a blind force on an idle seat ends normally, and the send is recorded as sent', async () => {
  // The mirror population of #125: the guard finds no open turn at all, so the force is recorded
  // against an explicit idle seat and the first post-force send goes immediately. The same
  // command, the same record shape, but the entry's `send` reads `sent` and the run ends normally.
  const dir = repo()
  const out = collect()
  const input = new PassThrough()
  const impl = slow('impl', 'claude', ['ack', 'Did it.'])
  // A closed `timed_out` verdict raises a `turn_incomplete` pause without leaving a live turn:
  // the guard samples the implementer, sees an explicit null, and `/continue force` is a blind
  // force on an idle seat rather than a force on a mid-turn child.
  impl.endTurn = { index: 1, verdict: TIMED_OUT }
  impl.childPid = 1
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 6,
    checks: [],
    operator: 'agent',
    sendPreconditionMs: 300,
    liveness: async () => IDLE_LIVENESS,
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'], 300)],
      claude: [impl],
    }),
    input,
    output: out.stream,
  })
  const until = async (pred: (f: ReturnType<typeof resolveSession>) => boolean, ms = 25_000) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      const f = resolveSession(dir)
      if (pred(f)) return f
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`timed out; console said:\n${out.text().slice(-700)}`)
  }

  await until((f) => 'session' in f && f.session.status.state === 'paused')
  await until((f) => 'session' in f && f.session.status.pause?.reason === 'turn_incomplete')
  const beforeForce = resolveSession(dir)
  assert.equal(
    'session' in beforeForce ? beforeForce.session.status.pause?.refusal : undefined,
    undefined,
    'no refusal precedes a blind force on an idle seat',
  )

  input.write('/continue force\n')
  await until((f) => 'session' in f && f.session.status.state === 'running')

  // Let the run reach its normal end without an operator close, then read the final record.
  await running
  const ended = resolveSession(dir)
  assert.ok('session' in ended, 'session is still readable after the run ends')
  assert.equal(ended.session.status.state, 'ended', 'status is ended after the run ends')
  const forces = ended.session.status.forces
  assert.ok(forces, 'forces is present on the final record')
  assert.equal(forces.length, 1, 'one force recorded')
  const entry = forces[0]!
  assert.equal(entry.refusedFirst, false, 'this was the blind-force population')
  assert.equal(entry.overrode.length, 1, 'one sampled seat was overridden')
  assert.equal(entry.overrode[0]!.seat, 'implementer')
  assert.equal(entry.overrode[0]!.turn, null, 'the seat was explicitly idle when the force was applied')
  assert.notEqual(entry.send, null, 'the send is stamped because the force produced a send to the overridden seat')
  assert.equal(entry.send!.outcome, 'sent', 'the overridden seat was idle, so the send happened immediately')
  assert.equal(entry.send!.seat, 'implementer', 'the send was to the overridden seat')
  assert.equal(entry.send!.waitMs, 0, 'an idle seat sends without waiting')
  assert.notEqual(entry.followedBy, null, 'followedBy is stamped when the run ends')
  assert.equal(
    entry.followedBy!.outcome,
    ended.session.status.outcome?.reason,
    'followedBy names the same terminal outcome as the final status',
  )
  assert.ok(
    entry.followedBy!.turnsCompleted >= 1,
    'the run demonstrably completed further turns after the force',
  )
  assert.ok(entry.followedBy!.ms >= 0, 'distance in milliseconds is non-negative')
})

test('the trailing-text rule stops at /continue: /pause still drops a suffix, /abort still keeps one', async () => {
  // The falsifier, made checkable rather than argued. There is no general "text after a
  // command is a message" rule in this console and this change does not create one:
  // `/rotate` and `/abort` already spend their argument on a REASON, and the argumentless
  // commands ignore whatever follows. So an operator who generalises from `/continue` to
  // `/pause I'll be back in ten` still loses the sentence, and that is a real cost of the
  // shape rather than an oversight in it — `/continue` could take this because `force` was
  // the only thing its argument slot had ever meant.
  //
  // Pinned so that a later attempt to spread the rule has to come here and change what this
  // test claims, which is the point at which the inconsistency gets argued about again.
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
  input.write("/pause I'll be back in ten\n")
  await until((f) => 'session' in f && f.session.status.state === 'paused')
  assert.equal(
    routedAll(dir).filter((e) => typeof e.text === 'string' && e.text.includes("back in ten")).length,
    0,
    '/pause still discards its suffix — unchanged, and documented rather than fixed here',
  )

  // ...while `/abort`'s trailing text is still its reason, spent on the outcome rather than
  // said to anybody.
  input.write('/abort the API is down\n')
  const ended = async (ms = 10_000) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      const e = events(dir).find((x) => x['type'] === 'run_end')
      if (e) return e
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`timed out; console said:\n${out.text().slice(-700)}`)
  }
  const end = await ended()
  assert.equal(end['detail'], 'the API is down', 'the text is the abort reason, not a message')
  assert.equal(
    routedAll(dir).filter((e) => e.fromRank === 'human' && e.text.trim() === 'the API is down').length,
    0,
    'and it was never routed to anybody',
  )

  input.write('/exit\n')
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

test('the console hands the configured SILENCE budget to the adapters, not only the absolute one', async () => {
  // The sibling of the test above, and written the same way for the same reason: on ARRIVAL
  // at the registry rather than on the source text. `--turn-timeout` was parsed into a console
  // option that did not exist, slipped past excess-property checking inside a conditional
  // spread, and did nothing for its whole life -- and a test that grepped either file would
  // have passed against that. Adding a second flag on the same path without the same test
  // would be repeating the mistake with the lesson already written down.
  const dir = repo()
  const out = collect()
  let idle: number | undefined
  let absolute: number | undefined
  await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    silenceWatchdogMs: 4242,
    registry: registryOf(
      {
        codex: [new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])],
        claude: [new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])],
      },
      (_agent, _args, ctx) => {
        if (typeof ctx?.idleMs === 'number') idle = ctx.idleMs
        if (typeof ctx?.watchdogMs === 'number') absolute = ctx.watchdogMs
      },
    ),
    input: script([]),
    output: out.stream,
  })
  assert.equal(idle, 4242, 'the console must hand the configured silence budget to the adapters')
  // And ONLY that one. A silence request that also filled the absolute slot would put a
  // deadline on a clock the operator was not configuring.
  assert.equal(absolute, undefined, 'and must not invent an absolute budget from it')
})

test('the banner says what each seat’s silence clock resolved to, including the seats that have none', async () => {
  // The launch reading that did not exist. `--turn-timeout` has been reportable per seat in
  // the run REPORT since that block was written, but a report is read after the run; the
  // banner is the three lines an operator takes in before there is any work to lose, and it
  // could say what bounds the RUN (#119's ceilings line) and nothing about what bounds a turn.
  //
  // The mixed pairing is the point, and is why this test declares clocks rather than using
  // the default doubles: the advisor HAS a silence clock and takes the configured budget, the
  // implementer has none and keeps saying so. A seat with no silence clock that goes quiet
  // forever produces NO verdict at all, so an operator who read the configured number as
  // applying everywhere would be waiting on a timeout that cannot arrive.
  const dir = repo()
  const out = collect()
  await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    silenceWatchdogMs: 90_000,
    registry: registryOf(
      {
        codex: [new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])],
        claude: [new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])],
      },
      undefined,
      {
        codex: { absolute: { supported: true }, silence: { supported: true } },
        claude: { absolute: { supported: true }, silence: { supported: false } },
      },
    ),
    input: script([]),
    output: out.stream,
  })
  const text = out.text()
  const line = text.split('\n').find((l) => l.includes('silence:'))
  assert.ok(line, 'the banner must carry a silence line')

  // What was asked for, and what each seat did with it, on one line.
  assert.match(line, /--silence-timeout 90s/)
  assert.match(line, /advisor 90s/)
  // The word this line exists for.
  assert.match(line, /implementer unsupported/)

  // IN the banner, between the ceilings line and the rotation line -- the same placement
  // argument the ceilings line makes: a line that drifted below the rule would be read after
  // the operator has stopped reading.
  const ceilingsAt = text.indexOf('ceilings:')
  const silenceAt = text.indexOf('silence:')
  const rotationAt = text.indexOf('rotation:')
  assert.ok(ceilingsAt > 0 && silenceAt > ceilingsAt, 'the silence line comes after the ceilings line')
  assert.ok(rotationAt > silenceAt, 'and before the rotation line')
})

test('the banner says what each seat’s absolute cap resolved to, beside the silence line', async () => {
  // The other clock, and the last launch surface that was silent about it. The argument for
  // printing only silence was that `--turn-timeout` had been reportable per seat since the
  // report block was written -- true of the run REPORT and of `status --json`, and both of
  // those are documents of a run that already exists. Before the run there was nothing, so an
  // operator who mistyped the number, or who seated an adapter running no absolute clock at
  // all, learned it from a turn that ran to the wrong bound or never stopped waiting.
  //
  // The mixed pairing again, and inverted from the silence test on purpose: here it is the
  // IMPLEMENTER that has the clock and the advisor that does not, so a line that reported the
  // silence resolution twice under two labels would fail rather than read plausibly.
  const dir = repo()
  const out = collect()
  await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    turnWatchdogMs: 600_000,
    registry: registryOf(
      {
        codex: [new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])],
        claude: [new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])],
      },
      undefined,
      {
        codex: { absolute: { supported: false }, silence: { supported: true } },
        claude: { absolute: { supported: true }, silence: { supported: true } },
      },
    ),
    input: script([]),
    output: out.stream,
  })
  const text = out.text()
  const line = text.split('\n').find((l) => l.includes('turn:'))
  assert.ok(line, `the banner must carry a turn line; it said:\n${text}`)

  // What was asked of the absolute clock, named by the flag that asks it.
  assert.match(line, /--turn-timeout 600s/)
  // And what each seat did with the request, including the seat it could not reach.
  assert.match(line, /advisor unsupported/)
  assert.match(line, /implementer 600s/)

  // The silence line is still its own line and still says what IT resolved to. One line
  // reporting both clocks would have to pick a number per seat, and the two are different
  // questions rather than two precisions of one.
  const silence = text.split('\n').find((l) => l.includes('silence:'))
  assert.ok(silence, 'the silence line must survive the absolute one arriving beside it')
  assert.match(silence, /--silence-timeout unset/)
  // `off`, not `unsupported`: these doubles declare the silence clock and no default for it,
  // and this run asked for nothing. A clock the seat HAS and this run left off is a different
  // fact from one it does not have, and the advisor is `unsupported` on the line above and
  // `off` on this one -- which is the pair that would collapse if either line were rendered
  // from the other's field.
  assert.match(silence, /advisor off/)
  assert.match(silence, /implementer off/)

  // Between the ceilings line and the rotation line, with silence: the same placement
  // argument the ceilings line makes, and the same block an operator reads before there is
  // work to lose.
  const ceilingsAt = text.indexOf('ceilings:')
  const turnAt = text.indexOf('turn:')
  const silenceAt = text.indexOf('silence:')
  const rotationAt = text.indexOf('rotation:')
  assert.ok(ceilingsAt > 0 && turnAt > ceilingsAt, 'the turn line comes after the ceilings line')
  assert.ok(silenceAt > turnAt, 'before the silence line -- absolute first, as declared')
  assert.ok(rotationAt > silenceAt, 'and the pair sits above the rotation line')
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
  const ran = await until((f) => 'session' in f && f.session.status.state === 'running')
  // An ABSENCE, so it is the record that must be empty. `doesNotMatch(out.text(), ...)` is the
  // version this replaces: a wrap falling inside the phrase satisfies it whether or not the
  // refusal happened, so it could pass for the wrong reason.
  assert.ok('session' in ran)
  assert.equal(ran.session.status.pause, undefined, 'an idle seat must not be treated as busy')

  input.end()
  await running
})

// ---------------------------------------------------------------------------------------
// Child liveness at the console resume path.
//
// The sampler protects against sending into a live turn, but the verdict the pause was raised
// on can be superseded. A completed replacement means the Stop hook proved the turn ended, so
// the child may still be alive but process liveness is irrelevant.
//
// A withdrawal with NO replacement verdict is also let through, and that is #66. It used to
// refuse, on the reading that the original concern was still standing. It is not: the only
// thing that produces a bare withdrawal is `Tracker.resetTranscript` finding that a rewritten
// transcript no longer holds the evidence a verdict rested on, so the open turn that refusal
// read is a deleted record and not an observed turn -- and the only event that could close it
// again is the one compaction removed. See `resumeRun` in src/repl/session.ts for the rule and
// the argument both: the guard reads the SEAT'S OWN EVENTS (`ActiveTurn.withdrawn`) rather than
// the pause record, because one compaction raises two pauses and a pause-keyed bypass clears the
// wrong one.
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
  // An ABSENCE, read off the record rather than off the screen: a wrap inside `not continuing`
  // satisfies a console `doesNotMatch` whether or not the refusal happened.
  assert.equal(resumed.session.status.pause, undefined, 'the run must resume without refusing')

  input.end()
  await running
})

test('a withdrawal with no replacement lets /continue through instead of refusing forever', async () => {
  // #66. The verdict is gone and `activeTurn` reads the turn as open again -- correctly, since
  // the `turn_end` that closed it has been retracted -- and this used to refuse on that reading.
  // It cannot: a bare withdrawal comes only from `Tracker.resetTranscript`, which withdraws a
  // verdict when a rewritten transcript no longer holds the evidence it rested on. So the open
  // turn is a DELETED RECORD, and the only event that could close it is the one that was
  // deleted. Refusing there is a refusal no amount of waiting can lift, with `/continue force`
  // -- a flag the operator has to already know -- as the only way out.
  //
  // The CPU sampler still runs and still decides nothing: it is printed beside the resumption
  // so an operator whose child turns out to have been working can see what they were told.
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
    // Busy, which is the reading that would have made the old refusal permanent.
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

  const paused = await until((f) => 'session' in f && f.session.status.state === 'paused')
  // The shape the bypass is keyed on, asserted off the record before it is relied on: a
  // supersession with no replacement verdict, on a pause that names the seat it is about.
  assert.ok('session' in paused)
  await until(
    (f) =>
      'session' in f &&
      f.session.status.pause?.superseded !== undefined &&
      f.session.status.pause?.superseded?.verdict === undefined,
  )
  const withdrawn = resolveSession(dir)
  assert.ok('session' in withdrawn)
  assert.equal(withdrawn.session.status.pause!.verdictOf?.participant, 'implementer')

  input.write('/continue\n')
  const resumed = await until((f) => 'session' in f && f.session.status.state === 'running')
  assert.ok('session' in resumed)
  // ABSENCES, off the record rather than off the screen: the run moved, and it did not refuse
  // on the way. A `doesNotMatch` against the console cannot tell a missing refusal from a
  // wrapped one.
  assert.equal(resumed.session.status.pause, undefined, 'the run must resume')
  assert.equal(sampled, true, 'and the reading is still taken, as colour on the resumption')
  // What the operator is told. Not the refusal's wording -- this is a resumption -- but it must
  // name the withdrawal, because proceeding on the absence of evidence is not the same as
  // proceeding on evidence and the console is the only place that difference is stated.
  assert.match(out.text(), /reads as mid-turn, and that reading has been withdrawn/)
  assert.match(out.text(), /the turn is open only because that record was deleted/)
  assert.match(out.text(), /deciding nothing/, 'the CPU line is still marked as deciding nothing')

  input.end()
  await running
})

test('a compaction-driven withdrawal lets /continue through, the same as any other', async () => {
  // The withdrawal an operator actually met (#66): `the timed_out verdict this pause was raised
  // on has been withdrawn (compaction)`. It is the SAME state as the test above -- the relay
  // matches a revision by the sequence it replaces and never looks at the reason -- and this
  // test exists to hold that equality, because the report was written about compaction and a
  // fix that only worked for `late_signal` would read as fixed and not be.
  //
  // It is also the case where the withdrawal is permanent by construction. A late signal is
  // followed by its replacement immediately; a compaction that removed the evidence has nothing
  // left to send.
  //
  // It raises TWO pauses, and that is the finding this test produced rather than a fixture
  // detail. A `compaction` revision is also the degradation signal, so with no rotation checks
  // configured the seat is first a `rotation_candidate` -- a pause carrying no `verdictOf` and
  // no supersession at all, in front of an operator whose seat's turn is open only because a
  // record was deleted. Both must resume. A bypass keyed on the PAUSE would have cleared the
  // second and refused the first forever, which is why the guard asks the seat's own events.
  //
  // The child is ALIVE and above the idle line throughout -- `BUSY_LIVENESS` is alive with
  // three samples at 12.5, 15.0 and 11.0 against an `IDLE_CPU_PERCENT` of 3 -- which is the
  // reading the original refusal was made on and the one that made it permanent. A Claude Code
  // session outlives its turn, so `alive` never goes false and a child sitting above the line
  // never falls below it; if this state is going to resume at all it has to resume like this.
  const dir = repo()
  const impl = slow('impl', 'claude', ['ack', 'Did it, slowly.', 'And again.'])
  impl.endTurn = { index: 1, verdict: TIMED_OUT, withdraw: 'no_replacement', withdrawReason: 'compaction' }
  impl.childPid = 1
  const out = collect()
  const input = new PassThrough()
  const readings: ChildLiveness[] = []
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
      readings.push(BUSY_LIVENESS)
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

  // TWO pauses, in an order this test does not get to choose: the degradation reading and the
  // withdrawn verdict are raised from the same compaction, and which one the operator meets
  // first varies run to run. So this walks pauses rather than scripting them -- answering
  // whatever is not the pause under test with an ordinary `/continue`, and recording every
  // pause reason and every refusal it passes through.
  //
  // Both must resume. The `rotation_candidate` one carries no supersession and no `verdictOf`,
  // and the seat's turn is already reopened by the withdrawal underneath it, so a bypass keyed
  // on the pause would refuse it forever. That is not a hypothetical: it is what the first cut
  // of this fix did, and this loop is what found it.
  const reasons = new Set<string>()
  const refusals: string[] = []
  /** Walk to the pause the withdrawal is on, resuming anything else on the way. */
  const untilWithdrawnPause = async (ms = 20_000) => {
    const t = Date.now()
    let answered: string | undefined
    while (Date.now() - t < ms) {
      const f = resolveSession(dir)
      if ('session' in f && f.session.status.state === 'paused') {
        const p = f.session.status.pause
        if (p) {
          reasons.add(p.reason)
          if (p.refusal) refusals.push(`${p.reason}: ${p.refusal.reason}`)
          if (p.superseded !== undefined && p.superseded.verdict === undefined) return f
          if (answered !== p.reason) {
            answered = p.reason
            input.write('/continue\n')
          }
        }
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`timed out; console said:\n${out.text().slice(-900)}`)
  }
  const withdrawn = await untilWithdrawnPause()

  // The state under test, off the record before anything is asked of it: a supersession naming
  // the compaction, carrying no replacement verdict, on a pause that names the seat.
  assert.ok('session' in withdrawn)
  const pause = withdrawn.session.status.pause!
  assert.equal(pause.reason, 'turn_incomplete')
  assert.equal(pause.superseded?.verdict, undefined, 'no replacement verdict, which is the whole case')
  assert.equal(pause.verdictOf?.participant, 'implementer', 'and the pause names the seat it was raised on')
  assert.match(pause.superseded!.note, /withdrawn \(compaction\)/, 'the wording #66 was reported with')

  // ORDINARY `/continue`. Not `force`, which was the only way through this state and is a flag
  // the operator has to already know exists.
  input.write('/continue\n')
  // Waited on the PAUSE GOING AWAY rather than on `state === 'running'`. The degradation pause
  // can be the next thing raised, and a poll looking for `running` can miss the gap between the
  // two entirely -- which would fail this test for a reason that has nothing to do with it.
  const moved = await until(
    (f) =>
      'session' in f &&
      !(f.session.status.pause?.superseded !== undefined && f.session.status.pause?.superseded?.verdict === undefined),
  )
  assert.ok('session' in moved)
  // The proof that it was not refused, and the strongest form available: a refusal leaves the
  // run paused on the SAME pause, so that pause being gone is the resumption. The refusals
  // collected while walking say the same thing about the pauses before it.
  assert.match(out.text(), /reads as mid-turn, and that reading has been withdrawn/)
  // The child really was alive and really was above the line while this resumed -- otherwise
  // the test would be proving the resumption against a reading that never objected.
  assert.ok(readings.length > 0, 'the sampler was asked')
  assert.equal(readings[0]!.alive, true, 'the child is alive')
  assert.equal(readings[0]!.idle, false, 'and above the idle threshold')
  assert.ok(readings[0]!.samples.every((c) => c > IDLE_CPU_PERCENT), 'every sample over the line')
  // NOTHING was refused on the way, at either pause. The pause under test is gone by now, so
  // this is read off what was collected while walking rather than off the final record.
  // BOTH pauses, and that is the assertion the rest of this test rests on. The order they
  // arrive in is not ours to choose, so meeting only `turn_incomplete` proves nothing about the
  // other one: if `rotation_candidate` comes second, the walk above has already stopped and the
  // exact rejected design -- a bypass keyed on the PAUSE, which clears this one and refuses that
  // one forever -- passes a test written to kill it. So walk on until it has been met too.
  if (!reasons.has('rotation_candidate')) {
    const t = Date.now()
    let answered: string | undefined
    while (Date.now() - t < 20_000 && !reasons.has('rotation_candidate')) {
      const f = resolveSession(dir)
      if ('session' in f && f.session.status.state === 'paused') {
        const p = f.session.status.pause
        if (p) {
          reasons.add(p.reason)
          if (p.refusal) refusals.push(`${p.reason}: ${p.refusal.reason}`)
          if (answered !== p.reason) {
            answered = p.reason
            input.write('/continue\n')
          }
        }
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  assert.ok(reasons.has('turn_incomplete'), `the withdrawn-verdict pause was met; saw ${[...reasons]}`)
  assert.ok(reasons.has('rotation_candidate'), `and so was the degradation pause; saw ${[...reasons]}`)
  // Read AFTER both have been walked, so it speaks for both.
  assert.deepEqual(refusals, [], 'no pause raised by this compaction may refuse an ordinary /continue')

  // Answer whatever the run raises next before closing the console. A paused run with nothing
  // left to read its input is a hung test rather than a failing one.
  input.write('/continue\n')
  input.end()
  await running
})

test('a refusal to continue is recorded on the paused session status', async () => {
  // The run stays paused, so `state` alone cannot tell an outside reader that a decision was
  // attempted and rejected. The refusal must be on the pause record, rewritten to disk, so
  // `conclave status --json` can observe it without scraping the console.
  //
  // Refused on a turn the child was SEEN to begin. The withdrawn verdict beneath it no longer
  // refuses on its own (#66), so the record this asserts is the record of the guard still
  // doing its job rather than of the state that made it a wall.
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
  await observedTurn(impl, dir)
  input.write('/continue\n')
  const found = await until((f) => 'session' in f && f.session.status.pause?.refusal !== undefined)
  assert.ok('session' in found)
  const refusal = found.session.status.pause!.refusal!
  assert.equal(typeof refusal.at, 'number')
  // The measurement is still carried -- it is the colour an operator reads before forcing --
  // and the REASON is now the turn, which is what was decided on.
  assert.equal(refusal.liveness?.pid, 1)
  assert.equal(refusal.liveness?.idle, false)
  assert.match(refusal.reason, /implementer is mid-turn/)
  // Readable through the JSON rendering, not only in-process.
  const asJson = JSON.parse(formatSessionJson(found.session))
  assert.equal(asJson.pause.refusal.liveness.idle, false)

  input.end()
  await running
})

test('a mixed CPU reading with no turn open no longer refuses the continue', async () => {
  // The obstructive half of #117, and the reason CPU stopped deciding. A finished child that
  // twitched once samples 0.3%, 0.2%, 7.2% -- three readings in a three-sample window, all
  // accurate -- and the old guard refused on the blip. Reported from a run that sat stuck for
  // over an hour, sampling 0.0 0.0 0.0 0.1 0.0 across fifteen seconds with no working
  // descendants, until `/continue force`.
  //
  // The verdict here is NOT withdrawn: the turn ended, so `activeTurn` says there is nothing in
  // flight, and no CPU reading may stand in the way of that.
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
      return MIXED_LIVENESS
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
  input.write('/continue\n')
  const resumed = await until((f) => 'session' in f && f.session.status.state === 'running')
  assert.ok('session' in resumed)
  // An ABSENCE, read off the record rather than the screen: a wrap falling inside `not
  // continuing` satisfies a console `doesNotMatch` whether or not the refusal happened.
  assert.equal(resumed.session.status.pause, undefined, 'a mixed reading must not hold a finished turn')
  assert.equal(sampled, false, 'with no turn open there is nothing to describe, so nothing is sampled')

  input.end()
  await running
})

test('the refusal #124 reports is unreachable: the blip it named is never sampled', async () => {
  // #124 asks a refusal that admits its own evidence is thin -- "no output count was taken with
  // this reading", "the samples disagree" -- to widen the sample before refusing. The refusal it
  // asks about cannot happen any more. Since #117 this guard refuses on `activeTurn`, and it
  // samples CPU only after it has already decided to refuse, as colour. The reported run's turn
  // had ENDED, so there is no refusal, and therefore no reading taken, thin or otherwise.
  //
  // Distinct from the #83 test above, which proves the same path with different numbers. This
  // one is the report's own reading, so the issue's exact claim has an exact falsifier.
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
      return BLIP_LIVENESS
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
  input.write('/continue\n')
  const resumed = await until((f) => 'session' in f && f.session.status.state === 'running')
  assert.ok('session' in resumed)
  // Read off the RECORD, which is where a refusal is written. The pause is gone, so nothing
  // refused; a screen assertion could be satisfied by a line wrap instead.
  assert.equal(resumed.session.status.pause, undefined, 'a 3.6% blip must not hold a finished turn')
  // The load-bearing half of the falsifier. The issue's premise is a guard that noticed its
  // evidence was poor and could have taken more; this guard took none, because CPU is not what
  // it reads. There is no thin reading here to widen.
  assert.equal(sampled, false, 'no turn open is no refusal, so no sample is taken to describe one')
  // The two assertions above are the whole claim. There were two more here, greping the SCREEN
  // for the phrases the report quotes -- and they were the defect #109 names, in a file that
  // states the rule: a negative assertion against rendered output is a content claim read off
  // the wrong surface. They failed on macOS CI and passed on Linux, because `relay.ts` renders
  // liveness prose too (its pause evidence, #101's refresh) and the screen carries both. The
  // assertion could not tell whose sentence it had found, so it was answering a question about
  // the CONSOLE GUARD with text produced by the relay. `sampled === false` says what they meant
  // to say, about the right component, and cannot be faked by a wrap or by a neighbour.

  input.end()
  await running
})

test('a child mid-turn is refused however idle it reads', async () => {
  // The unsafe half, and the reporter's own test. A child blocked in `sleep` inside a Bash tool
  // call is mid-turn and samples at 3.2%; the old guard read that as idle, said go, and the
  // send killed the run. The same path that refuses a CPU-busy child must refuse this one, and
  // the only way that holds is if CPU is not what either decision is made on.
  //
  // This is the coverage #66's bypass had to leave standing, which is why it is stated as an
  // OBSERVED turn. The bypass turns on `activeTurn`'s `withdrawn` mark, so the one thing that
  // would quietly retire this test is a mark that survived a `turn_start` -- and that is
  // exactly what this fixture puts in front of it.
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
    // Idle by every measure the old guard had: alive, and every sample under the line.
    liveness: async () => IDLE_LIVENESS,
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
  await observedTurn(impl, dir)
  input.write('/continue\n')
  const found = await until((f) => 'session' in f && f.session.status.pause?.refusal !== undefined)
  assert.ok('session' in found)
  assert.equal(found.session.status.state, 'paused', 'an idle-looking child mid-turn must still refuse')
  const refusal = found.session.status.pause!.refusal!
  assert.match(refusal.reason, /implementer is mid-turn/)
  // The reading that would have waved this through is still shown, and labelled as deciding
  // nothing -- which is the whole distinction between colour and evidence.
  assert.equal(refusal.liveness?.idle, true, 'the child reads idle, and is refused anyway')
  assert.match(out.text(), /not continuing/)
  assert.match(out.text(), /deciding nothing/)
  assert.match(out.text(), /\/continue force to send anyway/, 'the way past it is still named')

  input.end()
  await running
})

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
  // (src/relay/relay.ts:6791). A rank scan for implementers sampled the wrong child here too.
  assert.deepEqual(
    sampled(pauseFor({ reason: 'turn_incomplete', participant: 'advisor' }, { participant: 'advisor', endSeq: 2 })),
    ['advisor'],
  )
})

test('a conclave- or workstream-scoped pause samples nobody, with no fall back to rank', () => {
  // Both conclave-scoped reasons. Resuming an `advisor_escalated` pause sends to the ADVISOR
  // (src/relay/relay.ts:6912), so measuring implementer children was never the question; and
  // `operator_requested` is consumed at an advisor-turn boundary that states no turn is in
  // flight. Neither has anything for this guard to sample.
  assert.deepEqual(sampled(pauseFor({ reason: 'advisor_escalated' })), [])
  assert.deepEqual(sampled(pauseFor({ reason: 'operator_requested' })), [])
  // Workstream scope, and the id deliberately COLLIDES with a seat id -- at N=1 the workstream
  // is named after the seat carrying the instruction (src/relay/relay.ts:7079), which is exactly
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
  // sites, both turn_incomplete (src/relay/relay.ts:6795, src/relay/relay.ts:7315) -- so under
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
    // (src/relay/relay.ts:4736). A command that exits 0 immediately: what the checks DO is
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
  const resumedAfter = await until((f) => 'session' in f && f.session.status.state === 'running')
  // An ABSENCE, off the record: the resumed status carries no pause, and so no refusal at all.
  assert.ok('session' in resumedAfter)
  assert.equal(resumedAfter.session.status.pause, undefined, 'a busy seat the pause is not about must not refuse')
  // Nothing is sampled at all now, and that is the stronger form of the same claim: the seat
  // the pause NAMES is between turns, so there is nothing to describe -- and the seat that is
  // genuinely mid-turn is not this pause's to consult, which is what the scope rule decides.
  assert.equal(asked.includes(11), false, 'the seat the pause is not about must never be consulted')
  assert.deepEqual(asked, [], 'and a seat between turns needs no reading either, so nothing is sampled')

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
  const resumedNobody = await until((f) => 'session' in f && f.session.status.state === 'running')
  assert.equal(asked, 0, 'a pause that names no participant has nothing to sample')
  // An ABSENCE, off the record.
  assert.ok('session' in resumedNobody)
  assert.equal(resumedNobody.session.status.pause, undefined, 'and nothing to refuse on')

  input.end()
  await running
})

test('a turn that ends lets /continue resume on retry, however busy the child reads', async () => {
  // The guard re-reads rather than remembering the past. A turn that was open the first time
  // and ended the second must resume, or the guard is a wall again -- and it must resume while
  // the CPU sampler is still shouting `working`, because that reading is not what it consults.
  //
  // The open turn here is one the child was seen to begin, not a withdrawn verdict: a bare
  // withdrawal resumes on the first attempt now (#66), and there would be no second attempt to
  // make a claim about.
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
    // Busy every single time. Under the reading this replaces, the second `/continue` would
    // have been refused exactly like the first, forever.
    liveness: async () => {
      calls++
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
  await observedTurn(impl, dir)
  input.write('/continue\n')
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(calls, 1, 'the reading is taken once, as colour on the refusal')
  assert.match(out.text(), /not continuing/)

  // The turn ends. Not `completed`, which would make the console bypass its guard altogether
  // and test the wrong thing.
  //
  // Waited for rather than assumed: the end travels fake -> relay pump -> participant events,
  // and typing `/continue` before it lands would test the previous state and pass or fail on
  // scheduling. The supersession note is the relay saying it has seen the end.
  impl.endTurnLate()
  await until((f) => 'session' in f && f.session.status.pause?.superseded?.verdict !== undefined)
  input.write('/continue\n')
  await until((f) => 'session' in f && f.session.status.state === 'running')
  assert.equal(calls, 1, 'and no second reading is needed, because the turn is what lifted it')

  input.end()
  await running
})

// ---------------------------------------------------------------------------------------
// #75: a manual /rotate must carry the operator's own reason.
//
// Rotation was built as recovery and is being used as an instrument -- replacing a seat so a
// fresh reader applies a just-committed criterion is a good reason to rotate and is
// methodologically unrelated to degradation. A bare `/rotate` used to inherit whatever pause
// was on screen, so that rotation went into the record in the degradation proxy's words, and
// #10's dataset filled with rotations that had nothing to do with degradation.
//
// The prompt is the console half of the fix. These are about the PROMPT: whether it appears,
// what it consumes, and what it leaves alone. What the relay then records is proven in
// `src/relay/rotation.test.ts`.
// ---------------------------------------------------------------------------------------

test('a bare /rotate away from a rotation candidate asks why, and the next line is the reason (#75)', async () => {
  const dir = repo()
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 6,
    // ARMS ROTATION, which is what puts `rotate` on the pause's menu at all. What the check
    // DOES is not what this test is about.
    checks: ['true'],
    registry: registryOf({
      // The handoff has no headings, so the transaction rolls back. Deliberate: this test is
      // about the REASON reaching the rotation, and `rotating <seat>: <reason>` is recorded
      // before the transaction can fail. Driving a full acceptance here would re-test
      // `rotate.ts` and say nothing more about the prompt.
      codex: [slow('advisor', 'codex', ['Do it.', 'no headings here', 'More.', 'DONE'])],
      claude: [slow('impl', 'claude', ['ack', 'Did it.', 'And again.', 'NONE']), slow('fresh', 'claude', [])],
    }),
    input,
    output: out.stream,
  })
  await untilText('the first instruction', out.text, /Do it\./)
  input.write('/pause\n')
  // An `operator_requested` pause: rotation is offered on it, and it is emphatically NOT the
  // degradation proxy asking -- which is the whole case for the prompt.
  await untilText('the pause', out.text, /● paused operator_requested/)

  input.write('/rotate\n')
  // CONSOLE-ONLY notice, which is the one thing this file allows `out.text()` to be asserted
  // on: no record carries a prompt, and the claim is about what the operator was shown.
  await untilText('the prompt for a reason', out.text, /why are you rotating this seat/)

  input.write('a fresh reader applying the committed criterion is a stronger test\n')
  await untilText('the rotation to be attempted', out.text, /rolled back|rotated into/)

  // CONTENT off the record. The reason the operator typed is what the relay was given, rather
  // than the pause's own words -- which is exactly what a bare `/rotate` used to record.
  const note = routed(dir, 'rotating implementer:')
  assert.ok(note, `the rotation must be attempted with a reason: ${JSON.stringify(routedAll(dir).map((r) => r.text))}`)
  assert.match(note.text, /rotating implementer: a fresh reader applying the committed criterion is a stronger test/)

  input.write('/continue\n')
  input.end()
  await running
})

/**
 * A handoff with every section a replacement needs, so the transaction gets past the parse.
 *
 * The other rotation tests in this file deliberately hand the advisor prose with no headings:
 * they are about what the operator was PROMPTED, and the transaction rolling back immediately
 * is the cheapest way to reach the assertion. One test here needs the far side -- a transfer
 * that actually completes -- and this is the only fixture that gets there.
 */
const CONSOLE_HANDOFF = `## BRIEF
Keep the work moving.

## STATE
Half done.

## DECISIONS
- none

## EVIDENCE
The implementer says the check passes.

## FILES
- work.ts

## DISAGREEMENT
- none

## NEXT
Carry on.`

/** What a replacement says when it has run the one configured check and agrees with the record. */
const CONSOLE_ACCEPTED = 'CHECK 1: exit 0\n\nRead work.ts and ran the check. It matches the handoff.'

test('a rotation with an unconfirmed disposal warns the operator at the pause (#155)', async () => {
  /**
   * The console half of `rotated_cleanup_failed`, and the reason it is said HERE and not only
   * in the run report.
   *
   * The operator is standing in front of this transaction. An orphaned CLI still holding this
   * seat's tree is something they can go and look for now, with the pause on screen; the same
   * sentence at the end of the run is about a process they stopped thinking about an hour ago.
   *
   * Two claims, and the second is the one a regression would break quietly. The warning has to
   * appear -- and everything the console does for a plain `rotated` has to keep happening around
   * it, because the branch that prints this is the branch that promotes the replacement. A
   * console that reported the warning INSTEAD of the rotation would be describing a rollback
   * that did not occur.
   */
  const dir = repo()
  const out = collect()
  const input = new PassThrough()
  // The failure at the position the adapters actually fail from: `terminated` is their last
  // statement, so a close that rejects leaves the state at `rotating`.
  //
  // The injected message names a step AFTER the pty terminate, to stay consistent with what the
  // fixture records: `FakeRotationSession` marks its teardown complete before it rejects, so a
  // message claiming the pty is known to be alive would contradict the very double producing it.
  // The honest shape is a later step failing over a teardown that already ran -- and even then
  // nobody outside can tell that from a terminate that failed, which is why the console says
  // "could not be confirmed" rather than naming a state of the child.
  const old = slow('impl', 'claude', ['ack', 'Did it.', 'And again.', 'NONE'])
  old.closeThrowsBeforeTerminated = 'receiver.stop: the event server was already closed'
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 6,
    // ARMS ROTATION, and `true` is what the replacement reports on below.
    checks: ['true'],
    registry: registryOf({
      // Every reply after the first IS the handoff, so the test does not depend on how many
      // advisor turns happen to have been spent by the time `/rotate` is typed. That count is a
      // function of turn timing, and a fixture that pins it is an intermittent waiting to
      // happen -- the transaction takes whichever turn it takes, and this way it always parses.
      codex: [slow('advisor', 'codex', ['Do it.', CONSOLE_HANDOFF, CONSOLE_HANDOFF, CONSOLE_HANDOFF, CONSOLE_HANDOFF])],
      claude: [old, slow('fresh', 'claude', [CONSOLE_ACCEPTED, 'Carried on.', 'NONE'])],
    }),
    input,
    output: out.stream,
  })
  await untilText('the first instruction', out.text, /Do it\./)
  input.write('/pause\n')
  await untilText('the pause', out.text, /● paused operator_requested/)

  input.write('/rotate the session is wedged\n')
  await untilText('the rotation to finish', out.text, /rotated into|rolled back/)

  /**
   * Asserted on the console's OWN wording, not on any phrase the routed notes also carry.
   *
   * The relay records the disposal ambiguity too, and the console prints every routed note
   * through `markdown()` -- which wraps at the terminal width, so a phrase assertion that could
   * be satisfied by one of those is satisfied or not depending on where a line break lands
   * (#109). Measured, not guessed: an earlier draft of this test asserted `the rotation itself
   * stands`, and it passed against a build with `rotateNow`'s warning deleted entirely, because
   * the routed note happened to carry the same words.
   *
   * So each of these keys on something only `rotateNow` writes -- `WARNING:`, the `still
   * paused` tail, the lower-case `its state reads` with an em dash -- and those go through
   * `write()`, which emits the string verbatim.
   */
  assert.match(out.text(), /rotated into fresh; still paused/, 'the rotation is reported as the success it is')
  assert.match(
    out.text(),
    /WARNING: the outgoing session could NOT be confirmed disposed of: receiver.stop: the event server was already closed/,
  )
  assert.match(out.text(), /its state reads 'rotating' — check for an orphaned process holding this seat's tree/)
  assert.match(
    out.text(),
    /\(the rotation itself stands; only the teardown of the session it replaced failed\)/,
    'and it is not dressed up as a rollback',
  )

  // ABSENCE off the RECORD, never off the console: a negative assertion against wrapped output
  // is satisfied by a line break landing inside the phrase (#109).
  assert.equal(
    routed(dir, 'rolled back'),
    undefined,
    `nothing was rolled back: ${JSON.stringify(routedAll(dir).map((r) => r.text))}`,
  )
  // And the seat really did change hands, which is the half a warning-only regression would lose.
  assert.ok(routed(dir, 'rotated into fresh'), 'the swap is in the record, not just on screen')

  input.write('/continue\n')
  input.end()
  await running
})

test('a /command typed at the reason prompt cancels the rotation and runs the command (#75)', async () => {
  // An operator who changes their mind at the prompt is the likeliest person to type one, and
  // the alternative is recording `/state` as why a seat was replaced.
  const dir = repo()
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 6,
    checks: ['true'],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'])],
      claude: [slow('impl', 'claude', ['ack', 'Did it.', 'And again.', 'NONE']), slow('fresh', 'claude', [])],
    }),
    input,
    output: out.stream,
  })
  await untilText('the first instruction', out.text, /Do it\./)
  input.write('/pause\n')
  await untilText('the pause', out.text, /● paused operator_requested/)

  input.write('/rotate\n')
  await untilText('the prompt for a reason', out.text, /why are you rotating this seat/)
  input.write('/state\n')
  // Both halves are console-only notices: the cancellation, and the command having been run
  // rather than swallowed as a reason.
  await untilText('the cancellation', out.text, /rotation cancelled/)
  await untilText('/state to answer', out.text, /run: paused \(operator_requested\)/)

  // And nothing was rotated. Asserted as the ABSENCE OF A RECORD rather than of console text,
  // which a wrap could hide: the relay writes `rotating <seat>: <reason>` before it does
  // anything else, so its absence is the seat never having been touched.
  assert.equal(routed(dir, 'rotating implementer:'), undefined, 'the seat must not have been rotated')

  input.write('/continue\n')
  input.end()
  await running
})

test('/rotate at a rotation candidate still costs nothing to answer (#75)', async () => {
  // The other half, and the one that keeps the prompt from being a toll. At THIS pause the
  // proxy is what spoke; agreeing with it is the whole of the operator's contribution, so the
  // pause's own detail is the honest record and no question is put.
  const dir = repo()
  const impl = slow('impl', 'claude', ['ack', 'Did it.', 'And again.', 'NONE'])
  impl.compactOnTurn = 1
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 6,
    checks: ['true'],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'no headings here', 'More.', 'DONE'])],
      claude: [impl, slow('fresh', 'claude', [])],
    }),
    input,
    output: out.stream,
  })
  await untilText('the candidate pause', out.text, /● paused rotation_candidate/)

  input.write('/rotate\n')
  await untilText('the rotation to be attempted', out.text, /rolled back|rotated into/)

  // CONTENT: it went straight through, carrying the proxy's own words. A prompt would have
  // held the command instead, so this note existing at all is the claim.
  const note = routed(dir, 'rotating implementer:')
  assert.ok(note, `an accepted candidate rotates without being asked anything: ${out.text()}`)
  assert.match(note.text, /compaction generation rose 0 → 1/)

  input.write('/continue\n')
  input.end()
  await running
})

test('/rotate WITH a reason at a candidate says the reason was not recorded (#75)', async () => {
  // `/rotate the session is wedged` at a candidate is a natural thing to type, and the record
  // still carries the proxy's words: accepting a candidate is agreement, and `candidate_accepted`
  // beside a sentence the proxy never said is a record whose two fields describe different
  // events. Dropping the sentence is right; dropping it in silence is not. The operator watched
  // their words go into a command and would reasonably assume the record now carries them --
  // which is the same false belief about what the record says that #75 exists to remove.
  const dir = repo()
  const impl = slow('impl', 'claude', ['ack', 'Did it.', 'And again.', 'NONE'])
  impl.compactOnTurn = 1
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 6,
    checks: ['true'],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'no headings here', 'More.', 'DONE'])],
      claude: [impl, slow('fresh', 'claude', [])],
    }),
    input,
    output: out.stream,
  })
  await untilText('the candidate pause', out.text, /● paused rotation_candidate/)

  input.write('/rotate the session is wedged\n')
  // CONSOLE-ONLY notice, and the reason this file may assert on `out.text()` at all: no record
  // carries it, and the claim is precisely about what the operator was shown.
  await untilText('the notice', out.text, /your reason was NOT recorded/)
  // The words it will be recorded in, quoted back on the notice's own line -- matched together
  // rather than separately, because the pause banner above already shows the detail and an
  // assertion on the detail alone would pass without the notice existing at all.
  await untilText("the proxy's words, quoted back", out.text, /proxy's own words: .*compaction generation rose 0 → 1/)
  await untilText('the rotation to be attempted', out.text, /rolled back|rotated into/)

  // CONTENT: and it is not a notice that lies. What the relay was actually given is the pause's
  // own detail, with nothing of the typed sentence in it.
  const note = routed(dir, 'rotating implementer:')
  assert.ok(note, `the rotation must be attempted: ${out.text()}`)
  assert.match(note.text, /compaction generation rose 0 → 1/)
  assert.doesNotMatch(note.text, /wedged/, 'the operator’s gloss is not what the seat was replaced for')

  input.write('/continue\n')
  input.end()
  await running
})

test('any live seat is addressable by its own id, and a name no seat has is refused', async (t) => {
  // #93. `--implementers "claude, claude"` names seats `implementer` and `implementer-2`, and
  // the console's address parser accepted exactly two literal words -- so the second seat could
  // be watched working, listed by `/state` and narrated under its own id, and could not be
  // replied to. The transport was never the constraint: `Audience` is `'all' | {only}`, and
  // `Relay.#resolve` validates `only` against the participant map and returns that id alone.
  // What was missing was the parser, and this is the end-to-end proof that it is not any more.
  //
  // Asserted on the ROUTED RECORD rather than on the drawn line, because the claim is about
  // where the message went. `to` is the whole answer: it is exactly one seat, so every other
  // live seat is excluded by construction, and `/audit` is asserted beside it because that is
  // the surface an operator asks the same question through.
  const dir = repo()
  // Two seats mean linked worktrees cut from a COMMIT, so the console refuses to start with
  // anything uncommitted. The hook files it installs land untracked here, so they are ignored
  // and committed before the run rather than tripping a guard this test is not about.
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n.claude/\n.codex/\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'ignore agent hook files'], { cwd: dir })

  const advisor = slow('advisor', 'codex', ['@seat implementer-2: Sweep the docs.', 'DONE', 'DONE', 'DONE'], 200)
  // A pause the operator can type into, which is the state this is all about: the run is in
  // flight, both seats are up, and the console is where a reply has to be possible.
  advisor.endTurn = { index: 0, verdict: TIMED_OUT }
  const alpha = slow('alpha', 'alpha', ['ack', 'Did it.', 'Did it.', 'NONE'], 50)
  const beta = slow('beta', 'beta', ['ack', 'Did it.', 'Did it.', 'NONE'], 50)
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'alpha',
    // `alpha` fills seat `implementer`, `beta` fills seat `implementer-2` -- the ids the console
    // constructs for a named seat list, and the ones typed below.
    implementers: [
      { agent: 'alpha', args: [] },
      { agent: 'beta', args: [] },
    ],
    rounds: 6,
    checks: [],
    registry: registryOf({
      codex: [advisor],
      alpha: [alpha],
      beta: [beta],
    }),
    input,
    output: out.stream,
  })
  // A guard, not the exit path: the body below closes input and awaits `running` itself. This
  // is what unblocks the console when an assertion throws before it gets there, and both calls
  // are safe to make twice.
  t.after(async () => {
    input.end()
    await running
  })

  await untilText('the pause on the advisor turn', out.text, /paused/)

  input.write('>implementer-2 only you: touch nothing under src/adapters\n')
  await untilText('the second seat to be addressable at all', out.text, /queued for implementer-2/)

  // The same seat through the multi-line form, because the block opener enumerates its heads
  // and that list was two fixed words too. A seat you can address on one line and not in a
  // block is addressable in a way that fails exactly where the longest answers are written.
  input.write('>implementer-2 <<EOF\nfirst line\n\nsecond line\nEOF\n')
  await untilText('the block to be routed', out.text, /queued for implementer-2/)

  // A NAME NO SEAT HAS. Refused and told what exists -- not broadcast to everyone as plain
  // text, which is what a `>` word that is not an address falls through to, and not queued
  // into nothing.
  input.write('>implementor-2 this must go nowhere\n')
  await untilText('the refusal', out.text, /no seat named implementor-2/)

  // PUNCTUATION, one keystroke from a real address. The refusal used to be gated on a seat-id
  // character class, so this was not address-SHAPED, fell past the branch entirely, and went to
  // everyone as plain text -- the silent widening a narrowing prefix exists to prevent. The
  // comma is part of what was typed, so it is part of what is quoted back.
  input.write('>implementer-2, punctuation must go nowhere\n')
  await untilText('the punctuation refusal', out.text, /no seat named implementer-2,/)

  // A TYPOED BLOCK. The head was refused and then the body fell through line by line, each one
  // an unaddressed message to everyone -- so a mistyped address on a paste leaked exactly the
  // text it was narrowing. The block is recognised now, collected, and refused once.
  input.write('>implemnter-2 <<NOPE\nblock body must go nowhere\nnor must this second line\nNOPE\n')
  await untilText('the block refusal', out.text, /no seat named implemnter-2/)
  // The count notice is asserted at the END rather than waited on HERE, and deliberately: a
  // console that refuses the head and then leaks the body line by line still prints this
  // refusal, so a gate on it would pass under exactly the regression the record assertions
  // below exist to catch, and would stop the test before they ran.

  input.write('/audit\n')
  await untilText('the audit', out.text, /informed implementer-2/)

  input.write('/continue\n')
  // The delivery is waited for BEFORE stdin is closed, and the order is load-bearing. A piped
  // console ends on `Promise.race([firstRunEnded, rl close])`, so closing input is one of the
  // two ways this run can finish -- and it is the fast one: it tears the relay down while the
  // queued message is still waiting for the next turn boundary, so the seat never receives it
  // and the assertion below fails every time rather than flaking. Waited for, not slept on.
  await untilValue(
    'implementer-2 to actually be handed the message',
    () => beta.received.find((r) => r.includes('src/adapters')),
    out.text,
  )
  // Closed HERE rather than left to `t.after`, so nothing about finishing this test depends on
  // a hook running: the body closes stdin and waits for the exit code it asserts on.
  input.end()
  assert.equal(await running, 0)

  const text = out.text()
  // The refusal NAMES the seats that exist, which is the whole difference between a refusal
  // and a rejection: a typo is one letter from something real, and the console holds the list.
  // ANCHORED to end-of-line, and that is the point of it rather than tidiness. An unanchored
  // match is satisfied by a refusal that goes on to name seats which do not exist, so it holds
  // the console to naming AT LEAST the live seats -- while the refusal's whole job is to name
  // exactly them. Caught by the operator's mutation: a hardcoded superset passed unanchored.
  assert.match(text, /no seat named implementor-2 — live seats: advisor, implementer, implementer-2$/m, text.slice(-3000))

  // THE RECORD. One recipient, and it is the seat that was named.
  const m = routed(dir, 'touch nothing under src/adapters')
  assert.ok(m, `the message must be routed: ${text.slice(-3000)}`)
  assert.deepEqual([...m.to], ['implementer-2'])
  // Every other LIVE seat, read off the run rather than assumed: the advisor and the first
  // implementer are both up, and neither is a recipient.
  for (const other of ['advisor', 'implementer']) {
    assert.ok(!m.to.includes(other), `${other} is live and must not be a recipient`)
  }
  // And the exclusion as an operator asks for it. `/audit` lists it because the message is
  // `restricted`, which it is only because it reached one of three participants.
  assert.match(text, /informed implementer-2 · excluded advisor, implementer/, text.slice(-3000))

  // The block, verbatim, to the same one seat.
  const block = routed(dir, 'second line')
  assert.ok(block, 'the block must be routed')
  assert.equal(block.text, 'first line\n\nsecond line')
  assert.deepEqual([...block.to], ['implementer-2'])

  // DELIVERED, and to nobody else. The record says where it was addressed; this says what the
  // child was actually handed.
  assert.ok(beta.received.some((r) => r.includes('src/adapters')), 'implementer-2 receives it')
  assert.ok(!alpha.received.some((r) => r.includes('src/adapters')), 'implementer does not')
  assert.ok(!advisor.received.some((r) => r.includes('src/adapters')), 'nor does the advisor')

  // EVERY refused form reached NOTHING. Not a record, not a seat -- neither the opener nor,
  // for the block, the body it framed. The failure mode all three replace is one narrowing
  // prefix silently widening to everyone.
  const refused = [
    'this must go nowhere', // the plain typo
    'punctuation must go nowhere', // one character off a real seat
    'block body must go nowhere', // the block's first body line
    'nor must this second line', // and its second, which fell through separately
  ]
  for (const text of refused) {
    assert.ok(
      routedAll(dir).every((r) => !r.text.includes(text)),
      `a refused address must not be recorded as sent to anyone: ${text}`,
    )
    for (const seat of [advisor, alpha, beta]) {
      assert.ok(!seat.received.some((r) => r.includes(text)), `nor delivered: ${text}`)
    }
  }
  // The block's body was named as undelivered, rather than dropped without a word: the lines
  // were taken off stdin and there is no queue row for them, so the console saying how many is
  // the only account the operator gets.
  assert.match(text, /2 line\(s\) it framed were NOT delivered/, text.slice(-4000))
  // And the refusal quotes back what was typed, punctuation included, so a one-character
  // mistake is visible as one character rather than as an unrecognised word.
  assert.match(text, /no seat named implementer-2, — live seats: advisor, implementer, implementer-2$/m, text.slice(-4000))
})

test('with no run in flight, a named seat is asked DIRECTLY, and only that seat is asked', async (t) => {
  // The other half of #93, and the half that has no queue to inspect. `>seat <text>` takes two
  // paths: with a run it is INJECTED and drained at the next turn boundary, and with none it
  // goes through `askDirectly` -> `Relay.ask`, which sends a turn and waits for the reply. The
  // second path is the reason the console stays up after a run ends -- start the server so I
  // can try it, explain that change -- and it took the same two hardcoded words, so between
  // runs the second seat was not merely unqueueable, it was unaskable.
  //
  // NO GOAL, so no run ever starts. That is the state being tested, not a shortcut to it: the
  // seats are launched by `Relay.start` and are alive; only the loop is absent.
  const dir = repo()
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n.claude/\n.codex/\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'ignore agent hook files'], { cwd: dir })

  const advisor = slow('advisor', 'codex', ['DONE'], 50)
  const alpha = slow('alpha', 'alpha', ['ack'], 50)
  const beta = slow('beta', 'beta', ['the server is up on :4000'], 50)
  const out = collect()
  const input = new PassThrough()
  const running = runSession({
    cwd: dir,
    lead: 'codex',
    implementer: 'alpha',
    implementers: [
      { agent: 'alpha', args: [] },
      { agent: 'beta', args: [] },
    ],
    rounds: 6,
    checks: [],
    registry: registryOf({
      codex: [advisor],
      alpha: [alpha],
      beta: [beta],
    }),
    input,
    output: out.stream,
  })
  // A guard, not the exit path: the body closes input and awaits `running` itself.
  t.after(async () => {
    input.end()
    await running
  })

  await untilText('the console to be waiting for a goal', out.text, /no goal given/)

  input.write('>implementer-2 start the server so I can try it\n')

  // OBSERVED, not slept on, and in both directions: the seat was handed the question, and the
  // answer came back to the operator. A test that only waited for the question would pass on a
  // console that asks and never renders the reply, which is the whole value of this path.
  await untilValue(
    'implementer-2 to be handed the question',
    () => beta.received.find((r) => r.includes('start the server so I can try it')),
    out.text,
  )
  await untilText('the answer to reach the operator', out.text, /the server is up on :4000/)

  input.end()
  assert.equal(await running, 0)

  const text = out.text()
  // THE RECORD. `ask` records the human's question and the seat's reply as two messages, so
  // `/log` and `/audit` see this exactly as they see anything said to one seat and not another.
  const q = routed(dir, 'start the server so I can try it')
  assert.ok(q, `the question must be recorded: ${text.slice(-3000)}`)
  assert.equal(q.from, 'human')
  assert.deepEqual([...q.to], ['implementer-2'])
  const a = routed(dir, 'the server is up on :4000')
  assert.ok(a, 'and so must the answer')
  assert.equal(a.from, 'implementer-2', 'the reply is attributed to the seat that gave it')

  // ONLY that seat. Both others are live -- `Relay.start` launched them -- and neither was
  // sent the question nor saw the answer.
  assert.ok(!alpha.received.some((r) => r.includes('start the server')), 'implementer is not asked')
  assert.ok(!advisor.received.some((r) => r.includes('start the server')), 'nor is the advisor')

  // And no run was started by any of it. A direct question is not a goal, which is the
  // distinction that makes this path worth having at all.
  assert.ok(
    routedAll(dir).every((r) => r.kind !== 'goal'),
    'asking a seat something must not start a run',
  )
})

test('a well-formed id naming no seat in THIS run is refused, and the refusal names exactly the live ones', async () => {
  // The case a drifted seat list gets wrong, and the one an operator hits first: a DEFAULT
  // run, one implementer, and `>implementer-2` typed at it. The id is well-formed -- it is
  // what a second seat would be called, and the operator has seen it in the help -- but no
  // such seat is running, so it must be refused naming the two that are.
  //
  // Every other refusal test uses a two-implementer run where the refused ids are typos, and a
  // typo is absent from any list, live or stale. So none of them can tell `relay.participants`
  // apart from a hardcoded list that has drifted -- which is exactly the second-list failure
  // the design was picked to prevent, and it survived until this test. Found by the operator's
  // independent mutation: replacing `addressable()` with a fixed superset left the suite green.
  const dir = repo()
  const impl = slow('impl', 'claude', ['ack', 'Did it.', 'And again.'])
  const advisor = slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'])
  const out = collect()
  const code = await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    // ONE implementer. No `implementers` key, so this is the run the console has always been.
    implementer: 'claude',
    rounds: 4,
    checks: [],
    registry: registryOf({ codex: [advisor], claude: [impl] }),
    input: script(['>implementer-2 this seat is not in this run', '/audit'], 300),
    output: out.stream,
  })
  assert.equal(code, 0)
  const text = out.text()

  // EXACTLY the live seats, anchored to end-of-line. A refusal that named a seat which is not
  // running would be a worse answer than the silence it replaced: it tells the operator to
  // retype an address that cannot work. The anchor is what holds it to that -- unanchored,
  // `advisor, implementer` matches a line that continues `, implementer-2, implementer-3`.
  assert.match(
    text,
    /no seat named implementer-2 — live seats: advisor, implementer$/m,
    `the refusal must enumerate exactly the running seats: ${text.slice(-3000)}`,
  )

  // NOT RECORDED. `#resolve` would have thrown on an id that names no participant, and the
  // throw would surface as a console error from inside the run loop -- so the difference
  // between refusing and not is also the difference between an answer and a stack trace.
  assert.ok(
    routedAll(dir).every((r) => !r.text.includes('this seat is not in this run')),
    'a refused address must not be recorded as sent to anyone',
  )
  // NOT DELIVERED, to either seat that is actually up.
  for (const seat of [advisor, impl]) {
    assert.ok(!seat.received.some((r) => r.includes('this seat is not in this run')), 'nor delivered')
  }
  // And nothing was withheld from anyone, because nothing was sent: `/audit` is the surface
  // that would show a restricted message, and there is none to show.
  assert.match(text, /no restricted messages/)
})
