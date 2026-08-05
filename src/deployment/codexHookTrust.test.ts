/**
 * Codex hook-trust invalidation — a configuration/deployment invariant.
 *
 * This costs no model tokens (everything goes through `hooks/list` and the boot-time
 * trust prompt), so it can run while the account is rate-limited. It does mutate real
 * state: the project's `.codex/hooks.json` and the USER-level `~/.codex/config.toml`,
 * where Codex persists trust decisions. Both are snapshotted byte-for-byte and restored,
 * with the restoration asserted.
 *
 * Nothing here is lifecycle evidence. It must not change any turn-outcome grade -- a
 * trusted hook is not evidence that a turn completed. There is a test at the bottom
 * asserting that separation holds.
 *
 *   ORCH_CODEX=1 node --test src/deployment/codexHookTrust.test.ts
 */

import { strict as assert } from 'node:assert'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { diagnoseHookTrust, readCodexHooks, trustCodexHooks } from './codexHookTrust.ts'
import type { CodexHookReport } from './codexHookTrust.ts'
import { CODEX_CAPABILITIES } from '../conformance/capabilities.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const HOOKS_JSON = join(ROOT, '.codex', 'hooks.json')
const CODEX_CONFIG = join(homedir(), '.codex', 'config.toml')
const MATCH = 'hook_post.py'

const skip = process.env.ORCH_CODEX === '1' ? false : 'set ORCH_CODEX=1 (mutates ~/.codex/config.toml, then restores it)'

const status = (r: CodexHookReport, event = 'sessionStart') =>
  r.hooks.find((h) => h.eventName === event && h.command?.includes(MATCH))

function trustedHashes(): Record<string, string> {
  const out: Record<string, string> = {}
  let key = ''
  for (const line of readFileSync(CODEX_CONFIG, 'utf8').split('\n')) {
    const header = line.match(/^\[hooks\.state\."(.+)"\]\s*$/)
    if (header) key = header[1]!
    const hash = line.match(/^trusted_hash\s*=\s*"(.+)"\s*$/)
    if (hash && key) out[key] = hash[1]!
  }
  return out
}

test('hook trust is content-based, invalidates on edit, and survives a byte-exact revert', { skip }, async (t) => {
  // Snapshot BEFORE anything. Restoration is asserted, not assumed.
  const originalHooks = readFileSync(HOOKS_JSON)
  const originalConfig = readFileSync(CODEX_CONFIG)

  t.after(() => {
    writeFileSync(HOOKS_JSON, originalHooks)
    writeFileSync(CODEX_CONFIG, originalConfig)
    assert.ok(readFileSync(HOOKS_JSON).equals(originalHooks), '.codex/hooks.json not restored')
    assert.ok(readFileSync(CODEX_CONFIG).equals(originalConfig), '~/.codex/config.toml not restored')
  })

  // 1. Baseline: the trusted file reports trusted.
  const baseline = await readCodexHooks(ROOT)
  const before = status(baseline)
  assert.ok(before, 'expected our sessionStart hook to be loaded')
  assert.equal(before.trustStatus, 'trusted', 'baseline must start from a trusted state')
  assert.deepEqual(
    { loaded: before.loaded, enabled: before.enabled, trusted: before.trusted, executable: before.executable },
    { loaded: true, enabled: true, trusted: true, executable: true },
  )
  assert.equal(diagnoseHookTrust(baseline, MATCH).ready, true)

  const baselineHashes = trustedHashes()
  const hashKeys = Object.keys(baselineHashes).filter((k) => k.includes('coding-repl'))
  assert.ok(hashKeys.length >= 2, 'expected trusted_hash entries for this project')

  // 2. A content edit invalidates trust. This is the security-relevant case: the command
  //    that will be executed changed, so the prior decision cannot carry over.
  const parsed = JSON.parse(originalHooks.toString('utf8'))
  const edited = structuredClone(parsed)
  edited.hooks.SessionStart[0].hooks[0].command += ' --edited'
  writeFileSync(HOOKS_JSON, JSON.stringify(edited, null, 2) + '\n')

  const afterEdit = await readCodexHooks(ROOT)
  const edit = status(afterEdit)
  assert.ok(edit, 'the hook should still be loaded, just not trusted')
  assert.notEqual(edit.trustStatus, 'trusted', 'a changed command must invalidate trust')
  assert.ok(
    edit.trustStatus === 'modified' || edit.trustStatus === 'untrusted',
    `expected modified/untrusted, got ${edit.trustStatus}`,
  )
  // THE distinction. `enabled` says nothing about permission to execute: Codex reports
  // this hook as loaded and enabled, and will never run it. Collapsing the two is how
  // the original silent failure would reappear behind a nicer UI.
  assert.deepEqual(
    { loaded: edit.loaded, enabled: edit.enabled, trusted: edit.trusted, executable: edit.executable },
    { loaded: true, enabled: true, trusted: false, executable: false },
  )
  const diagnosis = diagnoseHookTrust(afterEdit, MATCH)
  assert.equal(diagnosis.ready, false)
  assert.ok(diagnosis.messages.some((m) => m.includes('will NOT run')))
  // The message must state all four, so a summary cannot quietly drop the one that matters.
  assert.ok(diagnosis.messages.some((m) => m.includes('enabled=true') && m.includes('executable=false')))

  console.log(`    [observed] edited command -> trustStatus=${edit.trustStatus}`)

  // 3. Reverting byte-for-byte restores the original hash behaviour, with no re-trust.
  writeFileSync(HOOKS_JSON, originalHooks)
  const afterRevert = await readCodexHooks(ROOT)
  const revert = status(afterRevert)
  assert.equal(revert?.trustStatus, 'trusted', 'a byte-exact revert must restore trust')
  assert.equal(revert?.currentHash, before.currentHash, 'the content hash must be identical')
  assert.equal(diagnoseHookTrust(afterRevert, MATCH).ready, true)

  // 4. Whitespace-only reformat: same parsed content, different file bytes.
  //
  //    Measured on codex 0.146.0: trust SURVIVES and currentHash is unchanged. The hash
  //    therefore covers the normalised handler -- command, type, async, timeout -- not
  //    the raw file. (JSON has no comments, so the comment half of the question is moot
  //    for the sidecar format; an inline [hooks] table in config.toml could differ.)
  //
  //    This matters both ways. Reformatting hooks.json will not re-prompt, so a
  //    formatter in CI is harmless. But it also means trust is scoped to the handler,
  //    not the file: changing `description` or adding an unrelated event does not
  //    re-validate handlers that did not themselves change.
  writeFileSync(HOOKS_JSON, JSON.stringify(parsed, null, 8) + '\n')
  const afterWhitespace = await readCodexHooks(ROOT)
  const ws = status(afterWhitespace)
  assert.ok(ws, 'the reformatted file must still parse and load')
  assert.equal(ws.trustStatus, 'trusted', 'whitespace-only changes must not invalidate trust')
  assert.equal(ws.currentHash, before.currentHash, 'the hash covers the handler, not the file bytes')
  assert.equal(ws.executable, true)

  writeFileSync(HOOKS_JSON, originalHooks)
})

test('re-trusting a changed hook writes a new trusted_hash', { skip }, async (t) => {
  const originalHooks = readFileSync(HOOKS_JSON)
  const originalConfig = readFileSync(CODEX_CONFIG)

  t.after(() => {
    writeFileSync(HOOKS_JSON, originalHooks)
    writeFileSync(CODEX_CONFIG, originalConfig)
    assert.ok(readFileSync(HOOKS_JSON).equals(originalHooks), '.codex/hooks.json not restored')
    assert.ok(readFileSync(CODEX_CONFIG).equals(originalConfig), '~/.codex/config.toml not restored')
  })

  const hashesBefore = trustedHashes()

  // Change the timeout: a real content change, and harmless if anything leaks.
  const parsed = JSON.parse(originalHooks.toString('utf8'))
  parsed.hooks.SessionStart[0].hooks[0].timeout = 11
  writeFileSync(HOOKS_JSON, JSON.stringify(parsed, null, 2) + '\n')

  const invalidated = await readCodexHooks(ROOT)
  assert.notEqual(status(invalidated)?.trustStatus, 'trusted', 'the change must invalidate first')

  const { prompted } = await trustCodexHooks(ROOT)
  assert.equal(prompted, true, 'changing hook content must re-prompt for review')

  const retrusted = await readCodexHooks(ROOT)
  const now = status(retrusted)
  assert.equal(now?.trustStatus, 'trusted', 're-trusting must restore execution')
  assert.equal(now?.executable, true)
  assert.equal(now?.timeoutSec, 11, 'the new content is what got trusted')

  const hashesAfter = trustedHashes()
  const key = Object.keys(hashesAfter).find((k) => k.includes('coding-repl') && k.includes('session_start'))
  assert.ok(key, 'expected a session_start trust entry')
  assert.ok(hashesAfter[key]!.startsWith('sha256:'), 'trust is recorded as a content hash')
  assert.notEqual(
    hashesAfter[key],
    hashesBefore[key],
    'a new trusted_hash must be written, not the old one reused',
  )
})

test('hook trust is deployment state and must not touch outcome grading', () => {
  // The separation this protects: trust answers "will hooks run", never "did a turn
  // complete". Folding a readiness signal into evidence grading would let a green
  // deployment check inflate confidence in a turn nobody observed.
  const report: CodexHookReport = {
    cwd: ROOT,
    hooks: [
      {
        eventName: 'stop',
        handlerType: 'command',
        source: 'project',
        trustStatus: 'trusted',
        loaded: true,
        enabled: true,
        trusted: true,
        executable: true,
        command: MATCH,
      },
    ],
    errors: [],
    warnings: [],
  }
  assert.equal(diagnoseHookTrust(report, MATCH).ready, true)

  // Codex's capability grades are unchanged by any of this, and stay below Claude's.
  assert.equal(CODEX_CAPABILITIES.outcomes.completed, 'observed')
  assert.equal(CODEX_CAPABILITIES.outcomes.cancelled, 'observed_historically')
  assert.equal(CODEX_CAPABILITIES.outcomes.permission_refused, 'inferred_from_documented_event')
  assert.equal(CODEX_CAPABILITIES.readinessSignal, 'unknown')
})

test('enabled is never treated as executable, in either direction', () => {
  // Pure unit check so the vocabulary is protected without needing Codex installed.
  const base = {
    eventName: 'stop',
    handlerType: 'command',
    source: 'project',
    sourcePath: '/p/.codex/hooks.json',
    command: MATCH,
    loaded: true,
  }
  const enabledButUntrusted: CodexHookReport = {
    cwd: '/p',
    hooks: [
      { ...base, trustStatus: 'modified', enabled: true, trusted: false, executable: false },
    ],
    errors: [],
    warnings: [],
  }
  const d = diagnoseHookTrust(enabledButUntrusted, MATCH)
  assert.equal(d.ready, false, 'enabled must not be mistaken for working')
  assert.equal(d.blocked.length, 1)

  const trustedButDisabled: CodexHookReport = {
    cwd: '/p',
    hooks: [
      { ...base, trustStatus: 'trusted', enabled: false, trusted: true, executable: false },
    ],
    errors: [],
    warnings: [],
  }
  assert.equal(diagnoseHookTrust(trustedButDisabled, MATCH).ready, false, 'trusted alone is not enough either')
})

test('the registry runs preflight before create, and refuses on failure', async () => {
  const { AgentRegistry } = await import('../registry/registry.ts')
  const order: string[] = []

  const ok = new AgentRegistry().register({
    id: 'ok-agent',
    displayName: 'ok',
    capabilities: { ...CODEX_CAPABILITIES, agent: 'ok-agent' },
    launch: { command: 'x', baseArgs: [] },
    preflight: async () => void order.push('preflight'),
    create: async () => {
      order.push('create')
      return {} as any
    },
  })
  await ok.createParticipant({ id: 'p', agent: 'ok-agent', role: 'advisor' }, { cwd: '/tmp' })
  assert.deepEqual(order, ['preflight', 'create'], 'preconditions must be checked first')

  // A session whose lifecycle guarantees are knowingly absent must not be started.
  const blocked = new AgentRegistry().register({
    id: 'blocked-agent',
    displayName: 'blocked',
    capabilities: { ...CODEX_CAPABILITIES, agent: 'blocked-agent' },
    launch: { command: 'x', baseArgs: [] },
    preflight: async () => {
      throw new Error('hooks are not executable; no turn-completion signal')
    },
    create: async () => {
      assert.fail('create must not run when preflight fails')
    },
  })
  await assert.rejects(
    () => blocked.createParticipant({ id: 'p', agent: 'blocked-agent', role: 'advisor' }, { cwd: '/tmp' }),
    /no turn-completion signal/,
  )
})

test('codex declares a preflight even though its adapter does not exist yet', async () => {
  // Wired ahead of the adapter so it cannot be forgotten when the adapter lands.
  const { CODEX_AGENT } = await import('../registry/builtin.ts')
  assert.equal(typeof CODEX_AGENT.preflight, 'function')
  assert.equal(CODEX_AGENT.create, undefined)
})
