/**
 * The hook timeout, and the diagnostic that exists because it can fire (#41).
 *
 *   node --test src/adapters/hookTimeout.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { hookTimeoutSeconds } from './hookTimeout.ts'

function withEnv(value: string | undefined, fn: () => void): void {
  const key = 'CONCLAVE_HOOK_TIMEOUT_S'
  const before = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    fn()
  } finally {
    if (before === undefined) delete process.env[key]
    else process.env[key] = before
  }
}

test('#41 the hook timeout defaults to 10 and can be raised for a loaded machine', () => {
  // Ten is generous for a POST to localhost and tight for a cold `node` start when every core
  // is pinned — observed to exceed it, at which point the CLI kills the handler before it runs.
  withEnv(undefined, () => assert.equal(hookTimeoutSeconds(), 10))
  withEnv('45', () => assert.equal(hookTimeoutSeconds(), 45))
})

test('#41 a malformed timeout falls back rather than stopping a session from starting', () => {
  // A bad env var must not be the reason a run cannot start, and 10 is what it would have been.
  for (const bad of ['', 'soon', '-5', '0', 'NaN']) {
    withEnv(bad, () => assert.equal(hookTimeoutSeconds(), 10, `${JSON.stringify(bad)} falls back`))
  }
})
