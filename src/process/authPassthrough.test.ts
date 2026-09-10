/**
 * A credential reaches the child; a session marker does not (#268).
 *
 * The invariant in `childenv.ts` is about SESSION MARKERS -- `CLAUDE_CODE_CHILD_SESSION` above
 * all, which silently disables transcript persistence in the mode this adapter drives. The
 * prefix test that enforces it cannot tell a marker from a credential, and
 * `CLAUDE_CODE_OAUTH_TOKEN` starts with `CLAUDE`.
 *
 * Invisible on a workstation, where the CLI falls back to keychain credentials. Fatal on a CI
 * runner, which has no keychain: the seat comes up at a login prompt and spends the whole turn
 * there.
 */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

import { AUTH_PASSTHROUGH, isParentAgentVar, sanitizedCopy } from './childenv.ts'

test('#268 a credential survives sanitising and the session marker still does not', () => {
  const env = {
    CLAUDE_CODE_OAUTH_TOKEN: 'tok',
    ANTHROPIC_API_KEY: 'key',
    ANTHROPIC_AUTH_TOKEN: 'auth',
    ANTHROPIC_BASE_URL: 'https://gateway.example',
    // THE ONE WITH TEETH. If this ever passes, transcript persistence goes silently and the
    // adapter loses its recovery and audit path -- which is the reason the boundary exists.
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    ANTHROPIC_MODEL: 'something',
    PATH: '/usr/bin',
  }
  const out = sanitizedCopy(env)

  assert.equal(out['CLAUDE_CODE_OAUTH_TOKEN'], 'tok', 'the token a CI runner authenticates with')
  assert.equal(out['ANTHROPIC_API_KEY'], 'key')
  assert.equal(out['ANTHROPIC_AUTH_TOKEN'], 'auth')
  assert.equal(out['ANTHROPIC_BASE_URL'], 'https://gateway.example', 'where the credential is valid')

  assert.equal('CLAUDE_CODE_CHILD_SESSION' in out, false, 'the marker must never pass')
  assert.equal('CLAUDE_CODE_ENTRYPOINT' in out, false, 'nor any other parent session state')
  assert.equal('ANTHROPIC_MODEL' in out, false, 'the allowlist is exact, not a prefix')
  assert.equal(out['PATH'], '/usr/bin', 'and ordinary variables are untouched')
})

test('#268 the allowlist is exact, so it cannot widen into the prefix it sits in front of', () => {
  // A prefix here would re-open the hole in the other direction: `CLAUDE_CODE_` covers the
  // session marker as readily as the token.
  assert.equal(isParentAgentVar('CLAUDE_CODE_OAUTH_TOKEN'), false)
  assert.equal(isParentAgentVar('CLAUDE_CODE_OAUTH_TOKEN_2'), true, 'a near miss is still stripped')
  // Not the mirror of the line above, and worth being explicit about: a name that merely
  // CONTAINS the token's is nobody's business here, because the prefix test is anchored at the
  // start. It passes through as any unrelated variable does, and it would have done so before
  // this change too.
  assert.equal(isParentAgentVar('XCLAUDE_CODE_OAUTH_TOKEN'), false, 'unrelated, and never was ours')
  assert.equal(isParentAgentVar('CLAUDE_CODE_CHILD_SESSION'), true)
})

test('#268 every allowlisted name is one the installed CLI actually reads', () => {
  // The house rule about claims made of another program: check it against the binary rather
  // than restating it. An allowlist is a hole in a security boundary, so a name that nothing
  // reads is a hole kept open for nobody.
  //
  // Skipped rather than failed where the binary cannot be read -- a CI runner without the CLI
  // installed must not turn this into a red suite, and saying so is better than a test that
  // quietly asserts nothing.
  let bundle: string
  try {
    const bin = execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim()
    if (!bin) return
    bundle = execFileSync('sh', ['-c', `strings -a "$(readlink -f ${bin} || echo ${bin})" 2>/dev/null || true`], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    })
  } catch {
    return
  }
  if (bundle.length === 0) return

  for (const name of AUTH_PASSTHROUGH) {
    assert.ok(bundle.includes(name), `${name} is allowlisted but the installed CLI never mentions it`)
  }
})
