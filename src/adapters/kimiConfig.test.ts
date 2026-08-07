/**
 * Generating a Kimi config that carries Conclave's hooks without touching the user's.
 *
 *   node --test src/adapters/kimiConfig.test.ts
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  KIMI_HOOK_EVENTS,
  readKimiConfig,
  withConclaveHooks,
  writeKimiConfig,
} from './kimiConfig.ts'

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'kimi-cfg-'))
}

test('a TOML config is read through python tomllib', () => {
  // Node has no TOML parser, and `kimi-cli` requires Python >= 3.12, where `tomllib` is
  // standard library. A machine that can run Kimi can always parse Kimi's config.
  const d = dir()
  const path = join(d, 'config.toml')
  writeFileSync(
    path,
    'default_model = "k"\n\n[providers.moonshot]\ntype = "openai_legacy"\nbase_url = "https://x/v1"\napi_key = "sk-secret"\n\n[models.k]\nprovider = "moonshot"\nmodel = "kimi-k3"\nmax_context_size = 262144\n',
  )

  const c = readKimiConfig(path)
  assert.equal(c.default_model, 'k')
  assert.deepEqual(Object.keys(c.providers as object), ['moonshot'])
  assert.equal((c.models as Record<string, { max_context_size: number }>).k!.max_context_size, 262144)
})

test('a missing config is empty rather than an error', () => {
  // Kimi creates a default when none exists. A run failing only because the operator has not
  // written a config yet would be reporting the wrong problem.
  assert.deepEqual(readKimiConfig(join(dir(), 'absent.toml')), {})
})

test('the operator\'s own hooks are preserved, not replaced', () => {
  // Someone who registered their own Stop hook has a reason for it, and a generator that
  // silently dropped it would break something invisible from here.
  const merged = withConclaveHooks(
    { hooks: [{ event: 'Stop', command: 'mine', timeout: 5 }] },
    'node client.ts kimi',
  )
  const hooks = merged.hooks as { event: string; command: string }[]
  assert.equal(hooks[0]!.command, 'mine', 'theirs comes first and survives')
  assert.equal(hooks.length, 1 + KIMI_HOOK_EVENTS.length)
})

test('only the events something consumes are registered', () => {
  // Kimi offers thirteen. Registering one nothing reads costs a subprocess per occurrence
  // and buys a journal entry nobody looks at.
  assert.ok(KIMI_HOOK_EVENTS.includes('Stop'), 'the announced turn end')
  assert.ok(KIMI_HOOK_EVENTS.includes('PostToolUseFailure'), 'the one thing the stream cannot say')
  assert.ok(!(KIMI_HOOK_EVENTS as readonly string[]).includes('PreToolUse'), 'nothing consumes it')
  assert.ok(!(KIMI_HOOK_EVENTS as readonly string[]).includes('Notification'))
})

test('the generated config keeps the credential and is not world-readable', () => {
  // It is a copy of the operator's config, so it carries whatever key that carries. Conclave
  // does not ask for the key and does not transmit it, but it does briefly hold a copy.
  const d = dir()
  const path = writeKimiConfig(d, withConclaveHooks({ providers: { m: { api_key: 'sk-x' } } }, 'cmd'))

  const written = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(written.providers.m.api_key, 'sk-x', 'the run would not authenticate without it')
  assert.equal(statSync(path).mode & 0o077, 0, 'no group or other access')
})

test('a JSON config is read directly, since kimi accepts one', () => {
  const d = dir()
  const path = join(d, 'config.json')
  writeFileSync(path, JSON.stringify({ default_model: 'j' }))
  assert.equal(readKimiConfig(path).default_model, 'j')
})
