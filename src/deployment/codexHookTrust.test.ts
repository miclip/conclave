/**
 * Codex hook-trust invalidation — a configuration/deployment invariant.
 *
 * Costs no model tokens (everything goes through `hooks/list` and the boot-time trust
 * prompt), so it runs while the account is rate-limited.
 *
 * By default these operate on a TEMPORARY project directory containing a rendered copy of
 * the sidecar, so this checkout's own `.codex/hooks.json` is never mutated. The trust
 * decision itself still lands in the user-level `~/.codex/config.toml` -- that is where
 * Codex stores it and there is no project-scoped alternative -- so that file is
 * snapshotted and restored byte-for-byte, with the restoration asserted.
 *
 * The one test that deliberately mutates the REAL installed sidecar is gated separately
 * behind ORCH_CODEX_REAL, because its purpose is to verify the registration this checkout
 * actually uses rather than a copy of it.
 *
 * Nothing here is lifecycle evidence. It must not change any turn-outcome grade -- a
 * trusted hook is not evidence that a turn completed. There is a test asserting that
 * separation holds, and it needs no Codex at all.
 *
 *   ORCH_CODEX=1      node --test src/deployment/codexHookTrust.test.ts
 *   ORCH_CODEX_REAL=1 node --test src/deployment/codexHookTrust.test.ts   # + real sidecar
 */

import { strict as assert } from 'node:assert'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  CONCLAVE_HOOK_MATCH,
  diagnoseHookTrust,
  readCodexHooks,
  trustCodexHooks,
} from './codexHookTrust.ts'
import type { CodexHookReport } from './codexHookTrust.ts'
import { checkAdapter } from '../conformance/suite.ts'
import { CODEX_CAPABILITIES } from '../conformance/capabilities.ts'
import { render, TARGETS } from '../config/install.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const CODEX_CONFIG = join(homedir(), '.codex', 'config.toml')
const MATCH = CONCLAVE_HOOK_MATCH

const skip =
  process.env.ORCH_CODEX === '1' || process.env.ORCH_CODEX_REAL === '1'
    ? false
    : 'set ORCH_CODEX=1 (uses a temp project; mutates ~/.codex/config.toml, then restores it)'

const skipReal =
  process.env.ORCH_CODEX_REAL === '1'
    ? false
    : 'set ORCH_CODEX_REAL=1 (mutates this checkout\'s real .codex/hooks.json)'

/**
 * A throwaway project directory with a rendered sidecar, so trust behaviour can be
 * exercised without touching the registration this checkout depends on.
 */
function tempProject(): { dir: string; hooksJson: string } {
  // realpath matters on macOS: mkdtemp returns /var/... while Codex resolves and reports
  // /private/var/..., so an unresolved path makes every trust key and sourcePath
  // comparison silently miss.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'conclave-trust-')))
  const target = TARGETS.find((t) => t.output.includes('.codex'))!
  const template = readFileSync(join(ROOT, target.template), 'utf8')
  const hooksJson = join(dir, target.output)
  mkdirSync(join(hooksJson, '..'), { recursive: true })
  // Rendered against the temp dir, so its handler hash is distinct from this checkout's.
  writeFileSync(hooksJson, render(template, dir))

  // Pre-seed DIRECTORY trust. It is a separate precondition from hook trust, and when
  // both prompts appear in sequence the second one does not reliably take. Seeding the
  // first leaves exactly the single-prompt path that the real checkout exercises.
  appendFileSync(CODEX_CONFIG, `\n[projects."${dir}"]\ntrust_level = "trusted"\n`)
  return { dir, hooksJson }
}

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
  // Snapshot the real trust store BEFORE tempProject() seeds directory trust into it.
  const originalConfig = readFileSync(CODEX_CONFIG)
  const { dir: PROJECT, hooksJson: HOOKS_JSON } = tempProject()
  const originalHooks = readFileSync(HOOKS_JSON)

  t.after(() => {
    writeFileSync(CODEX_CONFIG, originalConfig)
    assert.ok(readFileSync(CODEX_CONFIG).equals(originalConfig), '~/.codex/config.toml not restored')
  })

  // A fresh temp project has never been trusted, so establish a baseline first.
  await trustCodexHooks(PROJECT)

  // 1. Baseline: the trusted file reports trusted.
  const baseline = await readCodexHooks(PROJECT)
  const before = status(baseline)
  assert.ok(before, 'expected our sessionStart hook to be loaded')
  assert.equal(before.trustStatus, 'trusted', 'baseline must start from a trusted state')
  assert.deepEqual(
    { loaded: before.loaded, enabled: before.enabled, trusted: before.trusted, executable: before.executable },
    { loaded: true, enabled: true, trusted: true, executable: true },
  )
  assert.equal(diagnoseHookTrust(baseline, MATCH).ready, true)

  const baselineHashes = trustedHashes()
  const hashKeys = Object.keys(baselineHashes).filter((k) => k.startsWith(PROJECT))
  assert.ok(hashKeys.length >= 2, 'expected trusted_hash entries for the temp project')

  // 2. A content edit invalidates trust. This is the security-relevant case: the command
  //    that will be executed changed, so the prior decision cannot carry over.
  const parsed = JSON.parse(originalHooks.toString('utf8'))
  const edited = structuredClone(parsed)
  edited.hooks.SessionStart[0].hooks[0].command += ' --edited'
  writeFileSync(HOOKS_JSON, JSON.stringify(edited, null, 2) + '\n')

  const afterEdit = await readCodexHooks(PROJECT)
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
  const afterRevert = await readCodexHooks(PROJECT)
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
  const afterWhitespace = await readCodexHooks(PROJECT)
  const ws = status(afterWhitespace)
  assert.ok(ws, 'the reformatted file must still parse and load')
  assert.equal(ws.trustStatus, 'trusted', 'whitespace-only changes must not invalidate trust')
  assert.equal(ws.currentHash, before.currentHash, 'the hash covers the handler, not the file bytes')
  assert.equal(ws.executable, true)

  writeFileSync(HOOKS_JSON, originalHooks)
})

test('re-trusting a changed hook writes a new trusted_hash', { skip }, async (t) => {
  const originalConfig = readFileSync(CODEX_CONFIG)
  const { dir: PROJECT, hooksJson: HOOKS_JSON } = tempProject()
  const originalHooks = readFileSync(HOOKS_JSON)

  t.after(() => {
    writeFileSync(CODEX_CONFIG, originalConfig)
    assert.ok(readFileSync(CODEX_CONFIG).equals(originalConfig), '~/.codex/config.toml not restored')
  })

  await trustCodexHooks(PROJECT)
  const hashesBefore = trustedHashes()

  // Change the timeout: a real content change, and harmless if anything leaks.
  const parsed = JSON.parse(originalHooks.toString('utf8'))
  parsed.hooks.SessionStart[0].hooks[0].timeout = 11
  writeFileSync(HOOKS_JSON, JSON.stringify(parsed, null, 2) + '\n')

  const invalidated = await readCodexHooks(PROJECT)
  assert.notEqual(status(invalidated)?.trustStatus, 'trusted', 'the change must invalidate first')

  const { prompted } = await trustCodexHooks(PROJECT)
  assert.equal(prompted, true, 'changing hook content must re-prompt for review')

  const retrusted = await readCodexHooks(PROJECT)
  const now = status(retrusted)
  assert.equal(now?.trustStatus, 'trusted', 're-trusting must restore execution')
  assert.equal(now?.executable, true)
  assert.equal(now?.timeoutSec, 11, 'the new content is what got trusted')

  const hashesAfter = trustedHashes()
  const key = Object.keys(hashesAfter).find((k) => k.startsWith(PROJECT) && k.includes('session_start'))
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

  // Codex's capability grades come from live fixtures, and nothing about hook trust may move
  // them. A green deployment check must never inflate confidence in a turn nobody observed.
  //
  // Asserted as a PROPERTY rather than against named outcomes. This used to pin
  // `timed_out: 'reasoned_but_unverified'`, and when that outcome was actually captured from
  // a live run the test failed -- not because trust had leaked into grading, but because its
  // example had been overtaken. A test that has to be edited every time evidence improves is
  // measuring the evidence, not the separation it exists to protect.
  const rows = checkAdapter(CODEX_CAPABILITIES)
  for (const row of rows) {
    assert.notEqual(row.verdict, 'unsupported_claim', `${row.outcome} claims more than it has`)
  }
  assert.ok(
    rows.some((r) => CODEX_CAPABILITIES.outcomes[r.outcome] !== 'observed'),
    'if every outcome were observed this test could not tell inflation from evidence',
  )
  assert.equal(CODEX_CAPABILITIES.readinessSignal, 'first_turn')
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

test('codex is constructible but still gated on hook trust', async () => {
  // The preflight was wired ahead of the adapter precisely so it could not be forgotten
  // once the adapter landed. It must still be there now that it has.
  const { CODEX_AGENT } = await import('../registry/builtin.ts')
  assert.equal(typeof CODEX_AGENT.preflight, 'function')
  assert.equal(typeof CODEX_AGENT.create, 'function')
})

test('GATED: the real installed sidecar is trusted and executable', { skip: skipReal }, async () => {
  // The one test whose subject is the registration this checkout actually uses, rather
  // than a copy of it. Read-only: it asserts the installed state is usable and mutates
  // nothing, so the checkout's trust is never disturbed.
  const report = await readCodexHooks(ROOT)
  const diagnosis = diagnoseHookTrust(report, MATCH)
  assert.equal(
    diagnosis.ready,
    true,
    `this checkout's hooks are not executable; run \`npm run config:install\`:\n${diagnosis.messages.join('\n')}`,
  )
  for (const h of report.hooks.filter((x) => x.command?.includes(MATCH))) {
    assert.equal(h.executable, true)
    assert.ok(h.sourcePath?.startsWith(ROOT), 'the subject must be this checkout, not a copy')
  }
})
