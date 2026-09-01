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
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { HOOK_EVENTS } from './claude.ts'
import { findExecutable } from '../registry/executables.ts'

/**
 * A wrapper script passes `findExecutable` by construction -- that is deliberate there, and
 * wrong here, because a 200-byte shim contains none of the strings we are looking for and would
 * report every event as missing. Anything this small is treated as not-the-bundle and skipped,
 * which is the honest answer: we did not find the program, so we are not claiming anything
 * about it.
 */
const MIN_BUNDLE_BYTES = 1_000_000

/** A name no CLI dispatches. If this is ever "found", the search matches anything and proves nothing. */
const CANARY = 'ConclaveNoSuchHookEvent'

/**
 * Where the resolved executable is a launcher rather than the program -- `codex` on npm is a
 * 7KB `codex.js` that execs a platform binary several directories away -- the real one is
 * looked for beneath the package that shipped the launcher. Best effort by construction: it
 * finds the Claude binary directly, finds the Codex binary through the descent, and finds
 * nothing for a Python tool like Kimi, whose event names are not in its install tree in any
 * form. Finding nothing is reported as a skip, because "we could not locate the program" and
 * "the program lacks this event" must never arrive at the same answer.
 */
function safeReaddir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
}

function descend(dir: string, name: string, depth: number): string | undefined {
  if (depth < 0) return undefined
  const entries = safeReaddir(dir)
  if (!entries) return undefined
  for (const e of entries) {
    const at = join(dir, e.name)
    if (e.isFile() && e.name === name) {
      try {
        if (statSync(at).size >= MIN_BUNDLE_BYTES) return at
      } catch {
        /* raced or unreadable; keep looking */
      }
    }
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue
    const found = descend(join(dir, e.name), name, depth - 1)
    if (found) return found
  }
  return undefined
}

/** The directory of the package that shipped `file`, or its own directory when there is none. */
function packageRoot(file: string): string {
  let dir = dirname(file)
  for (let up = 0; up < 4; up++) {
    try {
      statSync(join(dir, 'package.json'))
      return dir
    } catch {
      dir = dirname(dir)
    }
  }
  return dirname(file)
}

function bundleOf(command: string): { bytes: Buffer; at: string } | { why: string } {
  const on = findExecutable(command, { cwd: process.cwd() })
  if (!on) return { why: `${command} is not on PATH` }

  let real: string
  try {
    real = realpathSync(on)
  } catch (e) {
    return { why: `${on} could not be resolved: ${String(e)}` }
  }

  let at = real
  try {
    if (statSync(at).size < MIN_BUNDLE_BYTES) {
      const deeper = descend(packageRoot(real), command, 6)
      if (!deeper) return { why: `${real} is a shim and no bundle was found beneath its package` }
      at = deeper
    }
    return { bytes: readFileSync(at), at }
  } catch (e) {
    return { why: `${at} could not be read: ${String(e)}` }
  }
}

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
