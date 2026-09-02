/**
 * Project-local configuration.
 *
 * Nothing outside a temp directory is touched and no CLI is spawned.
 *
 *   node --test src/config/project.test.ts
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DENIABLE_CAPABILITIES } from '../registry/operatorDenied.ts'
import {
  BYPASS_ARGS,
  BYPASS_NOTES,
  CONFIG_RELATIVE,
  denialsFrom,
  launchArgsFor,
  permissionModeFor,
  readProjectConfig,
  setPermissionMode,
} from './project.ts'

function projectWith(config: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-proj-'))
  if (config !== undefined) {
    mkdirSync(join(dir, '.conclave'), { recursive: true })
    writeFileSync(join(dir, CONFIG_RELATIVE), config)
  }
  return dir
}

test('a project with no config asks, which is each CLI\'s own default', () => {
  const config = readProjectConfig(projectWith(undefined))
  assert.deepEqual(config, {})
  assert.equal(permissionModeFor(config, 'claude'), 'ask')
  assert.deepEqual(launchArgsFor(config, 'codex'), [], 'and no flags are invented')
})

test('one setting covers both agents', () => {
  const config = readProjectConfig(projectWith('{"permissions":"bypass"}'))
  assert.deepEqual(launchArgsFor(config, 'claude'), ['--dangerously-skip-permissions'])
  assert.deepEqual(launchArgsFor(config, 'codex'), ['--dangerously-bypass-approvals-and-sandbox'])
})

test('a per-agent entry overrides the shared one, in both directions', () => {
  // The asymmetric case is the point: an implementer that may act freely inside a
  // repository, and an advisor that still asks before it runs anything.
  const config = readProjectConfig(
    projectWith('{"permissions":"bypass","agents":{"codex":{"permissions":"ask"}}}'),
  )
  assert.equal(permissionModeFor(config, 'claude'), 'bypass')
  assert.equal(permissionModeFor(config, 'codex'), 'ask')
  assert.deepEqual(launchArgsFor(config, 'codex'), [])

  const opposite = readProjectConfig(projectWith('{"agents":{"codex":{"permissions":"bypass"}}}'))
  assert.equal(permissionModeFor(opposite, 'claude'), 'ask')
  assert.deepEqual(launchArgsFor(opposite, 'codex'), BYPASS_ARGS.codex)
})

test('a malformed config fails loudly rather than quietly meaning "ask"', () => {
  // The failure this prevents is a silent one: a typo reinstates permission prompts, and
  // the operator meets it as a session that stops on every command with nothing saying
  // their configuration was ignored.
  assert.throws(() => readProjectConfig(projectWith('{ not json')), /not valid JSON/)
  assert.throws(() => readProjectConfig(projectWith('["bypass"]')), /must contain a JSON object/)
  assert.throws(
    () => readProjectConfig(projectWith('{"permissions":"bypasss"}')),
    /permissions must be "ask" or "bypass"/,
  )
  assert.throws(
    () => readProjectConfig(projectWith('{"agents":{"codex":{"permissions":true}}}')),
    /agents\.codex\.permissions must be "ask" or "bypass"/,
  )
  assert.throws(
    () => readProjectConfig(projectWith('{"agents":{"gemini":{"permissions":"bypass"}}}')),
    /unknown agent 'gemini'/,
  )
})

test('an agent with no known bypass flag gets none rather than a guess', () => {
  // The registry is open — a role can be filled by a CLI this file has never heard of.
  // Inventing a flag for it would at best be ignored and at worst mean something else.
  const config = readProjectConfig(projectWith('{"permissions":"bypass"}'))
  assert.equal(permissionModeFor(config, 'some-other-cli'), 'bypass')
  assert.deepEqual(launchArgsFor(config, 'some-other-cli'), [])
})

test('the flags are the ones the CLIs document, and none is undocumented', () => {
  // Pinned so a rename is caught here rather than by a session that silently starts
  // asking again. All three were read from the installed CLIs' own --help.
  assert.deepEqual(BYPASS_ARGS.claude, ['--dangerously-skip-permissions'])
  assert.deepEqual(BYPASS_ARGS.codex, ['--dangerously-bypass-approvals-and-sandbox'])
  assert.deepEqual(BYPASS_ARGS.opencode, ['--auto'])

  // The original form of this test required every flag to start with `--dangerously`, on
  // the reasoning that nothing here should look routine. OpenCode broke it -- `--auto`
  // does the same job under a name that reads like a convenience.
  //
  // Weakening the assertion to let it through would have thrown away the guard. Instead
  // the danger has to be recorded somewhere a reader will find it, and a flag that does
  // not announce itself must be quoted from the CLI that owns it.
  for (const [agent, args] of Object.entries(BYPASS_ARGS)) {
    const selfLabelling = args.every((a) => a.startsWith('--dangerously'))
    if (selfLabelling) continue
    const note = BYPASS_NOTES[agent]
    assert.ok(note, `${agent}'s flag does not announce itself, so its warning must be recorded`)
    assert.match(note, /dangerous/i, `${agent}: quote the CLI's own warning, not a paraphrase`)
  }
  // Every agent gets a note regardless, so the set cannot drift apart.
  assert.deepEqual(Object.keys(BYPASS_NOTES).sort(), Object.keys(BYPASS_ARGS).sort())
})

test('--bypass writes the mode and preserves everything else', () => {
  // Written rather than held for one run: an operator asking for this means "stop asking me
  // in this project", not "just this once". A flag that applied only to the current
  // invocation would be retyped every time and end up in a shell alias -- the same
  // persistence with none of the visibility.
  const root = projectWith('{"agents":{"codex":{"permissions":"ask"}}}')

  const { previous } = setPermissionMode(root, 'bypass')
  assert.equal(previous, undefined, 'nothing was set before')

  const after = readProjectConfig(root)
  assert.equal(after.permissions, 'bypass')
  // Merged, never replaced. Overwriting would silently discard a narrower policy the
  // operator had deliberately configured.
  assert.equal(after.agents!.codex!.permissions, 'ask')
})

test('a per-agent bypass does not disturb the project-wide setting', () => {
  const root = projectWith('{"permissions":"ask"}')
  setPermissionMode(root, 'bypass', 'claude')

  const after = readProjectConfig(root)
  assert.equal(after.permissions, 'ask', 'the project default is untouched')
  assert.equal(after.agents!.claude!.permissions, 'bypass')
  // And the resolution rule still holds: the narrower entry wins for that agent only.
  assert.equal(permissionModeFor(after, 'claude'), 'bypass')
  assert.equal(permissionModeFor(after, 'codex'), 'ask')
})

test('writing over a malformed file reports it rather than replacing it', () => {
  // A file that is already broken must be surfaced, not silently overwritten -- the operator
  // has something in there they meant, and a typo is not permission to discard it.
  const root = projectWith('{ not json')
  assert.throws(() => setPermissionMode(root, 'bypass'), /not valid JSON/)
})

test('the config directory is created when it does not exist yet', () => {
  const root = mkdtempSync(join(tmpdir(), 'conclave-bypass-'))
  setPermissionMode(root, 'bypass')
  assert.equal(readProjectConfig(root).permissions, 'bypass')
})

/*
 * DENY-ONLY PROJECT CONFIGURATION (#203).
 *
 * Two rules, and the tests below are them: absence is identity, and this file may narrow what
 * an adapter declares but never widen it. See `src/registry/operatorDenied.ts` for the argument.
 */

test('a project that denies nothing denies nothing, and says so as absence', () => {
  // `undefined` rather than a pair of empty arrays, because the front-ends spread this key in
  // only when it is present: a project with no maps hands `Relay.start` exactly the options it
  // handed before #203. An empty-array denial would behave the same and not BE the same.
  assert.equal(denialsFrom(readProjectConfig(projectWith(undefined))), undefined, 'no file at all')
  assert.equal(denialsFrom(readProjectConfig(projectWith('{}'))), undefined, 'a file with no maps')
  assert.equal(
    denialsFrom(readProjectConfig(projectWith('{"capabilities":{},"commands":{}}'))),
    undefined,
    'empty maps deny nothing, so they are the same as no maps',
  )
  const denied = denialsFrom(readProjectConfig(projectWith('{"capabilities":{"subagents":false},"commands":{"/compact":false}}')))
  assert.deepEqual(denied, { capabilities: ['subagents'], commands: ['/compact'] }, 'and a real denial is carried')
})

test('a map that names something nothing declares is refused at read', () => {
  // At startup, for the reason roles are: a run that begins with a denial nobody can honour is
  // a run whose operator believes a capability is withheld and it is not.
  assert.throws(
    () => readProjectConfig(projectWith('{"capabilities":{"subagants":false}}')),
    /capabilities\.subagants is not a capability anything declares/,
    'a misspelled capability names itself in the error',
  )
  assert.throws(
    () => readProjectConfig(projectWith('{"commands":{"/compcat":false}}')),
    /commands\.\/compcat is not a command anything declares/,
    'and so does a misspelled command',
  )
})

test('a map that is not a map of names is refused at read', () => {
  assert.throws(
    () => readProjectConfig(projectWith('{"capabilities":["subagents"]}')),
    /capabilities must be an object mapping capability names to false/,
  )
})

test('turning anything ON is refused, and a refused command is told why it is refused', () => {
  // The non-negotiable half. A capability is declared because someone read it off the installed
  // CLI; a command is allowed because someone argued it cannot break the run. Neither is a
  // preference this file may overrule, and an ACCEPTED-AND-IGNORED true would be worse than a
  // rejected one -- the operator would believe it took effect.
  assert.throws(
    () => readProjectConfig(projectWith('{"capabilities":{"subagents":true}}')),
    /may only NARROW what an adapter declares, never widen it/,
    'the rule is stated, not just the failure',
  )
  // And for a command refused for CORRECTNESS, the policy's own reason comes back with it.
  // `/clear` discards continuity and Codex's `/new` breaks the parser; an operator who tried to
  // re-enable either is asking a question this answers.
  assert.throws(
    () => readProjectConfig(projectWith('{"commands":{"/clear":true}}')),
    /Discards continuity/,
    '/clear carries the continuity reason from the policy',
  )
  assert.throws(
    () => readProjectConfig(projectWith('{"commands":{"/new":true}}')),
    /latches the transcript path/,
    '/new carries the parser reason from the policy',
  )
})

test('a value that is neither true nor false is refused as not-false', () => {
  // Distinct from the widening refusal on purpose: `"no"` is a typo and `true` is a belief
  // about what this file can do, and the two want different sentences.
  assert.throws(
    () => readProjectConfig(projectWith('{"commands":{"/compact":"no"}}')),
    /must be false, not "no"/,
  )
})

test('the README documents the deny-only maps, and names exactly the capabilities that exist', () => {
  // A config surface nobody can find is a config surface nobody uses, and a documented list of
  // names is the part that rots silently: a term added to `CAPABILITY_DESCRIPTORS` is deniable
  // the same day and stays undocumented until someone notices. Parsed rather than eyeballed, so
  // the README is checked against the table instead of against the last person to read both.
  const readme = readFileSync(join(import.meta.dirname, '..', '..', 'README.md'), 'utf8')
  const listed = /by its canonical name\s*\(([^)]*)\)/.exec(readme.replace(/\s+/g, ' '))
  assert.ok(listed, 'the README must list the capability names a project may deny')
  assert.deepEqual(
    listed[1]!.split(',').map((n) => n.trim().replace(/`/g, '')),
    [...DENIABLE_CAPABILITIES],
    'exactly the deniable capabilities, in the order the briefing renders them',
  )

  // And the rule, not just the syntax. An operator who knows the shape but not that it is
  // deny-only writes `true`, and finds out at startup rather than from the page they read.
  assert.match(
    readme,
    /Both are deny-only. The only value is `false`/,
    'the README states the rule that makes a `true` a startup error',
  )
})
