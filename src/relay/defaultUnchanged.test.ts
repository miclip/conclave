/**
 * One advisor and one implementer stays the default, and its observable surface does not change.
 *
 * N=1 is the identity case of every new abstraction: a seat's tree at N=1 IS the operator's
 * cwd, the task queue at N=1 with one seat IS the round loop, and the blocking scopes at N=1
 * all denote the same set. The default run must not pay for features it did not ask for.
 *
 * This guard inverts the invariant the same way `frontEndParity.test.ts` does: divergence is
 * allowed and must be DECLARED with a reason. Any change to the default run's participant ids,
 * cwd, flags, status JSON keys, or report shape must be written down before it ships.
 *
 *   node --test src/relay/defaultUnchanged.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import { main } from '../../bin/conclave.ts'
import { runSession } from '../repl/session.ts'
import type { AgentEvent, AgentSession, CloseMode, SessionSnapshot, SessionState, TurnKey } from '../contract/session.ts'
import { guaranteesFor, turnKey } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import type { CreateParticipantContext, ResolvedParticipant } from '../registry/types.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { Relay } from './relay.ts'
import { worktreePaths } from './subagents.ts'

const CLI = readFileSync(join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts'), 'utf8')
const RELAY = readFileSync(join(import.meta.dirname, 'relay.ts'), 'utf8')
const SESSION = readFileSync(join(import.meta.dirname, '..', 'repl', 'session.ts'), 'utf8')
const SESSION_RECORD = readFileSync(join(import.meta.dirname, '..', 'workspace', 'sessionRecord.ts'), 'utf8')
const SESSION_VIEW = readFileSync(join(import.meta.dirname, '..', 'workspace', 'sessionView.ts'), 'utf8')
const REPORT = readFileSync(join(import.meta.dirname, 'report.ts'), 'utf8')

/** Minimal in-memory agent for the dynamic default-run guard. */
class DefaultRunFakeSession implements AgentSession {
  readonly agent: string
  readonly sessionId: string
  readonly guarantees = guaranteesFor('mediated')
  state: SessionState = 'running'
  readonly received: string[] = []
  onSend: ((message: string) => void) | undefined
  #replies: string[]
  #queue: AgentEvent[] = []
  #waiters: ((e: IteratorResult<AgentEvent>) => void)[] = []
  #seq = 0
  #turns: { key: TurnKey; prose: string }[] = []

  constructor(agent: string, sessionId: string, replies: string[]) {
    this.agent = agent
    this.sessionId = sessionId
    this.#replies = replies
  }

  async send(message: string): Promise<TurnKey> {
    this.received.push(message)
    this.onSend?.(message)
    const key = turnKey(`${this.sessionId}-turn-${this.#turns.length}`)
    const prose = this.#replies.shift() ?? 'DONE'
    this.#turns.push({ key, prose })
    this.#emit({
      type: 'turn_end',
      verdict: { outcome: 'completed', confidence: 'proven', provenance: [{ source: 'hook', detail: 'Stop' }] },
      synthesized: false,
      turnKey: key,
      seq: ++this.#seq,
      at: Date.now(),
      provisional: false,
    })
    return key
  }

  #emit(e: AgentEvent): void {
    const w = this.#waiters.shift()
    if (w) w({ value: e, done: false })
    else this.#queue.push(e)
  }

  events(): AsyncIterable<AgentEvent> {
    const self = this
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<AgentEvent>>((resolve) => {
            const item = self.#queue.shift()
            if (item) resolve({ value: item, done: false })
            else self.#waiters.push(resolve)
          }),
      }),
    }
  }

  async snapshot(): Promise<SessionSnapshot> {
    return {
      sessionId: this.sessionId,
      agent: this.agent,
      cwd: '/tmp',
      turns: this.#turns.map((t) => ({
        key: t.key,
        prompt: '',
        state: 'completed',
        assistantText: t.prose,
        report: undefined,
        toolCalls: [],
      })),
      guarantees: this.guarantees,
      compactionGeneration: 0,
      builtAt: Date.now(),
    }
  }

  async quiesce(): Promise<void> {
    this.state = 'quiesced'
  }
  async unquiesce(): Promise<void> {
    this.state = 'running'
  }
  async beginRotation(): Promise<void> {
    this.state = 'rotating'
  }
  async cancel(): Promise<TurnKey | undefined> {
    return undefined
  }
  async decidePermission(): Promise<void> {}
  async fork(): Promise<AgentSession> {
    throw new Error('not implemented')
  }
  async close(mode: CloseMode = 'graceful'): Promise<void> {
    this.state = 'terminated'
  }
}

interface CreateRecord {
  id: string
  cwd: string
}

function defaultRegistry(
  sessions: Record<string, DefaultRunFakeSession>,
  records: CreateRecord[],
): AgentRegistry {
  const r = new AgentRegistry()
  for (const [agent, session] of Object.entries(sessions)) {
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
      async create(resolved: ResolvedParticipant, ctx: CreateParticipantContext) {
        records.push({ id: resolved.spec.id, cwd: ctx.cwd })
        return session
      },
    })
  }
  return r
}

function commandBlock(name: string, endsBefore: string): string {
  const start = CLI.indexOf(`if (command === '${name}')`)
  const end = CLI.indexOf(endsBefore, start)
  assert.ok(start > 0 && end > start, `the ${name} command block must be locatable`)
  return CLI.slice(start, end)
}

/** A repository for a front-end to run in. Both refuse to start outside one. */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-default-'))
  execFileSync('git', ['init', '--quiet'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'README.md'), '# hello')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: dir })
  return dir
}

/**
 * Run a front-end with its prose swallowed.
 *
 * `relay` writes its whole routing log through `console.log`/`console.error`, which is the
 * right behaviour for the command and unreadable interleaved with a test reporter.
 */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const [log, error] = [console.log, console.error]
  console.log = () => {}
  console.error = () => {}
  try {
    return await work()
  } finally {
    console.log = log
    console.error = error
  }
}

/** A console input that stays open, so the session ends on its own terms rather than on EOF. */
function idleInput(): PassThrough {
  return new PassThrough()
}

function sink(): NodeJS.WritableStream {
  return new Writable({
    write(_c, _e, cb) {
      cb()
    },
  })
}

function interfaceKeys(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name} {`)
  assert.ok(start > 0, `${name} interface must be locatable`)
  const open = source.indexOf('{', start)
  assert.ok(open > start, `${name} interface must have a body`)
  let depth = 0
  let end = open
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  assert.ok(end > open, `${name} interface body must close`)
  const block = source.slice(open + 1, end)
  const lines = block.split('\n')
  const keys: string[] = []
  let baseIndent: number | undefined
  for (const line of lines) {
    const trimmed = line.trimStart()
    if (trimmed.length === 0) continue
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue
    const indent = line.length - trimmed.length
    const match = trimmed.match(/^(\w+)(\?)?:/)
    if (!match) continue
    if (baseIndent === undefined) {
      baseIndent = indent
      keys.push(match[1]!)
    } else if (indent === baseIndent) {
      keys.push(match[1]!)
    }
  }
  return keys
}

/** Every `--flag` the block actually reads. Both spellings the CLI uses. */
function flagsIn(block: string): Set<string> {
  return new Set([
    ...[...block.matchAll(/flag\('([a-z-]+)'/g)].map((m) => m[1]!),
    ...[...block.matchAll(/includes\('--([a-z-]+)'\)/g)].map((m) => m[1]!),
  ])
}

function assertFlagHelperOptional(block: string, label: string): void {
  const helperStart = block.indexOf('const flag =')
  assert.ok(helperStart > 0, `${label} flag helper must be present`)
  const helperEnd = block.indexOf('\n    const ', helperStart)
  const helper = block.slice(helperStart, helperEnd > 0 ? helperEnd : helperStart + 500)
  // The relay helper returns the fallback when the flag is absent:
  // bin/conclave.ts:741-744. The session helper returns the fallback both when the flag is
  // absent and when it is present without a value: bin/conclave.ts:1134-1143.
  assert.match(
    helper,
    /return i >= 0 \? \(rest\[i \+ 1\] \?\? fallback\) : fallback|if \(i < 0\) return fallback/,
    `${label} flag helper must return the fallback when the flag is absent`,
  )
}

/**
 * Divergence that is a decision rather than an oversight.
 *
 * The only declared exception at N=1 is authority routing: `implementer_unanswered` stops
 * going straight to the operator and is routed to the advisor first. This is a real UX change
 * at the default size, and it is written down here instead of being found later.
 */
const DECLARED: Record<string, string> = {
  'implementer_unanswered -> advisor':
    'Authority routing (#56, D2) sends implementer_unanswered to the advisor before the operator, ' +
    'so a default run interrupts the human less than today. Real change at N=1, an improvement, ' +
    'declared rather than discovered. The pause reason exists at src/relay/run.ts:50 and is raised ' +
    'at src/relay/relay.ts:2036.',
}

test('DECLARED contains exactly the one pending authority-routing exception', () => {
  assert.deepEqual(Object.keys(DECLARED), ['implementer_unanswered -> advisor'])
})

/**
 * The seat ids each front-end actually constructs.
 *
 * Observed at the registry, which is the last place the id is Conclave's own before it
 * becomes a participant: `Relay.start` resolves each spec and hands it to
 * `AgentRegistry#createParticipant`, so `resolved.spec.id` here is the string the front-end
 * put in the option object and nothing the test supplied.
 *
 * Both front-ends are driven through their production entry point -- `main('relay', ...)`
 * from `bin/conclave.ts` and `runSession` from the console -- with only the registry
 * replaced. Nothing else about the default invocation is stubbed: no seat ids, no cwd, no
 * rounds beyond the default flag parsing.
 */
async function seatIdsFromRelayCli(): Promise<string[]> {
  const repo = tempRepo()
  const before = process.cwd()
  const creates: CreateRecord[] = []
  const registry = defaultRegistry(
    {
      'fake-lead': new DefaultRunFakeSession('fake-lead', 'lead-1', ['DONE']),
      'fake-impl': new DefaultRunFakeSession('fake-impl', 'impl-1', []),
    },
    creates,
  )
  try {
    // The relay command reads `process.cwd()` and takes no cwd flag, which is itself part of
    // the default surface this file guards.
    process.chdir(repo)
    const code = await quietly(() =>
      main(['relay', 'a default goal', '--advisor', 'fake-lead', '--implementer', 'fake-impl', '--rounds', '2'], {
        registry,
      }),
    )
    assert.equal(code, 0, 'a default relay run must succeed')
  } finally {
    process.chdir(before)
    rmSync(repo, { recursive: true, force: true })
  }
  return creates.map((c) => c.id)
}

async function seatIdsFromConsole(): Promise<string[]> {
  const repo = tempRepo()
  const creates: CreateRecord[] = []
  const registry = defaultRegistry(
    {
      'fake-lead': new DefaultRunFakeSession('fake-lead', 'lead-1', ['DONE']),
      'fake-impl': new DefaultRunFakeSession('fake-impl', 'impl-1', []),
    },
    creates,
  )
  try {
    const code = await runSession({
      cwd: repo,
      goal: 'a default goal',
      lead: 'fake-lead',
      implementer: 'fake-impl',
      rounds: 2,
      checks: [],
      registry,
      input: idleInput(),
      output: sink(),
    })
    assert.equal(code, 0, 'a default console run must succeed')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
  return creates.map((c) => c.id)
}

test('default relay and session runs construct exactly the two participant ids', async () => {
  // The lead is 'advisor' and the implementer is 'implementer', on both front-ends, and a
  // default run has exactly those two seats and no third. bin/conclave.ts sets the relay
  // pair; src/repl/session.ts sets the console's.
  //
  // Sorted rather than ordered: which seat is constructed first is Relay.start's business,
  // and pinning it here would make this guard fail on a change it does not speak to.
  assert.deepEqual(
    (await seatIdsFromRelayCli()).sort(),
    ['advisor', 'implementer'],
    'the relay CLI must construct exactly the advisor and implementer seats',
  )
  assert.deepEqual(
    (await seatIdsFromConsole()).sort(),
    ['advisor', 'implementer'],
    'the console must construct exactly the advisor and implementer seats',
  )
})

test('default run works in the run cwd and creates no worktree', async () => {
  const relay = commandBlock('relay', "if (command === 'session')")
  const session = commandBlock('session', "if (command === 'demo')")

  // The relay CLI passes process.cwd() as the run cwd: bin/conclave.ts:983.
  // The session CLI passes process.cwd() to runSession: bin/conclave.ts:1181.
  // The console forwards opts.cwd to Relay.start: src/repl/session.ts:569.
  // The relay hands that same cwd to each participant adapter: src/relay/relay.ts:662.
  // The cwd getter simply returns the option: src/relay/relay.ts:615.
  assert.match(relay, /cwd:\s*process\.cwd\(\)/, 'relay block must start in process.cwd')
  assert.match(session, /cwd:\s*process\.cwd\(\)/, 'session block must start in process.cwd')
  assert.match(SESSION, /Relay\.start\(\{\s*registry:[^}]*cwd:\s*opts\.cwd/s, 'console must pass opts.cwd to Relay.start')
  assert.match(
    RELAY,
    /registry\.createParticipant\(spec, \{\s*cwd:\s*this\.#opts\.cwd/s,
    'participant must be created in the run cwd',
  )

  // A default run with no subagents must not create any git worktree. The relay only samples
  // the worktree list for its subagent-use report: src/relay/subagents.ts:68 defines
  // worktreePaths, and src/relay/relay.ts:1144-1155, :1200-1202, and :1816-1817 read it.
  // Prove it by exercising the run in a real temporary repository.
  const repo = mkdtempSync(join(tmpdir(), 'conclave-default-'))
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
    writeFileSync(join(repo, 'README.md'), '# hello')
    execFileSync('git', ['add', 'README.md'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: repo })

    const initial = worktreePaths(repo)
    const lead = new DefaultRunFakeSession('fake-lead', 'lead-1', ['DONE'])
    const impl = new DefaultRunFakeSession('fake-impl', 'impl-1', [])
    const during: string[][] = []
    lead.onSend = () => during.push(worktreePaths(repo))
    impl.onSend = () => during.push(worktreePaths(repo))

    const creates: CreateRecord[] = []
    const relayInstance = await Relay.start({
      registry: defaultRegistry({ 'fake-lead': lead, 'fake-impl': impl }, creates),
      cwd: repo,
      lead: { id: 'advisor', agent: 'fake-lead', role: 'advisor' },
      implementer: { id: 'implementer', agent: 'fake-impl', role: 'implementer' },
      maxRounds: 3,
    })
    const afterStart = worktreePaths(repo)
    await relayInstance.run('a default goal')
    assert.ok(lead.received.length >= 1, 'advisor must be sent the briefing/goal')
    assert.ok(impl.received.length >= 1, 'implementer must be sent the briefing')
    const afterRun = worktreePaths(repo)

    const implCreate = creates.find((c) => c.id === 'implementer')
    assert.ok(implCreate, 'implementer must have been created through the registry')
    assert.equal(implCreate.cwd, repo, 'implementer must be created in the run cwd')

    assert.deepEqual(afterStart, initial, 'worktree list must be unchanged after Relay.start')
    assert.deepEqual(afterRun, initial, 'worktree list must be unchanged after run')
    for (const sample of during) {
      assert.deepEqual(sample, initial, 'worktree list must be unchanged during every turn')
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('no optional flag becomes required in the default relay or session blocks', () => {
  const relay = commandBlock('relay', "if (command === 'session')")
  const session = commandBlock('session', "if (command === 'demo')")

  // A default invocation must be able to run with just a goal. Both front-ends define the flag
  // helper with a fallback: bin/conclave.ts:741 (relay) and bin/conclave.ts:1134 (session).
  // Every flag read here uses that helper, so none become required.
  assertFlagHelperOptional(relay, 'relay')
  assertFlagHelperOptional(session, 'session')

  // Pin the current optional flag set for each front-end. This includes both the valued flags
  // read with flag('--name') and the boolean flags checked with includes('--name').
  // Adding a flag or removing the fallback from a valued flag must be a deliberate change.
  const relayFlags = flagsIn(relay)
  const sessionFlags = flagsIn(session)
  assert.deepEqual(
    [...relayFlags].sort(),
    [
      'advisor',
      'advisor-args',
      'checks',
      'checks-informational',
      'checks-unrelated',
      'detach',
      'detached-id',
      'dry-run',
      'force',
      'implementer',
      'implementer-args',
      'json',
      'lead',
      'lead-args',
      'max-minutes',
      'max-turns',
      'operator',
      'record',
      'resume',
      'rounds',
      'salvage',
      'settle',
      'strict-goal',
      'turn-timeout',
    ],
    'relay optional flag set must not change without updating the guard',
  )
  assert.deepEqual(
    [...sessionFlags].sort(),
    [
      'advisor',
      'advisor-args',
      'checks',
      'checks-informational',
      'checks-unrelated',
      'force',
      'implementer',
      'implementer-args',
      'lead',
      'lead-args',
      'operator',
      'record',
      'resume',
      'rounds',
      'salvage',
      'settle',
      'turn-timeout',
    ],
    'session optional flag set must not change without updating the guard',
  )
})

test('status --json keys at N=1 are the current SessionStatus set plus alive and abandoned', () => {
  // The session status interface is the contract: src/workspace/sessionRecord.ts:132-168.
  const statusKeys = interfaceKeys(SESSION_RECORD, 'SessionStatus')
  assert.deepEqual(
    statusKeys,
    [
      'schema',
      'id',
      'pid',
      'cwd',
      'goal',
      'front',
      'operator',
      'state',
      'startedAt',
      'updatedAt',
      'messages',
      'participants',
      'pause',
      'outcome',
      'eventsPath',
      'logPath',
      'build',
    ],
    'SessionStatus must not gain or lose top-level fields at N=1',
  )

  // formatSessionJson spreads the status and adds the two computed outside fields:
  // src/workspace/sessionView.ts:87-88.
  assert.match(
    SESSION_VIEW,
    /JSON\.stringify\(\{\s*\.\.\.s\.status,\s*alive:\s*s\.alive,\s*abandoned:\s*s\.abandoned\s*\}/,
    'status --json must add only alive and abandoned to the status record',
  )
})

/**
 * The seat block inside both records, pinned separately.
 *
 * The two tests either side of this one read TOP-LEVEL keys, so a field added to a
 * participant would have slipped past them — and the participant block is exactly where
 * per-seat features land. `role` is the first of those and is the reason this pin exists.
 *
 * It is NOT a declared divergence. It is additive and constant at N=1: every default run
 * reports `implementer`, no key changes value, no prose changes, and nothing that was
 * optional becomes required. A reader who ignores the field sees the record it saw before.
 * The alternative — omitting `role` when it equals the rank — is the `if (seats.length === 1)`
 * branch D1 rules out, and `report.ts` already argues the case against fields that vanish
 * when they have nothing to say: a reader then cannot tell "no role" from "this build does
 * not report roles".
 */
test('the participant block in the report and the status file gains role and nothing else', () => {
  assert.deepEqual(
    interfaceKeys(REPORT, 'ReportedParticipant'),
    ['id', 'agent', 'rank', 'role', 'sessionId', 'turns', 'compactionGeneration'],
    'ReportedParticipant must not gain or lose fields without a decision',
  )
  assert.deepEqual(
    interfaceKeys(SESSION_RECORD, 'SessionParticipantStatus'),
    ['id', 'agent', 'rank', 'role', 'turns', 'activity', 'awaitingPermission'],
    'SessionParticipantStatus must not gain or lose fields without a decision',
  )
})

test('run report shape is unchanged', () => {
  // The report schema is the wire contract for the final run record: src/relay/report.ts:63-134.
  const reportKeys = interfaceKeys(REPORT, 'RunReport')
  assert.deepEqual(
    reportKeys,
    [
      'schema',
      'goal',
      'cwd',
      'build',
      'operator',
      'outcome',
      'deadlines',
      'startedAt',
      'endedAt',
      'durationMs',
      'messages',
      'participants',
      'rotation',
      'subagents',
      'flags',
      'restricted',
    ],
    'RunReport must not gain or lose top-level fields at N=1',
  )
})
