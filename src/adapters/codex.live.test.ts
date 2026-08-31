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
import { currentVersion } from '../conformance/suite.ts'
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
/**
 * How long a transcript-backed revision may take before the claim is considered unproven.
 *
 * Generous on purpose, and the generosity is free: `waitFor` returns the moment the condition
 * holds, so a prompt revision costs nothing and only a genuinely absent one waits this out.
 * The number is therefore an upper bound on patience, not an estimate of anything -- which is
 * exactly what the 4000 ms it replaces was not.
 */
const REVISION_TIMEOUT_MS = 30_000

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

  /**
   * Wait for a terminal verdict, then for the revision that may refine it.
   *
   * `until` is the fix for #175 and the reason this is not simply a sleep. A verdict here is
   * reported as soon as the adapter can state one, and the transcript read that UPGRADES it --
   * `assumed` to `proven`, on the evidence of `turn_aborted` -- lands afterwards. How long
   * afterwards is not a property of the code: the failing runs took ~33 s end to end where the
   * passing ones took ~14 s, so a fixed 4000 ms was a bet on machine speed that a loaded
   * machine loses. The evidence always arrived; the harness had stopped looking.
   *
   * Given `until`, this waits for the CONDITION -- with a timeout far past any observed read,
   * so it costs nothing when the evidence is prompt and cannot be outrun when it is not.
   *
   * Timing out is deliberately NOT a failure here. The caller's assertion is what states the
   * claim, and it must be the thing that fails: a harness that threw on the timeout would
   * report "waited too long" for what is really "the transcript never proved it", which is the
   * regression this test exists to catch and the one message that must survive.
   *
   * Without `until` the old fixed settle stands, for the flows that only need the stream to go
   * quiet and have never been observed to flake. Changing those blind, in a suite that needs a
   * real Codex to run, would be trading a known-good bet for an unmeasured one.
   */
  async waitForSettled(
    timeoutMs: number,
    opts: { settleMs?: number; until?: (events: AgentEvent[]) => boolean } = {},
  ): Promise<boolean> {
    const { settleMs = 4000, until } = opts
    const got = await this.waitFor((e) => e.some((x) => x.type === 'turn_end'), timeoutMs)
    if (!got) return got
    if (until) await this.waitFor(until, REVISION_TIMEOUT_MS)
    else await new Promise((r) => setTimeout(r, settleMs))
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

  // Wait for the PROVEN verdict, not for four seconds and a hope. The transcript read that
  // carries `turn_aborted` lands after the first verdict is reported, and this is the claim the
  // test is about -- so it is the thing to wait for. If it never arrives the assertion below
  // still fails, and says so in the words of the claim rather than of the wait.
  await rec.waitForSettled(60_000, {
    until: (e) => e.some((x) => x.type === 'turn_end' && x.verdict.confidence === 'proven'),
  })
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

test('#14 are turn_aborted and Stop still mutually exclusive on this Codex?', { skip }, async (t) => {
  // `turn_aborted > Stop` is covered synthetically in `outcomes/precedence.test.ts`, and #14
  // says the rule never fires in practice because the two records are mutually exclusive --
  // measured on Codex 0.146.0, and recorded in `capabilities.ts` against that version.
  //
  // A version-pinned fact with nothing watching it is a fact that quietly stops being one. If a
  // later Codex emits both, the precedence rule stops being a guard and becomes live behaviour,
  // and the thing it protects against -- a cancellation silently upgraded to a completion --
  // becomes reachable.
  //
  // So this observes rather than asserts an answer. Either result is information; only the
  // absence of anyone looking is a problem.
  const session = await participant()
  t.after(() => session.close('graceful'))

  const rec = new Recorder(session)
  const key = await session.send(
    'Write a detailed 3000-word technical essay on the history of terminal emulators. ' +
      'Be exhaustive and do not stop early.',
    { kind: 'orchestrator' },
  )
  await session.pty.waitForOutput((a) => squash(a).includes('esctointerrupt'), 90_000)
  await new Promise((r) => setTimeout(r, 6000))
  assert.equal(await session.cancel(), key)

  await rec.waitForSettled(60_000, {
    until: (e) => e.some((x) => x.type === 'turn_end' && x.verdict.confidence === 'proven'),
  })

  const end = rec.lastTurnEnd()
  assert.ok(end, 'expected a terminal verdict')
  const details = end.verdict.provenance.map((p) => `${p.source}:${p.detail}`)
  const aborted = details.some((d) => /turn_aborted/.test(d))
  const stopped = details.some((d) => /\bStop\b/.test(d))

  t.diagnostic(
    `codex ${currentVersion('codex')} on cancel: turn_aborted=${aborted} Stop=${stopped} ` +
      `provenance=${JSON.stringify(details)}`,
  )

  // The cancellation itself must hold whatever the records do -- that is the claim the run
  // depends on, and it is asserted rather than reported.
  assert.equal(end.verdict.outcome, 'cancelled')
  assert.ok(aborted, 'turn_aborted is what proves a Codex cancellation')

  // And the finding #14 rests on, stated as an assertion so a change is a FAILURE rather than a
  // line in a log nobody reads. If this fires, the precedence rule has become live behaviour and
  // `capabilities.ts` needs its version note revisited.
  assert.equal(
    stopped,
    false,
    'Stop fired alongside turn_aborted -- the two are no longer mutually exclusive, so the ' +
      'precedence guard is now load-bearing and #14 needs reopening',
  )
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

test('#6 a blocked session keeps emitting, which is what the staleness rule has to survive', { skip }, async (t) => {
  // The premise `#trackPermission` is built on, observed against a real dialog rather than read
  // off the adapter.
  //
  // The first cut of that rule cleared a pending permission on ANY later event, reasoning that a
  // decision taken in the child's own terminal would otherwise leave a stale entry. It was wrong
  // about what a WAITING session emits: the transcript poller reports the very tool call being
  // blocked, so an event arrives immediately after `permission_requested` and cancelled the
  // request microseconds after it appeared. The console printed "needs a permission decision"
  // and `/allow` a moment later answered "nobody is waiting".
  //
  // That reasoning was taken from reading the adapter. This watches it happen: after the dialog
  // is up and BEFORE any decision, further events arrive on the same session.
  const probe = '/tmp/codex-accept-staleness.txt'
  rmSync(probe, { force: true })
  const session = await participant(CODEX_PROMPT_ON_APPROVAL_ARGS)
  t.after(() => session.close('graceful'))

  const rec = new Recorder(session)
  await session.send(`Use your file-writing tool to create ${probe} containing the word probe. Do this immediately.`, {
    kind: 'orchestrator',
  })

  const asked = await rec.waitFor((e) => e.some((x) => x.type === 'permission_requested'), 180_000)
  assert.ok(asked, 'expected a permission_requested event')
  const at = rec.events.findIndex((e) => e.type === 'permission_requested')

  // Nothing is decided yet. Anything that arrives now is what a clear-on-any-later-event rule
  // would have consumed the request on.
  const after = await rec.waitFor((e) => e.length > at + 1, 30_000)

  t.diagnostic(
    `after permission_requested, ${rec.events.length - at - 1} further event(s) arrived before any ` +
      `decision: ${JSON.stringify(rec.events.slice(at + 1).map((e) => e.type))}`,
  )

  // Reported rather than asserted as a count. What must hold is the DIRECTION: a blocked session
  // is not silent, so a rule that cleared on silence-until-decision would be resting on nothing.
  // If Codex ever went quiet here the rule would be safe for a reason nobody chose, and that is
  // worth seeing in a diagnostic rather than discovering when it changes back.
  assert.equal(after, true, 'a session stopped at a dialog must still be emitting')
  assert.equal(
    rec.events.slice(at + 1).some((e) => e.type === 'turn_end'),
    false,
    'and none of it is a turn_end -- which is the boundary the rule now uses, and the only one it may clear on',
  )

  await session.decidePermission('deny')
  await rec.waitForSettled(60_000)
  assert.equal(existsSync(probe), false, 'the write must not have happened')
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
