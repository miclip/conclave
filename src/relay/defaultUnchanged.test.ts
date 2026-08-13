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
import { VALUED_FLAGS, main } from '../../bin/conclave.ts'
import { flagReader } from '../config/cliFlags.ts'
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

function assertFlagHelperOptional(block: string, label: string, valued: readonly string[]): void {
  const helperStart = block.indexOf('const flag =')
  assert.ok(helperStart > 0, `${label} flag helper must be present`)
  assert.match(
    block.slice(helperStart, helperStart + 200),
    /const flag = flagReader\(/,
    `${label} must read its flags with the shared reader (see DECLARED['one flag reader for both front-ends'])`,
  )
  // The property this guard exists for, asserted against the reader itself rather than against
  // the text of a helper. Every valued flag is OPTIONAL -- D1 forbids one becoming required --
  // so an argv naming none of them must hand back every fallback unchanged and complain about
  // nothing. Two three-line helpers used to be pinned here by their source, which said the same
  // thing less directly and stopped saying it the moment the parsing moved.
  const flag = flagReader([], valued)
  for (const name of valued) {
    assert.equal(flag(name, 'fallback'), 'fallback', `${label}: --${name} must be optional`)
  }
  assert.equal(flag.missing, undefined, `${label}: an argv with no flags is missing no values`)
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
    'that raises it is at src/relay/relay.ts:4554.',
  'status.pause.resolution':
    'Classifying unresolved conditions on both axes (#56, D2) added `resolution` to every RunPause ' +
    '(src/relay/run.ts:193), so `conclave status --json` on a paused default run now carries ' +
    'pause.resolution = {reason, authority, scope} and pause.resolution.scope = {kind}. Additive and ' +
    'recorded rather than acted on: authority and scope are computed at the halt site from the reason ' +
    'and the run configuration (src/relay/resolution.ts:190), and a request whose authority is ' +
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
    'list of seats, each an agent optionally followed by that seat’s own launch arguments ' +
    '("claude --model opus-5, claude --model sonnet-5"). This is D1 as written -- "adding seats ' +
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
    'run with two constructed seats. ' +
    'PER-SEAT LAUNCH ARGUMENTS ride inside that same flag (#77), and no flag is added for them, ' +
    'which is the part being declared here. Seats that cannot differ in MODEL are barely ' +
    'heterogeneous -- one agent id spans dozens of models -- and --implementer-args is one flag ' +
    'that says implementer, so it applies to every seat by construction. The alternative was a ' +
    'second flag holding a list correlated with this one by POSITION, and a pairing that exists ' +
    'only as two array indices is one a single dropped entry silently reassigns: seat two ' +
    'launched with seat three’s model, run started, nothing anywhere says so. Carrying the ' +
    'arguments in the entry makes that unrepresentable. THE DEFAULT RUN DOES NOT CHANGE: with ' +
    '--implementers absent both front-ends build one seat from --implementer carrying no ' +
    'arguments of its own, so `implementerSpecsFor` composes the same argv from the same two ' +
    'sources it always did, and the flag sets pinned below are untouched. Two surfaces DO ' +
    'change and are named rather than left to be discovered: `SeatPlan.listed` carries `seats` ' +
    '(agent and args) instead of `agents`, and `SessionOptions.implementers` is `SeatRequest[]` ' +
    'rather than `string[]` -- the console front-end hands over a list and lets `runSession` ' +
    'build the specs, so a bare agent list there is a wire on which a seat’s own arguments have ' +
    'nowhere to be. One cost, stated rather than hidden: the comma is the seat boundary, so an ' +
    'argument containing a comma cannot be written on this flag and belongs in ' +
    '.conclave/config.json, which is keyed by agent. No assertion in this file was relaxed. That ' +
    'each seat receives its OWN arguments and no other seat’s is proved at the CLI, through ' +
    'both real front-ends, in src/relay/perSeatArgs.test.ts.',
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
  'one flag reader for both front-ends':
    'Both commands now read their argv with one shared `flagReader` over a declared list of ' +
    'valued flags, and the two three-line helpers they each carried are gone. The flag SURFACE ' +
    'does not change -- the two pinned sets below are the sets they were -- and neither does the ' +
    'default run, which names no flag at all and so reads nothing but fallbacks. Two things DO ' +
    'change and are declared for it. First, VALUES: `session --implementer-args "--model x"` was ' +
    'refused while `relay --implementer-args "--model x"` launched, because the console read any ' +
    'value beginning with `--` as a value that had gone missing and the relay read whatever token ' +
    'followed the flag (#81). The console rule was the better half and is kept for every flag ' +
    'except the ones whose value is argv for a CHILD cli (`PASS_THROUGH_FLAGS`), so the long ' +
    'spelling now works on both -- which matters because picking a model per seat is the ' +
    'mechanism behind heterogeneous seats (#77) and `--model` is exactly what was being refused. ' +
    'Second, and it is a NARROWING: `relay --rounds --json` used to read `--json` as the number ' +
    'of rounds and start anyway, and now refuses with the message the console already printed. ' +
    'That is a real change to what relay accepts, made deliberately rather than as a side ' +
    'effect -- the alternative was making the console as lenient as the relay, which reaches ' +
    'parity by deleting the better diagnostic, and relay is the front-end whose runs nobody is ' +
    'watching. One assertion in this file MOVED and none was relaxed: the pinned helper text ' +
    'became a behavioural check that every valued flag is still optional ' +
    '(`assertFlagHelperOptional`), which is what that pin was for and is now asserted by calling ' +
    'the reader rather than by matching three lines of source. That the two front-ends AGREE ' +
    'about values is not claimed here: it is proved in src/relay/frontEndParity.test.ts, which ' +
    'drives both commands through `main` over every shared valued flag and compares what each ' +
    'one accepts.',
  '--checks also gate the merged tree at N>1, and the integration_failed outcome':
    'NO FLAG IS ADDED and the pinned flag sets below are untouched, which is why this entry ' +
    'exists at all: the change is invisible to every guard in this file and is a real change ' +
    'to what an existing configuration DOES. --checks are now run a second time per merge, ' +
    'against the integration checkout, and a failure there is a new kind of failure. The ' +
    'operator’s reason (#80): the first real two-seat run merged three tasks with no git ' +
    'conflict at all and produced a tree that failed two tests, because nothing in the design ' +
    'looks at the integration RESULT — git reports textual conflict, and per-seat checks run ' +
    'in each seat’s own tree (D7), so every seat can pass while the tree they build together ' +
    'fails. A separate --integration-checks flag was built first and then removed on the ' +
    'operator’s ruling: an opt-in station leaves exactly the run that failed unprotected ' +
    'unless someone discovers the flag and duplicates configuration they have already ' +
    'supplied. src/relay/integrate.ts carries the original objection to reusing this field ' +
    'and why it was overruled; the cost is recorded there rather than dropped. A failure ' +
    'mid-run is a repair the advisor dispatches, naming BOTH contributing tasks — no seat is ' +
    'marked, because the defect exists in neither half and assigning it by fault would be a ' +
    'guess. A failure after the FINAL merge has no seat to repair it, so the run reports it ' +
    'instead: RunReason gains `integration_failed` (src/relay/observe.ts), it replaces `done` ' +
    'and `budget` in Relay.#end so no ending can report success over a tree that does not ' +
    'build, and `relay` exits non-zero on it as it does on ceiling and transport_failed. THE ' +
    'DEFAULT RUN DOES NOT CHANGE, and not by a seat-count branch: without seat worktrees ' +
    'there is no merge, so the boundary this runs in is not reached at all. A default run ' +
    'with --checks behaves exactly as before — same commands, same frequency, same meaning — ' +
    'and neither the ended nor any paused status document changes. No assertion in this file ' +
    'was relaxed. That the second station DOES something is proved against real worktrees, ' +
    'real merges and real check commands in src/relay/integrationRed.test.ts and ' +
    'src/relay/integrate.test.ts.',
  'the check lane is retained INERT, and --check-concurrency was withdrawn':
    'NOTHING ON THE GUARDED SURFACE CHANGES, and that is the entry: the pinned flag sets below ' +
    'are exactly the sets they were, no status document moves, and no default run behaves ' +
    'differently. It is written down so the flag is not re-added by someone reading #64 and ' +
    'finding no trace of the decision. --check-concurrency WAS built, on both front-ends, ' +
    'through a shared parser, into RelayOptions and SessionOptions — and was removed on the ' +
    'operator’s ruling before it shipped. #64’s premise is false in this codebase: it asks for ' +
    'the configured checks to be serialised across seats because four worktrees running ' +
    '"npm test" mean four test runners, but both check runners are spawnSync (`runCheck`, ' +
    '`runIntegrationChecks`) in the one orchestrator process, so a synchronous spawn blocks ' +
    'everything for the duration and serialisation is ALREADY guaranteed by the call. There is ' +
    'no contention to prevent, so the flag could not have had an effect — and a control that is ' +
    'accepted and plumbed and does nothing is worse than an absent one, because someone will ' +
    'set it and believe something changed. That is the same failure class as a test whose name ' +
    'asserts more than its assertions check. The mutex itself is KEPT (src/relay/checkLane.ts), ' +
    'one slot and not configurable, wrapping the two stations at their outermost points: ' +
    '`#crossBoundary` takes it once for the whole boundary including the checks integrateSeat ' +
    'runs for itself, and `rotateImplementer` once for the whole of rotate(). It is kept as a ' +
    'MECHANISM rather than as behaviour — it cannot contend until per-seat rotation (#78) adds ' +
    'a second live station, and building an async runner so it could would be building the ' +
    'problem in order to keep the solution. The condition on keeping it is that it is directly ' +
    'unit-tested rather than validated through a run that cannot exercise it: acquire, release, ' +
    'release-on-throw and the refusal to acquire twice are each asserted in ' +
    'src/relay/checkLane.test.ts. The one claim a real run CAN make — that each station takes ' +
    'the lane exactly once, which is what would deadlock it — is driven through real worktrees ' +
    'and real merges in src/relay/checkLaneRun.test.ts. No assertion in this file was relaxed, ' +
    'and none was added: this entry is the whole of the footprint.',
  'per-seat rotation, per-seat rotation policy, and the unobservable-acceptance stop (#78, #76)':
    'NO FLAG IS ADDED and no status document changes, which is most of why this entry exists: ' +
    'the whole of #78 lands on the PROGRAMMATIC surface, the way `implementers` did. Rotation ' +
    'gains Relay.rotateSeat(seatId, reason) and RotationConfig gains a `seats` map of per-seat ' +
    'overrides (D7: the run policy is a default a seat may amend); neither front-end sets ' +
    'either, so `--checks` still means one policy for the whole run and a default run is under ' +
    'exactly the policy it was. THREE THINGS IN THIS FILE MOVED, all of them localized, and ' +
    'none of them relaxed. (1) The pinned rotation-replacement cwd regex: the replacement is ' +
    'now created in `root`, the rotating seat’s own tree, because a replacement verified in the ' +
    'integration checkout would be measured against work its predecessor never did. At N=1 that ' +
    'root IS the run cwd — `#rootOf` answers `this.#opts.cwd` when there is no worktree ' +
    'manifest, which is not a seat-count branch — so the pin was replaced by three: the ' +
    'replacement is created in `root`, `root` comes from `#rootOf(seatId)`, and `#rootOf` falls ' +
    'back to the run cwd. The behavioural half of the guarantee is unchanged and still ' +
    'OBSERVED, by `seatsFromSessionCli` reading the cwd back off the registry. (2) The check ' +
    'lane entry above says the lane cannot contend until #78 adds a second live station; #78 is ' +
    'here, so src/relay/checkLane.ts now says what is and is not reachable — both stations are ' +
    'real, the dispatcher still processes one completion at a time so the LOOP cannot overlap ' +
    'them, and a wait is reachable only from a rotation started outside the loop. The lane ' +
    'gained an `onWait` notification, which is silent unless a section actually queues: no ' +
    'wait, no note, and no default run reaches it. No slot count, and --check-concurrency stays ' +
    'withdrawn. (3) A merge_blocked pause in a MULTI-SEAT run now offers `rotate`, asserted in ' +
    'src/relay/resolution.test.ts with the reason: the menu lists only options that would do ' +
    'something, and rotation can now name that seat. No pause in a default run changes — at N=1 ' +
    'the same conditions offered `rotate` before and offer it now. What #76 adds is a REASON ' +
    'rather than an option: acceptance that produces no observable output is ' +
    '`acceptance_unobservable` instead of `replacement_could_not_reproduce`, the run says ' +
    'rotation is not the remedy and stops attempting it, and rotationSummary gains a line only ' +
    'when that has happened. RunReason is untouched, the status JSON rotation keys are ' +
    'untouched, and rotationWatch gained no counter. Proved against real worktrees, real merges ' +
    'and a real replacement in src/relay/seatRotation.test.ts and src/relay/implementerSeats.test.ts. ' +
    'ONE PRE-EXISTING PROGRAMMATIC SURFACE DOES CHANGE, and it changes by refusing: rotateSeat — ' +
    'and so rotateImplementer, which delegates to it — now throws rather than proceeding when the ' +
    'target seat has an ungraded task or an exchange in flight, when the ADVISOR has an exchange ' +
    'in flight (rotation asks it for the handoff, and a concurrent send interleaves two turns on ' +
    'one transcript), or when that seat is already being rotated. Each of those would previously ' +
    'have quiesced and retired a session mid-turn or run two transactions over one seat. The ' +
    'relay tracks both facts itself — an in-flight exchange count per participant and a rotation ' +
    'claim per seat — rather than reading a session, because a session says `running` either way. ' +
    'NO DEFAULT RUN REACHES ANY OF THESE: the loop rotates from the completion path, after the ' +
    'grade and with no advisor exchange open, and the console refuses /rotate unless the run is ' +
    'already paused. They are reachable from an out-of-band caller, which is what they are for.',
  '--reviewer on both front-ends, and the review_blocked pause reason':
    'The optional flag surface grows by two on each command: --reviewer and --reviewer-args, ' +
    'an opt-in named seat at rank implementer and role reviewer (#72, D9b, D5). Declared for ' +
    'the same reason "--implementers on both front-ends" is: the argument for D1 ("adding ' +
    'seats brings new arguments and nothing else") is the thing being written down, not a ' +
    'change to the default run. THE DEFAULT RUN DOES NOT CHANGE: with --reviewer absent, no ' +
    'reviewer key reaches Relay.start on either front-end (reviewerSpecFor returns undefined ' +
    'for an empty agent string), no review task is ever admitted, and the merge boundary runs ' +
    'exactly as it did before this issue — every pinned shape and flag set below is untouched ' +
    'by a default invocation of either command. Review is modelled as a TASK PURPOSE (review, ' +
    'review_resolution) dispatched through the same scheduler merge_resolution already uses, ' +
    'never as a hook #crossBoundary calls: a completed seat’s boundary is deferred, not ' +
    'skipped, until a declared reviewer accepts or rejects it — proved end to end with real ' +
    'worktrees in src/relay/review.test.ts. #implementers() is now read off ROLE rather than ' +
    'RANK, because a reviewer is rank implementer with a different job (D5) and every existing ' +
    'caller — rotation eligibility, the opening implementer briefing, the closing question — ' +
    'means the job. At N=1 with no reviewer every rank-implementer participant is still ' +
    'role-implementer, so this is a no-op for the default run. A REJECTED review produces an ' +
    'automatic repair task, addressed to the producing seat by the relay itself — not the ' +
    'advisor — with Task.parent naming the immediate task it repairs; a repair whose own parent ' +
    'is itself a repair is the second rejection of the same work, which is what a new ' +
    'PauseReason, review_blocked, escalates rather than repairing a third time. Its pause shape ' +
    'is pinned below (provokeReviewBlocked), mirroring merge_blocked, and it is unreachable ' +
    'without a reviewer seat for the same reason merge_blocked is unreachable without a second ' +
    'implementer seat. The advisor is briefed about the reviewer only when one is declared ' +
    '(REVIEWER_BRIEFING_FOR_ADVISOR), proved absent-by-default and present-when-declared the ' +
    'same way MULTI_SEAT_BRIEFING is, in the mutation-tested test immediately above this one. ' +
    'No assertion in this file was relaxed.',
  "the console's /continue liveness guard samples by pause SCOPE, and no longer by rank":
    'NO FLAG IS ADDED and no document gains a key, which is why this entry exists: the change is ' +
    'invisible to every guard in this file and it does change what a DEFAULT console run does. ' +
    'The `/continue` guard that samples a child before resuming (seatsToSampleAtPause in ' +
    'src/repl/session.ts) now reads pause.resolution.scope: a participant scope samples that ' +
    'participant and nobody else, and a conclave or workstream scope samples NOBODY. It used to ' +
    'read pause.verdictOf.participant and fall back to scanning participants by rank for ' +
    'implementers — and verdictOf is set at exactly two halt sites, both turn_incomplete ' +
    '(src/relay/relay.ts:4307, src/relay/relay.ts:4693), so every other pause reached that rank ' +
    'scan. WHAT CHANGES AT N=1: on the three pauses whose scope names no participant — ' +
    'operator_requested (/pause), advisor_escalated, authority_conflict — the lone implementer ' +
    'child used to be sampled, so a child that measured busy REFUSED the resume and wrote ' +
    'pause.refusal into the status document. It is not sampled now, so that refusal cannot be ' +
    'raised for those three reasons and /continue proceeds. Declared as a real narrowing of a ' +
    'safety guard rather than presented as a pure N>1 fix. The reason it is the right narrowing: ' +
    'the guard exists because continuing SENDS into a child that cannot accept input mid-turn, ' +
    'and on those three pauses the child it measured is not the child being sent to — resuming ' +
    'advisor_escalated sends to the ADVISOR (src/relay/relay.ts:4406), resuming ' +
    'authority_conflict queues a constraint that is delivered by the dispatcher on the next ' +
    'dispatch to a free seat, and operator_requested is consumed at an advisor-turn boundary ' +
    'whose own evidence line says no turn is in flight. WHAT IS GIVEN UP, named rather than ' +
    'discovered: the advisor_escalated halt raised when a seat’s turn completed and its report ' +
    'could not be read (src/relay/relay.ts:4603) is conclave-scoped by design, yet the useful ' +
    'question there is whether THAT seat is still writing; at N=1 the rank scan sampled it by ' +
    'coincidence of it being the only implementer, and now nothing does. The pause still carries ' +
    'that seat’s liveness evidence from the halt site (src/relay/relay.ts:4616), which is what ' +
    'the operator actually reads; restoring a refusal there is a change to that halt’s scope, ' +
    'not to the guard. AT N>1 the old behaviour was unsafe in the other direction: a pause about ' +
    'one seat could be refused because a DIFFERENT seat was mid-turn, and the operator was told ' +
    'to wait for a seat the pause never mentioned. No assertion in this file was relaxed: the ' +
    'six pinned pause documents do not carry a refusal (none of them attempts a resume), and the ' +
    'rule is covered directly in src/repl/session.test.ts — over every reason’s scope, and end to ' +
    'end through a two-seat console run where one advisor reply dispatches to both seats, ' +
    'implementer-2 compacts into a rotation_candidate pause, and /continue resumes it while ' +
    'implementer is provably still mid-turn in the status document’s own seat block.',
  'a mixed CPU sample is reported as mixed rather than as a working child (#83)':
    'THE REASON, in one sentence: the liveness output now distinguishes an ALL-LOW measurement ' +
    'from an ALL-HIGH one and from a MIXED one, and hands all three to the operator as ' +
    'measurements to judge, because the binary it replaced could only say "idle" or "still ' +
    'working" and had to round every mixed sample up to the confident end. ' +
    'NO FLAG IS ADDED, no document gains a key, and NOTHING BECOMES LESS CONSERVATIVE — the ' +
    'rest of the change is entirely in what a default run SAYS at a pause, which is why it is ' +
    'declared rather than assumed invisible. `idle` is untouched: every sample below IDLE_CPU_PERCENT ' +
    'and nothing else, the asymmetry chosen after a run was lost to the opposite mistake. What ' +
    'was wrong was the other half of the same `if` — anything not idle was announced as "still ' +
    'working", so 0.3%, 0.2%, 7.2% with three events was a true report of a false thing. ' +
    'describeLiveness now reads one of three (readingOf: not_computing, working, mixed; gone ' +
    'when the process is not there), and a mixed reading says which way it leans — "is barely ' +
    'running" when most samples are below the line, "is working in bursts" when most are above ' +
    '— with the measured percentages still printed verbatim. THE EVENT COUNT IS NOW AN INPUT ' +
    'to that sentence rather than a clause after it, against QUIET_EVENT_COUNT (5), a new ' +
    'exported constant that is unmeasured and documented as unmeasured: it changes wording ' +
    'only, and `idle`, the /continue refusal and the pause menu are all blind to it. THREE ' +
    'PROGRAMMATIC SURFACES ARE ADDED, all in src/outcomes/liveness.ts and all read-only over a ' +
    'ChildLiveness that itself does not change (so pause.refusal.liveness in the status JSON is ' +
    'the shape it was): LivenessReading, readingOf and reportsChildOnCpu. The last exists ' +
    'because the relay decided the `wait` option by regex over the operator’s evidence prose ' +
    '(`/is still working \\(cpu/`), which would have silently dropped `wait` from a mixed pause ' +
    '— the one reading where the non-destructive option is worth the most; it now asks ' +
    'liveness.ts, which owns both the phrasing and the matcher. describeLiveness’s second ' +
    'parameter accepts undefined for "no count was taken with this sample", and the console’s ' +
    '/continue guard passes it: that guard samples the child fresh and has no matching count, ' +
    'so the `0` it passed rendered as "nothing at all since the prompt was sent" about a number ' +
    'nobody had measured — harmless while the count was decoration, not harmless now it is an ' +
    'input. WHAT A DEFAULT RUN DOES DIFFERENTLY: on a mixed sample the pause evidence and the ' +
    '/continue refusal read differently, and the console headline is "the child is not clearly ' +
    'idle" rather than "the child is working right now". THE REFUSAL ITSELF IS UNCHANGED — a ' +
    'mixed sample still refuses /continue and still requires force, because continuing SENDS ' +
    'and a burst may be a turn. No assertion in this file was relaxed; one citation moved with ' +
    'the code it pins (src/repl/session.ts:988). Covered in src/outcomes/liveness.test.ts on ' +
    'the reported numbers, and end to end through the console’s refusal path in ' +
    'src/repl/session.test.ts.',
  'models are validated before launch, graded per adapter, and a silent first turn names the model':
    'NO FLAG IS ADDED, no status document gains a key, and the pinned sets below are untouched — ' +
    'and this still changes what an existing configuration DOES, twice, which is why it is here. ' +
    'FIRST: a run whose argv names a model the child does not have is now REFUSED before any ' +
    'child is launched, instead of starting and dying at a watchdog. #82 is that failure: ' +
    '`--implementers "claude --model opus-5, claude --model sonnet-5"` was accepted, both seats ' +
    'launched, and every turn produced nothing at all until DEFAULT_IDLE_MS killed it — three ' +
    'turns, twenty-five minutes, and nothing anywhere said the model did not exist. THE MODEL ' +
    'LIST IS NOT IN CONCLAVE, which is the design and not an omission: a baked list would have ' +
    'refused `fable` before `fable` shipped, and a validator that refuses valid input gets ' +
    'switched off. The children are asked instead — `opencode models` enumerates 60, ' +
    '`claude --help` names its aliases inside the `--model` option text — and where a child ' +
    'cannot be asked the capability model already has the honest answer: `codex models` needs a ' +
    'terminal and kimi has no such command, so both are graded `unsupported` with the reason, ' +
    'and their selections pass through unjudged. The grade is declared beside each definition ' +
    '(`AgentDefinition.models`) for the reason `DeadlineSupport` gives, and it is OPTIONAL where ' +
    'deadlines are required, because silence here removes a check rather than inventing a ' +
    'guarantee. THE DEFAULT RUN DOES NOT CHANGE and does not pay for this: `modelFromArgs` ' +
    'reports `null` for an argv that names no model, a `null` selection is not checked, and no ' +
    'subprocess is spawned for it — a default run reaches the ask exactly never. Agent and role ' +
    'identifiers stay open-ended: nothing here narrows `RoleId`, an agent id, or a full model ' +
    'name, and only a name the CLI itself enumerates can be refused. A seat that named a model ' +
    'and could NOT be judged — an unsupported agent, a full model name passed through, a CLI ' +
    'that could not be asked — writes ONE internal note into the run log saying so and why, ' +
    'because the issue asks for exactly that ("an agent whose models cannot be enumerated says ' +
    'so rather than guessing") and a negative result nobody can see is a check an operator will ' +
    'believe covered them. A seat that WAS judged stays silent, and a default run names no ' +
    'model, so no default run produces the line. SECOND, and it is a change ' +
    'to a report an existing consumer reads: a deadline verdict on a session’s FIRST turn that ' +
    'produced no output whatsoever now carries one extra `orchestrator` provenance entry, ' +
    'flagged `caveat`, naming the launch model as a CANDIDATE cause. "Emitted nothing" and ' +
    '"emitted and then went quiet" read identically today and are different findings, and this ' +
    'is the second half of #82 — the diagnostic half, for the rejections validation cannot ' +
    'predict (an entitlement, an outage, a name valid for one account and not another). It is ' +
    'gated on the first turn because a later turn has already proved the launch works, and on ' +
    'the child having produced nothing, which is tracked separately from the idle clock: the ' +
    'adapters emit `turn_start` the instant they arm, so `lastActivityAt` cannot tell the two ' +
    'apart. "Produced nothing" means NO OUTPUT WHATSOEVER, a claim about bytes rather than ' +
    'about a structured stream, and it is measured per adapter family: on the pty adapters it ' +
    'is the absence of any event the CHILD sourced (`turn_start` and this adapter’s own ' +
    'revisions do not count), and on the run-per-turn adapters it is zero signals of ANY kind — ' +
    'no parsed record of any type, no hook delivery on kimi, and not one non-empty write to ' +
    'stderr. NOT empty content fields, which is what it read first and got wrong: an `error` ' +
    'record, a `role: "tool"` result, an empty assistant message, an unrecognised record type ' +
    'and a provider failure printed to stderr all leave `steps`/`textBlocks`/`toolCalls` empty ' +
    'on a child that has already answered, and naming its model there talks over that answer ' +
    'with speculation. ONE FURTHER REPORT CHANGE FALLS OUT OF THAT, small and observable: a ' +
    'watchdog-killed turn on either run-per-turn adapter now carries the child’s stderr in its ' +
    'verdict provenance as a `process` caveat, where that path used to keep the clock and the ' +
    'signal and discard the one line saying why. Nothing else about a verdict moves — same ' +
    'outcome, same confidence, same ' +
    'watchdog line first — and a turn that spoke, a later turn, or an adapter that reports no ' +
    'launch state gets the chain it always got, asserted byte for byte in ' +
    'src/outcomes/firstTurnDiagnosis.test.ts. No assertion in this file was relaxed. That both ' +
    'front-ends refuse before constructing any child, and start normally when every seat names ' +
    'a model its CLI has, is proved through `main` with the real argv in ' +
    'src/registry/models.test.ts; that the two pty adapters actually populate the diagnosis is ' +
    'proved against real ptys in src/adapters/watchdogWiring.test.ts.',
  'an unarmed run survives a compaction instead of ending on it (#96)':
    'A REAL CHANGE AT N=1, and to the most ordinary configuration there is: `--advisor codex ' +
    '--implementer claude` with no --checks. Such a run used to END when the implementer ' +
    'compacted -- outcome `escalated`, detail "No rotation checks are configured, so this needs ' +
    'a human" -- and it now raises a rotation_candidate pause instead, resolvable with ' +
    '/continue, or records a note and carries on when nobody is attending. Observed on ' +
    'oath-lang: a healthy seat, mid-work with 220 insertions and a new test file on disk, ' +
    'compacted normally and the run ended, telling a human it needed them while that human was ' +
    'at the console it never asked. WHY ENDING WAS WRONG, and it is not the claim that ' +
    'compaction is harmless: rotation needs checks to reproduce, so an unarmed run genuinely ' +
    'cannot rotate -- but that is an argument against ROTATING, and it was read as an argument ' +
    'for ENDING. The armed branch twenty lines below already made the case and had it accepted: ' +
    '"ending a run is the most drastic action available, not a neutral one", and "recorded, not ' +
    'acted on" has to mean recorded and not acted on. The unarmed branch acted HARDEST on the ' +
    'weakest evidence -- #10 is open, nothing yet shows compaction and degradation coincide -- ' +
    'in the configuration with the least means to check. Confidence and severity were inverted. ' +
    'WHAT DOES NOT CHANGE: detection. The seat is still assessed, the candidate still counts ' +
    'toward rotationWatch.candidates and the summary, and a run WITH checks behaves exactly as ' +
    'before. Rotation is still impossible without checks and is still not offered in the pause ' +
    'options, because an option that no-ops is the failure #66 and #76 both describe; the pause ' +
    'names --checks as what would widen the choice next time. The baseline is acknowledged on ' +
    'both paths, so one compaction is raised once -- without that the fix would trade a single ' +
    'fatal pause for one that repeats every turn, which is worse. ONE CONSEQUENCE FOR THE ' +
    'RESOLUTION MODEL, and it is the classification becoming honest rather than a new rule: the ' +
    '`operator` branch of the derived rotation authority (D2) is now REACHABLE. It describes an ' +
    'unarmed candidate -- nothing mechanical can settle it, so it is the operator\u2019s -- and ' +
    'until now the one configuration it described was the one that never produced a pause to ' +
    'describe. Proved in src/relay/resolution.test.ts, which asserted the ending and now asserts ' +
    'the pause, its authority, its scope, the absence of rotate from its options, and that the ' +
    'run continues past the compaction.',
  'a seat whose CLI is not installed is refused before anything is created (#51)':
    'NO FLAG IS ADDED, no status document gains a key, and the pinned sets below are untouched — ' +
    'and this changes what an existing configuration DOES, which is why it is here. A run seated ' +
    'on an agent whose command is not on the machine is now refused before `new Relay`, before ' +
    'the seat worktrees, before every adapter preflight and before any child. #51 is that ' +
    'failure: an implementer was seated on OpenCode before OpenCode was installed, `resolve()` ' +
    'reported the agent as available, and the run registered both seats, wrote its hooks, checked ' +
    'Codex trust, printed the banner and routed the goal — and then the first turn died as ' +
    '`unknown_abnormal_end`. The adapter classified that correctly and the capabilities table ' +
    'already documents the grade; the objection was never that the failure is mishandled, it is ' +
    'that everything before it was work done on the operator’s behalf in a configuration that ' +
    'could never have run. This is the rule `relay` already applies to being outside a git ' +
    'repository, whose guard says "before anything is spawned, registered or written", and a ' +
    'missing CLI is the same shape and cheaper to detect. NOTHING IS SPAWNED to find out, which ' +
    'is deliberate rather than an optimisation: running the command to see whether it exists ' +
    'starts a child that may open a terminal UI or act on a default nobody chose — which is ' +
    'exactly what `codex` did during spike 1. `findExecutable` (src/registry/executables.ts) does ' +
    'the walk `execvp` does instead — a separated command is a path resolved against the SEAT’s ' +
    'cwd, anything else is searched along PATH in order, a directory and a file with no ' +
    'executable bit never match, and on Windows each PATHEXT suffix is tried, because ' +
    '`npm i -g opencode-ai` puts `opencode.cmd` on PATH and reporting that missing would be worse ' +
    'than not checking at all. Wrappers pass by construction: nothing reads the file’s contents ' +
    'or asks what kind of program it is, so a shell shim, a `.cmd` stub and a version manager’s ' +
    'symlink are all just executable files. WHAT IS NOT CLAIMED is that the file found will run — ' +
    'absence is a fact, presence only removes one reason to fail — so a found command produces no ' +
    'output whatsoever and only a missing one produces a refusal. IT RUNS BEFORE THE MODEL CHECK ' +
    'and the order is load-bearing: enumerating models means spawning the very command in ' +
    'question, so an absent binary reaching that check is announced as a model that could not be ' +
    'verified rather than as the missing install it is. THE REQUIREMENT IS DECLARED PER ' +
    'DEFINITION, `LaunchSpec.executable`, for the reason `AgentDefinition.models` gives — and it ' +
    'is OPTIONAL for a reason `models` does not have: `LaunchSpec` is required, so every ' +
    'in-memory double in this suite carries a `command` that is a label rather than a program, ' +
    'and the declaration is what separates "this definition spawns this file" from "this ' +
    'definition names a string". Silence removes a check rather than inventing a guarantee, which ' +
    'is the safe direction and here also the only workable one. Each built-in additionally ' +
    'carries an INSTALL HINT, quoted into the refusal and never executed by anything, with its ' +
    'source stated beside it because an install line with no provenance is a claim about someone ' +
    'else’s machine — all four are read back off the machine these adapters were measured on. ' +
    'THE DEFAULT RUN DOES NOT CHANGE: `--advisor codex --implementer claude` on a machine with ' +
    'both installed reaches two `stat` calls and starts, and every guard in this file runs ' +
    'against agents that declare no requirement and are therefore not checked at all. SCOPE IS ' +
    'THE SEATED AGENTS ONLY — lead, every implementer, and the reviewer when one is declared — ' +
    'because `list()` exists to describe agents an operator has not seated, and refusing a run ' +
    'because an unused registration is uninstalled would make the registry’s breadth a ' +
    'liability. `createParticipant` enforces the same rule as the programmatic floor, the way it ' +
    'does for models: `Relay.start` checks the whole list so no seat has a live child when the ' +
    'refusal lands, and the funnel check covers the callers that never pass through it. A ' +
    'CONFIGURATION THAT DOES NOT RESOLVE IS REFUSED FOR THAT INSTEAD, and neither preflight runs ' +
    'at all — CI caught this and the developer machine could not have. `--lead nope` resolves no ' +
    'lead and a default implementer, and on a machine with neither CLI installed the executable ' +
    'check refused the IMPLEMENTER’s missing `claude`, so the operator was told to install ' +
    'something while the actual mistake, an agent named `nope`, went unmentioned. Dropping the ' +
    'unresolvable spec from the checked list is not enough, because the seats around it are still ' +
    'checked; when the seating itself is invalid there is no run to describe, and `#join` refuses ' +
    'it with the message written for it. THE RULE ' +
    'THE LOOKUP IS HELD TO, because it was got wrong once on the way in: an EMPTY PATH entry is ' +
    'the seat’s cwd, which is what `execvp` does with a zero-length element, so `PATH=":/usr/bin"` ' +
    'with a wrapper in the working directory is a setup that launches and is not refused. It was ' +
    'skipped first, on the argument that a run which starts only because a binary sits in the ' +
    'operator’s cwd is not reproducible — a fair objection, and not this check’s to make. ' +
    'Reproducibility is a different question from "would the OS find this file", and answering the ' +
    'second with the first produces a refusal of valid input, which is the one failure mode the ' +
    'model validator beside it already argues is worse than having no validator at all. ' +
    'ONE FURTHER CHANGE FALLS OUT OF THIS AND IS A REAL CHANGE TO A PROGRAMMATIC SURFACE: ' +
    '`launch.command` is now the command every built-in actually spawns. It was previously INERT ' +
    'for all four — the pty adapters hardcoded `PtyProcess.spawn({file: \'claude\'})` and ' +
    '`{file: \'codex\'}`, and the two run-per-turn adapters had a `command` option their `create` ' +
    'never passed — so the field could be set to an absolute path or a wrapper and nothing would ' +
    'read it. That was harmless while nothing read it and became a defect the moment this ' +
    'preflight did: the check would validate the wrapper and the adapter would then launch ' +
    'whatever was on PATH, which is a validated field describing a configuration the run does not ' +
    'have — worse than no check, because it reports on the wrong thing confidently. Both pty ' +
    'adapters gain an optional `command` defaulting to their bare name, so every direct caller ' +
    '(the live tests, watchdogWiring) is unchanged, and all four `create` functions now forward ' +
    '`resolved.agent.launch.command`. THE DEFAULT RUN DOES NOT CHANGE: the built-ins declare the ' +
    'bare names they always spawned, so the argument threaded through is the string that was ' +
    'hardcoded. What changes is that an operator or a config layer CAN now point a definition at ' +
    'a wrapper and have it both accepted and executed, which is proved end to end against the ' +
    'recorded stdout of a real `opencode run --format json` — the real built-in definition with ' +
    'one field changed, through the production `create` and the production adapter. ' +
    '`unavailableReason` is untouched and still means what it ' +
    'meant: whether conclave has an adapter, not whether the CLI that adapter drives is present. ' +
    'No assertion in this file was relaxed. Proved in src/registry/executables.test.ts — the ' +
    'lookup against real files in real directories, and the placement through both real ' +
    'front-ends and through `Relay.start` with two seats, where the counters that must read zero ' +
    'are the adapter preflights, the constructed children and the seat worktrees.',
}

test('DECLARED contains exactly the routing, pause-resolution, attribution, ceiling-flag, seat-flag, seat-status, launch-record, flag-reader, integration-check, per-seat-rotation, reviewer, resume-guard, mixed-liveness, model-validation, executable-preflight and compaction-survival entries', () => {
  assert.deepEqual(Object.keys(DECLARED), [
    'implementer_unanswered -> advisor',
    'status.pause.resolution',
    'per-seat artifact attribution',
    'optional ceiling flags on both front-ends',
    '--implementers on both front-ends',
    'per-seat dispatcher state in status --json',
    'per-seat launch args and model in status --json and the run report',
    'one flag reader for both front-ends',
    '--checks also gate the merged tree at N>1, and the integration_failed outcome',
    'the check lane is retained INERT, and --check-concurrency was withdrawn',
    'per-seat rotation, per-seat rotation policy, and the unobservable-acceptance stop (#78, #76)',
    '--reviewer on both front-ends, and the review_blocked pause reason',
    "the console's /continue liveness guard samples by pause SCOPE, and no longer by rank",
    'a mixed CPU sample is reported as mixed rather than as a working child (#83)',
    'models are validated before launch, graded per adapter, and a silent first turn names the model',
    'an unarmed run survives a compaction instead of ending on it (#96)',
    'a seat whose CLI is not installed is refused before anything is created (#51)',
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
 * call sites: the report is what `bin/conclave.ts:1308` prints, and the status record is what
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
 * `set('paused', { pause })` is the same call the console makes at src/repl/session.ts:988
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
 * A reviewer rejecting the same work twice, driven to escalation (#72).
 *
 * One implementer, one reviewer. The implementer's work is reviewed automatically -- no
 * advisor instruction addresses the reviewer, matching D9b's "not a hook the boundary
 * calls, but not an advisor decision either". The first rejection produces an automatic
 * repair; the repair is reviewed too and rejected again, which is what escalates: the
 * repair's own `parent` is the ORIGINAL task, and its `purpose` is `review_resolution`,
 * which is what `resolveReview` in `relay.ts` reads to tell a first rejection from a second.
 */
async function provokeReviewBlocked(repo: string): Promise<{ relay: Relay; run: RunHandle; pause: RunPause }> {
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })

  const advisor = new FakeRotationSession('advisor', 'codex', ['Write the answer.', 'DONE', 'DONE', 'DONE', 'DONE'])
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Wrote it.', 'Wrote it again.'])
  const reviewer = new FakeRotationSession('reviewer', 'claude', [
    'ack',
    'REJECT: not good enough.',
    'REJECT: still not good enough.',
  ])

  const registry = new AgentRegistry()
  for (const [agent, sessions] of [
    ['codex', [advisor]],
    ['claude', [impl, reviewer]],
  ] as const) {
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

  const relay = await Relay.start({
    registry,
    cwd: repo,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    reviewer: { id: 'reviewer', agent: 'claude', role: 'reviewer' },
    maxAdvisorTurns: 6,
  })

  const run = relay.start('Keep the work moving.')
  const pause = await run.untilPause()
  assert.ok(pause, 'the relay must raise a review_blocked pause for its status document to exist')
  return { relay, run, pause }
}

/**
 * Drive a real relay into one condition and return the pause it raised.
 *
 * The provocations are the ones `resolution.test.ts`'s own `provoke` already uses, deliberately:
 * the same triggers reaching the same single halt site (src/relay/relay.ts:2748), where the
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
  // Same reason, same shape: this needs a reviewer seat, which a default run cannot reach
  // in principle either (#72).
  if (reason === 'review_blocked') return provokeReviewBlocked(repo)

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
    // Same reason as `merge_blocked` above: needs a reviewer seat, provoked in its own branch.
    review_blocked: { advisor: [], impl: [] },
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
 * `set('paused', { pause })` is the same call the console makes at src/repl/session.ts:988
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
    // Passed because the console always passes one (src/repl/session.ts:809), so the status
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

  // The relay CLI passes process.cwd() as the run cwd: bin/conclave.ts:1220.
  // The relay hands that same cwd to each participant adapter: src/relay/relay.ts:1681-1687.
  // The cwd getter simply returns the option: src/relay/relay.ts:1531-1533.
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
  // The rotation replacement's cwd is now the ROTATING SEAT'S root rather than the run's, which
  // at N=1 is the same directory reached by the same expression every other read of a root uses
  // (`#rootOf`, whose no-worktree answer is `this.#opts.cwd`). Pinned at the same strength and
  // in two parts, because the claim now has two halves: the replacement is created in `root`,
  // and `root` is the seat's. See DECLARED['per-seat rotation ...'].
  assert.match(
    RELAY,
    /const ctx = \{ cwd: root, watchdogMs: this\.#opts\.turnWatchdogMs \}\s*const session = await this\.#opts\.registry\.createParticipant\(spec, ctx\)/,
    'a rotation replacement must be created in the rotating seat’s own root',
  )
  assert.match(
    RELAY,
    /const root = this\.#rootOf\(seatId\)/,
    'and that root must be the seat’s, which at N=1 is the run cwd',
  )
  assert.match(
    RELAY,
    /this\.#worktrees\?\.seats\.find\(\(s\) => s\.seatId === participantId\)\?\.worktreePath \?\?\s*this\.#opts\.cwd/,
    'a run with no seat worktrees answers the run cwd for every participant',
  )

  // A default run with no subagents must not create any git worktree. The relay only samples
  // the worktree list for its subagent-use report: src/relay/subagents.ts:68 defines
  // worktreePaths, and src/relay/relay.ts:2228, :2325 and :3837 read it.
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

  // A default invocation must be able to run with just a goal. Both front-ends now read their
  // flags with the one shared `flagReader`, and every flag read in either block goes through it,
  // so none become required. See DECLARED['one flag reader for both front-ends'].
  assertFlagHelperOptional(relay, 'relay', VALUED_FLAGS.relay)
  assertFlagHelperOptional(session, 'session', VALUED_FLAGS.session)

  // Pin the current optional flag set for each front-end. This includes both the valued flags
  // read with flag('--name') and the boolean flags checked with includes('--name').
  // Adding a flag or removing the fallback from a valued flag must be a deliberate change.
  //
  // The four ceiling flags below are a declared change to this surface, not an oversight:
  // see DECLARED['optional ceiling flags on both front-ends'] for the operator's reason.
  // `implementers` is the second such change, declared at
  // DECLARED['--implementers on both front-ends'] -- the flag that adds seats, which D1 says is
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
      'reviewer',
      'reviewer-args',
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
      'lead',
      'lead-args',
      'max-concurrent-seats',
      'max-minutes',
      'max-queue-depth',
      'max-turns',
      'operator',
      'record',
      'resume',
      'reviewer',
      'reviewer-args',
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
 *     its whole life (src/repl/session.ts:209-221), and a text-level pin cannot tell the
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
  // Needs a reviewer seat, provoked in its own branch (#72) -- same reason `merge_blocked`
  // above is not a default run either.
  review_blocked: {
    pause: 'at, atSeq, detail, evidence, options, reason, resolution',
    'pause.resolution': 'authority, reason, scope',
    'pause.resolution.scope': 'kind, participantId',
    'participants[]':
      'activity, agent, id, launch, rank, role, turns | activity, agent, id, launch, rank, role, seat, turns',
    'participants[].seat': 'dispatched, state',
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
