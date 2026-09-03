/**
 * Subagent lifecycle, from the child's hook to the adapter's event.
 *
 *   node --test src/adapters/subagentLifecycle.test.ts
 *
 * The console can currently say only what the SPAWNING TOOL was called: `relay/subagents.ts`
 * turns `wait_agent` into "waiting on a subagent" from a name list, because nothing structured
 * was available. A name list cannot say how many are running, and it is a guess -- it fires on
 * a tool that merely looks like delegation, and stays silent on one that does not.
 *
 * Claude Code 2.1.252 dispatches `SubagentStart` and `SubagentStop`, and its own payload
 * schemas make `agent_id` REQUIRED on both -- read out of the installed bundle rather than
 * remembered:
 *
 *     SubagentStart: { hook_event_name, agent_id, agent_type }
 *     SubagentStop:  { hook_event_name, stop_hook_active, agent_id, agent_transcript_path,
 *                      agent_type, last_assistant_message?, background_tasks? }
 *
 * So the count can be COUNTED. These tests drive the consumer that counts it: real PTY, real
 * HookReceiver, real hook decoding, real `#onHook`. The only thing that is not real is the CLI,
 * which is a stand-in on PATH that posts a scripted sequence of subagent hooks. No agent binary
 * is spawned and no quota is used.
 *
 * ## The half that a CLI may still withhold
 *
 * Both events are in `HOOK_EVENTS` (see the note there), so against 2.1.252 the adapter hears
 * matched pairs. Against a CLI that does not dispatch the start -- 2.1.224 -- the key is
 * accepted in silence and never fires, and the adapter hears stops only. That case is the third
 * test rather than an omission from these: an unpaired stop must leave the count alone, because
 * a consumer that decremented on a stop it never counted up would go negative.
 */

import { strict as assert } from 'node:assert'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { AgentEvent, SubagentStartEvent, SubagentStopEvent } from '../contract/session.ts'
import { ClaudePtyHookAdapter, TurnSubagents } from './claude.ts'
import { COMPOSER_JS } from './fakeCli.ts'
import { suiteTempDir } from '../testkit/tempDir.ts'

/**
 * The run directories the adapters this file boots make for themselves, contained.
 *
 * `Claude.#boot` and `Codex.#boot` each `mkdtemp` a run directory under `os.tmpdir()` and
 * never remove it. That is PRODUCTION behaviour and issue #203's business, not this file's --
 * so rather than change it, the floor it lands on moves: `tmpdir()` re-reads `TMPDIR` on every
 * call, so pointing it at a directory the testkit issued puts every run directory booted here
 * inside something whose lifetime the helper already owns.
 *
 * Per FILE, and that is what makes it safe rather than a shared global: every test file runs
 * in its own process under `node --test`, so this reaches no other suite, and the tests in
 * this one stay isolated from each other exactly as before -- by `tempDir` handing each its
 * own uniquely named child of this root.
 */
const ADAPTER_TMP_ROOT = suiteTempDir('adapter-run-root')
process.env['TMPDIR'] = ADAPTER_TMP_ROOT

/**
 * Stands in for `claude` on PATH. Extensionless and shebanged, so Node runs it as CJS.
 *
 * `ORCH_FAKE_SUBAGENTS` is a JSON list of hooks to fire once a prompt lands, in order and
 * AWAITED one at a time -- hooks are independent POSTs that nobody orders, and a test whose
 * subject is "what the second delivery did to the first one's count" cannot be built on POSTs
 * that merely tend to arrive in the order they were sent.
 *
 * `firedAt` is settable per entry because the receiver mints a delivery identity from the
 * payload plus the fire timestamp, and dedupes on it. Two byte-identical posts would otherwise
 * be one delivery or two depending on whether they landed in the same millisecond, which is a
 * coin toss dressed as a fixture.
 */
const FAKE_CLI = `#!/usr/bin/env node
const url = process.env.ORCH_HOOK_URL
const script = JSON.parse(process.env.ORCH_FAKE_SUBAGENTS || '[]')

function post(event, extra, firedAt) {
  const headers = { 'content-type': 'application/json', 'x-orch-agent': 'claude', 'x-orch-event': event }
  if (firedAt) headers['x-orch-fired-at'] = String(firedAt)
  return fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(Object.assign({ hook_event_name: event, session_id: 'fake-session' }, extra)),
  }).catch(function () {})
}

process.stdout.write('\\x1b[?2004h')
${COMPOSER_JS}
let turns = 0
let queue = Promise.resolve()
onComposerSubmit(function (prompt) {
  if (!prompt.trim()) return
  turns += 1
  const id = 'fake-turn-' + turns
  queue = queue.then(async function () {
    await post('UserPromptSubmit', { prompt_id: id, turn_id: id, prompt: prompt })
    for (const step of script) {
      const body = { prompt_id: step.unkeyed ? 'no-such-turn' : id, turn_id: id }
      if (step.agent_id !== undefined) body.agent_id = step.agent_id
      if (step.agent_type !== undefined) body.agent_type = step.agent_type
      if (step.event === 'SubagentStop') body.stop_hook_active = false
      await post(step.event, body, step.firedAt)
    }
    await post('Stop', { prompt_id: id, turn_id: id, last_assistant_message: 'done' })
  })
})

post('SessionStart', { transcript_path: process.env.ORCH_FAKE_TRANSCRIPT })
setInterval(function () {}, 1 << 30)
`

const RUN = suiteTempDir('orch-subagent-cli')
const TRANSCRIPT = join(RUN, 'fake-transcript.jsonl')
writeFileSync(join(RUN, 'claude'), FAKE_CLI)
chmodSync(join(RUN, 'claude'), 0o755)
writeFileSync(TRANSCRIPT, '')

// This file runs in its own process under `node --test`, so shadowing the real CLI on PATH
// cannot leak into any other suite.
process.env['PATH'] = `${RUN}:${process.env['PATH'] ?? ''}`
process.env['ORCH_FAKE_TRANSCRIPT'] = TRANSCRIPT

interface Step {
  event: 'SubagentStart' | 'SubagentStop'
  agent_id?: string
  agent_type?: string
  firedAt?: number
  /** Post under a `prompt_id` this adapter never armed, to exercise the turn fallback. */
  unkeyed?: boolean
}

/** Collect events until `done`, or give up. Returns what it saw either way. */
async function collect(
  session: { events(): AsyncIterable<AgentEvent> },
  done: (e: AgentEvent[]) => boolean,
  timeoutMs: number,
): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = []
  const deadline = Date.now() + timeoutMs
  const it = session.events()[Symbol.asyncIterator]()
  while (Date.now() < deadline) {
    let timer: NodeJS.Timeout | undefined
    const next = await Promise.race([
      it.next(),
      new Promise<'timeout'>((r) => {
        timer = setTimeout(() => r('timeout'), Math.max(0, deadline - Date.now()))
      }),
    ]).finally(() => clearTimeout(timer))
    if (next === 'timeout' || next.done) break
    seen.push(next.value)
    if (done(seen)) break
  }
  return seen
}

/**
 * Run one scripted turn and return everything the adapter emitted for it.
 *
 * Waits for `turn_end`, which the stand-in sends only AFTER the whole script, so a missing
 * subagent event is a failed assertion rather than a race with the collector's deadline.
 */
async function runScript(script: Step[]): Promise<AgentEvent[]> {
  process.env['ORCH_FAKE_SUBAGENTS'] = JSON.stringify(script)
  const session = await ClaudePtyHookAdapter.start({
    cwd: RUN,
    role: 'implementer',
    readyTimeoutMs: 20_000,
  })
  try {
    await session.send('delegate please', { kind: 'orchestrator' })
    return await collect(session, (e) => e.some((x) => x.type === 'turn_end'), 15_000)
  } finally {
    await session.close()
  }
}

const starts = (e: AgentEvent[]) => e.filter((x) => x.type === 'subagent_start') as SubagentStartEvent[]
const stops = (e: AgentEvent[]) => e.filter((x) => x.type === 'subagent_stop') as SubagentStopEvent[]

test('a started subagent is counted until its own stop arrives, and the count is per subagent', async () => {
  const events = await runScript([
    { event: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' },
    { event: 'SubagentStart', agent_id: 'a2', agent_type: 'general-purpose' },
    { event: 'SubagentStop', agent_id: 'a1', agent_type: 'Explore' },
    { event: 'SubagentStop', agent_id: 'a2', agent_type: 'general-purpose' },
  ])

  // The count as the console would read it, event by event. Two up, two down -- and the ORDER
  // is the claim: a count that merely ended at zero could have been a counter that never moved.
  assert.deepEqual(
    events.filter((e) => e.type === 'subagent_start' || e.type === 'subagent_stop').map((e) => e.outstanding),
    [1, 2, 1, 0],
  )

  const [s1, s2] = starts(events)
  assert.equal(s1?.agentId, 'a1')
  assert.equal(s1?.agentType, 'Explore', 'the child names the kind of subagent, and it is worth keeping')
  assert.equal(s2?.agentId, 'a2')
  assert.ok(
    stops(events).every((s) => s.paired),
    'both stops matched a start this adapter had seen',
  )

  // Attributed to the PARENT turn: the subagent hooks fire in the parent session and carry its
  // `prompt_id`, which is the turn the console is showing a clock for.
  const turnStart = events.find((e) => e.type === 'turn_start')
  assert.ok(turnStart?.turnKey, 'the turn must have a key for the rest of this to mean anything')
  for (const e of events.filter((x) => x.type === 'subagent_start' || x.type === 'subagent_stop')) {
    assert.equal(e.turnKey, turnStart.turnKey)
  }
})

test('the same subagent delivered twice is still one subagent', async () => {
  // Hook delivery is at-most-once and replayed from a local journal on recovery, so a repeat is
  // a matter of time rather than a hypothetical. A counter that incremented on arrival would
  // read 2 here and never come back down -- the stop takes away only what it can find.
  const events = await runScript([
    { event: 'SubagentStart', agent_id: 'a1', firedAt: 1_700_000_000.1 },
    { event: 'SubagentStart', agent_id: 'a1', firedAt: 1_700_000_000.2 },
    { event: 'SubagentStop', agent_id: 'a1', firedAt: 1_700_000_000.3 },
    { event: 'SubagentStop', agent_id: 'a1', firedAt: 1_700_000_000.4 },
  ])

  assert.equal(starts(events).length, 1, 'the second start is the same subagent, not another one')
  assert.equal(stops(events).length, 1, 'and the second stop has nothing left to stop')
  assert.deepEqual(
    events.filter((e) => e.type === 'subagent_start' || e.type === 'subagent_stop').map((e) => e.outstanding),
    [1, 0],
  )
  // Distinct `x-orch-fired-at` on each post, so all four were distinct DELIVERIES: the receiver
  // mints its identity from payload + pid + fire time and drops exact repeats before the
  // adapter ever sees them. Without this the test would be proving the receiver's dedupe.
  assert.equal(
    events.filter((e) => e.type === 'error').length,
    0,
    'nothing was rejected as a replayed delivery, so the adapter really saw all four',
  )
})

test('a stop with no start is left unpaired and moves no count', async () => {
  // The shape a run against a CLI that does not dispatch `SubagentStart` produces, and the
  // shape of any start lost before the receiver was listening. The stop is still reported:
  // something finished, and saying so is true. What it must not do is take one away from a
  // count that was never added to.
  const events = await runScript([{ event: 'SubagentStop', agent_id: 'a9', agent_type: 'Explore' }])

  const seen = stops(events)
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.paired, false, 'nothing was ever seen to start')
  assert.equal(seen[0]?.outstanding, 0, 'and the count stays where it was')
  assert.equal(starts(events).length, 0)
})

test('a subagent hook keyed to no known turn still lands on the turn in flight', async () => {
  // The key is the ordinary route and the fallback is for a payload whose `prompt_id` names
  // nothing this adapter armed. Dropping those would mean a console that goes blank whenever
  // the child keys an event in a way we did not predict.
  const events = await runScript([
    { event: 'SubagentStart', agent_id: 'a1', unkeyed: true },
    { event: 'SubagentStop', agent_id: 'a1', unkeyed: true },
  ])

  const turnStart = events.find((e) => e.type === 'turn_start')
  assert.equal(starts(events).length, 1)
  assert.equal(starts(events)[0]?.outstanding, 1)
  assert.equal(stops(events)[0]?.paired, true, 'both halves found the same turn, so they paired')
  assert.equal(starts(events)[0]?.turnKey, turnStart?.turnKey, 'attributed to the live turn')
})

test('the id-keyed set is what makes a repeat recognisable, in both directions', () => {
  // The set is asserted directly as well as through the adapter, because these are the cases a
  // redelivery produces and only two of them can be provoked through a PTY without contriving
  // the order the child fires hooks in.
  const set = new TurnSubagents()

  assert.equal(set.start('a1'), 'started')
  assert.equal(set.outstanding, 1)
  assert.equal(set.start('a1'), 'duplicate', 'the same subagent again is not a second subagent')
  assert.equal(set.outstanding, 1)

  assert.equal(set.stop('a1'), 'stopped')
  assert.equal(set.outstanding, 0)
  assert.equal(set.stop('a1'), 'duplicate', 'and it cannot stop twice')
  assert.equal(set.outstanding, 0)

  // The case that needs the second set. A start redelivered AFTER its stop finds the id absent
  // from the running set, and with only that set to consult it reads as news -- resurrecting a
  // subagent that has finished and leaving a count that never comes down again.
  assert.equal(set.start('a1'), 'duplicate', 'a finished subagent is not restarted by a replay')
  assert.equal(set.outstanding, 0)
})

test('an unpaired stop is distinguished from a paired one, and neither goes negative', () => {
  const set = new TurnSubagents()

  assert.equal(set.stop('never-started'), 'unpaired')
  assert.equal(set.outstanding, 0, 'a count that was never raised cannot be lowered')
  assert.equal(set.stop('never-started'), 'duplicate', 'and the unpaired one is remembered too')
  assert.equal(set.outstanding, 0)

  // Interleaving proves the ids are what pair, rather than arrival order.
  set.start('a1')
  set.start('a2')
  assert.equal(set.stop('a2'), 'stopped')
  assert.equal(set.outstanding, 1, 'a1 is still running')
  assert.equal(set.stop('a1'), 'stopped')
  assert.equal(set.outstanding, 0)
})
