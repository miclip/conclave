/**
 * Relay routing and the audit trail behind restricted asides.
 *
 * Fake sessions rather than live agents: this is about who saw what, which is
 * deterministic and belongs in the offline suite. The live behaviour of the adapters is
 * covered by their own acceptance suites.
 *
 * The aside tests exercise the hazard rather than the string. Asserting that `say()`
 * appends to a log proves nothing — the point of the label is that a human reading the
 * log afterwards can tell genuine model disagreement from disagreement manufactured by
 * unequal context.
 *
 *   node --test src/relay/relay.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
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
import { outranks, type RelayMessage } from './message.ts'
import type { RelayEvent } from './observe.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'

/** Records everything it was sent and replies with scripted prose. */
class FakeSession implements AgentSession {
  readonly guarantees = guaranteesFor('mediated')
  readonly received: string[] = []
  #replies: string[]
  #turns: { key: TurnKey; prose: string; args: string[] }[] = []
  /**
   * The one delivery mechanism, shared with the adapters rather than reimplemented.
   *
   * Every double in this project used to carry its own copy of a single-consumer queue, and every
   * copy had the same hole: nothing ended the iteration, so a consumer's `for await` parked
   * forever after `close()`. `AgentSession.events()` is required to END once `close()` has
   * returned -- `Relay.stop()` waits for exactly that before it calls a turn abandoned (#143) --
   * and a double that cannot do it is a double that cannot be stopped.
   */
  #events = new AsyncQueue<AgentEvent>()
  #seq = 0
  closedAs: CloseMode | undefined
  // Declared explicitly rather than as constructor parameter properties: erasableSyntaxOnly
  // rejects those, since native type stripping cannot erase them.
  readonly agent: string
  readonly sessionId: string
  /** What a real adapter reports having done to the machine at boot; see `startupNotices`. */
  readonly startupNotices: string[] = []
  /** Emitted before each turn_end, so a turn is not a single instantaneous event. */
  #tools: string[]
  /**
   * Serialized tool inputs this session reports for a turn, chosen from what that turn was
   * asked to do. Attribution reads these and nothing else, so a fake that reports none is a
   * session that touched nothing.
   *
   * A function of the prompt rather than an array indexed by turn number, because the turn
   * numbering is not what a test means. The implementer's turn 0 is the briefing exchange,
   * so `[[], [args]]` puts the args on the briefing's successor and not, as it reads, on
   * the turn after the aside — which is how these tests first failed.
   */
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
    for (const text of this.#narration) {
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

  /** Push an event as the child would, for cases the scripted turn cannot produce. */
  emit(e: AgentEvent): void {
    this.#emit(e)
  }

  /**
   * Emit a tool call after a delay, with nothing driving it. Stands in for a child still
   * emitting while the relay tears down around it.
   */
  emitLate(tool: string, delayMs: number): void {
    setTimeout(() => {
      this.#emit({
        type: 'tool_use',
        tool,
        input: {},
        seq: ++this.#seq,
        at: Date.now(),
        provisional: true,
      })
    }, delayMs).unref()
  }

  #emit(e: AgentEvent): void {
    this.#events.push(e)
  }

  events(): AsyncIterable<AgentEvent> {
    return this.#events
  }

  /**
   * Simulate the transcript lagging the `Stop` hook: the last turn reports `in_progress`
   * carrying only its preamble until `afterMs`, then completes carrying the real report.
   */
  #lag: { text: string; until: number; silent: boolean } | undefined
  /**
   * `silent` withholds the preamble too, so the lagging turn has NO prose at all.
   *
   * That is the shape #39 was reported in: a completed turn whose transcript produced
   * nothing, not merely less. The two behave differently on purpose -- a partial report is
   * used and its shortfall noted, an empty one is worth waiting much longer for, because the
   * alternative is routing a blank or ending the run.
   */
  lagTranscript(finalText: string, afterMs: number, opts: { silent?: boolean } = {}): void {
    this.#lag = { text: finalText, until: Date.now() + afterMs, silent: opts.silent === true }
  }

  /** Called on every send, so a fake can change the working tree the way a real turn does. */
  onSend: ((message: string) => void) | undefined

  /**
   * Narration streamed during the turn, as a real adapter emits it.
   *
   * The console renders these live, which is the proof that a turn's prose exists in memory
   * even when the transcript later yields none of it -- the case this exists to exercise.
   */
  #narration: string[] = []
  streamNarration(...lines: string[]): void {
    this.#narration = lines
  }

  /** Narration and closing message as the parsers now distinguish them. */
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
        return {
          key: t.key,
          prompt: '',
          state: (held && lagging ? 'in_progress' : 'completed') as 'in_progress' | 'completed',
          assistantText:
            held && lagging && this.#lag!.silent
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
  /** What the orchestrator decided, so a test can assert it REACHED the session. */
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
    // The stream ENDS with the session, which is the half of the contract every one of these
    // doubles used to omit. See `#events`.
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
      // An in-memory double: no child process, so no clock of either kind.
      deadlines: NO_DEADLINE_CLOCKS,
      launch: { command: agent, baseArgs: [] },
      async create() {
        return session
      },
    })
  }
  return r
}

async function twoParty(
  leadReplies: string[],
  implReplies: string[],
  implTools: string[] = [],
  onLog?: (m: RelayMessage) => void,
) {
  const lead = new FakeSession('fake-lead', 'lead-1', leadReplies)
  const impl = new FakeSession('fake-impl', 'impl-1', implReplies, implTools)
  const relay = await Relay.start({
    registry: registryWith({ 'fake-lead': lead, 'fake-impl': impl }),
    cwd: '/tmp',
    lead: { id: 'advisor', agent: 'fake-lead', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'fake-impl', role: 'implementer' },
    maxAdvisorTurns: 3,
    ...(onLog ? { onLog } : {}),
  })
  return { relay, lead, impl }
}

// --- startup notices ------------------------------------------------------------------

test('what an adapter had to do to the machine to start is recorded, naming the directory', async () => {
  // Claude Code's folder-trust dialog is answered by the adapter now (#108), which is a
  // decision taken on the operator's machine while nobody is watching. The event stream is not
  // where that can be reported: boot events are drained when the relay attaches, before either
  // front-end subscribes to activity. The routing log is printed by both and kept by the run
  // record, so this is the channel the notice has to reach.
  const lead = new FakeSession('fake-lead', 'lead-1', ['DONE'])
  const impl = new FakeSession('fake-impl', 'impl-1', [])
  impl.startupNotices.push(
    "accepted claude's folder-trust dialog for /Users/x/repo — this grants folder trust only " +
      'and does not bypass tool permissions',
  )
  const relay = await Relay.start({
    registry: registryWith({ 'fake-lead': lead, 'fake-impl': impl }),
    cwd: '/tmp',
    lead: { id: 'advisor', agent: 'fake-lead', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'fake-impl', role: 'implementer' },
    maxAdvisorTurns: 3,
  })

  const notes = relay.log.filter((m) => m.kind === 'note').map((m) => m.text)
  const notice = notes.find((t) => t.includes('folder-trust'))
  assert.ok(notice, `the notice must reach the log: ${JSON.stringify(notes)}`)
  assert.match(notice, /^implementer: /, 'attributed to the seat it happened to')
  // The exact directory, because that IS the decision. A seat in an isolated worktree is
  // launched in the tree's path, not the checkout the operator started the run from, so
  // "trusted the project directory" would name the wrong one.
  assert.ok(notice.includes('/Users/x/repo'), 'the accepted directory must be named')

  // A seat with nothing to report adds nothing: the default run's log is unchanged.
  assert.deepEqual(
    notes.filter((t) => t.startsWith('advisor: ')),
    [],
  )
})

// --- briefings ----------------------------------------------------------------------

test('both participants are told about subagents, and about the worktree rule', async () => {
  // Neither CLI was told it could spawn subagents, so the only parallelism available to a
  // participant went unused. WHEN is left to the model; WHERE is not — a subagent writing
  // into the shared checkout makes `sessionLock` and the dirty-path attribution wrong,
  // silently, because its writes are indistinguishable from its parent's.
  const { relay, lead, impl } = await twoParty(['DONE'], [])
  await relay.run('a goal')

  for (const [who, session] of [['advisor', lead], ['implementer', impl]] as const) {
    const opening = session.received[0]!
    assert.match(opening, /subagents/i, `${who} should be told it has subagents`)
    assert.match(opening, /worktree/i, `${who} should be told where a writing subagent works`)
    assert.match(opening, /only read/i, `${who} should be told read-only subagents are exempt`)
  }
})

test('the goal reaches the advisor alone, and the implementer is told so', async () => {
  // A session may need the implementer not to know where the work is heading — a reviewer
  // told what verdict is wanted stops being a reviewer — and a goal delivered to both by
  // default makes that impossible to arrange afterwards. The advisor holds it and decides
  // what to pass on.
  const { relay, lead, impl } = await twoParty(['DONE'], [])
  await relay.run('ship the dark mode toggle')

  const goal = relay.log.find((m) => m.kind === 'goal')!
  assert.deepEqual(goal.to, ['advisor'], 'the goal is addressed to the advisor alone')

  assert.match(lead.received[0]!, /ship the dark mode toggle/, 'the advisor is given the goal')
  assert.ok(
    !impl.received[0]!.includes('ship the dark mode toggle'),
    'and the implementer is not, in the opening it actually receives',
  )
  // Stated, not merely absent: an implementer that noticed no goal would go looking for
  // one, or ask, and spend a turn doing it.
  assert.match(impl.received[0]!, /advisor holds this session's goal/i)
  assert.match(impl.received[0]!, /deliberate/i)
})

test('an advisor-held goal is not an audited withholding', async () => {
  // The distinction the audit depends on. `restricted` means a human chose to hide THIS
  // message from THIS participant; `audit()` and `asymmetryAt` both read it that way. The
  // goal reaching the advisor alone is how every session works now, so marking it would
  // leave the audit permanently non-empty and asymmetry permanently true — a signal
  // present in every run, which is no signal.
  const { relay } = await twoParty(['instruction', 'DONE'], ['done it'])
  await relay.run('a goal')

  const goal = relay.log.find((m) => m.kind === 'goal')!
  assert.equal(goal.visibility, 'normal')
  assert.deepEqual(goal.excluded, [])
  assert.deepEqual(relay.audit(), [], 'nothing was WITHHELD, so the audit stays empty')
  const report = relay.log.find((m) => m.kind === 'report')!
  assert.deepEqual(relay.asymmetryAt(report.seq).excluded, [], 'and no asymmetry is manufactured')
})

test('the advisor is told to investigate itself rather than delegate everything', async () => {
  // Observed live: asked to research free data sources, the advisor turned the request
  // into an instruction and handed it to an implementer already mid-build. That is the
  // only behaviour its briefing described — "give it one concrete instruction at a time".
  const { relay, lead } = await twoParty(['DONE'], [])
  await relay.run('a goal')

  const opening = lead.received[0]!
  assert.match(opening, /YOURSELF/, 'the advisor must be told to do investigative work itself')
  assert.match(opening, /CHANGING the repository/, 'and what the implementer’s turn is for')
  // Holding the goal is a responsibility, not just a privilege: it has to know it decides
  // what to pass on, that withholding is not licence to mislead, and that it can ask.
  assert.match(opening, /YOU HOLD THE GOAL/)
  assert.match(opening, /never state something false/i)
  assert.match(opening, /ESCALATE: followed by your question/)
  // Findings must survive the turn: the advisor's only channel onward is its next
  // instruction, so research it does not report is research nobody sees.
  assert.match(opening, /what you FOUND/)
})

test('the implementer is told the difference between UNANSWERED and FLAG', async () => {
  // The two markers are only useful if the implementer knows which one to use. The distinction
  // is load-bearing: UNANSWERED: pauses the run for a build-changing scope question, while
  // FLAG: qualifies the result and the run continues. The briefing must say both what the
  // failure mode is and what the implementer should still decide itself.
  const { relay, impl } = await twoParty(['DONE'], [])
  await relay.run('a goal')

  const opening = impl.received[0]!
  assert.match(opening, /UNANSWERED:/, 'the implementer must be told about the UNANSWERED: marker')
  assert.match(opening, /had to choose a build-changing scope direction without an answer/, 'UNANSWERED: is for a build-changing scope choice made without an answer')
  assert.match(opening, /Include what you did\s+meanwhile in the same reply/, 'UNANSWERED: must carry what was done meanwhile')
  assert.match(opening, /PAUSES the run/, 'an UNANSWERED: line pauses the run')
  assert.match(opening, /FLAG:/, 'the implementer must be told about the FLAG: marker')
  assert.match(opening, /does NOT stop the run/, 'a FLAG: does not stop the run')
  assert.match(opening, /Choices about\s+how to build remain yours/, 'how-to-build choices remain the implementer')
  assert.match(opening, /use FLAG: for every concern that only qualifies the result[\s\S]*?than invalidating it/, 'FLAG: is for concerns that only qualify the result')
})

// --- asking a participant outside a run ----------------------------------------------

test('a participant can be asked directly once the run has ended', async () => {
  // A run ending does not end the sessions — only `stop()` does that, when the console
  // closes. The loose ends are the reason to stay: start the server so I can try what you
  // built, explain that change. `say` cannot serve them, because it QUEUES and the queue
  // is drained by a run loop that is no longer running.
  // 'ack' is consumed by the briefing exchange; the second reply answers the question.
  const { relay, lead, impl } = await twoParty(['DONE'], ['ack', 'NONE', 'server is up on :3000'])
  await relay.run('a goal')

  const answer = await relay.ask('implementer', 'start the server so I can test it')

  assert.equal(answer, 'server is up on :3000', 'a turn, not a queue: the answer comes back')
  assert.ok(impl.received.some((m) => m.includes('start the server so I can test it')))
  assert.ok(
    !lead.received.some((m) => m.includes('start the server')),
    'the other participant sees neither the question nor the answer',
  )

  // Both halves are recorded, so `/log` and `/audit` see this as they see anything else
  // said to one participant and not the other.
  const question = relay.log.find((m) => m.text.includes('start the server so I can test it'))!
  assert.deepEqual(question.to, ['implementer'])
  assert.equal(question.visibility, 'restricted', 'the advisor was not told, and that is auditable')
  const reply = relay.log.at(-1)!
  assert.equal(reply.from, 'implementer')
  assert.deepEqual(reply.to, [], 'addressed to the human, who is not a routed participant')
})

test('asking is refused while a run is in flight, rather than racing its turns', async () => {
  // Two things sending turns to one session would interleave with the loop's own, and the
  // transcript would be neither's. During a run the run handle is the way in.
  const { relay } = await twoParty(['instruction', 'DONE'], ['done it'])
  const running = relay.run('a goal')
  await assert.rejects(() => relay.ask('implementer', 'sneak this in'), /run is in flight/)
  await running

  // And it works again the moment the loop lets go.
  await relay.ask('implementer', 'now that it is over')
})

test('a direct question says where the answer goes, so it is not read as an instruction', async () => {
  // Observed live. Asked "get the implementer to fix those" out of run, the advisor
  // announced it was "handing the accessibility fix to an implementer agent" and spawned a
  // subagent. Every reply it makes DURING a run is routed onward as an instruction, and
  // nothing in a direct question said this one would not be — so it reached for the only
  // other way it had to make work happen.
  const { relay, lead } = await twoParty(['DONE', 'here is what I found'], ['ack'])
  await relay.run('a goal')
  await relay.ask('advisor', 'get the implementer to fix those')

  // Whitespace collapsed: the notice is wrapped prose, and an assertion that broke when
  // someone rewrapped a line would be testing the line breaks rather than the meaning.
  const asked = lead.received.at(-1)!.replace(/\s+/g, ' ')
  assert.match(asked, /get the implementer to fix those/, 'the question itself is sent')
  assert.match(asked, /No run is in flight/)
  assert.match(asked, /nothing you say here is routed to the other participant/)
  assert.match(asked, /do not spawn a subagent to stand in for the other participant/)

  // The LOG keeps what the human said. Recording the framing too would bury the question
  // under orchestrator boilerplate every time anyone read the transcript.
  const recorded = relay.log.find((m) => m.text.includes('get the implementer to fix those'))!
  assert.equal(recorded.text, 'get the implementer to fix those')
})

test('subagents are distinguished from the other participant', async () => {
  // The collision this session created: we told both participants they could spawn
  // subagents, in a vocabulary where "the implementer" already names a peer. Nothing said
  // those were different kinds of thing.
  const { relay, lead, impl } = await twoParty(['DONE'], [])
  await relay.run('a goal')
  for (const session of [lead, impl]) {
    const opening = session.received[0]!
    assert.match(opening, /A subagent is YOURS/)
    assert.match(opening, /you cannot spawn one/, 'a peer is not something you can create')
    assert.match(opening, /do not hand the job to a subagent and call it delegation/)
  }
})

test('two participants can be asked at once; the same one, not twice', async () => {
  // The sessions are independent. Asking the implementer to start a server has no bearing
  // on asking the advisor to look at something while it does — and a guard that serialised
  // across everyone turned two unrelated questions into a queue, which is what the operator
  // saw as "still waiting on implementer; one at a time".
  // 'DONE' ends the run at the advisor's first turn, so the second reply of each is left
  // for the questions rather than being eaten by the loop.
  const { relay, lead, impl } = await twoParty(['DONE', 'looked at it'], ['ack', 'NONE', 'server is up'])
  await relay.run('a goal')

  const both = await Promise.all([
    relay.ask('implementer', 'start the web server'),
    relay.ask('advisor', 'meanwhile, look at the routes'),
  ])
  assert.deepEqual(both, ['server is up', 'looked at it'], 'both were asked, neither waited')
  assert.ok(impl.received.some((m) => m.includes('start the web server')))
  assert.ok(lead.received.some((m) => m.includes('look at the routes')))

  // The same participant twice IS serialised: a session runs one turn at a time, so the
  // second would interleave with the first.
  const first = relay.ask('implementer', 'and now this')
  await assert.rejects(() => relay.ask('implementer', 'and this too'), /still answering/)
  await first
})

test('asking an unknown participant names the ones that exist', async () => {
  const { relay } = await twoParty(['DONE'], [])
  await relay.run('a goal')
  await assert.rejects(() => relay.ask('archivist', 'hello'), /unknown participant 'archivist'/)
  await assert.rejects(() => relay.ask('archivist', 'hello'), /advisor, implementer/)
})

/** Let the relay's event pump drain what was just emitted. */
const settle = () => new Promise((r) => setTimeout(r, 10))

// --- permission decisions -------------------------------------------------------------

test('a permission request can be answered, and reaches the session', async () => {
  // Both adapters implement `decidePermission` down to the keystroke, and nothing above
  // them ever called it. The console rendered `awaiting a permission decision` and offered
  // no way to answer, so the turn sat at the prompt until a watchdog gave up waiting on it and
  // emitted a verdict -- which released the run and left the child standing at the same prompt.
  const { relay, impl } = await twoParty(['DONE'], ['ack'])
  await relay.run('a goal')

  impl.emit({ type: 'permission_requested', tool: 'exec', input: {}, seq: 900, at: Date.now(), provisional: true })
  await settle()

  assert.deepEqual(relay.permissionsPending(), [{ id: 'implementer', tool: 'exec' }])
  await relay.decidePermission('implementer', 'allow')

  assert.equal(impl.decided, 'allow', 'the decision reaches the session, not just the log')
  assert.deepEqual(relay.permissionsPending(), [], 'and the request is no longer outstanding')
  // Recorded: a human decision about what a participant may do is exactly what someone
  // reading the log later needs in order to explain why a tool call did or did not happen.
  assert.match(relay.log.at(-1)!.text, /you allowed implementer: exec/)
})

test('a request survives the activity that a waiting session keeps emitting', async () => {
  // The regression that made the feature useless in practice. A session stopped at a
  // permission dialog is not silent: the transcript poller reports the very tool call
  // being waited on, so `tool_use` lands immediately after `permission_requested`. Clearing
  // on any later event cancelled the request microseconds after it appeared — the console
  // printed "needs a permission decision" and `/allow` answered "nobody is waiting".
  const { relay, impl } = await twoParty(['DONE'], ['ack'])
  await relay.run('a goal')

  impl.emit({ type: 'permission_requested', tool: 'Bash', input: {}, seq: 901, at: Date.now(), provisional: false })
  impl.emit({ type: 'tool_use', tool: 'Bash', input: {}, seq: 902, at: Date.now(), provisional: true })
  await settle()

  assert.deepEqual(
    relay.permissionsPending(),
    [{ id: 'implementer', tool: 'Bash' }],
    'the session is still at the dialog; its own reporting must not dismiss it',
  )
  await relay.decidePermission('implementer', 'allow')
  assert.equal(impl.decided, 'allow')
})

test('a request does not outlive the turn that raised it', async () => {
  // `turn_end` is the honest boundary: a turn that ended is not sitting at a prompt, so
  // offering to decide would send a keystroke nothing consumes.
  const { relay, impl } = await twoParty(['DONE'], ['ack'])
  await relay.run('a goal')

  impl.emit({ type: 'permission_requested', tool: 'exec', input: {}, seq: 903, at: Date.now(), provisional: false })
  await settle()
  assert.equal(relay.permissionsPending().length, 1)

  impl.emit({
    type: 'turn_end',
    verdict: { outcome: 'completed', confidence: 'proven', provenance: [{ source: 'hook', detail: 'Stop' }] },
    synthesized: false,
    seq: 904,
    at: Date.now(),
    provisional: false,
  })
  await settle()

  assert.deepEqual(relay.permissionsPending(), [], 'the turn is over, so there is nothing to decide')
  await assert.rejects(
    () => relay.decidePermission('implementer', 'allow'),
    /not waiting on a permission decision/,
  )
})

// --- visibility ---------------------------------------------------------------------

test('ordinary point-to-point relay traffic is NOT restricted', async () => {
  // The bug the first live run exposed: visibility derived from recipient count marked
  // every advisor instruction as hidden influence, which makes the label worthless.
  const { relay } = await twoParty(['do the thing', 'DONE'], ['done it'])
  await relay.run('a goal')

  const instruction = relay.log.find((m) => m.kind === 'instruction')!
  assert.equal(instruction.to.length, 1, 'an instruction reaches exactly one participant')
  assert.equal(instruction.visibility, 'normal', 'and that is entirely ordinary')
  assert.deepEqual(instruction.excluded, [])

  const report = relay.log.find((m) => m.kind === 'report')!
  assert.equal(report.visibility, 'normal')

  assert.deepEqual(relay.audit(), [], 'nothing was withheld, so the audit is empty')
})

test('orchestrator notes are internal, never participant speech', async () => {
  const { relay } = await twoParty(['DONE'], [])
  await relay.run('a goal')
  const notes = relay.log.filter((m) => m.kind === 'note')
  assert.ok(notes.length > 0)
  for (const n of notes) {
    assert.equal(n.visibility, 'internal')
    assert.deepEqual(n.to, [], 'internal state is delivered to nobody')
  }
})

test('a human message to everyone is normal, not restricted', async () => {
  const { relay } = await twoParty(['DONE'], [])
  const m = relay.say('applies to both of you', 'all')
  assert.equal(m.visibility, 'normal')
  assert.deepEqual(m.excluded, [])
})

// --- the restricted aside, end to end ------------------------------------------------

test('a restricted aside reaches only its recipient, once, and is auditable', async () => {
  const { relay, lead, impl } = await twoParty(
    ['first instruction', 'second instruction', 'DONE'],
    ['first report', 'second report', 'third report'],
  )

  // 1. a normal exchange is under way
  const aside = relay.say('we have already ruled out Postgres', { only: 'implementer' }, 'aside')

  // 5. the log marks it restricted and names who was excluded
  assert.equal(aside.visibility, 'restricted')
  assert.deepEqual(aside.to, ['implementer'])
  assert.deepEqual(aside.excluded, ['advisor'])

  await relay.run('a goal')

  // 3. drained exactly once into the next implementer turn
  const carrying = impl.received.filter((r) => r.includes('ruled out Postgres'))
  assert.equal(carrying.length, 1, 'delivered exactly once')
  assert.ok(
    carrying[0]!.includes('FROM THE HUMAN'),
    'and at human privilege, not as advisor prose',
  )

  // 4. the advisor never receives it, directly or by relay
  assert.equal(
    lead.received.filter((r) => r.includes('ruled out Postgres')).length,
    0,
    'the excluded participant must never see it through any path',
  )

  // 6. later exchanges do not replay it
  assert.ok(impl.received.length > 1, 'there were later turns to replay into')
  for (const later of impl.received.slice(carrying.length + 1)) {
    assert.ok(!later.includes('ruled out Postgres'), 'an aside is not re-sent every turn')
  }

  // 7. a subsequent disagreement is attributable to asymmetric information
  const report = relay.log.find((m) => m.kind === 'report')!
  const asym = relay.asymmetryAt(report.seq)
  assert.deepEqual(asym.informed, ['implementer'])
  assert.deepEqual(asym.excluded, ['advisor'])

  const entry = relay.audit()[0]!
  assert.equal(entry.seq, aside.seq)
  assert.deepEqual(entry.excluded, ['advisor'])
  assert.ok(entry.text.includes('Postgres'), 'the audit records what was withheld, not just that something was')
})

test('broadcasting an aside in full reconciles its origin record, and says so (#171)', async () => {
  // The wiring, not the rule -- `authorityReconciliation.test.ts` is where the containment
  // and detection rules are pinned. What this proves is that the operator's actual route,
  // typing at a pause, reaches the record: `handle.constrain` is `say`, `say` records, and
  // `#record` is where a human message is checked against the origins already standing.
  const { relay } = await twoParty(['DONE'], [])
  const withheld = 'Keep `src/legacy/shim.ts` exactly as it is — I put that back on purpose.'
  const origin = relay.say(withheld, { only: 'implementer' }, 'aside')
  assert.equal(origin.visibility, 'restricted')
  assert.deepEqual(relay.restrictedOrigins[0]!.excluded, ['advisor'])

  // The operator repairs the asymmetry the way #171 describes: the whole message, to both.
  const delivery = relay.say(`For the record, both of you: ${withheld} That is all of it.`, 'all')

  const record = relay.restrictedOrigins[0]!
  assert.deepEqual(record.excluded, [], 'the advisor is no longer in the dark')
  assert.deepEqual(record.informed, ['implementer', 'advisor'])
  assert.deepEqual(record.reconciled, [{ participant: 'advisor', seq: delivery.seq }])

  // And the run says it happened. A pause that silently stops firing is indistinguishable
  // from a detector that broke, which is the reading this note exists to prevent.
  const note = relay.log.find((m) => m.kind === 'note' && m.text.includes(`#${origin.seq}`))
  assert.ok(note, 'the reconciliation is recorded')
  assert.equal(note.visibility, 'internal')
  assert.ok(note.text.includes('advisor'), 'and names the seat that was given it')

  // The LOG is untouched: what happened at that seq is that it was withheld, and no later
  // message changes that. `audit()` and `asymmetryAt()` still answer the historical question.
  assert.deepEqual(relay.audit()[0]!.excluded, ['advisor'])
  assert.deepEqual(relay.asymmetryAt(delivery.seq).excluded, ['advisor'])
  await relay.stop()
})

test('a partial re-quote leaves the origin record exactly as it was (#171)', async () => {
  const { relay } = await twoParty(['DONE'], [])
  relay.say('Keep `src/legacy/shim.ts` exactly as it is — I put that back on purpose.', { only: 'implementer' }, 'aside')
  relay.say('Both of you: I did say something about `src/legacy/shim.ts` earlier.', 'all')

  const record = relay.restrictedOrigins[0]!
  assert.deepEqual(record.excluded, ['advisor'], 'a mention is not a delivery')
  assert.deepEqual(record.reconciled, [])
  assert.equal(
    relay.log.filter((m) => m.kind === 'note' && m.text.includes('reproduced restricted message')).length,
    0,
    'and nothing was announced',
  )
  await relay.stop()
})

test('with nothing withheld, a disagreement cannot be blamed on us', async () => {
  // The other half of the same property: the audit must not manufacture an explanation
  // for a disagreement that was genuinely about the work.
  const { relay } = await twoParty(['instruction', 'DONE'], ['I disagree, and here is why'])
  await relay.run('a goal')
  const report = relay.log.find((m) => m.kind === 'report')!
  const asym = relay.asymmetryAt(report.seq)
  assert.deepEqual(asym.informed, [])
  assert.deepEqual(asym.excluded, [])
})

// --- rank and routing ----------------------------------------------------------------

test('rank is legible in what a participant actually receives', async () => {
  const { relay, impl } = await twoParty(['do the thing', 'DONE'], ['done it'])
  await relay.run('a goal')
  const instruction = impl.received.find((r) => r.includes('do the thing'))!
  assert.ok(instruction.includes('FROM THE ADVISOR'), 'the source must be named')
  assert.ok(
    instruction.includes('peer AI model, not your user'),
    "an unattributed instruction would carry the human's authority and stop pushback",
  )
  assert.ok(instruction.includes('You may disagree'))
})

test('rank ordering is human > advisor > implementer', () => {
  assert.ok(outranks('human', 'advisor'))
  assert.ok(outranks('advisor', 'implementer'))
  assert.ok(outranks('human', 'implementer'))
  assert.ok(!outranks('implementer', 'advisor'))
})

test('DONE and ESCALATE hand back to the human rather than being acted on', async () => {
  const done = await twoParty(['DONE'], [])
  assert.equal((await done.relay.run('goal')).reason, 'done')

  const esc = await twoParty(['ESCALATE: the tests contradict the goal'], [])
  const outcome = await esc.relay.run('goal')
  assert.equal(outcome.reason, 'escalated')
  assert.ok(outcome.detail?.includes('contradict'))
})

test('the advisor-turn budget stops an unbounded loop', async () => {
  const { relay } = await twoParty(
    ['a', 'b', 'c', 'd', 'e', 'f'],
    ['1', '2', '3', '4', '5', '6'],
  )
  assert.equal((await relay.run('goal')).reason, 'budget')
})

test('an unknown recipient is rejected rather than silently dropped', async () => {
  const { relay } = await twoParty(['DONE'], [])
  assert.throws(() => relay.say('hello', { only: 'nobody' }), /unknown participant/)
})

test('stopping closes every session gracefully', async () => {
  const { relay, lead, impl } = await twoParty(['DONE'], [])
  await relay.stop()
  assert.equal(lead.closedAs, 'graceful')
  assert.equal(impl.closedAs, 'graceful')
})

// --- observing a run in progress ------------------------------------------------------

function messagesIn(events: RelayEvent[]): RelayMessage[] {
  return events.flatMap((e) => (e.type === 'message' ? [e.message] : []))
}

/** Reads a subscription to completion. Hangs if the stream never terminates, on purpose. */
async function drain(stream: AsyncIterable<RelayEvent>): Promise<RelayEvent[]> {
  const out: RelayEvent[] = []
  for await (const e of stream) out.push(e)
  return out
}

test('an observer sees the routing log in order, and the turn happening between entries', async () => {
  // The tools are the point. A stream carrying only log entries goes silent from the
  // instruction until the report -- which is the entire duration of the work, and exactly
  // the interval a live view exists to show.
  const { relay } = await twoParty(['do the thing', 'DONE'], ['done it'], ['Read', 'Edit'])
  const collected = drain(relay.observe())
  await relay.run('a goal')
  const events = await collected

  assert.deepEqual(
    messagesIn(events).map((m) => m.seq),
    relay.log.map((m) => m.seq),
    'every log entry reaches the observer, in log order',
  )

  const at = (kind: string) => events.findIndex((e) => e.type === 'message' && e.message.kind === kind)
  const instruction = at('instruction')
  const report = at('report')
  assert.ok(instruction >= 0 && report > instruction, 'an instruction, then the report answering it')
  const during = events
    .slice(instruction, report)
    .filter((e) => e.type === 'activity' && e.event.type === 'tool_use')
  assert.ok(during.length > 0, 'the wait for a turn is not silent')

  const end = events.at(-1)!
  assert.equal(end.type, 'run_end', 'terminal, and the iteration completed rather than hanging')
  if (end.type === 'run_end') assert.equal(end.reason, 'done')
})

test('a subscriber attaching mid-run replays what it missed, then follows live', async () => {
  const { relay } = await twoParty(['do the thing', 'DONE'], ['done it'], ['Read'])
  const running = relay.run('a goal')
  while (!relay.log.some((m) => m.kind === 'instruction')) {
    await new Promise((r) => setTimeout(r, 5))
  }

  const late = drain(relay.observe())
  await running
  const events = await late

  // Including the goal and both briefings, which were routed before it attached. A gap
  // here would be invisible to the subscriber, which is what makes it worth closing.
  assert.deepEqual(
    messagesIn(events).map((m) => m.seq),
    relay.log.map((m) => m.seq),
    'replay covers everything before the attach',
  )
  assert.equal(events.at(-1)?.type, 'run_end')

  const nothing = await drain(relay.observe({ replay: false }))
  assert.deepEqual(nothing, [], 'opting out of replay after the run yields nothing at all')
})

test('two subscribers each receive the whole stream', async () => {
  const { relay } = await twoParty(['do the thing', 'DONE'], ['done it'], ['Read'])
  const a = drain(relay.observe())
  const b = drain(relay.observe())
  await relay.run('a goal')
  const [ea, eb] = await Promise.all([a, b])

  assert.ok(ea.length > 0)
  assert.deepEqual(
    ea.map((e) => e.seq),
    eb.map((e) => e.seq),
    'one shared queue would have them stealing events from each other',
  )
})

test('breaking out of one subscription detaches it and leaves the others intact', async () => {
  const { relay } = await twoParty(['do the thing', 'DONE'], ['done it'], ['Read'])
  const survivor = drain(relay.observe())

  const quitter: RelayEvent[] = []
  for await (const e of relay.observe()) {
    quitter.push(e)
    break
  }

  await relay.run('a goal')
  const events = await survivor

  assert.equal(quitter.length, 1, 'it stopped where it broke rather than draining the run')
  assert.ok(events.length > 1)
  assert.equal(events.at(-1)?.type, 'run_end', 'and the subscriber that stayed ran to completion')
})

test('run_end is terminal for a late subscriber too, not just a live one', async () => {
  // A child does not stop emitting because the relay decided the run was over. If those
  // events reached the history, a subscriber attaching afterwards would replay tool calls
  // sitting AFTER the run they belong to -- a live subscriber and a replayed one would
  // disagree about where the session ended.
  const { relay, impl } = await twoParty(['do the thing', 'DONE'], ['done it'], ['Read'])
  const live = drain(relay.observe())
  await relay.run('a goal')
  const liveEvents = await live

  impl.emitLate('LateWrite', 5)
  impl.emitLate('LaterWrite', 20)
  await new Promise((r) => setTimeout(r, 120))

  assert.equal(liveEvents.at(-1)?.type, 'run_end', 'the subscriber that watched it happen')

  const replayed = await drain(relay.observe())
  assert.equal(replayed.at(-1)?.type, 'run_end', 'and one attaching after the fact')
  assert.deepEqual(
    replayed.map((e) => e.seq),
    liveEvents.map((e) => e.seq),
    'both see exactly the same stream',
  )
  assert.equal(
    replayed.findIndex((e) => e.type === 'activity' && e.event.type === 'tool_use' && /Late/.test(e.event.tool)),
    -1,
    'nothing from after the run appears anywhere in it',
  )

  assert.equal(relay.droppedAfterEnd, 2, 'the refused events are counted, not silently eaten')
  assert.ok(
    relay.participants
      .find((p) => p.id === 'implementer')!
      .events.some((e) => e.type === 'tool_use' && e.tool === 'LateWrite'),
    'and the participant still holds them -- the stream declined them, nothing was destroyed',
  )
})

test('observing changes neither the routing log numbering nor onLog', async () => {
  // audit() and asymmetryAt() are defined over RelayMessage.seq. Interleaving activity
  // into that numbering would silently change what a recorded asymmetry refers to.
  const pushed: RelayMessage[] = []
  const { relay } = await twoParty(['instruction', 'DONE'], ['a report'], ['Read', 'Edit'], (m) =>
    pushed.push(m),
  )
  const aside = relay.say('withheld from the advisor', { only: 'implementer' }, 'aside')
  const collected = drain(relay.observe())
  await relay.run('a goal')
  const events = await collected

  assert.deepEqual(
    relay.log.map((m) => m.seq),
    relay.log.map((_, i) => i + 1),
    'message numbering stays contiguous',
  )
  assert.deepEqual(pushed.map((m) => m.seq), relay.log.map((m) => m.seq), 'onLog still receives every entry')
  assert.equal(relay.audit()[0]!.seq, aside.seq)
  assert.deepEqual(relay.asymmetryAt(relay.log.at(-1)!.seq).excluded, ['advisor'])

  const lastMessageEvent = events.filter((e) => e.type === 'message').at(-1)!
  assert.ok(
    lastMessageEvent.seq > lastMessageEvent.message.seq,
    'the stream counts its own events; activity does not consume message numbers',
  )
})

// --- artifact attribution -----------------------------------------------------------
//
// The evidence question, not the matching question. `authority.test.ts` covers what
// `attributable` decides given evidence; these cover whether the relay hands it the right
// evidence, against a real `git status` in a real repository.

/** A throwaway git repo, so `dirtyPaths` has something true to report. */
function scratchRepo(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-attribution-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  writeFileSync(join(dir, 'seed.txt'), 'seed\n')
  git('add', '-A')
  git('commit', '-qm', 'seed')
  return dir
}

/**
 * Run a two-party relay in `cwd`, sending an aside and dirtying the tree mid-run.
 *
 * `dirty` fires from `onLog` when the first report is recorded — after `say()` has
 * snapshotted the tree and before the turn that triggers attribution — which is the window
 * a real participant writes in.
 *
 * `implToolArgs` is given the prompt of each implementer turn. `ASIDE` appears verbatim in
 * the prompt of the turn that received it, so a test says "the turn that was told the
 * aside" instead of guessing a turn index.
 */
const ASIDE = 'quietly, please'

async function attributionRun(
  cwd: string,
  implToolArgs: (message: string) => string[],
  dirty: () => void,
) {
  // Three advisor replies, so the implementer gets a turn AFTER the aside. With two, the
  // advisor says DONE off the back of the first report and the run ends before the turn
  // that attribution is meant to read.
  const lead = new FakeSession('fake-lead', 'lead-1', ['first instruction', 'second instruction', 'DONE'])
  const impl = new FakeSession('fake-impl', 'impl-1', ['first report', 'second report'], [], implToolArgs)
  let relay: Relay
  let armed = false
  relay = await Relay.start({
    registry: registryWith({ 'fake-lead': lead, 'fake-impl': impl }),
    cwd,
    lead: { id: 'advisor', agent: 'fake-lead', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'fake-impl', role: 'implementer' },
    maxAdvisorTurns: 3,
    onLog: (m) => {
      if (m.kind !== 'report' || armed) return
      armed = true
      relay.say(ASIDE, { only: 'implementer' }, 'aside')
      dirty()
    },
  })
  await relay.run('a goal')
  return relay.restrictedOrigins.at(-1)!
}

/** A heredoc, not a `Write`. Most file work in this repository looks like this, and a
 *  structured `file_path` rule would see nothing in it. */
const HEREDOC = `python3 - <<'PY'\nopen('asked-for.txt','w').write('x')\nPY`

test('a path the implementer names in a tool call is attributed to the aside', async (t) => {
  const dir = scratchRepo(t)
  const origin = await attributionRun(
    dir,
    (msg) => (msg.includes(ASIDE) ? [HEREDOC] : []),
    () => writeFileSync(join(dir, 'asked-for.txt'), 'x\n'),
  )
  assert.deepEqual(origin.artifacts, ['asked-for.txt'])
})

test('a path another editor dirtied is NOT attributed to the aside', async (t) => {
  // The whole reason this changed. `git status` reports this file exactly as it reports the
  // implementer's; only the absence of participant evidence separates them.
  const dir = scratchRepo(t)
  const origin = await attributionRun(
    dir,
    (msg) => (msg.includes(ASIDE) ? [HEREDOC] : []),
    () => {
      writeFileSync(join(dir, 'asked-for.txt'), 'x\n')
      writeFileSync(join(dir, 'colleague-was-here.txt'), 'not ours\n')
    },
  )
  assert.deepEqual(origin.artifacts, ['asked-for.txt'])
  assert.ok(
    !origin.artifacts.includes('colleague-was-here.txt'),
    'a concurrent editor must not have their work attributed to a message they never saw',
  )
})

test('with no tool evidence at all, nothing is attributed rather than everything', async (t) => {
  // The direction of failure, asserted explicitly. A participant whose transcript yields no
  // tool inputs — an adapter that cannot supply them — attributes nothing. That is
  // under-detection, and it is chosen over reinstating the whole working tree.
  const dir = scratchRepo(t)
  const origin = await attributionRun(dir, () => [], () => {
    writeFileSync(join(dir, 'appeared.txt'), 'x\n')
  })
  assert.deepEqual(origin.artifacts, [])
})

test('tool calls made BEFORE the aside are not evidence for it', async (t) => {
  // Work already done cannot have been caused by a message that had not been sent, so
  // naming the path on an earlier turn must not attribute it.
  const dir = scratchRepo(t)
  const origin = await attributionRun(
    dir,
    (msg) => (msg.includes(ASIDE) ? [] : ['cat asked-for.txt']),
    () => writeFileSync(join(dir, 'asked-for.txt'), 'x\n'),
  )
  assert.deepEqual(origin.artifacts, [])
})

test('a report is not read until the transcript has caught up with the turn', async () => {
  // The failure this prevents: `Stop` fires when a turn ends, but the final assistant
  // message may not be flushed yet, so reading immediately returns only the interstitial
  // narration. Observed live -- an advisor asked for the same trace three times because
  // every report it received was a preamble.
  const lagging = new FakeSession('claude', 'impl', ['ack', 'PREAMBLE'])
  // The transcript reports the turn still in progress, then completes it with the real
  // report a moment later. Reading eagerly gets the preamble; settling gets the report.
  lagging.lagTranscript('PREAMBLE — the full findings follow.', 400)

  const relay = await Relay.start({
    registry: registryWith({ codex: new FakeSession('codex', 'advisor', ['Do it.', 'DONE']), claude: lagging }),
    cwd: process.cwd(),
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 2,
  })
  await relay.run('Keep the work moving.')
  await relay.stop()

  const report = relay.log.filter((m) => m.kind === 'report').at(-1)
  assert.ok(report)
  assert.match(report.text, /the full findings follow/, 'the settled report, not the preamble')
  assert.ok(
    !relay.log.some((m) => m.text.includes('may be incomplete')),
    'and it settled within the window, so no shortfall was recorded',
  )
})

test('a transcript that never settles is used anyway, and the shortfall is recorded', async () => {
  // Silence is the failure mode being avoided. A truncated report the log explains can be
  // recovered from; one it does not cannot.
  // 'NONE' answers the closing question the relay asks when the advisor says DONE.
  const stuck = new FakeSession('claude', 'impl', ['ack', 'PREAMBLE', 'NONE'])
  stuck.lagTranscript('never arrives', 60_000)

  const relay = await Relay.start({
    registry: registryWith({ codex: new FakeSession('codex', 'advisor', ['Do it.', 'DONE']), claude: stuck }),
    cwd: process.cwd(),
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 2,
    transcriptSettleMs: 300,
  })
  await relay.run('Keep the work moving.')
  await relay.stop()

  assert.ok(relay.log.some((m) => m.text.includes('may be incomplete')))
  assert.match(relay.log.filter((m) => m.kind === 'report').at(-1)!.text, /PREAMBLE/)
})

test('the other participant receives the report, not the narration', async () => {
  // An advisor that reads "I'll start by finding the relevant code" answers the stated
  // intention rather than the result, and then re-asks for work already done. The human
  // sees narration live instead; see repl/session.ts.
  const impl = new FakeSession('claude', 'impl', ['ack', 'IGNORED'])
  impl.splitProse("I'll start by finding the relevant code.", 'Done. guard --json is in.')

  const relay = await Relay.start({
    registry: registryWith({ codex: new FakeSession('codex', 'advisor', ['Do it.', 'DONE']), claude: impl }),
    cwd: process.cwd(),
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 2,
  })
  await relay.run('Keep the work moving.')
  await relay.stop()

  const report = relay.log.filter((m) => m.kind === 'report').at(-1)!
  assert.equal(report.text, 'Done. guard --json is in.')
  assert.ok(!report.text.includes("I'll start by"), 'the narration must not be routed')
})

/**
 * A completed turn whose transcript produced nothing at all (#39).
 *
 * Reported live: an implementer completed a turn, grew a record file from 517 to 724 lines,
 * and the relay read an empty report, escalated, and ended the run. The work survived; the
 * run's knowledge of it did not, so the next `--resume` starts from a log whose last
 * implementer turn says nothing — which is exactly the re-derivation `--resume` exists to
 * prevent.
 *
 * Distinct from the lag test above, where the transcript held a preamble. Nothing versus
 * less is the whole distinction: a partial report is routed with its shortfall noted, and an
 * empty one is worth waiting far longer for.
 */
test('an empty report from a completed turn is waited for, not discarded', async () => {
  const impl = new FakeSession('claude', 'impl', ['ack', 'PREAMBLE', 'NONE'])
  // Nothing in the transcript for 700ms, then the real report. The settle window expires
  // first; the salvage window is what recovers it.
  impl.lagTranscript('Rewrote the record: seven new sections.', 700, { silent: true })

  const relay = await Relay.start({
    registry: registryWith({ codex: new FakeSession('codex', 'advisor', ['Do it.', 'DONE']), claude: impl }),
    cwd: process.cwd(),
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 2,
    transcriptSettleMs: 150,
    transcriptSalvageMs: 5_000,
  })
  const outcome = await relay.run('Keep the work moving.')
  await relay.stop()

  assert.notEqual(outcome.reason, 'escalated', 'the run must not end over a transcript that was merely slow')
  const report = relay.log.filter((m) => m.kind === 'report').at(-1)
  assert.match(report?.text ?? '', /seven new sections/, 'the report that arrived late is the one routed')
  assert.ok(
    relay.log.some((m) => m.text.includes('arrived after the settle window')),
    'and the log says it was recovered rather than pretending it was never late',
  )
})

test('a report that never arrives escalates in terms of what was lost', async () => {
  // When it genuinely cannot be recovered the run still stops -- but the message has to say
  // what that costs. The first version read as a routing detail ("the transcript had not
  // settled"), when what it means is that a completed turn's entire account was discarded.
  const dir = mkdtempSync(join(tmpdir(), 'conclave-lost-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })

  const impl = new FakeSession('claude', 'impl', ['ack', 'PREAMBLE', 'NONE'])
  impl.lagTranscript('never arrives', 60_000, { silent: true })
  // The turn does real work on disk, as the reported one did. This is the part the
  // escalation has to mention: the files are the evidence that something was lost.
  // A NEW file per turn. The diff can only see paths that became dirty, so a turn that only
  // re-edits an already-dirty file is the case the message has to stay honest about — and
  // it is asserted separately below rather than conflated with this one.
  let n = 0
  impl.onSend = () => writeFileSync(join(dir, `record-${n++}.md`), 'seven new sections\n')

  const relay = await Relay.start({
    registry: registryWith({ codex: new FakeSession('codex', 'advisor', ['Do it.', 'DONE']), claude: impl }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 2,
    transcriptSettleMs: 100,
    transcriptSalvageMs: 200,
  })
  await relay.run('Keep the work moving.')
  await relay.stop()

  const escalation = relay.log.find((m) => m.text.includes('could not be read'))
  assert.ok(escalation, `the escalation must name the failure:\n${relay.log.map((m) => m.text).join('\n---\n')}`)
  assert.match(escalation.text, /record-\d\.md/, 'and name the file that changed, so the loss is legible')
  assert.match(escalation.text, /resume/, 'and warn that a resume starts from a turn saying nothing')
  rmSync(dir, { recursive: true, force: true })
})

test('a completed turn whose transcript yields nothing is rebuilt from what it was seen to say', async () => {
  // #39's remaining half, found in a live run on a build that already had the first half.
  // The Stop-hook fallback only helps when `last_assistant_message` is present; twice in one
  // session it was not, both salvage windows expired, and one of the discarded reports
  // described eight changed files. The work was on disk and the account of it was thrown
  // away while a copy sat in the event list the console had been rendering from all along.
  const impl = new FakeSession('claude', 'impl', ['ack', 'IGNORED', 'NONE'])
  impl.lagTranscript('never arrives', 60_000, { silent: true })
  impl.streamNarration('Read the parser.', 'Rewrote the inline-table branch and added a test.')

  const relay = await Relay.start({
    registry: registryWith({ codex: new FakeSession('codex', 'advisor', ['Do it.', 'DONE']), claude: impl }),
    cwd: process.cwd(),
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 2,
    transcriptSettleMs: 100,
    transcriptSalvageMs: 150,
  })
  await relay.run('Keep the work moving.')
  await relay.stop()

  const report = relay.log.filter((m) => m.kind === 'report').at(-1)
  assert.match(report?.text ?? '', /Rewrote the inline-table branch/, 'the streamed narration is routed rather than a blank')

  // Marked, not passed off. Narration is longer and less pointed than a closing statement,
  // and a reader deciding how much to trust an instruction built on it should know which of
  // the two they have.
  assert.ok(
    relay.log.some((m) => /rebuilt from the 2 message\(s\) streamed during the turn/.test(m.text)),
    `the log must say the report was reconstructed:\n${relay.log.map((m) => m.text).join('\n---\n')}`,
  )
})

test('a turn that streamed nothing either says so, rather than going quiet (#94)', async () => {
  // The branch beside the one above, and it recorded no line at all. Observed on oath-lang:
  // one run salvaged from 10 streamed messages and explained itself, then hit this case and
  // went silent -- so the operator saw two notes about waiting and then nothing, and had to
  // infer from an ABSENT third note that a third stage existed. The quietest moment was the
  // one that most needed a sentence.
  const impl = new FakeSession('claude', 'impl', ['ack', 'IGNORED', 'NONE'])
  impl.lagTranscript('never arrives', 60_000, { silent: true })
  // No streamNarration: nothing was seen, so there is nothing to rebuild from.

  const relay = await Relay.start({
    registry: registryWith({ codex: new FakeSession('codex', 'advisor', ['Do it.', 'DONE']), claude: impl }),
    cwd: process.cwd(),
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 2,
    transcriptSettleMs: 100,
    transcriptSalvageMs: 150,
  })
  await relay.run('Keep the work moving.')
  await relay.stop()

  assert.ok(
    relay.log.some((m) => /nothing was streamed during the turn, so there is nothing to rebuild one from/.test(m.text)),
    `the log must say the salvage found nothing:\n${relay.log.map((m) => m.text).join('\n---\n')}`,
  )
  // The two outcomes must stay distinguishable. This branch is reached only when there was
  // nothing to rebuild from, so claiming a rebuild here would describe work that did not happen.
  assert.ok(
    !relay.log.some((m) => /rebuilt from the/.test(m.text)),
    'a salvage that found nothing must not claim to have rebuilt anything',
  )
})
