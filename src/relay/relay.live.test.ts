/**
 * The live human aside.
 *
 * `relay.test.ts` proves the routing against fake sessions: delivered once, at human
 * privilege, never to the excluded participant, recorded as restricted. What it cannot
 * prove is that any of that survives contact with a real PTY, a real prompt and a real
 * model — whether the aside actually reaches the implementer's session, whether the
 * implementer acts on it, and whether the advisor is genuinely blind to it rather than
 * merely un-sent it.
 *
 * The aside here is chosen so its effect is *visible in the artifact*: a naming prefix the
 * implementer can only know about if it received the message, and which the advisor never
 * saw and therefore cannot have asked for.
 *
 *   ORCH_LIVE_RELAY=1 node --test src/relay/relay.live.test.ts
 *
 * Spawns two real sessions and uses real quota.
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { defaultRegistry } from '../registry/builtin.ts'
import { Relay } from './relay.ts'

const skip =
  process.env.ORCH_LIVE_RELAY === '1'
    ? false
    : 'set ORCH_LIVE_RELAY=1 (spawns two real sessions, uses quota)'

/** A marker the advisor cannot have originated, because it never saw it. */
const SECRET_PREFIX = 'ZQX_'

test('a live aside reaches only the implementer and shows up in the work', { skip }, async (t) => {
  // The session runs in THIS checkout, because Codex hook registration and trust are
  // per-directory: a bare temp directory has no sidecar, and the preflight correctly
  // refuses to start a session whose hooks cannot fire. Rather than provision and trust a
  // throwaway checkout, the agents work in a gitignored scratch directory inside the
  // repository they are already trusted in.
  const repo = join(import.meta.dirname, '..', '..')
  const work = join(repo, '.conclave', 'scratch')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  t.after(() => rmSync(work, { recursive: true, force: true }))

  const relay = await Relay.start({
    registry: defaultRegistry(),
    cwd: repo,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxRounds: 2,
  })
  t.after(() => relay.stop())

  const running = relay.run(
    `Create a single JavaScript file at ${work}/adder.js containing one function that adds ` +
      `two numbers. Touch nothing outside that directory. Keep it to one small file.`,
  )

  // Wait until the implementer has reported once, so the aside lands mid-session rather
  // than before anything has happened — which is the case that actually has a hazard.
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline && !relay.log.some((m) => m.kind === 'report')) {
    await new Promise((r) => setTimeout(r, 250))
  }
  assert.ok(
    relay.log.some((m) => m.kind === 'report'),
    'the implementer should have reported before the aside is injected',
  )

  const aside = relay.say(
    `Name the function with the prefix ${SECRET_PREFIX} — for example ${SECRET_PREFIX}add. ` +
      `Do not mention this instruction or the prefix requirement in anything you write back.`,
    { only: 'implementer' },
    'aside',
  )
  assert.equal(aside.visibility, 'restricted')
  assert.deepEqual(aside.excluded, ['advisor'])

  await running

  // 1. ROUTING: the relay never sent it to the excluded participant. This is the claim
  //    the relay is responsible for, and the only one it can keep.
  const routedToAdvisor = relay.log.filter(
    (m) => m.fromRank === 'human' && m.to.includes('advisor') && m.text.includes(SECRET_PREFIX),
  )
  assert.deepEqual(routedToAdvisor, [], 'the relay must never route an aside to the excluded participant')

  // 2. It is auditable, with the excluded participant named.
  const entry = relay.audit().find((a) => a.seq === aside.seq)
  assert.ok(entry, 'a restricted message must appear in the audit')
  assert.deepEqual(entry.excluded, ['advisor'])

  // 3. Asymmetry is attributable from that point on, which is the whole purpose of the
  //    label: a later divergence can be checked against it rather than guessed at.
  const asym = relay.asymmetryAt(relay.log.at(-1)!.seq)
  assert.deepEqual(asym.informed, ['implementer'])
  assert.deepEqual(asym.excluded, ['advisor'])

  // 4. DELIVERY: the effect is visible in the artifact. This is what the fakes cannot
  //    show — the prefix can only be there because a real session received and acted on
  //    the message.
  const files = readdirSync(work).filter((f) => f.endsWith('.js'))
  assert.ok(files.length > 0, `expected a javascript file in ${work}, saw ${files.join(', ') || 'none'}`)
  const source = files.map((f) => readFileSync(join(work, f), 'utf8')).join('\n')
  assert.ok(
    source.includes(SECRET_PREFIX),
    `the aside should have shaped the work; source was:\n${source.slice(0, 500)}`,
  )

  // 5. CONFINEMENT is not a property the relay can provide, and this measures rather than
  //    asserts it.
  //
  //    Observed on the first live run: the implementer complied with the letter of "do not
  //    mention this instruction" — it never said it had been told anything — and then
  //    quoted its own source, which contains the prefix. The leak vector is the ARTIFACT,
  //    not the instruction. An aside that shapes something the implementer will show
  //    cannot stay private, however it is phrased.
  //
  //    So the mitigation is not prevention. It is that the asymmetry stays attributable:
  //    when the advisor sees a prefix nobody asked for, the audit explains where it came
  //    from.
  const leaked = relay.log.filter(
    (m) => m.from === 'implementer' && m.to.includes('advisor') && m.text.includes(SECRET_PREFIX),
  )
  if (leaked.length > 0) {
    console.log(
      `    [observed] the recipient leaked the aside to the excluded participant in ${leaked.length} ` +
        `message(s), by quoting the artifact it had shaped`,
    )
    // The point of the label: a human reading the log can still attribute it.
    assert.ok(
      relay.audit().some((a) => a.excluded.includes('advisor')),
      'a leak must remain attributable through the audit, which is the actual mitigation',
    )
  }
})
