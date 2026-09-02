/**
 * The event names an adapter registers are not configuration. Each one is a claim about a
 * DIFFERENT program: that the CLI about to be launched dispatches a hook by that exact
 * spelling.
 *
 * Neither CLI validates the block it is handed. An unknown event key is accepted in silence and
 * simply never fires -- measured on Claude Code 2.1.251, where a settings block carrying a
 * deliberately bogus event still delivered `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
 * `PostToolUse`, `Stop` and `SessionEnd` normally. So a rename upstream produces no error
 * anywhere. It produces a seat that boots, runs a turn, and never reports finishing it, until
 * the watchdog says so forty-five minutes later. That is #36's symptom, and the reason these
 * names are checked against the installed binary rather than against a comment.
 *
 * The comments were the thing that went stale. Two claims in this tree read as present tense
 * while a version bump had already falsified them -- `SubagentStart` "Claude Code has no such
 * event" and `StopFailure` "No Claude Code equivalent", both true of 2.1.224 and both false by
 * 2.1.251. Nothing failed, because nothing was checking.
 *
 * This reads the executable and looks for the quoted literal. It cannot prove an event FIRES --
 * that needs a live session, and `claude.live.test.ts` is where the ones conclave depends on are
 * exercised end to end. It proves the weaker and more perishable thing: that the name is still
 * one the program knows.
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { HOOK_EVENTS } from './claude.ts'
import { KIMI_HOOK_EVENTS } from './kimiConfig.ts'
import { ABSENT_LITERAL_CANARY, installedBundle } from '../registry/installedBundle.ts'

/**
 * Locating the bundle is shared with the command-policy guard, which needs exactly the same
 * lookup for exactly the same reason -- see `src/registry/installedBundle.ts`.
 */
const bundleOf = installedBundle

/** A name no CLI dispatches. If this is ever "found", the search matches anything and proves nothing. */
const CANARY = ABSENT_LITERAL_CANARY

/** The event name as it appears in the program's own source: a quoted literal. */
const dispatches = (bytes: Buffer, event: string) => bytes.includes(`"${event}"`)

function checkNames(command: string, events: readonly string[], t: { diagnostic: (m: string) => void }) {
  const found = bundleOf(command)
  if ('why' in found) {
    t.diagnostic(`skipped: ${found.why}`)
    return
  }
  t.diagnostic(`checked against ${found.at} (${found.bytes.byteLength}B)`)

  assert.equal(
    dispatches(found.bytes, CANARY),
    false,
    'the canary was found, so the search matches anything and the assertions below are vacuous',
  )

  const missing = events.filter((e) => !dispatches(found.bytes, e))
  assert.deepEqual(
    missing,
    [],
    `${command} has no hook event by these names, so registering them buys silence, not events: ${missing.join(', ')}`,
  )
}

test('every event the Claude adapter registers is a name the installed Claude Code knows', (t) => {
  checkNames('claude', HOOK_EVENTS, t)
})

test('every event the Codex sidecar registers is a name the installed Codex knows', (t) => {
  // Read from the template that is actually installed, not from a list restated here, so a
  // name added to the sidecar is covered without anyone remembering to add it twice.
  const sidecar = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'config', 'templates', 'codex-hooks.json'), 'utf8'),
  ) as { hooks: Record<string, unknown> }
  const events = Object.keys(sidecar.hooks)
  assert.ok(events.length > 0, 'the sidecar template registers nothing, so this test proves nothing')
  checkNames('codex', events, t)
})

test('the installed Codex knows both compaction events, whichever seat registers them', (t) => {
  // The test above reads the sidecar's own keys, which is what keeps IT from going stale and
  // is exactly why it cannot see this. `config/templates/codex-hooks.json` registers no
  // compaction event, so `PreCompact` and `PostCompact` fall outside everything it examines --
  // and the "Codex does not" on `KIMI_HOOK_EVENTS` sat unchecked through the very commit that
  // turned this file's other two dated comments into checks. A claim about another program is
  // checked against that program or it is not checked.
  //
  // The pair is read OUT of `KIMI_HOOK_EVENTS` and then pinned back against the literal names,
  // so one misspelling in the adapter's list trips this and nothing else: the availability
  // assertion stops finding the name in the bundle, and the membership assertion stops finding
  // the pair in the list.
  const compaction = (KIMI_HOOK_EVENTS as readonly string[]).filter((e) => e.includes('Compact'))

  const found = bundleOf('codex')
  if ('why' in found) {
    t.diagnostic(`skipped the availability half: ${found.why}`)
  } else {
    t.diagnostic(`checked against ${found.at} (${found.bytes.byteLength}B)`)
    assert.equal(
      dispatches(found.bytes, CANARY),
      false,
      'the canary was found, so the search matches anything and the assertions below are vacuous',
    )
    const missing = compaction.filter((e) => !dispatches(found.bytes, e))
    assert.deepEqual(
      missing,
      [],
      `the installed Codex knows no event by these names, so the comment on KIMI_HOOK_EVENTS should say which version stopped dispatching them: ${missing.join(', ')}`,
    )
  }

  assert.deepEqual(
    compaction,
    ['PreCompact', 'PostCompact'],
    'these hooks are the only compaction evidence the Kimi adapter has -- it reads no transcript, so nothing else counts a generation for that seat; dropping either half removes the evidence without removing the claim',
  )
})

test('both halves of the subagent lifecycle are registered on Claude, and the CLI knows both names', (t) => {
  // #5's symptom was a delegating seat that read as an ending without a beginning, and the
  // reason moved twice: the CLI genuinely lacked `SubagentStart` at 2.1.224, then it had it and
  // nothing here consumed it. Both are spent -- `#onSubagentHook` counts the pair -- so the
  // names are registered.
  //
  // Membership is asserted HERE rather than left to the check above, which only reads names OUT
  // of the list: dropping one would shrink what that test examines and pass, while the console
  // went quietly back to guessing delegation from the spawning tool's name.
  for (const event of ['SubagentStart', 'SubagentStop']) {
    assert.ok(
      (HOOK_EVENTS as readonly string[]).includes(event),
      `${event} is not registered, so the adapter never hears it and the count it feeds stays at zero`,
    )
  }

  const found = bundleOf('claude')
  if ('why' in found) {
    t.diagnostic(`skipped the availability half: ${found.why}`)
    return
  }
  for (const event of ['SubagentStart', 'SubagentStop']) {
    assert.ok(
      dispatches(found.bytes, event),
      `the installed CLI dispatches no ${event}, so registering it buys silence -- what an operator sees is the tool-name fallback in relay/subagents.ts`,
    )
  }
})
