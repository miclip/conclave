/**
 * Deciding between the two ways to trust a project.
 *
 *   node --test src/deployment/ensureTrust.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { ensureCodexHooksTrusted, type TrustDeps } from './ensureTrust.ts'

const NOT_READY = { codex: { ready: false, messages: ['codex loaded no hooks'] } } as never
const READY = { codex: { ready: true, messages: [] } } as never

function deps(over: Partial<TrustDeps> = {}): { d: Partial<TrustDeps>; calls: string[] } {
  const calls: string[] = []
  const d: Partial<TrustDeps> = {
    diagnose: async () => {
      calls.push('diagnose')
      return NOT_READY
    },
    trust: async () => {
      calls.push('trust')
      return { prompted: true, askedAboutDirectory: true, launches: 2 }
    },
    recorded: () => 'trusted',
    seed: async () => {
      calls.push('seed')
      return { added: ['[projects."x"]'], ready: true }
    },
    waitExecutable: async () => {
      calls.push('wait')
      return true
    },
    ...over,
  }
  return { d, calls }
}

test('a directory Codex recorded as untrusted is seeded rather than refused', async () => {
  // The failure another project reported: the flow meant to trust a directory finished with
  // `trust_level = "untrusted"` on disk, then refused to start. Refusing was correct given
  // what it knew — but the operator opted into trusting this directory by asking for a
  // session in it, and a run that will not start is the worse outcome.
  const said: string[] = []
  const { d, calls } = deps({ recorded: () => 'untrusted' })
  const r = await ensureCodexHooksTrusted({
    projectRoot: '/p',
    agents: ['codex'],
    say: (l) => said.push(l),
    deps: d,
  })
  assert.equal(r.ready, true)
  assert.ok(calls.includes('seed'), 'the direct path must run when the TUI left it untrusted')
  assert.ok(
    said.some((l) => /recorded this directory as untrusted/.test(l)),
    `it must say what Codex actually recorded:\n${said.join('\n')}`,
  )
})

test('a directory the prompts did trust is left alone', async () => {
  // The fallback writes the operator's global config, so it must not fire on the happy path.
  const { d, calls } = deps()
  const r = await ensureCodexHooksTrusted({ projectRoot: '/p', agents: ['codex'], say: () => {}, deps: d })
  assert.equal(r.ready, true)
  assert.ok(!calls.includes('seed'), 'nothing to fix, so nothing may be written')
})

test('nothing is spawned when the hooks already run', async () => {
  // A ready project costs one silent probe. Spawning a Codex to trust what is already
  // trusted would put a minute of TUI driving in front of every session.
  const { d, calls } = deps()
  // Overridden AFTER construction so it still records the call; replacing it in `deps()`
  // dropped the recording and the assertion below then passed against an empty array for
  // the wrong reason.
  d.diagnose = async () => {
    calls.push('diagnose')
    return READY
  }
  const r = await ensureCodexHooksTrusted({ projectRoot: '/p', agents: ['codex'], say: () => {}, deps: d })
  assert.deepEqual(r, { attempted: false, ready: true })
  assert.deepEqual(calls, ['diagnose'])
})

test('when neither path works, the message names the flag that does', async () => {
  // `--trust` records the entries directly and was never mentioned; the failure text sent
  // people to hand-edit TOML, which is harder and the thing they are least equipped to get
  // right. Reported by a project that had to be told the flag existed.
  const said: string[] = []
  const { d } = deps({
    recorded: () => 'untrusted',
    seed: async () => ({ added: [], ready: false }),
    waitExecutable: async () => false,
  })
  const r = await ensureCodexHooksTrusted({
    projectRoot: '/p',
    agents: ['codex'],
    say: (l) => said.push(l),
    deps: d,
  })
  assert.equal(r.ready, false)
  assert.ok(
    said.some((l) => /config install --trust/.test(l)),
    `the one command that fixes this must be named:\n${said.join('\n')}`,
  )
})
