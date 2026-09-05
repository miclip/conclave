/**
 * Repeat-suppression for reconstructed instructions (#218).
 *
 * When a reconstructed advisor turn's narration produces an instruction that exactly
 * equals (===) the last instruction actually sent to the same seat, the instruction is
 * suppressed at dispatch time before #assign. The advisor is told its reconstructed turn
 * produced an exact repeat and was not delivered, and is asked for a new instruction.
 *
 * Reconstruction is one-shot in the double below: `reconstructNextSend` applies to exactly
 * one, named turn, so an advisor re-asked after a suppression is not itself reconstructed
 * from the same narration (that was the fault the sticky lag introduced: the re-ask was
 * wrongly re-suppressed because it re-read the same narration).
 *
 * Non-suppressed reconstructed instructions and reports carry provenance notices in the
 * actual prompt text sent to the receiving peer, and in the routing log as orchestrator
 * notes addressed to that peer.
 *
 *   node --test src/relay/repeatSuppression.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { AsyncQueue } from '../adapters/asyncQueue.ts'
import type {
  AgentEvent,
  AgentSession,
  CloseMode,
  SessionSnapshot,
  SessionState,
  TurnKey,
} from '../contract/session.ts'
import { guaranteesFor, turnKey } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { Relay } from './relay.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { tempDir } from '../testkit/tempDir.ts'

/** Records everything it was sent and replies with scripted prose. */
class FakeSession implements AgentSession {
  readonly guarantees = guaranteesFor('mediated')
  readonly received: string[] = []
  #replies: string[]
  #turns: { key: TurnKey; prose: string; args: string[] }[] = []
  #events = new AsyncQueue<AgentEvent>()
  #seq = 0
  closedAs: CloseMode | undefined
  readonly agent: string
  readonly sessionId: string
  #tools: string[]
  #toolArgsFor: (message: string) => string[]

  constructor(
    agent: string,
    sessionId: string,
    replies: string[],
    tools: string[] = [],
    toolArgsFor: (message: string) => string[] = () => [],
  ) {
    this.agent = agent
    this.sessionId = sessionId
    this.#replies = [...replies]
    this.#tools = tools
    this.#toolArgsFor = toolArgsFor
  }

  async send(message: string): Promise<TurnKey> {
    this.received.push(message)
    this.onSend?.(message)
    const key = turnKey(`${this.sessionId}-turn-${this.#turns.length}`)
    const prose = this.#replies.shift() ?? '(no further scripted reply)'
    this.#turns.push({ key, prose, args: this.#toolArgsFor(message) })
    // A previous turn's reconstruction is complete the moment a new send starts, so drop it.
    // If a NEW reconstruction was requested by `onSend` above (via `reconstructNextSend`),
    // this is the turn it applies to, and exactly this one.
    const pending = this.#pendingReconstruct
    this.#pendingReconstruct = undefined
    this.#reconstruct = pending ? { turn: key, ...pending } : undefined
    for (const tool of this.#tools) {
      this.#emit({
        type: 'tool_use',
        tool,
        input: {},
        turnKey: key,
        seq: ++this.#seq,
        at: Date.now(),
        provisional: true,
      })
    }
    for (const text of this.#reconstruct ? this.#reconstruct.narration : []) {
      this.#emit({
        type: 'message',
        role: 'assistant',
        text,
        turnKey: key,
        seq: ++this.#seq,
        at: Date.now(),
        provisional: true,
      })
    }
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

  emit(e: AgentEvent): void {
    this.#emit(e)
  }

  #emit(e: AgentEvent): void {
    this.#events.push(e)
  }

  events(): AsyncIterable<AgentEvent> {
    return this.#events
  }

  #lag: { text: string; until: number; silent: boolean } | undefined
  lagTranscript(finalText: string, afterMs: number, opts: { silent?: boolean } = {}): void {
    this.#lag = { text: finalText, until: Date.now() + afterMs, silent: opts.silent === true }
  }

  clearLag(): void {
    this.#lag = undefined
  }

  onSend: ((message: string) => void) | undefined
  // One-shot reconstruction. The NEXT `send()` this session performs streams `narration`
  // and lags its transcript; the turn after it is completely normal. Keyed by turn, so a
  // later advisor turn cannot be wrongly reconstructed from the same narration (#218).
  reconstructNextSend(narration: string[], finalText: string, lagMs: number): void {
    this.#pendingReconstruct = { narration, finalText, until: Date.now() + lagMs }
  }

  #pendingReconstruct: { narration: string[]; finalText: string; until: number } | undefined
  #reconstruct: { turn: TurnKey; narration: string[]; finalText: string; until: number } | undefined

  #split: { narration: string; report: string } | undefined
  splitProse(narration: string, report: string): void {
    this.#split = { narration, report }
  }

  async snapshot(): Promise<SessionSnapshot> {
    const lagging = this.#lag !== undefined && Date.now() < this.#lag.until
    return {
      sessionId: this.sessionId,
      agent: this.agent,
      cwd: '/tmp',
      turns: this.#turns.map((t, i) => {
        const last = i === this.#turns.length - 1
        const held = this.#lag !== undefined && last
        const rec = this.#reconstruct
        const reconstructed = last && rec !== undefined && rec.turn === t.key
        const recLagging = reconstructed && Date.now() < rec.until
        return {
          key: t.key,
          prompt: '',
          state: (reconstructed && recLagging ? 'in_progress' : held && lagging ? 'in_progress' : 'completed') as
            | 'in_progress'
            | 'completed',
          assistantText:
            reconstructed && recLagging
              ? undefined
              : reconstructed && !recLagging
                ? rec.finalText
                : held && lagging && this.#lag!.silent
                  ? undefined
                  : held && !lagging
                    ? this.#lag!.text
                    : this.#split && last
                      ? `${this.#split.narration}\n\n${this.#split.report}`
                      : t.prose,
          report: this.#split && last ? this.#split.report : undefined,
          toolCalls: t.args.map((args) => ({ tool: 'Bash', failed: false, args })),
        }
      }),
      guarantees: this.guarantees,
      compactionGeneration: 0,
      builtAt: Date.now(),
    }
  }

  state: SessionState = 'running'

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

  decided: 'allow' | 'deny' | undefined
  async decidePermission(decision: 'allow' | 'deny'): Promise<void> {
    this.decided = decision
  }

  async fork(): Promise<AgentSession> {
    throw new Error('not implemented')
  }

  async close(mode: CloseMode = 'graceful'): Promise<void> {
    this.closedAs = mode
    this.state = 'terminated'
    this.#events.close()
  }
}

function registryWith(sessions: Record<string, FakeSession>): AgentRegistry {
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
      async create() {
        return session
      },
    })
  }
  return r
}

/** Build an advisor whose NTH send (1-based) is the one reconstructed, one-shot. */
function reconstructedAdvisor(
  replies: string[],
  reconstructAtSend: number,
  narration: string[],
  finalText: string,
  lagMs: number,
): FakeSession {
  const advisor = new FakeSession('codex', 'advisor', replies)
  let sendCount = 0
  advisor.onSend = () => {
    sendCount++
    if (sendCount === reconstructAtSend) {
      advisor.reconstructNextSend(narration, finalText, lagMs)
    }
  }
  return advisor
}

function startRelay(
  registry: AgentRegistry,
  cwd: string,
  opts: { implementers?: { id: string; agent: string; role: string }[]; maxAdvisorTurns?: number } = {},
): Promise<Relay> {
  return Relay.start({
    registry,
    cwd,
    lead: { id: 'advisor', agent: 'leader', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'worker', role: 'implementer' },
    ...(opts.implementers ? { implementers: opts.implementers } : {}),
    maxAdvisorTurns: opts.maxAdvisorTurns ?? 6,
    transcriptSettleMs: 100,
    transcriptSalvageMs: 150,
  })
}

const NO_SUPPRESSION = (relay: Relay): string =>
  relay.log.map((m) => `[${m.kind}] ${m.text.slice(0, 220)}`).join('\n')

// ─── seq 7/13 reproduction ───────────────────────────────────────────────────

test('a reconstructed instruction that exactly repeats the last one to the same seat is suppressed (seq 7/13)', async () => {
  const INSTRUCTION = 'Do it.'
  // Turn 1 dispatches INSTRUCTION normally. Turn 2 is reconstructed AND streams the exact
  // same instruction through its narration, so the rebuilt instruction is a byte-for-byte
  // repeat of the last thing actually sent.
  const advisor = reconstructedAdvisor(
    [INSTRUCTION, 'never arrives', 'Do something else.', 'DONE'],
    2,
    [INSTRUCTION],
    'never arrives',
    60_000,
  )
  const impl = new FakeSession('worker', 'impl', ['ack', 'new work'])
  const relay = await startRelay(registryWith({ leader: advisor, worker: impl }), process.cwd())
  await relay.run('a goal')
  await relay.stop()

  const suppressedNote = relay.log.find(
    (m) => m.kind === 'note' && m.text.includes('suppressed instruction'),
  )
  assert.ok(suppressedNote, 'a suppression note must appear in the log')
  assert.match(suppressedNote!.text, /suppressed instruction for implementer/, 'names the seat')
  assert.match(suppressedNote!.text, /exact repeat/, 'explains why')
  assert.match(suppressedNote!.text, /already dispatched/, 'says the original was already sent')

  const implementationWhetherDelivered = impl.received.filter((m) => m.includes(INSTRUCTION))
  assert.equal(
    implementationWhetherDelivered.length,
    1,
    `the implementer must receive the repeated instruction exactly once:\n` +
      impl.received.map((m, i) => `[${i}] ${m.slice(0, 200)}`).join('\n'),
  )
})

// ─── advisor notification and re-ask ─────────────────────────────────────────

test('the advisor is told its reconstructed instruction was suppressed and is asked for a new one', async () => {
  const INSTRUCTION = 'Do it.'
  const advisor = reconstructedAdvisor(
    [INSTRUCTION, 'never arrives', 'Do something else.', 'DONE'],
    2,
    [INSTRUCTION],
    'never arrives',
    60_000,
  )
  const impl = new FakeSession('worker', 'impl', ['ack', 'new work'])
  const relay = await startRelay(registryWith({ leader: advisor, worker: impl }), process.cwd())
  await relay.run('a goal')
  await relay.stop()

  const suppressionMsg = advisor.received.find(
    (m) => m.includes('suppressed') && m.includes('new instruction'),
  )
  assert.ok(
    suppressionMsg,
    `the advisor must be told about the suppression and asked for a new instruction:\n` +
      advisor.received.map((m, i) => `[${i}] ${m.slice(0, 300)}`).join('\n'),
  )
  // A suppressed repeat costs no advisor turn beyond the notice; the new instruction follows.
  const newInstrMsg = impl.received.find((m) => m.includes('Do something else.'))
  assert.ok(newInstrMsg, 'the new instruction after the suppression must reach the implementer')
})

// ─── provenance: implementer report → advisor prompt ─────────────────────────

test('a reconstructed implementer report is identified to the advisor in the prompt text', async () => {
  const impl = new FakeSession('worker', 'impl', ['ack', 'final work'])
  let implSend = 0
  impl.onSend = () => {
    implSend++
    if (implSend === 2) impl.reconstructNextSend(['Read the file.', 'Rewrote the parser.'], 'never arrives', 60_000)
  }

  const advisor = new FakeSession('leader', 'advisor', ['Do it.', 'DONE'])
  const relay = await startRelay(
    registryWith({ leader: advisor, worker: impl }),
    process.cwd(),
    { maxAdvisorTurns: 3 },
  )
  await relay.run('a goal')
  await relay.stop()

  const provenanceMsg = advisor.received.find((m) => m.includes('reconstructed from streamed narration'))
  assert.ok(
    provenanceMsg,
    `the advisor's prompt must contain a provenance notice for the reconstructed report:\n` +
      advisor.received.map((m, i) => `[${i}] ${m.slice(0, 200)}`).join('\n'),
  )
  assert.ok(
    provenanceMsg!.includes("lost and reconstructed from streamed narration"),
    "the notice must say the report was lost and reconstructed",
  )
  assert.ok(
    provenanceMsg!.includes('without a closing statement') || provenanceMsg!.includes('not a closing statement'),
    'the notice must say the report has no closing statement',
  )

  const recorded = relay.log.find(
    (m) => m.kind === 'note' && m.text.includes('report to the advisor was lost and reconstructed'),
  )
  assert.ok(
    recorded,
    `the provenance must also be recorded in the routing log:\n` + NO_SUPPRESSION(relay),
  )
})

// ─── provenance: advisor instruction → implementer prompt (byte identity) ────

test('a reconstructed instruction one byte different from the last is not suppressed and reaches the implementer with provenance', async (t) => {
  // Byte identity, not fuzzy equality: the reconstructed instruction differs from the last
  // one sent to the SAME seat by exactly one byte, so it is not a repeat and is dispatched.
  // This is the one test that ever dispatches a reconstructed instruction without suppressing
  // it, so it is deliberately the single place that pins the strict `===` (rather than a
  // normalized compare) and the implementer-side provenance notice.
  const repo = tempRepo(t)
  const INSTRUCTION = 'Do it.'
  const DIFF = 'Do it!' // exactly one byte differs from `INSTRUCTION`.
  // Turn 1 sends INSTRUCTION to implementer. Turn 2 is reconstructed and sends the one-byte
  // different DIFF to implementer-2: not a same-seat repeat, so it must reach its seat.
  const advisor = reconstructedAdvisor(
    [`@seat implementer: ${INSTRUCTION}`, 'never arrives', 'DONE'],
    2,
    [`@seat implementer-2: ${DIFF}`],
    'never arrives',
    60_000,
  )
  const impl1 = new FakeSession('worker', 'impl1', ['ack', 'work from seat 1'])
  const impl2 = new FakeSession('worker', 'impl2', ['ack2', 'done the ! work'])

  const relay = await startRelay(
    registryWith({ leader: advisor, worker: impl1, worker2: impl2 }),
    repo,
    {
      implementers: [
        { id: 'implementer', agent: 'worker', role: 'implementer' },
        { id: 'implementer-2', agent: 'worker2', role: 'implementer' },
      ],
    },
  )
  await relay.run('a goal')
  await relay.stop()

  const suppressedNote = relay.log.find(
    (m) => m.kind === 'note' && m.text.includes('suppressed instruction'),
  )
  assert.equal(
    suppressedNote,
    undefined,
    `a one-byte-different reconstruction (and a different seat) is not a repeat and must not be suppressed:\n` +
      NO_SUPPRESSION(relay),
  )

  const provMsg = impl2.received.find((m) => m.includes('reconstructed from streamed narration'))
  assert.ok(
    provMsg,
    `seat 2 must receive the non-suppressed reconstructed instruction with provenance:\n` +
      impl2.received.map((m, i) => `[${i}] ${m.slice(0, 200)}`).join('\n'),
  )
  assert.ok(
    provMsg!.includes('produced by a turn reconstructed from streamed narration'),
    'the notice must identify the instruction as from a reconstructed turn',
  )
  assert.equal(provMsg!.includes(DIFF), true, 'the one-byte-different instruction itself is delivered')
})

// ─── deliberate non-reconstructed resend ─────────────────────────────────────

test('the same instruction after a non-reconstructed report is not suppressed', async () => {
  const INSTRUCTION = 'Do it again.'
  const impl = new FakeSession('worker', 'impl', ['ack', 'All done.', 'ack2', 'Also done.'])
  const relay = await startRelay(
    registryWith({
      leader: new FakeSession('leader', 'advisor', [INSTRUCTION, INSTRUCTION, 'DONE']),
      worker: impl,
    }),
    process.cwd(),
  )
  await relay.run('a goal')
  await relay.stop()

  const suppressedNote = relay.log.find(
    (m) => m.kind === 'note' && m.text.includes('suppressed instruction'),
  )
  assert.equal(
    suppressedNote,
    undefined,
    'same instruction after a normal (non-reconstructed) report must not be suppressed',
  )
})

// ─── clean task and seat state after suppression ─────────────────────────────

test('suppressed task is cancelled, seat is not occupied, no implementer turn is spent', async () => {
  const INSTRUCTION = 'Do it.'
  const advisor = reconstructedAdvisor(
    [INSTRUCTION, 'never arrives', 'new instruction', 'DONE'],
    2,
    [INSTRUCTION],
    'never arrives',
    60_000,
  )
  const impl = new FakeSession('worker', 'impl', ['ack', 'new work done'])
  const relay = await startRelay(registryWith({ leader: advisor, worker: impl }), process.cwd())
  const outcome = await relay.run('a goal')
  await relay.stop()

  assert.notEqual(outcome.reason, 'peer_busy', 'suppression must not introduce a peer_busy ending')

  const implReceived = impl.received
  const instructionMessages = implReceived.filter((m) => m.includes(INSTRUCTION))
  assert.equal(
    instructionMessages.length,
    1,
    `the implementer must receive the instruction exactly once (suppressed on repeat):\n` +
      implReceived.map((m, i) => `[${i}] ${m.slice(0, 200)}`).join('\n'),
  )

  const suppressedNote = relay.log.find(
    (m) => m.kind === 'note' && m.text.includes('suppressed instruction'),
  )
  assert.ok(suppressedNote, 'suppression note must be recorded')
  assert.match(suppressedNote!.text, /spending no implementer turn/, 'confirms no turn was spent')

  const match = suppressedNote!.text.match(/\((\".+\")\), which was already dispatched/)
  assert.ok(match, 'the suppression note must quote the suppressed instruction')
  const suppressedInstr = JSON.parse(match[1]!) as string
  const suppressedTasks = relay.tasks().filter(
    (t) => t.runtime.state === 'cancelled' && t.task.instruction === suppressedInstr,
  )
  assert.equal(
    suppressedTasks.length,
    1,
    `the suppressed duplicate must be cancelled in the task runtime:\n` +
      relay
        .tasks()
        .map((t) => `${t.task.id} state=${t.runtime.state} instr=${JSON.stringify(t.task.instruction)}`)
        .join('\n'),
  )
})

/** A committed scratch git repository, so worktree creation has clean HEAD state. */
function tempRepo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-repeat')
  execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'README.md'), '# hello\n')
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: dir, stdio: 'ignore' })
  return dir
}
