/**
 * LIVE — the single-check acceptance contract, against a real replacement.
 *
 * Narrow on purpose. The rollback branch is already observed live; this asks one question:
 *
 *   with exactly one configured check, does a real replacement report exactly one
 *   `CHECK 1: exit <code>` line, and does that line say what the arbiter observed?
 *
 * It exists because the prompt used to answer that question wrongly. `acceptancePrompt`
 * rendered a fixed `CHECK 1` / `CHECK 2` example whatever the real check count, and given
 * one check two live replacements diverged: one refused to invent a second line and said
 * so, the other filled the template in — reporting a `CHECK 1` exit code the arbiter had
 * not observed alongside a `CHECK 2` that did not exist.
 *
 * That is a claim mismatch **manufactured by the orchestrator**. Had the repository not
 * diverged first in that run, the transaction would have refused a sound transfer and
 * recorded `replacement_could_not_reproduce` against the replacement. The example is now
 * generated from the actual checks, and this is the live evidence that the repair holds.
 *
 * The check is trivial and always passes: the subject is the reporting contract, not
 * verification. A rotation is driven only as far as acceptance and then abandoned.
 *
 *   ORCH_LIVE_CLAIM=1 node --test src/rotation/acceptanceClaim.live.test.ts
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { defaultRegistry } from '../registry/builtin.ts'
import { Relay } from '../relay/relay.ts'
import { acceptancePrompt, parseClaimedChecks } from './handoff.ts'

const skip =
  process.env.ORCH_LIVE_CLAIM === '1'
    ? false
    : 'set ORCH_LIVE_CLAIM=1 (spawns three real sessions, uses quota)'

test('one configured check yields exactly one claim, and it matches the arbiter', { skip }, async (t) => {
  const repo = join(import.meta.dirname, '..', '..')
  const work = join(repo, '.conclave', 'scratch-claim')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  t.after(() => rmSync(work, { recursive: true, force: true }))

  const CHECK = "sh -c 'true'"

  const relay = await Relay.start({
    registry: defaultRegistry(),
    cwd: repo,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 3,
    rotation: { checks: [CHECK], checkTimeoutMs: 60_000 },
  })
  t.after(() => relay.stop())

  const run = relay.start(
    `Work only inside ${work}. Create hello.txt containing one short line, then wait for ` +
      `the next instruction. Touch nothing outside that directory.`,
  )

  const armed = Date.now() + 420_000
  while (Date.now() < armed && !relay.log.some((m) => m.kind === 'report')) {
    await new Promise((r) => setTimeout(r, 250))
  }
  assert.ok(relay.log.some((m) => m.kind === 'report'), 'the implementer should have reported first')

  assert.ok(await run.requestPause('rotating to exercise the acceptance contract'))
  const result = await run.rotateImplementer('mechanism test: single-check reporting contract')

  console.log(`\n    [status] ${result.status}`)
  if (result.status === 'rolled_back') console.log(`    [reason] ${result.reason}: ${result.detail}`)

  const acceptance = result.acceptance
  assert.ok(acceptance, `no acceptance was reached: ${result.status === 'rolled_back' ? result.detail : ''}`)

  console.log(`    [claimed] ${JSON.stringify(acceptance.claimed)}`)
  console.log(`    [observed] ${JSON.stringify(acceptance.observed.checks.map((c) => ({ command: c.command, exitCode: c.exitCode })))}`)
  console.log(`    [prose]\n${acceptance.prose.split('\n').slice(0, 14).map((l) => `      ${l}`).join('\n')}`)

  // 1. Exactly one claim, for the one check that exists.
  assert.equal(acceptance.claimed.length, 1, `expected exactly one CHECK line, got ${JSON.stringify(acceptance.claimed)}`)
  assert.equal(acceptance.claimed[0]!.index, 1)

  // 2. No invented second check anywhere in the prose. The parser only reads well-formed
  //    lines, so a fabricated `CHECK 2` could otherwise pass unnoticed.
  assert.deepEqual(
    parseClaimedChecks(acceptance.prose).filter((c) => c.index !== 1),
    [],
    'the replacement must not report a check that was never declared',
  )

  // 3. The claim says what the arbiter observed — the property the whole comparison rests
  //    on, and the one the old template was corrupting.
  assert.equal(acceptance.observed.checks.length, 1)
  assert.equal(acceptance.claimed[0]!.exitCode, acceptance.observed.checks[0]!.exitCode)
  assert.deepEqual(acceptance.claimMismatches, [])

  // 4. And the transfer is accepted, with no invented or missing check standing in its way.
  assert.equal(result.status, 'rotated', 'a sound transfer must not be refused by the reporting contract')

  // The prompt itself, checked against what it asked for.
  const rendered = acceptancePrompt(result.handoff)
  assert.ok(rendered.includes('CHECK 1: exit <code>'))
  assert.ok(!rendered.includes('CHECK 2'), 'the example must not show a check that does not exist')

  await run.abort('scoped to the reporting contract; nothing further to drive')
})
