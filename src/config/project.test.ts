/**
 * Project-local configuration.
 *
 * Nothing outside a temp directory is touched and no CLI is spawned.
 *
 *   node --test src/config/project.test.ts
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  BYPASS_ARGS,
  CONFIG_RELATIVE,
  launchArgsFor,
  permissionModeFor,
  readProjectConfig,
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

test('the flags are the ones the CLIs document, and are marked dangerous by both', () => {
  // Pinned so a rename is caught here rather than by a session that silently starts
  // asking again. Both were read from the installed CLIs' own --help.
  assert.deepEqual(BYPASS_ARGS.claude, ['--dangerously-skip-permissions'])
  assert.deepEqual(BYPASS_ARGS.codex, ['--dangerously-bypass-approvals-and-sandbox'])
  for (const args of Object.values(BYPASS_ARGS)) {
    assert.ok(args.every((a) => a.startsWith('--dangerously')), 'nothing here should look routine')
  }
})
