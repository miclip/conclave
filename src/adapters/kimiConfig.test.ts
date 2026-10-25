/**
 * Generating a Kimi config that carries Conclave's hooks without touching the user's.
 *
 *   node --test src/adapters/kimiConfig.test.ts
 */

import { strict as assert } from 'node:assert'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  KIMI_HOOK_EVENTS,
  readKimiConfig,
  withConclaveHooks,
  writeKimiConfig,
} from './kimiConfig.ts'
import { tempDir } from '../testkit/tempDir.ts'

test('a TOML config is read through python tomllib', (t) => {
  // Node has no TOML parser, so this needs a separate `python3` on PATH with `tomllib`
  // (3.11+). Kimi does not supply one: uv runs it on its own interpreter, off PATH.
  const d = tempDir(t, 'kimi-cfg')
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

test('an unreadable TOML config names the python3 it needs and the JSON way around it', (t) => {
  // The guidance must not send the operator to Kimi's own Python: uv keeps that off PATH.
  const d = tempDir(t, 'kimi-cfg')
  const path = join(d, 'config.toml')
  writeFileSync(path, 'this is = = not toml\n')
  assert.throws(
    () => readKimiConfig(path),
    (e: Error) => {
      assert.match(e.message, /could not read .* as TOML/)
      assert.match(e.message, /separate python3 on PATH that has tomllib \(Python 3\.11\+\)/)
      assert.match(e.message, /pass a \.json config, which needs no Python/)
      assert.ok(!/ships with the Python that kimi-cli/.test(e.message), 'the old rationale is gone')
      return true
    },
  )
})

test('a missing config is empty rather than an error', (t) => {
  // Kimi creates a default when none exists. A run failing only because the operator has not
  // written a config yet would be reporting the wrong problem.
  assert.deepEqual(readKimiConfig(join(tempDir(t, 'kimi-cfg'), 'absent.toml')), {})
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

test('the generated config keeps the credential and is not world-readable', (t) => {
  // It is a copy of the operator's config, so it carries whatever key that carries. Conclave
  // does not ask for the key and does not transmit it, but it does briefly hold a copy.
  const d = tempDir(t, 'kimi-cfg')
  const path = writeKimiConfig(d, withConclaveHooks({ providers: { m: { api_key: 'sk-x' } } }, 'cmd'))

  const written = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(written.providers.m.api_key, 'sk-x', 'the run would not authenticate without it')
  assert.equal(statSync(path).mode & 0o077, 0, 'no group or other access')
})

test('a JSON config is read directly, since kimi accepts one', (t) => {
  const d = tempDir(t, 'kimi-cfg')
  const path = join(d, 'config.json')
  writeFileSync(path, JSON.stringify({ default_model: 'j' }))
  assert.equal(readKimiConfig(path).default_model, 'j')
})
