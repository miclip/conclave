/**
 * Generating a Kimi config that carries Conclave's hooks without touching the user's.
 *
 *   node --test src/adapters/kimiConfig.test.ts
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  KIMI_HOOK_EVENTS,
  readKimiConfig,
  withConclaveHooks,
  writeKimiConfig,
} from './kimiConfig.ts'
import { tempDir } from '../testkit/tempDir.ts'

const fixture = fileURLToPath(new URL('./kimiConfig.fixture.ts', import.meta.url))

/**
 * `readKimiConfig` in a child, with the child's two streams kept APART. #389's first defect is
 * a traceback on the process's own stderr, and merged into stdout it is indistinguishable from
 * the same traceback inside the thrown message -- which is the second defect.
 */
function readInChild(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): { stdout: string; stderr: string; outcome: { value?: unknown; name?: string; message?: string } } {
  const r = spawnSync(process.execPath, [fixture, path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env })
  assert.equal(r.status, 0, `the fixture itself failed: ${r.stderr}`)
  return { stdout: r.stdout, stderr: r.stderr, outcome: JSON.parse(r.stdout) }
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

const MALFORMED_TOML = 'this is = = not toml\n'
/**
 * What marks tomllib's reason line. Only the exception's name: its wording and the position
 * format are the installed python's to change, and pinning them would fail a correct function.
 */
const TOML_REASON = 'TOMLDecodeError'
const MALFORMED_JSON = '{ not json\n'
/** JSON.parse's own reason for MALFORMED_JSON, taken from this Node rather than written down. */
const JSON_REASON = (() => {
  try {
    JSON.parse(MALFORMED_JSON)
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('MALFORMED_JSON parsed')
})()

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

test('#389: a malformed TOML config writes nothing to the process\'s own stderr', (t) => {
  // The child's stderr was copied to conclave's, so python's traceback drew over the console.
  // Asserted on the stream itself, captured apart from stdout -- not on the thrown message.
  const path = join(tempDir(t, 'kimi-cfg'), 'config.toml')
  writeFileSync(path, MALFORMED_TOML)
  const { stderr, outcome } = readInChild(path)
  assert.ok(outcome.message, 'it still throws')
  assert.equal(stderr, '', 'nothing leaked to stderr')
})

test('#389: the operator sees the traceback at most once, and the reason exactly once', (t) => {
  // It was twice: once copied to stderr, once inside `err.message`, which the thrown string
  // interpolated whole. Counted across everything the operator would see. The reason line is
  // the control: a fix that dropped the child's output entirely would also count zero
  // tracebacks, and would leave the operator with no idea what is wrong with the file.
  const path = join(tempDir(t, 'kimi-cfg'), 'config.toml')
  writeFileSync(path, MALFORMED_TOML)
  const { stderr, outcome } = readInChild(path)
  const seen = stderr + (outcome.message ?? '')
  assert.ok(count(seen, 'Traceback (most recent call last)') <= 1, `tracebacks seen: ${count(seen, 'Traceback (most recent call last)')}`)
  assert.equal(count(seen, TOML_REASON), 1, 'the parser\'s reason, once')
  assert.match(outcome.message!, new RegExp(`could not read ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} as TOML`), 'names the file')
})

test('#389: a malformed JSON config names the file, the reason and a remedy', (t) => {
  // The .json branch threw JSON.parse's bare SyntaxError: no file, no remedy. It should read
  // as well as the TOML branch does -- an operator should not be able to tell which one failed
  // by how carefully the message was written.
  const path = join(tempDir(t, 'kimi-cfg'), 'config.json')
  writeFileSync(path, MALFORMED_JSON)
  const { stderr, outcome } = readInChild(path)
  assert.equal(stderr, '', 'nothing leaked to stderr')
  assert.ok(outcome.message, 'it throws')
  assert.notEqual(outcome.name, 'SyntaxError', 'not the parser\'s raw error')
  assert.ok(outcome.message.startsWith('kimi: '), 'prefixed like the TOML branch')
  assert.ok(outcome.message.includes(path), 'names the file')
  assert.match(outcome.message, / as JSON/, 'says what it was read as')
  assert.equal(count(outcome.message, JSON_REASON), 1, 'the parser\'s reason, once')
  assert.match(outcome.message, /\b(fix|repair|correct)\b/i, 'gives a remedy')
})

test('#389 controls: valid configs of both kinds return the same shape, missing ones {}', (t) => {
  // These keep the tests above from being satisfied by a function that fails everything.
  const d = tempDir(t, 'kimi-cfg')
  const expected = {
    default_model: 'k',
    providers: { moonshot: { type: 'openai_legacy', base_url: 'https://x/v1', api_key: 'sk-secret' } },
    models: { k: { provider: 'moonshot', model: 'kimi-k3', max_context_size: 262144 } },
  }
  const toml = join(d, 'config.toml')
  writeFileSync(
    toml,
    'default_model = "k"\n\n[providers.moonshot]\ntype = "openai_legacy"\nbase_url = "https://x/v1"\napi_key = "sk-secret"\n\n[models.k]\nprovider = "moonshot"\nmodel = "kimi-k3"\nmax_context_size = 262144\n',
  )
  const json = join(d, 'config.json')
  writeFileSync(json, JSON.stringify(expected))

  for (const path of [toml, json]) {
    const { stderr, outcome } = readInChild(path)
    assert.deepEqual(outcome, { value: expected }, `${path} parses to the same object`)
    assert.equal(stderr, '', `${path}: nothing on stderr`)
  }
  assert.deepEqual(readKimiConfig(join(d, 'absent.toml')), {})
  assert.deepEqual(readKimiConfig(join(d, 'absent.json')), {})
})

test('#389: the reader\'s own error is kept as `cause`, for both formats', (t) => {
  // The message carries one line of it; whoever needs the rest -- the child's stderr and its
  // exit status -- finds it here rather than in what the operator reads.
  const d = tempDir(t, 'kimi-cfg')
  const toml = join(d, 'config.toml')
  writeFileSync(toml, MALFORMED_TOML)
  const json = join(d, 'config.json')
  writeFileSync(json, MALFORMED_JSON)
  assert.throws(
    () => readKimiConfig(toml),
    (e: Error) => {
      const cause = e.cause as { stderr?: string; status?: number }
      return /TOMLDecodeError/.test(String(cause.stderr)) && cause.status === 1
    },
  )
  assert.throws(() => readKimiConfig(json), (e: Error) => e.cause instanceof SyntaxError)
})

test('#389: valid TOML that JSON cannot hold fails in the one shape, naming the value', (t) => {
  // `inf` is TOML and not JSON. Left to json.dump's default it became `Infinity`, python exited
  // 0, and node's JSON.parse threw a bare SyntaxError naming no file.
  const path = join(tempDir(t, 'kimi-cfg'), 'config.toml')
  writeFileSync(path, 'value = inf\n')
  const { stderr, outcome } = readInChild(path)
  assert.equal(stderr, '', 'nothing leaked to stderr')
  assert.equal(outcome.name, 'UnreadableKimiConfigError')
  assert.ok(outcome.message!.includes(`could not read ${path} as TOML`), 'names the file')
  assert.match(outcome.message!, /\(ValueError: [^)]*\binf\b/, 'the reason names the value')
  assert.match(outcome.message!, /pass a \.json config, which needs no Python/, 'the remedy is kept')
})

test('#389: the reason is the exception, not a note python printed after it', (t) => {
  // json.dump attaches a PEP 678 note to what it cannot serialize, and python prints notes
  // AFTER the exception line -- so "the last line of the traceback" was `when serializing dict
  // item 'd'`, which says nothing about what is wrong with it.
  const path = join(tempDir(t, 'kimi-cfg'), 'config.toml')
  writeFileSync(path, 'd = 1979-05-27T07:32:00Z\n')
  const { stderr, outcome } = readInChild(path)
  assert.equal(stderr, '')
  assert.match(outcome.message!, /as TOML \(TypeError: [^)]*datetime/, 'the exception itself comes first')
})

test('#389: a python3 that prints something other than JSON fails in the one shape', (t) => {
  // Unreachable with a real python running READ_TOML, which exits non-zero rather than write
  // what JSON cannot hold -- so it is staged with a python3 that is not one.
  const d = tempDir(t, 'kimi-cfg')
  const fake = join(d, 'python3')
  writeFileSync(fake, '#!/bin/sh\necho not-json\n')
  chmodSync(fake, 0o755)
  const path = join(d, 'config.toml')
  writeFileSync(path, 'a = 1\n')
  const { stderr, outcome } = readInChild(path, { ...process.env, PATH: `${d}:${process.env.PATH}` })
  assert.equal(stderr, '')
  assert.equal(outcome.name, 'UnreadableKimiConfigError')
  assert.ok(outcome.message!.includes(`could not read ${path} as TOML (python3 printed something that is not JSON: `))
})
