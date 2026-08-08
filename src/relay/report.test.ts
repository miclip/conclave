/**
 * The terminal record, as data.
 *
 *   node --test src/relay/report.test.ts
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { Relay } from './relay.ts'
import { runReport, REPORT_SCHEMA } from './report.ts'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-report-'))
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })
  return dir
}

function registryOf(sessions: Record<string, FakeRotationSession[]>): AgentRegistry {
  const r = new AgentRegistry()
  for (const [agent, queue] of Object.entries(sessions)) {
    const remaining = [...queue]
    r.register({
      id: agent,
      displayName: agent,
      capabilities: {
        agent,
        readinessSignal: 'first_turn',
        turnKeySource: 'run_invocation',
        outcomes: {
          completed: 'observed',
          cancelled: 'reasoned_but_unverified',
          permission_refused: 'unsupported',
          process_exited: 'reasoned_but_unverified',
          timed_out: 'reasoned_but_unverified',
          transport_lost: 'reasoned_but_unverified',
          unknown_abnormal_end: 'reasoned_but_unverified',
        },
      },
      launch: { command: agent, baseArgs: [] },
      create: async () => remaining.shift()!,
    })
  }
  return r
}

async function reportOf(replies: string[] = ['DONE']) {
  const dir = repo()
  const relay = await Relay.start({
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', replies)],
      claude: [new FakeRotationSession('impl', 'claude', ['a report'])],
    }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxRounds: 2,
    rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000 },
  })
  const startedAt = Date.now()
  const outcome = await relay.run('a goal')
  const report = await runReport(relay, { goal: 'a goal', outcome, startedAt })
  await relay.stop()
  return { report, relay, dir }
}

test('the report carries the same claims the prose lines make', async () => {
  const { report, dir } = await reportOf()

  assert.equal(report.schema, REPORT_SCHEMA)
  assert.equal(report.goal, 'a goal')
  assert.equal(report.cwd, dir)
  assert.ok(report.messages > 0)
  assert.ok(report.durationMs >= 0)
  assert.deepEqual(
    report.participants.map((p) => p.id).sort(),
    ['advisor', 'implementer'],
  )
})

test('rotation state is reported even when nothing happened', async () => {
  const { report } = await reportOf()
  // The whole point of rotationWatch: a null is only evidence if the instrument was live.
  // A field that vanished when it had nothing to say would put the reader back where they
  // started, unable to tell "saw nothing" from "this build does not report it".
  assert.equal(report.rotation.armed, true)
  assert.equal(typeof report.rotation.assessments, 'number')
  assert.equal(report.rotation.peakGeneration, 0)
})

test('an empty flags array is a claim, not a gap', async () => {
  const { report } = await reportOf()
  assert.deepEqual(report.flags, [])
  assert.deepEqual(report.restricted, [])
})

test('a flagged caveat reaches the record', async () => {
  const dir = repo()
  const relay = await Relay.start({
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['DONE'])],
      claude: [
        new FakeRotationSession('impl', 'claude', [
          'Done.\nFLAG: conformance.sh remains unrun; inherited reasoning.',
        ]),
      ],
    }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxRounds: 2,
  })
  const outcome = await relay.run('a goal')
  const report = await runReport(relay, { goal: 'a goal', outcome, startedAt: Date.now() })
  await relay.stop()

  assert.equal(report.flags.length, 1)
  assert.match(report.flags[0]!.text, /conformance\.sh/)
  // An operator confirming this run reads `outcome.reason` and `flags` together. The verdict
  // being `done` while something is outstanding is precisely the case the record exists for.
  assert.equal(report.outcome.reason, 'done')
})

test('per-turn verdicts carry their confidence and provenance, not just a state', async () => {
  const { report } = await reportOf()
  const impl = report.participants.find((p) => p.id === 'implementer')!
  assert.ok(impl.turns.length > 0)
  const turn = impl.turns[0]!
  // The reason this is one issue and not two: a record that reported `completed` without
  // saying how strongly it was evidenced is exactly the prose summary, in JSON.
  assert.equal(typeof turn.state, 'string')
  assert.ok('confidence' in turn, 'the grade travels with the verdict')
  assert.ok(Array.isArray(turn.tools))
})

test('the record is JSON-serialisable with no cycles or undefined-only keys', async () => {
  const { report } = await reportOf()
  const round = JSON.parse(JSON.stringify(report))
  assert.equal(round.schema, REPORT_SCHEMA)
  assert.equal(round.goal, report.goal)
  // Serialised and re-read, because a consumer never sees the object -- it sees the bytes.
  assert.deepEqual(round.rotation, report.rotation)
})

test('under --json nothing but the report may reach stdout', () => {
  // A structural check on the source, because the failure it guards is invisible at runtime
  // until a consumer chokes on a log line it did not expect. `config check --json` learned
  // this the same way: a stray line alongside valid JSON makes a machine-readable mode
  // useless, and the parse succeeds right up until it does not.
  //
  // Every human-facing line in the relay command goes through `say`, which writes to stderr
  // when --json is set. Only the report itself uses console.log.
  const cli = readFileSync(join(REPO, 'bin', 'conclave.ts'), 'utf8')
  const start = cli.indexOf("if (command === 'relay'")
  const end = cli.indexOf("if (command === 'session'")
  assert.ok(start > 0 && end > start, 'the relay command block must be locatable')
  const block = cli.slice(start, end)

  const stdoutWrites = block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('console.log('))
    // Two writes are legitimate and are named rather than counted around:
    //   - the `say` helper's own definition, which is what routes everything else
    //   - `--help`, which returns before a run starts and has no report to conflict with
    .filter((l) => !l.startsWith('const say ='))
    .filter((l) => !l.includes('console.log(USAGE)'))
    //   - `--detach`, whose entire product IS the session id on stdout, for
    //     `ID=$(conclave relay ... --detach)`. It returns before a run starts, so it can
    //     never collide with a report, and under --json it emits JSON like everything else.
    //     Named rather than allowed by pattern: "a bare value is fine" is how the next
    //     stray log line gets in.
    .filter((l) => l !== 'console.log(id)')

  // The invariant is not "one write" -- `--dry-run --json` legitimately emits a plan instead
  // of a report, and the two are mutually exclusive because dry-run returns before the run.
  // It is that NOTHING reaches stdout except serialised JSON.
  for (const line of stdoutWrites) {
    assert.match(
      line,
      /console\.log\(JSON\.stringify\(/,
      `stdout may carry only serialised JSON; found: ${line}`,
    )
  }
  assert.ok(
    stdoutWrites.some((l) => l.includes('runReport')),
    'and the report is one of them',
  )

  // The exception above is only safe while both halves hold: the id goes to stdout ALONE,
  // and --json takes the JSON path instead. Asserted here so the exemption cannot outlive
  // the reasoning for it.
  const detach = block.slice(block.indexOf("if (rest.includes('--detach')) {"))
  const detachEnd = detach.indexOf('\n    }\n')
  const detachBlock = detach.slice(0, detachEnd)
  assert.ok(detachBlock.includes('console.log(id)'), 'the detach block must be locatable')
  assert.ok(
    detachBlock.includes('console.log(JSON.stringify('),
    '--detach --json must emit JSON on stdout, not the bare id',
  )
  assert.ok(
    detachBlock.includes('console.error(`  detached as pid'),
    'everything a human reads about a detached run must go to stderr',
  )
})

test('a resumed relay tells both seats they are continuing (#34)', async () => {
  const dir = repo()
  const lead = new FakeRotationSession('advisor', 'codex', ['DONE'])
  const impl = new FakeRotationSession('impl', 'claude', ['a report'])
  const relay = await Relay.start({
    registry: registryOf({ codex: [lead], claude: [impl] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxRounds: 2,
    resume: [
      {
        seq: 1,
        at: 1,
        from: 'implementer',
        fromRank: 'implementer',
        to: ['advisor'],
        kind: 'report',
        text: 'The harness is at rung2_measure_test.go; 12 implications found.',
        visibility: 'all',
        excluded: [],
      } as never,
    ],
  })
  await relay.run('finish the measurement')
  await relay.stop()

  // BOTH seats. An advisor that does not know what it already decided re-issues an
  // instruction the log shows as completed, which is the same waste from the other end.
  for (const [who, session] of [['implementer', impl], ['advisor', lead]] as const) {
    const first = session.received[0]!
    assert.match(first, /THIS RUN IS A CONTINUATION/, `${who} must be told it is resuming`)
    assert.match(first, /rung2_measure_test\.go/, `${who} must receive the prior log verbatim`)
  }
})

test('a turn ceiling ends the run with its own reason (#28)', async () => {
  const dir = repo()
  const relay = await Relay.start({
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['keep going', 'keep going', 'keep going'])],
      claude: [new FakeRotationSession('impl', 'claude', ['working', 'working', 'working'])],
    }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxRounds: 20,
    ceilings: { maxTurns: 3 },
  })
  const outcome = await relay.run('a long goal')
  await relay.stop()

  // Its own reason, not `budget`. `budget` means the round structure ran its course; this
  // means the run was still going and was stopped, and an operator deciding whether to
  // resume needs to know which happened.
  assert.equal(outcome.reason, 'ceiling')
  assert.match(outcome.detail ?? '', /turn ceiling reached/)
})

test('the default briefing is byte-identical when the operator is human (#27)', async () => {
  // A live experiment runs against the unmodified briefing, and its pre-registration says not
  // to change it mid-study (spikes/experiments/04-complaint-as-signal.md). The agent-operator
  // guidance is APPENDED for one case rather than edited into LEAD_BRIEFING, so the default
  // path stays exactly what the experiment measured.
  const dir = repo()
  const lead = new FakeRotationSession('advisor', 'codex', ['DONE'])
  const relay = await Relay.start({
    registry: registryOf({ codex: [lead], claude: [new FakeRotationSession('i', 'claude', ['r'])] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxRounds: 2,
  })
  await relay.run('a goal')
  await relay.stop()

  assert.doesNotMatch(lead.received[0]!, /operator of this session is an AGENT/)
  assert.equal(relay.operator, 'human')
})

test('an agent operator is told what to escalate, and what not to', async () => {
  const dir = repo()
  const lead = new FakeRotationSession('advisor', 'codex', ['DONE'])
  const relay = await Relay.start({
    registry: registryOf({ codex: [lead], claude: [new FakeRotationSession('i', 'claude', ['r'])] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxRounds: 2,
    operator: 'agent',
  })
  const outcome = await relay.run('a goal')
  const first = lead.received[0]!

  assert.match(first, /operator of this session is an AGENT/)
  // Not merely "ask more". An operator of the same kind as the participants shares their
  // blind spots, so permission questions add nothing and premise questions are the value.
  assert.match(first, /premise in the goal you suspect is wrong/)
  assert.match(first, /Do NOT escalate to ask permission/)
  // And the advisor is told the answer is not independent evidence.
  assert.match(first, /not independent confirmation/)

  // Recorded, because it changes what an escalation MEANS and the routing log cannot show it.
  const report = await runReport(relay, { goal: 'a goal', outcome, startedAt: Date.now() })
  assert.equal(report.operator, 'agent')
  await relay.stop()
})

test('an advisor that produces no instruction never relays an empty message (#35)', async () => {
  // The minimum bar from the issue: there is no circumstance in which relaying nothing is
  // right. The implementer received a routing header with no body, asked for a resend, and
  // the run churned rounds toward its budget instead of failing with the real reason.
  //
  // The existing `turn_incomplete` guard covers the IMPLEMENTER only, which is why an
  // advisor whose turn errored went straight through it.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['a report'])
  const relay = await Relay.start({
    registry: registryOf({
      // No scripted replies: every advisor turn comes back empty, as an errored one does.
      codex: [new FakeRotationSession('advisor', 'codex', [])],
      claude: [impl],
    }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxRounds: 4,
  })
  const outcome = await relay.run('a goal')
  await relay.stop()

  // Ends rather than churning rounds.
  assert.equal(outcome.reason, 'escalated')
  assert.match(outcome.detail ?? '', /produced no instruction/)
  // And the implementer was never handed an empty body.
  const relayed = relay.log.filter((m) => m.from === 'advisor' && m.to.includes('implementer'))
  assert.ok(
    relayed.every((m) => m.text.trim() !== ''),
    'no empty instruction may reach the implementer',
  )
})

test('the implementer gets a guaranteed last word when the advisor says DONE (#37)', async () => {
  // A run used to end on the advisor's verdict alone. In the first live four-agent run the
  // implementer ended its report with a direct question -- "if you intended something else,
  // tell me what the expected behaviour should be" -- the advisor replied DONE, and the run
  // reported unqualified success with the question unanswered and unrecorded.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', [
    'Done, but I did not change anything because nothing was wrong.',
    'FLAG: the premise in the goal was false; add() already returned a + b.',
  ])
  const relay = await Relay.start({
    registry: registryOf({ codex: [new FakeRotationSession('advisor', 'codex', ['DONE'])], claude: [impl] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxRounds: 3,
  })
  const outcome = await relay.run('a goal with a false premise')
  const report = await runReport(relay, { goal: 'g', outcome, startedAt: Date.now() })
  await relay.stop()

  assert.match(impl.received.at(-1)!, /is anything unresolved, unverified, or unanswered/)
  assert.equal(outcome.reason, 'done', 'it does not reopen the work')
  assert.equal(report.flags.length, 1)
  assert.match(report.flags[0]!.text, /premise in the goal was false/)
})

test('an unstructured closing answer is carried anyway (#38)', async () => {
  // The FLAG: convention was not used by the one real participant that had something to
  // flag -- it wrote prose. Discarding an answer for lacking a prefix would repeat exactly
  // the failure this exists to fix.
  const dir = repo()
  const relay = await Relay.start({
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['DONE'])],
      claude: [new FakeRotationSession('impl', 'claude', ['done', 'I never ran the conformance script.'])],
    }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxRounds: 3,
  })
  const outcome = await relay.run('a goal')
  const report = await runReport(relay, { goal: 'g', outcome, startedAt: Date.now() })
  await relay.stop()

  assert.equal(report.flags.length, 1)
  assert.match(report.flags[0]!.text, /never ran the conformance script/)
})

test('NONE means nothing outstanding, and adds no noise', async () => {
  // The line must not appear on a clean run, or it trains the reader to skip the exact place
  // a real flag shows up.
  const dir = repo()
  const relay = await Relay.start({
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['DONE'])],
      claude: [new FakeRotationSession('impl', 'claude', ['done', 'NONE'])],
    }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxRounds: 3,
  })
  const outcome = await relay.run('a goal')
  const report = await runReport(relay, { goal: 'g', outcome, startedAt: Date.now() })
  await relay.stop()

  assert.deepEqual(report.flags, [])
  assert.deepEqual(relay.flagSummary(), [])
})

test('an advisor NOTE reaches the human without halting or reaching the implementer (#1)', async () => {
  // The advisor had two options and neither was this: fold the finding into the next
  // instruction, polluting it with something the implementer does not need, or ESCALATE,
  // which stops the run to say it. A finding worth recording but not worth stopping for died
  // with the turn.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['did it', 'NONE'])
  const relay = await Relay.start({
    registry: registryOf({
      codex: [
        new FakeRotationSession('advisor', 'codex', [
          'NOTE: the goal assumes a bug that may not exist; proceeding to check rather than fix.\nRead calc.py and report what add() does.',
          'DONE',
        ]),
      ],
      claude: [impl],
    }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxRounds: 3,
  })
  const outcome = await relay.run('a goal')
  await relay.stop()

  // Non-halting: the run carried on to its normal end.
  assert.equal(outcome.reason, 'done')

  // Recorded for the operator, addressed to nobody.
  const note = relay.log.find((m) => m.from === 'advisor' && m.kind === 'note' && /may not exist/.test(m.text))
  assert.ok(note, 'the note is in the routing log')
  assert.deepEqual(note!.to, [], 'addressed to the operator, not to a participant')

  // And stripped from what the implementer received, which is the whole point.
  const sent = impl.received.join('\n')
  assert.match(sent, /Read calc\.py/, 'the instruction still arrived')
  assert.doesNotMatch(sent, /may not exist/, 'the note did not')
})

test('a reply that is ONLY a note is not treated as an instruction', async () => {
  // Otherwise stripping the note leaves an empty instruction, which the #35 guard would
  // correctly refuse -- ending a run because the advisor said something useful.
  const { splitNotes } = await import('./relay.ts')
  const { notes, rest } = splitNotes('NOTE: just so you know.')
  assert.deepEqual(notes, ['just so you know.'])
  assert.equal(rest, '', 'the caller sees an empty instruction and handles it as one')
})

test('a note-only reply is asked again rather than ending the run (#1)', async () => {
  // Stripping a note can leave an empty instruction, which the #35 guard correctly refuses.
  // Halting there would end a run BECAUSE the advisor said something useful, so it is asked
  // once for the instruction that goes with the note.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['did it', 'NONE'])
  const relay = await Relay.start({
    registry: registryOf({
      codex: [
        new FakeRotationSession('advisor', 'codex', [
          'NOTE: the premise looks wrong to me.',
          'Read calc.py and report what add() does.',
          'DONE',
        ]),
      ],
      claude: [impl],
    }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxRounds: 3,
  })
  const outcome = await relay.run('a goal')
  await relay.stop()

  assert.equal(outcome.reason, 'done', 'the run was not ended by a useful note')
  assert.ok(relay.log.some((m) => m.kind === 'note' && /premise looks wrong/.test(m.text)))
  assert.match(impl.received.join('\n'), /Read calc\.py/, 'and the instruction still arrived')
})

test('a dead implementer does not turn a completed run into a transport failure (#5 review)', async () => {
  // The closing question runs AFTER the advisor's DONE is recorded. If the implementer's
  // session is gone, `send` throws, `#loop`'s catch converts an already-completed run into
  // `transport_failed`, and the log contradicts itself -- `advisor reports the work complete`
  // is already in it.
  //
  // A closing question is worth one turn, never a verdict.
  const dir = repo()
  const impl = new FakeRotationSession('impl', 'claude', ['did the work'])
  const relay = await Relay.start({
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['DONE'])],
      claude: [impl],
    }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxRounds: 3,
  })
  // Every send after the first throws, as a dead pty does.
  impl.failSendOnTurn = 1

  const outcome = await relay.run('a goal')
  await relay.stop()

  assert.equal(outcome.reason, 'done', 'the advisor said DONE and that stands')
  assert.notEqual(outcome.reason, 'transport_failed')
})
