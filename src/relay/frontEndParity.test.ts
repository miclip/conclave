/**
 * The two front-ends must not quietly diverge.
 *
 * "A capability wired into one front-end and not the other" is the mistake this codebase has
 * now made eight times, and every one of them was found by somebody hitting it:
 *
 *   --advisor-args      an opencode participant with no model pinned does not fail, it HANGS
 *   --bypass            written into the project by one command and ignored by the other
 *   permission mode     read from .conclave/config.json only by the console
 *   the project config  same, in the other direction
 *   rotation summary    printed at the end of a run by one of them
 *   flag summary        same
 *   --operator agent    relay-only, so an agent could only reach the front-end that ENDS
 *                       the run at every pause -- while the flag claimed someone was
 *                       attending (found by an agent that hand-resumed four times)
 *   --record            documented on SessionOptions as the way to inspect a rendering
 *                       fault in the bytes, and reachable from no invocation at all
 *
 * A count that keeps going up is a process failure, not a run of bad luck. So the invariant
 * is inverted here: divergence is allowed, and it must be DECLARED. A flag that exists on one
 * command and not the other fails this test until someone writes down why, which is the step
 * that was missing every time.
 *
 *   node --test src/relay/frontEndParity.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { COMMANDS } from '../repl/session.ts'

const CLI = readFileSync(join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts'), 'utf8')

function commandBlock(name: string, endsBefore: string): string {
  const start = CLI.indexOf(`if (command === '${name}')`)
  const end = CLI.indexOf(endsBefore, start)
  assert.ok(start > 0 && end > start, `the ${name} command block must be locatable`)
  return CLI.slice(start, end)
}

/** Every `--flag` the block actually reads. Both spellings the CLI uses. */
function flagsIn(block: string): Set<string> {
  return new Set([
    ...[...block.matchAll(/flag\('([a-z-]+)'/g)].map((m) => m[1]!),
    ...[...block.matchAll(/includes\('--([a-z-]+)'\)/g)].map((m) => m[1]!),
  ])
}

/**
 * Divergence that is a decision rather than an oversight.
 *
 * Each entry is a claim someone made deliberately. Deleting a flag from here is how you
 * propose that the two front-ends should agree again; adding one is how you say they should
 * not, and the reason is the price of admission.
 */
const DECLARED: Record<string, string> = {
  // --- relay only -----------------------------------------------------------------------
  detach:
    'a console detached from its terminal has nothing left to be. The session record makes ' +
    'the WATCHING half unnecessary; driving a detached console is #4 and needs a decision ' +
    'about how input reaches it, not a flag.',
  'detached-id': 'internal: how a detached child adopts the id its parent already printed.',
  'dry-run':
    'relay resolves everything and starts nothing, which needs a point of no return to stop ' +
    'short of. The console has none -- it starts, then waits for a goal -- so the same flag ' +
    'would describe a plan it was already too late not to have made.',
  json:
    'the console IS the human surface; a --json console would be two renderings competing ' +
    'for one stdout. `conclave status --json` is the machine-readable view of a live ' +
    'console, and it carries more than a final report can.',
  'strict-goal':
    'deliberate and documented in `begin()`: a goal typed at the console was written by the ' +
    'person reading the warning, who can retype it in a second. Refusing costs more than it ' +
    'saves. Unattended there is nobody to retype it, so relay refuses.',
  'max-turns':
    'UNRESOLVED, and worth resolving now that `session --operator agent` exists: the ' +
    'console relied on a human noticing a run had gone long, and an agent-driven one has ' +
    'nobody watching. Declared rather than fixed because a ceiling that ENDS a console is ' +
    'not obviously what it should do -- pausing may be right, and that is a design call.',
  'max-minutes': 'as --max-turns.',
  force:
    'UNRESOLVED. relay refuses to start outside a git repository because attribution and ' +
    'rotation both diff the tree; the console does neither of those things at start-up but ' +
    'does run the same participants. Left declared rather than silently different.',
  // --- session only ---------------------------------------------------------------------
  'turn-timeout':
    'UNRESOLVED in the other direction: `turnWatchdogMs` exists on RelayOptions and only the ' +
    'console passes it, so an unattended run cannot shorten the watchdog that decides when a ' +
    'silent turn is dead. #36 is about exactly that deadline.',
}

test('every flag one front-end takes and the other does not is declared', () => {
  const relay = flagsIn(commandBlock('relay', "if (command === 'session')"))
  const session = flagsIn(commandBlock('session', "if (command === 'demo')"))

  const only = [
    ...[...relay].filter((f) => !session.has(f)).map((f) => [f, 'relay'] as const),
    ...[...session].filter((f) => !relay.has(f)).map((f) => [f, 'session'] as const),
  ]

  const undeclared = only.filter(([f]) => !(f in DECLARED))
  assert.deepEqual(
    undeclared.map(([f, where]) => `--${f} (${where} only)`),
    [],
    'a capability on one front-end and not the other must be a decision someone wrote down. ' +
      'Either wire it into both, or add it to DECLARED with the reason.',
  )

  // The list must not outlive its subject either. A stale exemption is a claim nobody is
  // checking, and it would silently re-permit the divergence it was written to explain.
  const live = new Set(only.map(([f]) => f))
  const stale = Object.keys(DECLARED).filter((f) => !live.has(f))
  assert.deepEqual(stale, [], 'these flags no longer diverge; remove them from DECLARED')
})

test('both front-ends read the project config, and both can write the bypass', () => {
  // Two of the eight, and the pair that shows the shape best: `.conclave/config.json` is a
  // property of the PROJECT rather than of which command opened it, so reading it in one
  // place meant an unattended run ignored the permission mode its operator had configured --
  // and an unattended run is the one with nobody to answer the prompt it then stopped at.
  const relay = commandBlock('relay', "if (command === 'session')")
  const session = commandBlock('session', "if (command === 'demo')")
  for (const [name, block] of [['relay', relay], ['session', session]] as const) {
    assert.match(block, /applyBypassFlag/, `${name} must be able to apply --bypass`)
  }
  // The console reads it inside runSession rather than in the CLI block, which is why this
  // asserts on the module instead of the block.
  const consoleSrc = readFileSync(
    join(import.meta.dirname, '..', 'repl', 'session.ts'),
    'utf8',
  )
  assert.match(consoleSrc, /readProjectConfig/, 'the console must read the project config')
  assert.match(relay, /readProjectConfig/, 'and so must relay')
})

test('both front-ends record a readable session', () => {
  // #26. A run an operator cannot inspect from outside is the same defect whichever command
  // started it, and the console is the one most likely to be left running in another window.
  const relay = commandBlock('relay', "if (command === 'session')")
  const consoleSrc = readFileSync(join(import.meta.dirname, '..', 'repl', 'session.ts'), 'utf8')
  assert.match(relay, /recordSession\(/, 'relay must record its session')
  assert.match(consoleSrc, /recordSession\(/, 'and so must the console')
})

/**
 * The agent-facing section of `--help`, checked against the code it describes.
 *
 * An agent arriving cold reads `--help` and gets a command reference written for someone
 * who already knows the shape of the thing. It then GUESSES: it picks `relay` because the
 * name sounds unattended, discovers that every pause ends the run, and hand-reconstructs
 * state on each retry. That happened, four times, to a real caller.
 *
 * So the instructions exist — and a set of instructions that drifts from the code is worse
 * than none, because it is believed. Every command the section names is asserted to exist:
 * the slash commands against the console's own list, the subcommands against the dispatch.
 */
test('the agent instructions name only things that exist', () => {
  const cli = readFileSync(join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts'), 'utf8')
  const start = cli.indexOf('Driving conclave from an agent')
  const end = cli.indexOf('\nCommands:', start)
  assert.ok(start > 0 && end > start, 'the agent section must be present in USAGE')
  const section = cli.slice(start, end)

  // The one thing it exists to say. An agent that picks `relay` for an attended run loses
  // its state at the first pause.
  assert.match(section, /Use "session", not "relay"/)

  // Every slash command it lists must be one the console actually accepts.
  const documented = [...section.matchAll(/\/[a-z]+/g)].map((m) => m[0])
  assert.ok(documented.length >= 6, 'the section must list the slash commands')
  for (const cmd of new Set(documented)) {
    assert.ok(COMMANDS.includes(cmd), `--help documents ${cmd}, which the console does not accept`)
  }

  // ...and every subcommand it points at must be dispatched.
  for (const sub of ['status', 'events', 'sessions']) {
    assert.match(section, new RegExp(`conclave ${sub}`), `the section must point at ${sub}`)
    assert.match(cli, new RegExp(`command === '${sub}'`), `${sub} must actually be a command`)
  }

  // The distinction a poller gets wrong, and the reason `abandoned` exists at all.
  assert.match(section, /alive false is a crashed run/)
})

test('both front-ends get Codex to trust the hooks they register', () => {
  // Registration is not enough -- Codex silently executes nothing in a directory it does not
  // trust -- and `relay` registered the sidecar, never trusted it, and never even checked.
  // The front-end designed to run WITHOUT a human was the one missing the step that removes
  // the need for one, so an unattended first run in a fresh project ended `transport_failed`
  // at turn one. Ninth instance.
  const relay = commandBlock('relay', "if (command === 'session')")
  const consoleSrc = readFileSync(join(import.meta.dirname, '..', 'repl', 'session.ts'), 'utf8')
  assert.match(relay, /ensureCodexHooksTrusted\(/, 'relay must ensure Codex trust')
  assert.match(consoleSrc, /ensureCodexHooksTrusted\(/, 'and so must the console')
})

test('version reports the commit when run from a checkout', () => {
  // `package.json` is bumped once per release, so a checkout thirteen commits past a tag
  // reported the tag. Two projects filed bugs against builds described as `0.2.7`; one
  // supplied the commit by hand because the tool would not. A symlink on PATH pointing into
  // a working tree is the normal way to run this while developing it, so that state is not
  // exotic — it is how its own authors use it.
  const out = execFileSync(
    process.execPath,
    [join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts'), 'version'],
    { encoding: 'utf8' },
  ).trim()
  assert.match(out, /^\d+\.\d+\.\d+ \([0-9a-f]{7,}(-dirty)?\)$/, `saw: ${out}`)
})
