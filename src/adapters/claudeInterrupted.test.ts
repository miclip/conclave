/**
 * An interrupted turn is recorded by the child, in the transcript, and that is what makes the
 * #174 retry reachable on a Claude seat (#225).
 *
 * The retry may only re-type a message once the CHILD has confirmed the turn ended -- our own
 * note of having typed ESC proves nothing about what the child did with it, and splicing a
 * second message into a turn that is still running is the failure the guard exists to prevent.
 *
 * The adapter's comment said Claude Code "records an interruption nowhere". Half right, and the
 * wrong half was load-bearing: no HOOK reports it, so `childClosure` never arrived and every
 * corrupted turn on a Claude seat was terminal for the run. The transcript does record it.
 *
 * Both halves are claims about another program, so both are checked against the installed
 * binary here rather than restated in a comment. This repository has had two such claims go
 * stale silently already -- see `hookEventNames.test.ts` -- and this file exists because a
 * third would put the retry back out of reach without anything failing.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { writeFileSync } from 'node:fs'

import { CLAUDE_INTERRUPTION, parseClaude } from '../transcript/parse.ts'
import { ABSENT_LITERAL_CANARY, installedBundle } from '../registry/installedBundle.ts'
import { ClaudePtyHookAdapter } from './claude.ts'
import { installFakeClis } from './fakeCli.ts'
import { containAdapterRunDirs } from '../testkit/tempDir.ts'

// Same reasoning as `promptFidelity.test.ts`: the adapter booted here makes a run directory
// under `tmpdir()` and never removes it, so the floor it lands on is one the testkit owns.
containAdapterRunDirs()

const { dir: RUN, transcript: TRANSCRIPT } = installFakeClis()

/**
 * One corrupted send at a child that never reports its turns ending.
 *
 * `recordsInterruption` is the only variable: with it, the stand-in writes the interruption to
 * its transcript exactly as Claude Code does, and dispatches no hook for it either way.
 */
async function corruptedSend(child: 'records' | 'writes nothing' | 'transcript, no record'): Promise<Error | undefined> {
  writeFileSync(TRANSCRIPT, '')
  process.env['ORCH_FAKE_LOSE'] = 'tail:9'
  // ONCE. A transport that glitched and then recovered is what the retry is for; a permanently
  // broken one is refused on a different branch and would not reach the question this asks.
  process.env['ORCH_FAKE_LOSE_TURNS'] = '1'
  // NO `ORCH_FAKE_STOP_MS`, deliberately: this child reports no `Stop`, no `SessionEnd` and does
  // not exit, which is the state a real Claude seat is in after an ESC. Every hook-derived
  // closure is therefore unavailable, and the transcript is the only evidence there is.
  // Two knobs, because three children matter: one that keeps no transcript, one that keeps a
  // transcript showing the turn still running, and one that records the interruption.
  if (child !== 'writes nothing') process.env['ORCH_FAKE_WRITE_TRANSCRIPT'] = '1'
  else delete process.env['ORCH_FAKE_WRITE_TRANSCRIPT']
  if (child === 'records') process.env['ORCH_FAKE_INTERRUPT_TRANSCRIPT'] = '1'
  else delete process.env['ORCH_FAKE_INTERRUPT_TRANSCRIPT']

  const session = await ClaudePtyHookAdapter.start({
    cwd: RUN,
    role: 'implementer' as const,
    readyTimeoutMs: 20_000,
    promptRecoveryMs: 6_000,
  })
  try {
    return await session
      .send('a message the transport will mangle exactly once', { kind: 'orchestrator' })
      .then(() => undefined, (e: Error) => e)
  } finally {
    delete process.env['ORCH_FAKE_LOSE']
    delete process.env['ORCH_FAKE_LOSE_TURNS']
    delete process.env['ORCH_FAKE_INTERRUPT_TRANSCRIPT']
    delete process.env['ORCH_FAKE_WRITE_TRANSCRIPT']
    await session.close()
  }
}

/** A user record shaped as Claude Code writes one: content is a plain string. */
const user = (text: string) => ({ type: 'user', message: { content: text } })
const assistant = (text: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
})

test('#225 an interruption CLOSES the turn it follows rather than opening a new one', () => {
  // The defect, and it cost twice. The marker is shaped exactly like a prompt -- a user message
  // whose content is a string -- so it opened a turn of its own, left the real turn
  // `in_progress` for ever, and buried the only evidence that the turn had ended.
  const { turns } = parseClaude([
    user('do the thing'),
    assistant('working on it'),
    user('[Request interrupted by user]'),
  ])

  assert.equal(turns.length, 1, 'one turn happened, not two')
  assert.equal(turns[0]?.prompt, 'do the thing', 'and the marker is not a prompt')
  assert.equal(turns[0]?.state, 'cancelled', 'the child says the turn ended, which is the point')
})

test('#225 a prompt sent after an interruption is still a prompt', () => {
  // The interruption closes ONE turn. What follows it is ordinary work, and swallowing that
  // would trade a turn that never ends for a turn that never starts.
  const { turns } = parseClaude([
    user('do the thing'),
    assistant('working'),
    user('[Request interrupted by user]'),
    user('do it again'),
    assistant('done'),
  ])

  assert.equal(turns.length, 2)
  assert.equal(turns[0]?.state, 'cancelled')
  assert.equal(turns[1]?.prompt, 'do it again')
  assert.equal(turns[1]?.state, 'in_progress', 'still open, having had no closure of its own')
})

test('#225 nothing written after the interruption is attached to the cancelled turn', () => {
  // Why the closure clears `current` as well as setting the state. Claude Code can write more
  // after an interruption -- an apology, a partial block already in flight -- and appending that
  // to the cancelled turn puts words into the report of a turn that did not finish. The relay
  // routes `report` to the other participant, so an advisor would read a truncated turn's
  // trailing sentence as its answer.
  const { turns } = parseClaude([
    user('do the thing'),
    assistant('working on it'),
    user('[Request interrupted by user]'),
    assistant('ok, stopping there'),
  ])

  assert.equal(turns.length, 1)
  assert.equal(turns[0]?.state, 'cancelled')
  assert.equal(turns[0]?.report, 'working on it', 'the report is what it said BEFORE it was stopped')
  assert.equal(
    turns[0]?.assistantText?.includes('ok, stopping there'),
    false,
    'and nothing written after the interruption joined it',
  )
})

test('#225 the marker is matched with the suffix Claude Code appends, and only at the start', () => {
  // `[^\]]*` is the program's own shape: it emits the marker bare and with a suffix. Anchored,
  // because a turn whose REPORT quotes the marker is a turn that ran and said something, and
  // cancelling that one would discard work on the strength of a quotation.
  assert.ok(CLAUDE_INTERRUPTION.test('[Request interrupted by user]'))
  assert.ok(CLAUDE_INTERRUPTION.test('[Request interrupted by user for tool use]'))
  assert.equal(CLAUDE_INTERRUPTION.test('the log said [Request interrupted by user]'), false)

  const { turns } = parseClaude([
    user('do the thing'),
    assistant('the log said [Request interrupted by user] which I am quoting'),
  ])
  assert.equal(turns[0]?.state, 'in_progress', 'a quotation is not a closure')
})

test('#225 Claude Code still writes this marker — checked against the installed binary', () => {
  // A claim with an expiry date. If the marker is reworded, the parse above silently stops
  // recognising it and the retry silently goes back out of reach, with nothing failing.
  const bundle = installedBundle('claude')
  if ('why' in bundle) {
    // Not a failure: a machine without the CLI installed cannot answer, and saying so is
    // honest where inventing a pass is not.
    assert.ok(bundle.why.length > 0)
    return
  }
  assert.equal(
    bundle.bytes.includes(ABSENT_LITERAL_CANARY),
    false,
    'the canary must be absent, or this search matches anything and proves nothing',
  )
  assert.ok(
    bundle.bytes.includes('[Request interrupted by user'),
    `the interruption marker is no longer in ${bundle.at}; the #225 transcript evidence has moved`,
  )
})

test('#225 Claude Code still dispatches NO interruption hook — which is why the transcript is read', () => {
  // The other half, and the reason this is not simply wired to a hook. If an interruption event
  // ever appears, THIS is the test that should fail: a hook is better evidence than a parsed
  // marker, and the adapter should be moved onto it rather than left reading prose.
  const bundle = installedBundle('claude')
  if ('why' in bundle) return
  const text = bundle.bytes.toString('utf8')
  // The program's own enumeration of every event it dispatches, found by its known members
  // rather than by a variable name that minifies differently every release.
  const at = text.indexOf('"PreToolUse","PostToolUse"')
  assert.notEqual(at, -1, 'the hook enumeration could not be found; this test needs rewriting')
  const list = text.slice(at, text.indexOf(']', at))
  assert.ok(list.includes('"Stop"') && list.includes('"SessionEnd"'), 'the list is the one meant')
  for (const invented of ['Interrupt', 'Interrupted', 'UserInterrupt', 'TurnInterrupted', 'Cancelled']) {
    assert.equal(
      list.includes(`"${invented}"`),
      false,
      `Claude Code now dispatches ${invented}: prefer the hook over the transcript marker (#225)`,
    )
  }
})

test('#225 a corrupted prompt IS retried when the child recorded the interruption', async () => {
  // The defect this issue is about, end to end. The child mangles the first send, reports no
  // `Stop`, no `SessionEnd` and does not exit -- so before this fix the retry could not be
  // taken and the run ended `transport_failed`, having lost work over nine bytes.
  //
  // The only thing added is the child writing down what it did. That is enough, because it is
  // the CHILD saying the turn ended rather than conclave's note of having typed ESC.
  const error = await corruptedSend('records')
  assert.equal(
    error,
    undefined,
    `the retry should have been taken: ${error?.message ?? ''}`,
  )
})

test('#225 and is still REFUSED when the child recorded nothing', async () => {
  // The guard the fix must not weaken. A child that says nothing anywhere -- no hook, nothing
  // in its transcript -- is indistinguishable from one still running the fragment, and typing a
  // second message into that turn is the failure the whole retry path exists to prevent. An
  // unrepaired send is recoverable by an operator; two messages spliced into one turn are not.
  const error = await corruptedSend('writes nothing')
  assert.ok(error, 'a child that confirmed nothing must not be typed into')
  assert.match(error.message, /never confirmed that turn/)
  assert.match(error.message, /no interruption recorded in its transcript/)
})

test('#225 a transcript that still shows the turn RUNNING is not confirmation', async () => {
  // The guard the transcript evidence rests on, and the case that separates "the child wrote
  // something" from "the child wrote that it stopped". This child keeps a transcript and its
  // prompt is in it, so there is plenty to read -- and what it says is that the turn is still
  // in progress, which is the one answer that must not release the retry.
  //
  // Without this the refusing case has an EMPTY transcript, which is answered by a different
  // branch, and the check that actually matters is never exercised.
  const error = await corruptedSend('transcript, no record')
  assert.ok(error, 'a turn the child still shows as running must not be typed into')
  assert.match(error.message, /no interruption recorded in its transcript/)
})
