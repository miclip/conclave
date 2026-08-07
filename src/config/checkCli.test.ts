/**
 * `conclave config check` at the CLI boundary.
 *
 * These spawn the real entry point rather than calling `installConfig` directly, because
 * what is under test is precisely what the module tests cannot see: flag routing, which
 * renderer stdout receives, and the exit code a caller gates on. `installConfig` resolves
 * the repository root from `process.cwd()`, so pointing a spawned CLI at a fixture is only
 * possible via `cwd` -- hence a temp checkout rather than the real one.
 *
 * `--no-diagnose` throughout: the diagnosis spawns `codex app-server`, which is neither
 * available nor relevant here.
 *
 *   node --test src/config/checkCli.test.ts
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveRepoRoot, TARGETS } from './install.ts'

const REPO = resolveRepoRoot(import.meta.dirname)
const CLI = join(REPO, 'bin', 'conclave.ts')

/** A checkout with the templates but no rendered registrations, so the first run drifts. */
function fixtureRepo(): string {
  // Real path, not the symlinked one: on macOS `tmpdir()` is /var/... while a spawned
  // child's `process.cwd()` reports /private/var/..., and the report echoes the latter.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'conclave-cli-')))
  writeFileSync(join(dir, 'package.json'), '{}')
  for (const t of TARGETS) {
    const dst = join(dir, t.template)
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, readFileSync(join(REPO, t.template)))
  }
  return dir
}

function check(cwd: string, ...flags: string[]) {
  const r = spawnSync(process.execPath, [CLI, 'config', 'check', '--no-diagnose', ...flags], {
    cwd,
    encoding: 'utf8',
  })
  if (r.error) throw r.error
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

/** Render the registrations, so the checkout is clean and a check reports no drift. */
function install(cwd: string) {
  const r = spawnSync(process.execPath, [CLI, 'config', 'install', '--no-diagnose'], {
    cwd,
    encoding: 'utf8',
  })
  if (r.error) throw r.error
  assert.equal(r.status, 0, `install failed: ${r.stderr}`)
}

test('--json prints the report as JSON and nothing else', () => {
  const repo = fixtureRepo()
  const { status, stdout } = check(repo, '--json')

  // Parse the whole stream, not a substring: a stray log line alongside valid JSON is
  // exactly the failure that makes a machine-readable mode useless.
  const report = JSON.parse(stdout)

  assert.equal(report.drift, true, 'an unrendered checkout has drifted')
  assert.equal(report.dryRun, true, 'check must never present itself as having written')
  // The project being registered, which since the CLI went on PATH is no longer
  // necessarily Conclave's own checkout. Both roots are reported, because a consumer that
  // conflated them is the bug this split exists to prevent.
  assert.equal(report.projectRoot, repo)
  assert.equal(report.conclaveRoot, REPO)
  assert.equal(report.selfHosted, false, 'a fixture project is not Conclave')
  assert.equal(report.written.length, TARGETS.length)
  assert.ok(report.written.every((w: { changed: boolean }) => w.changed))
  assert.deepEqual(
    report.written.map((w: { label: string }) => w.label).sort(),
    TARGETS.map((t) => t.label).sort(),
  )
  assert.equal(status, 1, 'drift must still exit non-zero under --json')
})

test('--json exits zero and reports no drift on a clean checkout', () => {
  const repo = fixtureRepo()
  install(repo)

  const { status, stdout } = check(repo, '--json')
  const report = JSON.parse(stdout)

  assert.equal(report.drift, false)
  assert.ok(report.written.every((w: { changed: boolean }) => !w.changed))
  assert.equal(status, 0)
})

test('the exit code is the same with and without --json', () => {
  const drifted = fixtureRepo()
  assert.equal(check(drifted).status, 1)
  assert.equal(check(drifted, '--json').status, 1)

  const clean = fixtureRepo()
  install(clean)
  assert.equal(check(clean).status, 0)
  assert.equal(check(clean, '--json').status, 0)
})

test('prose remains the default output', () => {
  const repo = fixtureRepo()
  const { status, stdout } = check(repo)

  assert.throws(() => JSON.parse(stdout), 'the default output must not have become JSON')
  assert.ok(stdout.includes(`project: ${repo}`))
  assert.ok(stdout.includes(`hooks run from: ${REPO}`), 'a reader must be told which Conclave runs')
  assert.ok(stdout.includes('DRIFT'), 'drift must still be visible to a reader')
  assert.equal(status, 1)
})

test('--json does not rewrite the registrations it reports on', () => {
  // The check contract: reporting drift must not resolve it. Rewriting a Codex handler
  // re-hashes it and silently drops an existing trust decision.
  const repo = fixtureRepo()
  install(repo)
  const codexOut = join(repo, '.codex/hooks.json')
  const perturbed = readFileSync(codexOut, 'utf8').replace('"timeout": 10', '"timeout": 11')
  writeFileSync(codexOut, perturbed)

  const { status, stdout } = check(repo, '--json')
  assert.equal(JSON.parse(stdout).drift, true)
  assert.equal(status, 1)
  assert.equal(readFileSync(codexOut, 'utf8'), perturbed, 'a check must not write')
})

test('relay refuses a flag in the goal position instead of billing for it', () => {
  // `conclave relay --help` parsed `--help` as the GOAL: two real agent sessions launched,
  // an advisor asked what `--help` means, the run escalated, and it billed for the answer.
  // The one invocation someone types when they do not know what a command does was the one
  // that spent their quota. `session` has guarded this since it was written.
  //
  // Spawned rather than unit-tested, because what must be proven is that NO SESSION STARTS
  // — a return value cannot show that, and this is the one test whose failure costs money.
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, 'relay', ...args], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 20_000,
    })

  // Asking for help gets help, and nothing else happens.
  for (const flag of ['--help', '-h']) {
    const help = run(flag)
    assert.equal(help.status, 0, `relay ${flag} prints usage`)
    assert.match(help.stdout, /conclave <command>/)
    assert.ok(!/joined as (advisor|implementer)/.test(help.stdout), 'no participant may start')
  }

  // Anything else flag-shaped is a mistake, and is refused rather than interpreted.
  for (const bad of ['--rounds', '--lead', '-x']) {
    const r = run(bad)
    assert.equal(r.status, 1, `${bad} must be refused`)
    assert.match(r.stderr, /looks like a flag, not a goal/)
    assert.ok(!/joined as/.test(r.stdout), `${bad} must not start a session`)
  }

  const none = run()
  assert.equal(none.status, 1)
  assert.match(none.stderr, /relay needs a goal/)
})

test('the advisor seat is named --advisor, and --lead still works', () => {
  // `--lead` was the RelayOptions FIELD name leaking into the CLI. Every other surface says
  // advisor: the seat id, the routing log, the console's `>advisor`, the briefing header. A
  // flag that alone says "lead" makes an operator wonder whether it is a different thing.
  const help = spawnSync(process.execPath, [CLI, 'relay', '--help'], { encoding: 'utf8' })
  assert.match(help.stdout, /--advisor codex/, 'usage names the seat as everything else does')

  // The old spelling keeps working: v0.2.x scripts exist and a rename that breaks them buys
  // consistency at someone else's expense.
  const plan = (flag: string) => {
    const r = spawnSync(process.execPath, [CLI, 'relay', 'a goal', flag, 'kimi', '--dry-run', '--json'], {
      cwd: REPO,
      encoding: 'utf8',
    })
    return JSON.parse(r.stdout) as { advisor: { agent: string } }
  }
  assert.equal(plan('--advisor').advisor.agent, 'kimi')
  assert.equal(plan('--lead').advisor.agent, 'kimi', '--lead remains an alias')
})
