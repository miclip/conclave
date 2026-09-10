/**
 * The readiness window is reachable, and the failure that mentions it says something true (#271).
 *
 * The message told an operator to "raise readyTimeoutMs" and nothing set it -- no flag, no env
 * var, no config key. It also opened with "the hooks may not be registered", which sent a CI
 * operator to `conclave config check`; the hooks WERE registered and the check said so, which
 * made conclave look at fault for the CLI's own first-run state.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'

import { bootFailureMessage } from './claude.ts'

const REPO = fileURLToPath(new URL('../..', import.meta.url))

test('#271 a seat that is alive and silent is not reported as a registration problem', () => {
  const m = bootFailureMessage({ screen: 'Welcome to Claude Code', cwd: '/w', alive: true })

  assert.match(m, /started and stayed alive but never reported SessionStart/)
  assert.match(m, /NOT necessarily a registration problem/, 'the old message asserted the opposite')
  assert.match(m, /onboarding/, 'and names the cause a cold runner actually hits')
  assert.match(m, /--ready-timeout/, 'pointing at a flag that exists')
  assert.doesNotMatch(m, /readyTimeoutMs/, 'not at an internal field nobody can set')
})

test('#271 the message carries what the terminal showed, because that is the evidence', () => {
  // The trust-dialog branches win where they match, so anything reaching here is unrecognised
  // by construction: the screen is the only thing that knows why.
  const m = bootFailureMessage({
    screen: 'line one\n\n  Do you want to continue?  \nlast visible line',
    cwd: '/w',
    alive: true,
  })
  assert.match(m, /Its terminal last showed/)
  assert.match(m, /last visible line/, 'the tail, so an operator sees what the seat was doing')
  assert.doesNotMatch(m, /"\s*"/, 'blank lines are dropped rather than quoted as evidence')
})

test('#271 a seat that showed nothing at all says so, rather than quoting emptiness', () => {
  const m = bootFailureMessage({ screen: '   \n\n  ', cwd: '/w', alive: true })
  assert.match(m, /showed nothing at all, which is itself the symptom/)
})

test('#271 a dead seat keeps its own diagnosis', () => {
  // The alive/dead split predates this and is the more informative distinction; widening the
  // new message over it would have lost that.
  const m = bootFailureMessage({ screen: 'anything', cwd: '/w', alive: false })
  assert.match(m, /exited before reporting SessionStart/)
})

test('#271 --ready-timeout is a declared flag on both front-ends, not just documented', () => {
  // A flag named only in help text is refused as unknown at parse time, which is a worse
  // failure than the one this replaces: the operator does what the message says and is told
  // the option does not exist.
  const cli = readFileSync(join(REPO, 'bin/conclave.ts'), 'utf8')
  assert.match(cli, /'ready-timeout',/, 'declared among the valued flags')
  assert.ok(
    cli.includes("flag('ready-timeout', '')"),
    'and read somewhere, so declaring it is not the whole of it',
  )
})
