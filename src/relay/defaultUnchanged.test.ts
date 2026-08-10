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
import { newSessionId, recordSession } from '../workspace/sessionRecord.ts'
import type { Verdict } from '../contract/outcome.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import type { PauseReason, RunHandle, RunPause } from './run.ts'
import type { AgentEvent, AgentSession, CloseMode, SessionSnapshot, SessionState, TurnKey } from '../contract/session.ts'
import { guaranteesFor, turnKey } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import type { CreateParticipantContext, ResolvedParticipant } from '../registry/types.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { Relay } from './relay.ts'
import { worktreePaths } from './subagents.ts'

const CLI = readFileSync(join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts'), 'utf8')
const RELAY = readFileSync(join(import.meta.dirname, 'relay.ts'), 'utf8')

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

/**
 * The same, keeping what went to stdout.
 *
 * Under `--json` the front-ends put the machine-readable document on stdout and every human
 * line on stderr, so what this returns is exactly the document a consumer would parse.
 */
async function stdoutOf(work: () => Promise<number>): Promise<string> {
  const [log, error] = [console.log, console.error]
  const lines: string[] = []
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '))
  console.error = () => {}
  try {
    const code = await work()
    assert.equal(code, 0, 'the command must succeed')
  } finally {
    console.log = log
    console.error = error
  }
  return lines.join('\n')
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

/**
 * Every object key set in a JSON document, at every depth, keyed by path.
 *
 * The path uses `[]` for an array step, so `participants[].turns[]` names the shape of a
 * turn regardless of how many there are. When two values at the same path disagree -- one
 * participant carrying a key its neighbour lacks -- both key sets are recorded joined by
 * ` | `, which fails the comparison and names the disagreement instead of quietly reporting
 * their union. A union would let a key appear on one seat and vanish from the other without
 * anything noticing, which is exactly the class of drift being guarded.
 *
 * Only objects contribute. A primitive has no shape, and an EMPTY array contributes no
 * element path at all -- so a document whose `subagents` is `[]` on a default run pins that
 * it is empty and says nothing about what an element would look like. That is the honest
 * limit of observing a real run rather than reading a type.
 */
function shapesIn(value: unknown, path = '', into: Map<string, string> = new Map()): Map<string, string> {
  if (Array.isArray(value)) {
    for (const item of value) shapesIn(item, `${path}[]`, into)
    return into
  }
  if (value === null || typeof value !== 'object') return into
  const keys = Object.keys(value as Record<string, unknown>).sort().join(', ')
  const seen = into.get(path)
  if (seen === undefined) into.set(path, keys)
  else if (!seen.split(' | ').includes(keys)) into.set(path, `${seen} | ${keys}`)
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    shapesIn(v, path === '' ? k : `${path}.${k}`, into)
  }
  return into
}

/** `shapesIn` as a plain object, so an assertion failure prints as a readable diff. */
function shapeOf(value: unknown): Record<string, string> {
  return Object.fromEntries([...shapesIn(value)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
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
  // bin/conclave.ts:812-815. The session helper returns the fallback both when the flag is
  // absent and when it is present without a value: bin/conclave.ts:1271-1280.
  assert.match(
    helper,
    /return i >= 0 \? \(rest\[i \+ 1\] \?\? fallback\) : fallback|if \(i < 0\) return fallback/,
    `${label} flag helper must return the fallback when the flag is absent`,
  )
}

/**
 * Divergence that is a decision rather than an oversight.
 *
 * Three entries, and they are different kinds of thing. The first is PENDING: a routing change
 * written down before it ships. The second has ALREADY SHIPPED and is declared retroactively,
 * because it reached the status document while the guard was reading interfaces as text and
 * therefore could not see it -- which is the argument for the guard being observational, made
 * by the one field that proves it. The third is a change to the guarded FLAG SURFACE, declared
 * here as the change ships rather than recorded only in the pinned list it moves.
 */
const DECLARED: Record<string, string> = {
  'implementer_unanswered -> advisor':
    'Authority routing (#56, D2) sends implementer_unanswered to the advisor before the operator, ' +
    'so a default run interrupts the human less than today. Real change at N=1, an improvement, ' +
    'declared rather than discovered. The pause reason exists at src/relay/run.ts:51 and the halt ' +
    'that raises it is at src/relay/relay.ts:3720.',
  'status.pause.resolution':
    'Classifying unresolved conditions on both axes (#56, D2) added `resolution` to every RunPause ' +
    '(src/relay/run.ts:183), so `conclave status --json` on a paused default run now carries ' +
    'pause.resolution = {reason, authority, scope} and pause.resolution.scope = {kind}. Additive and ' +
    'recorded rather than acted on: authority and scope are computed at the halt site from the reason ' +
    'and the run configuration (src/relay/resolution.ts:188), and a request whose authority is ' +
    'mechanical or advisor still produces the same pause today, because nothing exists yet that could ' +
    'resolve one and dropping the pause first would lose the decision point rather than automate it. ' +
    '`reason` is deliberately duplicated between pause.reason and pause.resolution.reason: the loose ' +
    'field is what every existing reader is written against and the nested one is the whole ' +
    'classification (src/relay/run.ts:169-183). Nothing an existing consumer read changed value.',
  'per-seat artifact attribution':
    'Artifact attribution (#62) is now scoped to the ROOT a participant works in, and records ' +
    'which seat each attributed path came from. `RestrictedOrigin` gains one key, ' +
    '`attributions` — a list of {path, support, seat, confidence} — so a status document paused ' +
    'on authority_conflict carries it too, and the pinned shape above was updated rather than ' +
    'relaxed. Nothing at N=1 changed value or meaning: every participant shares the operator ' +
    'cwd, so the candidate set and the evidence set are the ones the single-root code produced, ' +
    'and every entry is `seat: null` with `confidence: reasoned_but_unverified` — the same claim ' +
    'this made before the field existed. A shared checkout does not learn who wrote a file ' +
    'because the code got more careful, and the `observed` grade is reachable ONLY from a linked ' +
    'worktree, which the default run does not have. The default `relay --json` report is ' +
    'byte-identical: `restricted` is empty on a run with no restricted message, which the shape ' +
    'guard below asserts explicitly rather than relying on. Declared because the N>1 report ' +
    'surface is intentional and the pause document key is a change an existing consumer can see.',
  'optional ceiling flags on both front-ends':
    'The optional flag surface grows by four: --max-queue-depth and --max-concurrent-seats on ' +
    'both commands, and --max-turns / --max-minutes on `session`, which had neither. The ' +
    "operator's reason: `session --operator agent` already makes a console run unattended, and " +
    'an unattended console run had NO ceiling of any kind. D8 recorded that "the console relied ' +
    'on a human noticing a run had gone long"; that premise is already false for agent-driven ' +
    'runs, so this closes a live gap rather than provisioning for N>1. Declared rather than ' +
    'merely added: D1 forbids an optional flag becoming required and forbids the default run ' +
    'changing, and neither happens here -- all four are optional, none has a default, and a run ' +
    'given none is bounded exactly as before (proved by `absent ceilings are behaviourless` in ' +
    'src/relay/ceilings.test.ts). The pinned flag sets below are stricter than D1 requires, and ' +
    'that strictness is the point: it forced this entry to be written instead of letting the ' +
    'addition land unremarked. No assertion in this file was relaxed to accommodate it.',
  '--implementers on both front-ends':
    'The optional flag surface grows by one on each command: --implementers, a comma-separated ' +
    'list of agents naming one implementer seat each. This is D1 as written -- "adding seats ' +
    'brings new arguments and nothing else" -- and the argument is the thing being declared. ' +
    'What does NOT change is the default run: with the flag absent both front-ends pass no ' +
    '`implementers` key to Relay.start at all (the key is spread in conditionally in ' +
    'bin/conclave.ts and in src/repl/session.ts), so `implementerSeats` returns `[implementer]` ' +
    'by the same expression as before, the lead seat is still `implementer` because ' +
    '`seatIdFor(0)` is that string at every N, and the spec handed over is the object those two ' +
    'blocks used to build inline. `--implementer claude` is untouched: it still names the lead ' +
    'implementer, still defaults to claude, and is still the only way to say it. The two flags ' +
    'are read by one shared builder (`implementerSeatPlan`) which REFUSES rather than ' +
    'reconciles when they name different agents for the same seat, because there is no third ' +
    'seat to put the loser in. Declared here rather than only in the pinned lists below: those ' +
    'lists are what forced this to be written, and no assertion in this file was relaxed to ' +
    'accommodate it -- the seat-id, cwd, report-shape and status-shape guards all still run ' +
    'against a default run that never mentions the new flag. That the flag DOES something is a ' +
    'separate claim, proved in src/relay/seatCli.test.ts by driving both real front-ends to a ' +
    'run with two constructed seats.',
  'per-seat dispatcher state in status --json':
    'A run with more than one implementer seat now reports, per seat, the dispatcher state ' +
    'that only exists at N>1: `participants[].seat = {state, dispatched, task?, worktree?}` ' +
    '(src/workspace/sessionRecord.ts). The operator’s reason: at N=1 "what is the implementer ' +
    'doing" is answered by the one thing on screen, and at N>1 it is four questions — which ' +
    'seat, holding which task, on which branch, in which tree — and a poller had NO way to ' +
    'answer any of them. `conclave status --json` is the whole interface an agent operator ' +
    'has (#26), and a status document that cannot distinguish two seats is the file-shaped ' +
    'version of the console bug beside it. Every value is projected from state the relay ' +
    'already holds and already copies out — `seats()`, `tasks()` and `worktrees` — so nothing ' +
    'here is a second record that could disagree with the first. NESTED deliberately, and ' +
    'that nesting is the part being declared: four loose keys on the participant would put ' +
    'seat facts beside `rank` and `turns`, which are facts about a participant at every N, ' +
    'and a consumer could not tell by looking which half stops meaning anything at N=1. ' +
    'THE DEFAULT RUN DOES NOT CHANGE: the block is emitted only when the dispatcher holds ' +
    'more than one seat, so every N=1 document — ended and all six paused shapes above — is ' +
    'pinned byte-for-byte as it was, and none of those pins was relaxed to accommodate this. ' +
    'The one guarded document that does change is the merge_blocked pause, which takes two ' +
    'seats to provoke; its pin now records the advisor/seat DISAGREEMENT explicitly rather ' +
    'than being unioned or dropped. The console half of the same issue (#65) is not in this ' +
    'file: it renders one pinned row per busy seat, and at N=1 renders none, which ' +
    'src/repl/screen.test.ts and src/repl/session.tty.test.ts cover.',
  'per-seat launch args and model in status --json and the run report':
    'Every seat, at every N, now reports how it was LAUNCHED: ' +
    '`participants[].launch = {args, model}` in both `conclave status --json` and the ' +
    '`relay --json` report. This one DOES change the default run’s two documents — each gains ' +
    'a key on every participant — and it is declared for that reason rather than nested away ' +
    'behind a seat count like the block above. The operator’s reason (#71): `agent: opencode` ' +
    'identifies nothing. One agent id spans dozens of models at roughly a 30x price spread, so ' +
    'a finished run can be neither costed by hand nor repeated — `--implementer-args ' +
    '"-m opencode/kimi-k2.7-code"` reached the launch and was then dropped at `Relay.#join`, ' +
    'exactly as `spec.role` was before #57. "A field that says nothing at N=1" was the argument ' +
    'for hiding the `seat` block; this one says the same thing at every N, so hiding it at N=1 ' +
    'would withhold it from the runs an operator is most likely to be reading. `model` is ' +
    '`null`, never `""`, when the argv named none — the issue asks for that distinction by ' +
    'name — and `args` is the whole composed argv, adapter base args included, because that is ' +
    'what someone would have to type to repeat the run. Composed ONCE, by `launchRecordFor` in ' +
    'src/registry/launch.ts, which is the same function every built-in adapter now builds its ' +
    'child’s argv with (src/registry/builtin.ts), so the record IS the launch rather than a ' +
    'reconstruction of it. NO TOKEN COUNT AND NO COST ACCOMPANIES IT, and that half of #71 is ' +
    'deferred with its reason: conclave drives the operator’s own CLI on their own ' +
    'subscription, real usage would mean tapping enterprise analytics or OTEL on their ' +
    'machine, and scraping whatever one adapter’s transcript happens to expose would produce a ' +
    'confident partial number for a multi-seat run. What ships is the join key for the billing ' +
    'export their provider already holds. Every pinned shape below was updated rather than ' +
    'relaxed, and src/relay/launchRecord.test.ts proves the field carries a real value by ' +
    'driving both front-ends with --implementer-args.',
  '--integration-checks on both front-ends, and the integration_failed outcome':
    'The optional flag surface grows by one on each command: --integration-checks, commands ' +
    'run against the MERGED tree after every merge including the last. The operator’s reason ' +
    '(#80): the first real two-seat run merged three tasks with no git conflict at all and ' +
    'produced a tree that failed two tests, because nothing in the design looks at the ' +
    'integration RESULT — git reports textual conflict, --checks run per seat in that seat’s ' +
    'own tree (D7), and every seat can therefore pass while the tree they build together ' +
    'fails. Its own flag rather than a second reading of --checks, which is the objection ' +
    'recorded in src/relay/integrate.ts and it still holds: those say what a REPLACEMENT must ' +
    'reproduce, and firing them at every merge would change how often an operator’s existing ' +
    'commands run and what their failure means without them asking. A failure mid-run is a ' +
    'repair the advisor dispatches, naming BOTH contributing tasks — no seat is marked, ' +
    'because the defect exists in neither half and assigning it by fault would be a guess. A ' +
    'failure after the FINAL merge has no seat to repair it, so the run reports it instead: ' +
    'RunReason gains `integration_failed` (src/relay/observe.ts), it replaces `done` and ' +
    '`budget` in Relay.#end so no ending can report success over a tree that does not build, ' +
    'and `relay` exits non-zero on it as it does on ceiling and transport_failed. THE ' +
    'DEFAULT RUN DOES NOT CHANGE: the flag is optional with no default, an absent ' +
    '`integration` option runs no command, and the station is unreachable at N=1 in any case ' +
    '— without seat worktrees there is no merge and no integration checkout distinct from ' +
    'the tree the implementer has been working in all along. Neither the ended nor any paused ' +
    'status document changes, and no assertion in this file was relaxed to accommodate it. ' +
    'That the flag DOES something is proved against real worktrees, real merges and real ' +
    'check commands in src/relay/integrationRed.test.ts and src/relay/integrate.test.ts.',
}

test('DECLARED contains exactly the routing, pause-resolution, attribution, ceiling-flag, seat-flag, seat-status, launch-record and integration-check entries', () => {
  assert.deepEqual(Object.keys(DECLARED), [
    'implementer_unanswered -> advisor',
    'status.pause.resolution',
    'per-seat artifact attribution',
    'optional ceiling flags on both front-ends',
    '--implementers on both front-ends',
    'per-seat dispatcher state in status --json',
    'per-seat launch args and model in status --json and the run report',
    '--integration-checks on both front-ends, and the integration_failed outcome',
  ])
})

/**
 * The seat ids each front-end actually constructs.
 *
 * Observed at the registry, which is the last place the id is Conclave's own before it
 * becomes a participant: `Relay.start` resolves each spec and hands it to
 * `AgentRegistry#createParticipant`, so `resolved.spec.id` here is the string the front-end
 * put in the option object and nothing the test supplied.
 *
 * Both front-ends are driven through their production entry point -- `main(['relay', ...])`
 * and `main(['session', ...])` from `bin/conclave.ts` -- with only the registry replaced.
 * Nothing else about the default invocation is stubbed: no seat ids, no cwd, no rounds
 * beyond the default flag parsing.
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

/**
 * The same, for the console -- through `main(['session', ...])` rather than `runSession`.
 *
 * Calling `runSession` directly skipped every line of `bin/conclave.ts`'s session block:
 * the argv parsing, the goal-position rule, the flag helper, and the option object it
 * builds. That block was covered by regexes over the file instead (#69), which pass whether
 * or not the call they matched is the call that runs. `MainOverrides.registry` reaches it
 * now, so this is the production entry point with the participants replaced and nothing else.
 *
 * Returns the cwd each seat was created in as well as its id: the run cwd is not something
 * the caller supplied here -- the session block reads `process.cwd()` itself, so what comes
 * back is the CLI's own answer.
 */
async function seatsFromSessionCli(): Promise<{ creates: CreateRecord[]; cwd: string }> {
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
  // Resolved rather than assumed: on macOS the temporary directory is reached through a
  // symlink, so `process.cwd()` after chdir is the real path and not the string `mkdtemp`
  // returned. Comparing against what the process is actually in is also the sharper
  // assertion — it is the cwd an operator's shell would have handed the command.
  let cwd = repo
  try {
    process.chdir(repo)
    cwd = process.cwd()
    const code = await quietly(() =>
      main(['session', 'a default goal', '--advisor', 'fake-lead', '--implementer', 'fake-impl', '--rounds', '2'], {
        registry,
        input: idleInput(),
        output: sink(),
      }),
    )
    assert.equal(code, 0, 'a default console run must succeed')
  } finally {
    process.chdir(before)
    rmSync(repo, { recursive: true, force: true })
  }
  return { creates, cwd }
}

/**
 * The two machine-readable documents a default run actually emits.
 *
 * Both come out of one `relay --json` run in a temporary repository, through the production
 * call sites: the report is what `bin/conclave.ts:1198` prints, and the status record is what
 * `recordSession` wrote during that same run, read back by `main(['status', '--json'])` --
 * which resolves the most recent session in `process.cwd()`, so the record has to have been
 * written where an operator would look for it.
 *
 * Reading the interfaces instead, which is what stood here before, could not see any of
 * that: a field can be declared and never populated, populated and never declared, or
 * declared in a type the writer does not use.
 */
async function defaultRunDocuments(): Promise<{ report: unknown; status: unknown }> {
  const repo = tempRepo()
  const before = process.cwd()
  const registry = defaultRegistry(
    {
      'fake-lead': new DefaultRunFakeSession('fake-lead', 'lead-1', ['DONE']),
      'fake-impl': new DefaultRunFakeSession('fake-impl', 'impl-1', []),
    },
    [],
  )
  try {
    process.chdir(repo)
    const report = await stdoutOf(() =>
      main(
        ['relay', 'a default goal', '--advisor', 'fake-lead', '--implementer', 'fake-impl', '--rounds', '2', '--json'],
        { registry },
      ),
    )
    // No id: `status` with no argument means the most recent session, which is the run above.
    const status = await stdoutOf(() => main(['status', '--json']))
    return { report: JSON.parse(report), status: JSON.parse(status) }
  } finally {
    process.chdir(before)
    rmSync(repo, { recursive: true, force: true })
  }
}

/**
 * The status document of a run that is PAUSED, which the ended one cannot stand in for.
 *
 * `pause` is absent from a run that reached its end, so pinning the ended document alone
 * says nothing about the largest nested object the status file has -- and `pause.resolution`
 * (#56, D2) is drift that already shipped underneath it. A guard claiming "every depth" while
 * blind to that subtree is claiming more than it checks.
 *
 * Built through the real recorder: `recordSession` is what both front-ends call, and
 * `set('paused', { pause })` is the same call the console makes at src/repl/session.ts:863
 * with the same object -- a `RunPause` the run handle raised, not one written here. Read back
 * through `main(['status', '--json'])`, so the serialisation and the reconciliation against
 * the pid are the production ones.
 *
 * Deliberately NOT driven through the console front-end. Doing so means requesting a pause
 * while a run is still going and polling until it lands, and a shape guard that can time out
 * is a guard people learn to rerun. The object being pinned is identical either way: the
 * console records the pause its handle gives it, and so does this.
 */
const TIMED_OUT: Verdict = {
  outcome: 'timed_out',
  confidence: 'uncertain',
  provenance: [{ source: 'orchestrator', detail: 'watchdog fired' }],
}

function registryOf(advisor: FakeRotationSession, impl: FakeRotationSession): AgentRegistry {
  const r = new AgentRegistry()
  for (const [agent, session] of [
    ['codex', advisor],
    ['claude', impl],
  ] as const) {
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
        return session
      },
    })
  }
  return r
}

/**
 * The two-seat conflict, driven to the second failure.
 *
 * Seat `implementer` and seat `implementer-2` rewrite the same line from the same base. The
 * first merges; the second is blocked, told about it, and given a repair turn that changes
 * nothing — a second failure against the same integration parent, which is what escalates.
 * Every step is the production path: real worktrees, a real `git merge`, a real abort.
 */
async function provokeMergeBlocked(repo: string): Promise<{ relay: Relay; run: RunHandle; pause: RunPause }> {
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(join(repo, 'work.ts'), 'export const answer = 0\n')
  execFileSync('git', ['add', 'work.ts'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'work'], { cwd: repo })

  // The repair is ADDRESSED, and only because this run has two seats. An untargeted
  // instruction now reaches whichever seat is free rather than being redirected onto the
  // blocked one — that redirect fired unconditionally and was starvation at N>1. At N=1 the
  // blocked seat is the only seat, so the redirect still fires and nothing about the default
  // run's repair path changed; this provocation is the two-seat case and says so above.
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'Set the answer to one.',
    'Set the answer to two.',
    '@seat implementer-2: Resolve the conflict in your own worktree.',
    'DONE',
  ])
  const first = new FakeRotationSession('impl', 'claude', ['ack', 'Did it.', 'NONE'])
  const second = new FakeRotationSession('impl-2', 'claude', ['ack', 'Did it.', 'Still stuck.', 'NONE'])

  // A queue rather than one session per agent: two seats filled by the same agent must be two
  // children, or the run is one session pretending to be two.
  const registry = new AgentRegistry()
  for (const [agent, queue] of [
    ['codex', [advisor]],
    ['claude', [first, second]],
  ] as const) {
    const remaining = [...queue]
    registry.register({
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

  const relay = await Relay.start({
    registry,
    cwd: repo,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    implementers: [
      { id: 'implementer', agent: 'claude', role: 'implementer' },
      { id: 'implementer-2', agent: 'claude', role: 'implementer' },
    ],
    maxAdvisorTurns: 5,
  })
  const trees = Object.fromEntries(relay.worktrees!.seats.map((s) => [s.seatId, s.worktreePath]))
  first.onSend = () => writeFileSync(join(trees.implementer!, 'work.ts'), 'export const answer = 1\n')
  second.onSend = () => writeFileSync(join(trees['implementer-2']!, 'work.ts'), 'export const answer = 2\n')

  const run = relay.start('Keep the work moving.')
  const pause = await run.untilPause()
  assert.ok(pause, 'the relay must raise a merge_blocked pause for its status document to exist')
  return { relay, run, pause }
}

/**
 * Drive a real relay into one condition and return the pause it raised.
 *
 * The provocations are the ones `resolution.test.ts`'s own `provoke` already uses, deliberately:
 * the same triggers reaching the same single halt site (src/relay/relay.ts:2243), where the
 * classification is computed by production `resolutionFor` from the subject the caller passed.
 * Nothing here writes a `RunPause`.
 *
 * `rotation_candidate` is the one condition that cannot occur on a bare default invocation:
 * the degradation is only assessed when `rotation` is configured, which is what `--checks`
 * does. It is armed for that variant alone, and the run stays otherwise default.
 */
async function provoke(
  repo: string,
  reason: PauseReason,
): Promise<{ relay: Relay; run: RunHandle; pause: RunPause }> {
  // Two seats, one file, real git — the only condition here that a default run cannot reach
  // even in principle, since it needs a second implementer to conflict with. It is provoked
  // separately rather than being squeezed into the table below, and the run is otherwise
  // ordinary: no flags, no overrides beyond the seat list.
  if (reason === 'merge_blocked') return provokeMergeBlocked(repo)

  const armed = reason === 'rotation_candidate'
  const scripts: Record<PauseReason, { advisor: string[]; impl: string[] }> = {
    rotation_candidate: { advisor: ['Do the thing.', 'DONE'], impl: ['ack', 'Did it.'] },
    advisor_escalated: {
      advisor: ['ESCALATE: I do not know whether this is in scope.', 'Do the thing.', 'DONE'],
      impl: ['ack', 'Did it.'],
    },
    implementer_unanswered: {
      advisor: ['Read the routes and report what you find.', 'Use /api/v1 for the endpoint.', 'DONE'],
      impl: [
        'ack',
        'Read the existing routes.\nUNANSWERED: Should the new endpoint be under /api/v1 or /api/v2?',
        'Done.',
        'NONE',
      ],
    },
    authority_conflict: {
      advisor: ['Do it.', 'Remove two.txt and wait.', 'DONE'],
      impl: ['ack', 'Wrote two.txt.', 'Removed it.'],
    },
    turn_incomplete: { advisor: ['Do it.', 'DONE'], impl: ['ack', 'Did it, slowly.'] },
    // Unused by the single-implementer path below: `merge_blocked` needs two seats and a real
    // conflict, and is provoked in its own branch. Present because the table is keyed by
    // `PauseReason` on purpose — a reason that appears here and nowhere else is a reason
    // somebody has to come and finish.
    merge_blocked: { advisor: [], impl: [] },
    operator_requested: {
      advisor: ['Do the first thing.', 'Do the second thing.', 'DONE'],
      impl: ['ack', 'Did the first thing.', 'Did the second thing.', 'NONE'],
    },
  }
  const script = scripts[reason]
  const advisor = new FakeRotationSession('advisor', 'codex', script.advisor)
  const impl = new FakeRotationSession('impl', 'claude', script.impl)
  if (reason === 'turn_incomplete') impl.endTurn = { index: 1, verdict: TIMED_OUT }
  if (reason === 'operator_requested') {
    // Slow turns, so the request lands while a turn is in flight and the loop honours it at
    // the round boundary — the only place it can, since neither child CLI reads input
    // mid-turn.
    advisor.delayMs = 20
    impl.delayMs = 20
  }
  const relay = await Relay.start({
    registry: registryOf(advisor, impl),
    cwd: repo,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxRounds: 4,
    ...(armed ? { rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000 } } : {}),
  })
  const run = relay.start(reason === 'implementer_unanswered' ? 'Add the endpoint.' : 'Keep the work moving.')
  if (reason === 'rotation_candidate') impl.compact()
  if (reason === 'authority_conflict') relay.say('Also write the word into two.txt.', { only: 'implementer' }, 'aside')
  const pause =
    reason === 'operator_requested'
      ? await run.requestPause('the operator asked to pause')
      : await run.untilPause()
  assert.ok(pause, `the relay must raise a ${reason} pause for its status document to exist`)
  return { relay, run, pause }
}

/**
 * The status document of a run paused for one given reason.
 *
 * Built through the real recorder: `recordSession` is what both front-ends call, and
 * `set('paused', { pause })` is the same call the console makes at src/repl/session.ts:863
 * with the same object -- a `RunPause` the relay raised, not one written here. Read back
 * through `main(['status', '--json'])`, so the serialisation and the reconciliation against
 * the pid are the production ones.
 *
 * Deliberately NOT driven through the console front-end. Doing so means provoking each
 * condition while polling a status file until it changes, and a shape guard that can time out
 * is a guard people learn to rerun. The object being pinned is identical either way: the
 * console records the pause its handle gives it, and so does this.
 */
async function pausedStatusDocument(reason: PauseReason): Promise<unknown> {
  const repo = tempRepo()
  const before = process.cwd()
  const { relay, pause } = await provoke(repo, reason)
  const recording = recordSession(relay, {
    repoRoot: repo,
    id: newSessionId(Date.now(), process.pid),
    goal: 'a default goal',
    front: 'session',
    startedAt: Date.now(),
    // Passed because the console always passes one (src/repl/session.ts:689), so the status
    // documents this file pins differ only in what a pause actually changes.
    logPath: join(repo, '.conclave', 'runs', 'session-test.ndjson'),
    build: 'test',
  })
  try {
    process.chdir(repo)
    recording.set('paused', { pause })
    await recording.refresh()
    return JSON.parse(await stdoutOf(() => main(['status', '--json'])))
  } finally {
    process.chdir(before)
    await recording.close()
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
}

/**
 * What the default advisor is TOLD, which nothing in this file was watching.
 *
 * The briefing is part of the default run's observable surface and arguably the most
 * consequential part of it: everything the advisor does is downstream of it, and this project
 * has a live experiment running against the unmodified text whose pre-registration says not to
 * change it mid-study (spikes/experiments/04-complaint-as-studying is at
 * spikes/experiments/04-complaint-as-signal.md). Every other guard here reads ids, cwds, flags
 * and JSON shapes -- a paragraph appended to the advisor's opening prompt changed none of
 * those, so it would have shipped unremarked.
 *
 * Found by mutation: making `MULTI_SEAT_BRIEFING` unconditional -- so a one-seat run learns a
 * multi-seat syntax and is told its reports arrive out of order -- passed the entire focused
 * suite, this file included.
 *
 * Both halves, because either alone is worth little. The absence at N=1 is the D1 claim; the
 * presence at N>1 is what stops the claim being satisfied by deleting the feature.
 */
test('the multi-seat briefing reaches a two-seat advisor and no part of it reaches a default one', async () => {
  const MARKERS = [/MORE THAN ONE IMPLEMENTER SEAT/, /@seat <seat-id>:/, /@role <role>:/, /dispatched CONCURRENTLY/]

  const repo = tempRepo()
  const one = new FakeRotationSession('lead-1', 'codex', ['DONE'])
  const solo = await Relay.start({
    registry: registryOf(one, new FakeRotationSession('impl-1', 'claude', [])),
    cwd: repo,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 1,
  })
  try {
    await solo.run('a default goal')
    const opening = one.received[0] ?? ''
    assert.match(opening, /^You are the ADVISOR on a two-agent coding session/, 'the opening prompt is the briefing')
    for (const marker of MARKERS) {
      assert.doesNotMatch(opening, marker, 'a default advisor must not be taught a syntax for seats it does not have')
    }
    // Nor anywhere else in the run: the syntax is not smuggled in on a later prompt either.
    for (const m of one.received) {
      assert.doesNotMatch(m, /MORE THAN ONE IMPLEMENTER SEAT/)
    }
  } finally {
    await solo.stop()
    rmSync(repo, { recursive: true, force: true })
  }

  // The other half. A two-seat run is where the syntax is the only way to say who work is for,
  // so its advisor must be told -- and this is the assertion that would fail if the N=1 claim
  // above were satisfied by removing the briefing altogether.
  const twoSeatRepo = tempRepo()
  const pair = new FakeRotationSession('lead-2', 'codex', ['DONE'])
  const registry = new AgentRegistry()
  const queue = [new FakeRotationSession('a-1', 'claude', []), new FakeRotationSession('b-1', 'claude', [])]
  for (const [agent, sessions] of [['codex', [pair]], ['claude', queue]] as const) {
    const remaining = [...sessions]
    registry.register({
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
  const many = await Relay.start({
    registry,
    cwd: twoSeatRepo,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    implementers: [
      { id: 'implementer', agent: 'claude', role: 'implementer' },
      { id: 'implementer-2', agent: 'claude', role: 'implementer' },
    ],
    maxAdvisorTurns: 1,
  })
  try {
    await many.run('a two-seat goal')
    const opening = pair.received[0] ?? ''
    for (const marker of MARKERS) {
      assert.match(opening, marker, 'a multi-seat advisor must be taught the syntax it is required to use')
    }
  } finally {
    await many.stop()
    rmSync(twoSeatRepo, { recursive: true, force: true })
  }
})

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
    (await seatsFromSessionCli()).creates.map((c) => c.id).sort(),
    ['advisor', 'implementer'],
    'the session CLI must construct exactly the advisor and implementer seats',
  )
})

/**
 * The seam itself, guarded.
 *
 * Everything below that reaches the console through `main` is only as good as this: if
 * `bin/conclave.ts` stopped forwarding `overrides.registry` to `runSession`, the fakes would
 * be silently ignored and the session block would build the real registry from `--advisor
 * fake-lead`. That is not a subtle failure -- `Relay.start` would try to launch a command
 * called `fake-lead` -- but it is one worth naming, because the symptom is a test that fails
 * for a reason that has nothing to do with what it was written to check.
 */
test('main(session) uses the injected registry rather than the built-in one', async () => {
  const { creates } = await seatsFromSessionCli()
  assert.ok(
    creates.length > 0,
    'the injected registry must be the one the session CLI creates participants through',
  )
  assert.deepEqual(
    [...new Set(creates.map((c) => c.id))].sort(),
    ['advisor', 'implementer'],
    'every participant the session CLI created must have come from the injected registry',
  )
})

test('default run works in the run cwd and creates no worktree', async () => {
  const relay = commandBlock('relay', "if (command === 'session')")

  // The console side is OBSERVED, not read. Two regexes used to stand here -- one matching
  // `cwd: process.cwd()` in the session block, one matching `cwd: opts.cwd` inside the
  // `Relay.start` call in src/repl/session.ts -- and between them they asserted that two
  // string literals appear in two files. Neither could tell whether the call it matched is
  // the call that runs, and the second would have gone on passing if the session block had
  // handed `runSession` a different directory entirely.
  //
  // Driving `main(['session', ...])` from inside a temporary repository and asking the
  // registry where it was told to create each participant covers the whole chain those two
  // regexes described in pieces: process.cwd() -> SessionOptions.cwd -> Relay.start ->
  // AgentRegistry#createParticipant.
  const fromCli = await seatsFromSessionCli()
  assert.ok(fromCli.creates.length > 0, 'the session CLI must create participants')
  for (const c of fromCli.creates) {
    assert.equal(c.cwd, fromCli.cwd, `the session CLI must create ${c.id} in the run cwd`)
  }

  // The relay CLI passes process.cwd() as the run cwd: bin/conclave.ts:1107.
  // The relay hands that same cwd to each participant adapter: src/relay/relay.ts:1258-1264.
  // The cwd getter simply returns the option: src/relay/relay.ts:1151-1153.
  assert.match(relay, /cwd:\s*process\.cwd\(\)/, 'relay block must start in process.cwd')
  // Both creation sites now pass a NAMED context object rather than an inline literal, because
  // the same object composes the launch args that get recorded -- see
  // DECLARED['per-seat launch args and model ...']. The regex that stood here matched
  // `createParticipant(spec, { cwd: this.#opts.cwd`, which was in fact the ROTATION
  // replacement's call and not `#join`'s; both are pinned separately below, at the same
  // strength and without widening what is claimed. The cwd guarantee for a default run is
  // proved above by observation anyway -- `seatsFromSessionCli` reads it back from the
  // registry -- and this is the text-level echo of it.
  assert.match(
    RELAY,
    /#join\(spec: ParticipantSpec, rank: Rank, cwd: string = this\.#opts\.cwd\)/,
    "a joining participant's cwd must default to the run cwd",
  )
  assert.match(
    RELAY,
    /const ctx = \{ cwd, watchdogMs: this\.#opts\.turnWatchdogMs \}\s*const session = await this\.#opts\.registry\.createParticipant\(spec, ctx\)/,
    'a joining participant must be created in that cwd',
  )
  assert.match(
    RELAY,
    /const ctx = \{ cwd: this\.#opts\.cwd, watchdogMs: this\.#opts\.turnWatchdogMs \}\s*const session = await this\.#opts\.registry\.createParticipant\(spec, ctx\)/,
    'a rotation replacement must be created in the run cwd',
  )

  // A default run with no subagents must not create any git worktree. The relay only samples
  // the worktree list for its subagent-use report: src/relay/subagents.ts:68 defines
  // worktreePaths, and src/relay/relay.ts:1805, :1852 and :3130 read it.
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

// Named for both halves: the fallback check is what keeps a flag optional, and the two
// literal sets below are a pin in their own right — adding a flag fails this test even
// though nothing became required.
test('both flag helpers fall back when the flag is absent, and each block reads exactly these flags', () => {
  const relay = commandBlock('relay', "if (command === 'session')")
  const session = commandBlock('session', "if (command === 'demo')")

  // A default invocation must be able to run with just a goal. Both front-ends define the flag
  // helper with a fallback: bin/conclave.ts:812 (relay) and bin/conclave.ts:1271 (session).
  // Every flag read here uses that helper, so none become required.
  assertFlagHelperOptional(relay, 'relay')
  assertFlagHelperOptional(session, 'session')

  // Pin the current optional flag set for each front-end. This includes both the valued flags
  // read with flag('--name') and the boolean flags checked with includes('--name').
  // Adding a flag or removing the fallback from a valued flag must be a deliberate change.
  //
  // The four ceiling flags below are a declared change to this surface, not an oversight:
  // see DECLARED['optional ceiling flags on both front-ends'] for the operator's reason.
  // `implementers` is the second such change, declared at
  // DECLARED['--implementers on both front-ends'] -- the flag that adds seats, which D1 says is
  // the ONLY thing adding seats may do.
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
      'implementers',
      'integration-checks',
      'json',
      'lead',
      'lead-args',
      'max-concurrent-seats',
      'max-minutes',
      'max-queue-depth',
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
      'implementers',
      'integration-checks',
      'lead',
      'lead-args',
      'max-concurrent-seats',
      'max-minutes',
      'max-queue-depth',
      'max-turns',
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

/** One default run, both documents, shared by the two shape guards below. */
let documents: Promise<{ report: unknown; status: unknown }> | undefined
const runDocuments = (): Promise<{ report: unknown; status: unknown }> =>
  (documents ??= defaultRunDocuments())

/**
 * The wire contract for the final run record, as emitted rather than as declared.
 *
 * What stood here read `export interface RunReport` out of `src/relay/report.ts` as text and
 * compared its TOP-LEVEL field names. Three holes in that, all of them load-bearing:
 *
 *   - It stopped at depth one. `participants`, `deadlines` and `rotation` are objects, and a
 *     field added inside any of them was invisible -- which is precisely where per-seat
 *     features land.
 *   - A declared field is not an emitted one. `turnWatchdogMs` was declared and dropped for
 *     its whole life (src/repl/session.ts:199-212), and a text-level pin cannot tell the
 *     difference.
 *   - An emitted field need not be declared anywhere this test was reading. A key spread in
 *     from another type, or written by a builder that widens its return, appears in the JSON
 *     an operator parses and in no interface at all.
 *
 * Every path below is a real object in a real document. `role` on the participant block is
 * the field this pin was originally added for, and it stays: additive, constant at N=1, and
 * a decision rather than an oversight -- the alternative of omitting it when it equals the
 * rank is the `if (seats.length === 1)` branch D1 rules out, and a reader then cannot tell
 * "no role" from "this build does not report roles".
 */
test('the default relay --json report emits exactly these keys at every depth', async () => {
  const { report } = await runDocuments()
  assert.deepEqual(
    shapeOf(report),
    {
      '': 'build, cwd, deadlines, durationMs, endedAt, flags, goal, messages, operator, outcome, participants, restricted, rotation, schema, startedAt, subagents',
      deadlines: 'configuredAbsoluteMs, participants',
      'deadlines.participants[]': 'absolute, agent, id, silence',
      'deadlines.participants[].absolute': 'status',
      'deadlines.participants[].silence': 'status',
      'flags[]': 'participant, seq, text',
      outcome: 'detail, reason',
      'participants[]': 'agent, compactionGeneration, id, launch, rank, role, sessionId, turns',
      // The declared addition; see DECLARED['per-seat launch args and model ...']. `args` is
      // an EMPTY array on a default run — no seat was given a flag — so it contributes no
      // element path, and `model` is null, which contributes no path either. What is pinned
      // is that both keys are present and that neither has grown a shape underneath it.
      'participants[].launch': 'args, model',
      'participants[].turns[]': 'key, state, tools',
      rotation:
        'armed, assessments, candidates, complaintsSeen, degradationsSeen, peakGeneration, rotations',
      subagents: 'delegated, worktreesCreated',
    },
    'the default run report must not gain or lose a key at any depth without a decision',
  )
  // Said out loud rather than left implicit. `restricted` is why the shape above is unchanged
  // by #62: a default run has no restricted message, so the array is empty and contributes no
  // element path — which is exactly the reasoning DECLARED['per-seat artifact attribution']
  // rests on, and it would be silently false if a default run ever produced one.
  assert.deepEqual(
    (report as { restricted: unknown[] }).restricted,
    [],
    'a default run has no restricted message, which is what keeps the attribution fields off its report',
  )
})

/**
 * The same, for what `conclave status --json` hands a process watching the run.
 *
 * Read back through `main(['status', '--json'])`, so this covers the record `recordSession`
 * wrote -- the participant block `sessionRecord.ts`'s `seats()` builds and the document
 * `recordSession` puts it in as `participants` -- the reconciliation `readSession` does
 * against the pid, and the two computed fields `formatSessionJson` adds outside the record --
 * `alive` and `abandoned` are at the root here because they are observed in the output, not
 * because a regex found them being spread in.
 *
 * The participant block differs from the report's and is pinned separately for that reason:
 * it carries `activity`, which is live state, and lacks `sessionId` and
 * `compactionGeneration`, which are properties of a finished run. Both blocks carry `role`.
 *
 * `pause` and `awaitingPermission` are absent, not optional-and-empty: a run that reaches its
 * end unpaused emits neither key, and JSON has no way to spell an undefined field. Pinning
 * their ABSENCE is the point -- a build that started emitting `pause: null` would change what
 * every consumer's `if (status.pause)` does.
 *
 * Which also means this document says NOTHING about the keys under `pause`. The name says
 * `ended` for that reason; the paused document is pinned separately below.
 */
test('an ended conclave status --json emits exactly these keys at every depth', async () => {
  const { status } = await runDocuments()
  assert.deepEqual(
    shapeOf(status),
    {
      '': 'abandoned, alive, build, cwd, eventsPath, front, goal, id, logPath, messages, operator, outcome, participants, pid, schema, startedAt, state, updatedAt',
      outcome: 'detail, reason',
      'participants[]': 'activity, agent, id, launch, rank, role, turns',
      'participants[].activity': 'kind, since',
      'participants[].launch': 'args, model',
      'participants[].turns[]': 'key, state',
    },
    'the status document must not gain or lose a key at any depth without a decision',
  )
})

/**
 * Every paused status document a run can produce, one test per condition.
 *
 * The ended document above cannot stand in for any of these and its name does not claim to:
 * `pause` is absent there, so everything beneath it was unpinned. Nor can ONE paused document
 * stand in for the other five -- an `escalatedFrom` key added to the `advisor_escalated` branch
 * of `resolutionFor` passed a guard that observed only `operator_requested`, which is how this
 * corpus came to exist.
 *
 * Asserted per condition rather than unioned, because the differences are the interesting part
 * and a union would let one variant lose a key while another still had it. Between them the six
 * cover all three `ResolutionScope` shapes: `{kind}` for a conclave-scoped condition,
 * `{kind, participantId}` for a seat-scoped one, and `{kind, workstreamId}` for a
 * workstream-scoped one.
 *
 * `options` is an array of plain strings, so it contributes no element path; what is pinned is
 * that the array is there and that its entries are not objects.
 */
const PAUSED_COMMON = {
  '': 'abandoned, alive, build, cwd, eventsPath, front, goal, id, logPath, messages, operator, participants, pause, pid, schema, startedAt, state, updatedAt',
  'participants[]': 'activity, agent, id, launch, rank, role, turns',
  'participants[].activity': 'kind, since',
  'participants[].launch': 'args, model',
  'participants[].turns[]': 'confidence, key, provenance, state',
  'participants[].turns[].provenance[]': 'detail, source',
} as const

/**
 * The pause subtree each condition emits, and nothing more.
 *
 * The optional nested objects are here where they belong and absent where they do not:
 * `verdictOf` only on `turn_incomplete`, which is the one condition resting on a specific
 * verdict, and `conflict` only on `authority_conflict`, which is the one that has two sides to
 * adjudicate. `superseded`, `waiting` and `refusal` are emitted by none of the six as provoked
 * -- they are written onto a pause AFTER it is raised, by a late revision or an operator
 * decision, so a document captured at the moment of the halt has none of them.
 */
const PAUSED_SUBTREE: Record<PauseReason, Record<string, string>> = {
  rotation_candidate: {
    pause: 'at, atSeq, detail, evidence, options, reason, resolution',
    'pause.resolution': 'authority, reason, scope',
    'pause.resolution.scope': 'kind, participantId',
  },
  advisor_escalated: {
    pause: 'at, atSeq, detail, evidence, options, reason, resolution',
    'pause.resolution': 'authority, reason, scope',
    'pause.resolution.scope': 'kind',
  },
  implementer_unanswered: {
    pause: 'at, atSeq, detail, evidence, options, reason, resolution',
    'pause.resolution': 'authority, reason, scope',
    'pause.resolution.scope': 'kind, participantId',
  },
  turn_incomplete: {
    pause: 'at, atSeq, detail, evidence, options, reason, resolution, verdictOf',
    'pause.resolution': 'authority, reason, scope',
    'pause.resolution.scope': 'kind, participantId',
    'pause.verdictOf': 'endSeq, participant',
  },
  authority_conflict: {
    pause: 'at, atSeq, conflict, detail, evidence, options, reason, resolution',
    'pause.conflict': 'instruction, matched, origin, verb',
    // `attributions` is the declared addition; see DECLARED['per-seat artifact attribution'].
    // It is present and EMPTY here, which is why it contributes no element path: this
    // provocation attributes nothing, exactly as `artifactSupport: {}` beside it records.
    'pause.conflict.origin': 'artifactSupport, artifacts, at, attributions, excluded, informed, seq, text, tokens',
    // An object with no keys at all, and pinned as one: `artifactSupport` is a map keyed by
    // artifact, and this origin supports none. A build that started emitting an entry here
    // would change what a reader of the conflict sees.
    'pause.conflict.origin.artifactSupport': '',
    'pause.resolution': 'authority, reason, scope',
    'pause.resolution.scope': 'kind, workstreamId',
  },
  operator_requested: {
    pause: 'at, atSeq, detail, evidence, options, reason, resolution',
    'pause.resolution': 'authority, reason, scope',
    'pause.resolution.scope': 'kind',
  },
  // The only entry whose run is not a default run: it takes two implementer seats, because a
  // merge conflict between seats needs two seats. The document shape is pinned for the same
  // reason as the other six — this is what a consumer parses when it happens.
  merge_blocked: {
    pause: 'at, atSeq, detail, evidence, options, reason, resolution',
    'pause.resolution': 'authority, reason, scope',
    'pause.resolution.scope': 'kind, participantId',
    // The one document in this corpus that HAS seats to tell apart, and therefore the only one
    // carrying the seat block; see DECLARED['per-seat dispatcher state in status --json'].
    //
    // Pinned as a DISAGREEMENT rather than as a union, which is the whole reason `shapesIn`
    // records both key sets joined by ` | `. The advisor has no seat and no block; the two
    // implementers have one each. Relaxing this line to the union — or dropping `participants[]`
    // from the merge_blocked override so the common pin applied — would let the block vanish
    // from a seat, or appear on the advisor, with nothing failing. That the two sides are
    // exactly `…, role, turns` and `…, role, seat, turns` is the assertion.
    'participants[]':
      'activity, agent, id, launch, rank, role, turns | activity, agent, id, launch, rank, role, seat, turns',
    // `state`, `dispatched` and `worktree`, and NO `task`: this pause is raised after both
    // seats' turns have been graded and their tasks released, so neither is holding one. A
    // build that started reporting a task here would be reporting a seat as busy at the moment
    // the run stopped to ask a human about it. The busy shape — `task` present, with its own
    // three keys — is pinned in src/relay/seatStatus.test.ts against a seat caught mid-turn,
    // which is the state this corpus cannot reach because a paused run has no turn in flight.
    'participants[].seat': 'dispatched, state, worktree',
    'participants[].seat.worktree': 'branch, path',
  },
}

for (const reason of Object.keys(PAUSED_SUBTREE) as PauseReason[]) {
  // `rotation_candidate` is the one condition a bare default invocation cannot reach: the
  // degradation is only assessed when `--checks` configures rotation. `provoke` arms it for
  // that variant alone, and the name says which condition each test speaks for.
  test(`a status document paused on ${reason} emits exactly these keys at every depth`, async () => {
    assert.deepEqual(
      shapeOf(await pausedStatusDocument(reason)),
      { ...PAUSED_COMMON, ...PAUSED_SUBTREE[reason] },
      `the ${reason} status document must not gain or lose a key at any depth without a decision`,
    )
  })
}
