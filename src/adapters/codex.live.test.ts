/**
 * CodexPtyHookAdapter acceptance boundary.
 *
 * Every session is built through `registry.createParticipant`, never by calling the
 * adapter directly. That is deliberate: the registry runs the Codex preflight, which
 * refuses construction when this checkout's hooks are loaded and enabled but not trusted.
 * A test that constructed the adapter itself would skip the deployment contract and pass
 * against a session whose hooks could never fire.
 *
 *   ORCH_LIVE_CODEX=1 node --test src/adapters/codex.live.test.ts
 *
 * Prompts ask for a COMPUTED token: waiting on a literal that appears in the prompt is
 * satisfied instantly by the TUI echoing our own typing.
 */

import { strict as assert } from 'node:assert'
import { existsSync, rmSync } from 'node:fs'
import test from 'node:test'
import type { AgentEvent, SessionSnapshot, TurnEndEvent } from '../contract/session.ts'
import { defaultRegistry, CODEX_PROMPT_ON_APPROVAL_ARGS } from '../registry/builtin.ts'
import { squash } from '../process/pty.ts'
import type { CodexPtyHookAdapter } from './codex.ts'

const CWD = process.cwd()
const skip =
  process.env.ORCH_LIVE_CODEX === '1'
    ? false
    : 'set ORCH_LIVE_CODEX=1 (spawns real Codex sessions, uses quota)'

async function participant(args: string[] = []): Promise<CodexPtyHookAdapter> {
  const registry = defaultRegistry()
  const session = await registry.createParticipant(
    { id: 'advisor', agent: 'codex', role: 'advisor', args },
    { cwd: CWD },
  )
  return session as CodexPtyHookAdapter
}

/**
 * Single consumer of `events()`, because the adapter's queue delivers each event to
 * exactly one reader. Two concurrent collectors silently split the stream between them --
 * which is what made the permission tests time out waiting for an event another collector
 * had already taken.
 *
 * Recording once and querying the buffer is also closer to what a real consumer does.
 */
class Recorder {
  readonly events: AgentEvent[] = []

  constructor(session: CodexPtyHookAdapter) {
    void (async () => {
      for await (const e of session.events()) this.events.push(e)
    })()
  }

  async waitFor(pred: (events: AgentEvent[]) => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (pred(this.events)) return true
      await new Promise((r) => setTimeout(r, 200))
    }
    return pred(this.events)
  }

  /** Wait for a terminal verdict, then keep watching briefly in case it is revised. */
  async waitForSettled(timeoutMs: number, settleMs = 4000): Promise<boolean> {
    const got = await this.waitFor((e) => e.some((x) => x.type === 'turn_end'), timeoutMs)
    if (got) await new Promise((r) => setTimeout(r, settleMs))
    return got
  }

  lastTurnEnd(): TurnEndEvent | undefined {
    return [...this.events].reverse().find((e) => e.type === 'turn_end') as TurnEndEvent | undefined
  }
}

/**
 * Fold the event stream the way an ordinary consumer would -- apply terminal verdicts,
 * drop anything a revision withdrew -- and require it to agree with the authoritative
 * snapshot. Run after EVERY flow, not just the happy one: the flows most likely to
 * diverge are the ones whose verdict changes after it was first reported.
 */
function assertConverges(events: AgentEvent[], snap: SessionSnapshot, label: string): void {
  const withdrawn = new Set(events.filter((e) => e.type === 'revision').flatMap((e) => e.replaces))
  const folded = new Map<string, string>()
  for (const e of events) {
    if (e.type === 'turn_end' && !withdrawn.has(e.seq) && e.turnKey) {
      folded.set(String(e.turnKey), e.verdict.outcome)
    }
  }
  const authoritative = new Map(
    snap.turns.filter((t) => t.state !== 'in_progress').map((t) => [String(t.key), t.state]),
  )
  assert.deepEqual(
    [...folded.entries()].sort(),
    [...authoritative.entries()].sort(),
    `${label}: a consumer folding events() must agree with snapshot()`,
  )
}

test('preflight gates construction on hook trust', { skip }, async () => {
  // Not a formality. Codex hooks that are registered and enabled but untrusted never
  // execute, and a session built on them has no turn-completion signal at all.
  const registry = defaultRegistry()
  const codex = registry.get('codex')
  assert.ok(codex.preflight, 'codex must declare a preflight')
  assert.ok(codex.create, 'codex must now be constructible')
  await codex.preflight(registry.resolve({ id: 'a', agent: 'codex', role: 'advisor' }), { cwd: CWD })
})

test('start -> acceptsInput', { skip }, async (t) => {
  const session = await participant()
  t.after(() => session.close('graceful'))

  assert.equal(session.acceptsInput, true, 'the composer should accept input')
  assert.equal(session.isReady, true)
  // Readiness here is raw-mode negotiation, NOT SessionStart. Codex fires no hook before
  // the first turn, so session identity is legitimately unknown at this point.
  assert.equal(
    session.sessionIdentified,
    false,
    'session identity must not be claimed before any hook has supplied it',
  )
  assert.equal(session.sessionId, '')
})

test('send -> completed', { skip }, async (t) => {
  const session = await participant()
  t.after(() => session.close('graceful'))

  const rec = new Recorder(session)
  const key = await session.send(
    'Reply with exactly CDXA-N and nothing else, where N is 41 plus 1. No tools.',
    { kind: 'orchestrator' },
  )
  await rec.waitForSettled(240_000)
  const events = rec.events

  const end = rec.lastTurnEnd()
  assert.ok(end, 'expected a turn_end')
  assert.equal(end.verdict.outcome, 'completed')
  assert.equal(end.verdict.confidence, 'proven')
  assert.equal(end.synthesized, false, 'Stop announced this one')
  assert.ok(end.verdict.provenance.some((p) => p.source === 'hook' && p.detail === 'Stop'))

  // Only now is session identity known -- supplied by the hooks the turn produced.
  assert.equal(session.sessionIdentified, true)
  assert.ok(session.sessionId.length > 0)

  const snap = await session.snapshot()
  assertConverges(events, snap, 'completed')
  assert.equal(snap.turns.find((tn) => String(tn.key) === String(key))?.state, 'completed')
})

test('send -> cancel -> cancelled, proven from the transcript', { skip }, async (t) => {
  const session = await participant()
  t.after(() => session.close('graceful'))

  const rec = new Recorder(session)
  const key = await session.send(
    'Write a detailed 3000-word technical essay on the history of terminal emulators. ' +
      'Be exhaustive and do not stop early.',
    { kind: 'orchestrator' },
  )
  // Match on squashed output: the TUI interleaves ANSI, so the raw stream does not
  // reliably contain the literal phrase.
  await session.pty.waitForOutput((a) => squash(a).includes('esctointerrupt'), 90_000)
  await new Promise((r) => setTimeout(r, 6000))

  const cancelled = await session.cancel()
  assert.equal(cancelled, key)

  await rec.waitForSettled(60_000)
  const events = rec.events
  const end = rec.lastTurnEnd()
  assert.ok(end, 'expected a turn_end for the cancelled turn')
  assert.equal(end.verdict.outcome, 'cancelled')
  // Unlike Claude, the child records this, so the verdict is not merely `assumed`.
  assert.equal(
    end.verdict.confidence,
    'proven',
    'turn_aborted in the transcript proves cancellation on Codex',
  )
  assert.ok(end.verdict.provenance.some((p) => p.detail.includes('turn_aborted')))

  const cancelAction = session.inputLog.find((a) => a.kind === 'cancel')
  assert.equal(cancelAction?.origin, 'orchestrator')

  assertConverges(events, await session.snapshot(), 'cancelled')
})

test('send -> permission deny -> permission_refused', { skip }, async (t) => {
  const probe = '/tmp/codex-accept-deny.txt'
  rmSync(probe, { force: true })
  // Restrictive approval settings are passed per participant, not baked into the launch
  // spec: with defaults Codex auto-approves and no dialog ever appears.
  const session = await participant(CODEX_PROMPT_ON_APPROVAL_ARGS)
  t.after(() => session.close('graceful'))

  const rec = new Recorder(session)
  await session.send(`Use your file-writing tool to create ${probe} containing the word probe. Do this immediately.`, {
    kind: 'orchestrator',
  })

  const asked = await rec.waitFor((e) => e.some((x) => x.type === 'permission_requested'), 180_000)
  assert.ok(asked, 'expected a permission_requested event')

  await session.decidePermission('deny')
  await rec.waitForSettled(60_000)
  const events = rec.events
  const end = rec.lastTurnEnd()
  assert.ok(end)
  assert.equal(end.verdict.outcome, 'permission_refused')
  assert.ok(
    end.verdict.provenance.some((p) => p.source === 'orchestrator' && p.detail === 'denied'),
    'refusal must cite the mediated decision; turn_aborted alone reads as a cancellation',
  )
  assert.equal(existsSync(probe), false, 'the write must not have happened')

  // The semantic action AND the exact byte encoding, with origin.
  const decision = session.inputLog.find((a) => a.kind === 'permission_decision')
  assert.equal(decision?.detail, 'deny')
  assert.equal(decision?.bytes, JSON.stringify('\x1b'))
  assert.equal(decision?.origin, 'orchestrator')

  assertConverges(events, await session.snapshot(), 'permission_refused')
})

test('send -> permission allow -> completed', { skip }, async (t) => {
  const probe = '/tmp/codex-accept-allow.txt'
  rmSync(probe, { force: true })
  const session = await participant(CODEX_PROMPT_ON_APPROVAL_ARGS)
  t.after(() => {
    rmSync(probe, { force: true })
    return session.close('graceful')
  })

  const rec = new Recorder(session)
  await session.send(`Use your file-writing tool to create ${probe} containing the word probe. Do this immediately.`, {
    kind: 'orchestrator',
  })
  const asked = await rec.waitFor((e) => e.some((x) => x.type === 'permission_requested'), 180_000)
  assert.ok(asked, 'expected a permission_requested event')

  await session.decidePermission('allow')
  await rec.waitForSettled(120_000)
  const events = rec.events
  const end = rec.lastTurnEnd()
  assert.ok(end)
  assert.equal(end.verdict.outcome, 'completed')
  assert.equal(existsSync(probe), true, 'the allowed write must have happened')

  // Encoding is `y`, observed against a real dialog rather than presumed.
  const decision = session.inputLog.find((a) => a.kind === 'permission_decision')
  assert.equal(decision?.detail, 'allow')
  assert.equal(decision?.bytes, JSON.stringify('y'))
  assert.equal(decision?.origin, 'orchestrator')

  assertConverges(events, await session.snapshot(), 'permission_allow')
})

test('abandon -> transport_lost with correct provenance', { skip }, async (t) => {
  const session = await participant()
  t.after(() => session.pty.terminate())

  const rec = new Recorder(session)
  await session.send(
    'Write a detailed 3000-word technical essay on the history of text editors. Be exhaustive.',
    { kind: 'orchestrator' },
  )
  await session.pty.waitForOutput((a) => squash(a).includes('esctointerrupt'), 90_000)
  await new Promise((r) => setTimeout(r, 3000))

  await session.close('abandoned')
  await rec.waitFor((e) => e.some((x) => x.type === 'turn_end'), 30_000)
  const events = rec.events

  const end = rec.lastTurnEnd()
  assert.ok(end, `expected a turn_end; saw: ${events.map((e) => e.type).join(', ')}`)
  assert.equal(end.verdict.outcome, 'transport_lost')
  assert.equal(end.verdict.confidence, 'uncertain')
  assert.ok(
    end.verdict.provenance.some((p) => p.caveat && p.detail.includes('may still be running')),
    'abandonment must not imply the child died',
  )
  assert.equal(session.closeMode, 'abandoned')

  assertConverges(events, await session.snapshot(), 'abandoned')
})

test('SessionEnd is recorded if it appears, and nothing depends on it', { skip }, async (t) => {
  // No Codex fixture has ever produced SessionEnd. This asserts the adapter does not
  // require it, and reports whether this run happened to see one.
  const session = await participant()
  t.after(() => session.close('graceful'))

  const rec = new Recorder(session)
  await session.send('Reply with exactly SEND-N and nothing else, where N is 20 plus 2. No tools.', {
    kind: 'orchestrator',
  })
  await rec.waitForSettled(240_000)
  assert.equal(rec.lastTurnEnd()?.verdict.outcome, 'completed')

  await session.close('graceful')
  const seen = session.receiver.journal.read().map((d) => d.event)
  console.log(`    [observed] hooks this run: ${[...new Set(seen)].join(', ')}`)
  assert.ok(seen.includes('Stop'), 'completion must not have depended on SessionEnd')
})
