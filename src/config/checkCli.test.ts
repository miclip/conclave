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
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'
import { hasDrift, installConfig, resolveRepoRoot, TARGETS } from './install.ts'

const REPO = resolveRepoRoot(import.meta.dirname)
const CLI = join(REPO, 'bin', 'conclave.ts')

/** A checkout with the templates but no rendered registrations, so the first run drifts. */
function fixtureRepo(t: TestContext): string {
  // `tempDir` resolves the canonical path itself, which matters here: on macOS `tmpdir()` is
  // /var/... while a spawned child's `process.cwd()` reports /private/var/..., and the report
  // echoes the latter.
  const dir = tempDir(t, 'conclave-cli')
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

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
}

const RUN_ID = 'r-fixture'
const SLUG = 'implementer'

/**
 * A real run root with a real seat worktree under it, laid out as `createSeatWorktrees` does:
 * `<root>/.conclave/worktrees/<runId>/<slug>`, a linked checkout on its own branch.
 *
 * Real rather than mocked, because what is under test is a decision made from the DIRECTORY —
 * a hand-made directory of the right shape would prove only that string matching works, and
 * the linked-worktree requirement is precisely what stops a look-alike exempting itself.
 */
function seatFixture(t: TestContext): { root: string; seat: string } {
  const root = tempDir(t, 'conclave-seat')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'fixture@example.invalid')
  git(root, 'config', 'user.name', 'fixture')
  writeFileSync(join(root, 'package.json'), '{}')
  for (const t of TARGETS) {
    const dst = join(root, t.template)
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, readFileSync(join(REPO, t.template)))
  }
  // The rendered registrations are ignored here as they are in a real project — which is the
  // whole reason a seat checkout never receives them.
  writeFileSync(join(root, '.gitignore'), '.claude/settings.json\n.codex/hooks.json\n.conclave/\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'fixture')

  const seat = join(root, '.conclave', 'worktrees', RUN_ID, SLUG)
  git(root, 'worktree', 'add', '-q', '-b', `conclave/${RUN_ID}/${SLUG}`, seat, 'HEAD')
  return { root, seat }
}

test('--json prints the report as JSON and nothing else', (t) => {
  const repo = fixtureRepo(t)
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

test('--json exits zero and reports no drift on a clean checkout', (t) => {
  const repo = fixtureRepo(t)
  install(repo)

  const { status, stdout } = check(repo, '--json')
  const report = JSON.parse(stdout)

  assert.equal(report.drift, false)
  assert.ok(report.written.every((w: { changed: boolean }) => !w.changed))
  assert.equal(status, 0)
})

test('the exit code is the same with and without --json', (t) => {
  const drifted = fixtureRepo(t)
  assert.equal(check(drifted).status, 1)
  assert.equal(check(drifted, '--json').status, 1)

  const clean = fixtureRepo(t)
  install(clean)
  assert.equal(check(clean).status, 0)
  assert.equal(check(clean, '--json').status, 0)
})

test('prose remains the default output', (t) => {
  const repo = fixtureRepo(t)
  const { status, stdout } = check(repo)

  assert.throws(() => JSON.parse(stdout), 'the default output must not have become JSON')
  assert.ok(stdout.includes(`project: ${repo}`))
  assert.ok(stdout.includes(`hooks run from: ${REPO}`), 'a reader must be told which Conclave runs')
  assert.ok(stdout.includes('DRIFT'), 'drift must still be visible to a reader')
  assert.equal(status, 1)
})

test('--json does not rewrite the registrations it reports on', (t) => {
  // The check contract: reporting drift must not resolve it. Rewriting a Codex handler
  // re-hashes it and silently drops an existing trust decision.
  const repo = fixtureRepo(t)
  install(repo)
  const codexOut = join(repo, '.codex/hooks.json')
  const perturbed = readFileSync(codexOut, 'utf8').replace('"timeout": 10', '"timeout": 11')
  writeFileSync(codexOut, perturbed)

  const { status, stdout } = check(repo, '--json')
  assert.equal(JSON.parse(stdout).drift, true)
  assert.equal(status, 1)
  assert.equal(readFileSync(codexOut, 'utf8'), perturbed, 'a check must not write')
})

test('the run root still exits red on drift, seat worktrees or no', async (t) => {
  // The signal that used to live in an ambient unit test (`src/config/install.test.ts`) and
  // now lives here: registrations that no longer match the templates must fail a check run
  // where the registrations actually are. Nothing about the seat exemption below may soften
  // that, so this asserts it against a root that HAS a seat worktree hanging off it.
  const { root } = seatFixture(t)
  install(root)
  assert.equal(check(root).status, 0, 'a freshly installed run root is clean')

  const sidecar = join(root, '.codex', 'hooks.json')
  writeFileSync(sidecar, readFileSync(sidecar, 'utf8').replace('"timeout": 10', '"timeout": 11'))

  const prose = check(root)
  assert.equal(prose.status, 1, 'drift at the run root is red')
  assert.match(prose.stdout, /DRIFT/)
  const json = check(root, '--json')
  assert.equal(json.status, 1, 'and red in either rendering')
  const report = JSON.parse(json.stdout)
  assert.equal(report.drift, true)
  assert.equal(report.status, 'drift', 'the status word agrees with the exit code')
  // The report is not a repair: what it described must still be on disk afterwards.
  assert.match(readFileSync(sidecar, 'utf8'), /"timeout": 11/)
})

test('a seat worktree reports not_applicable and exits zero', async (t) => {
  // A seat is a linked checkout, and registrations are generated and git-ignored, so git never
  // puts them there. Checking a seat therefore reports the RUN ROOT's registrations as missing
  // — for every seat, every run, with no change behind it. Seats run the suite at their own
  // HEAD, so a red answer here would arrive as a seat test failure nothing could fix.
  const { root, seat } = seatFixture(t)
  install(root)

  // The condition being exempted is real, not hypothetical: the seat has no Claude
  // registration of its own, and a raw dry run there does report drift.
  assert.equal(existsSync(join(seat, '.claude', 'settings.json')), false)
  const raw = await installConfig({ projectRoot: seat, conclaveRoot: REPO, diagnose: false, dryRun: true })
  assert.equal(hasDrift(raw), true, 'without the exemption a seat is unconditionally red')

  const json = check(seat, '--json')
  assert.equal(json.status, 0, 'a declined question is not a failure')
  const report = JSON.parse(json.stdout)
  assert.equal(report.status, 'not_applicable')
  assert.equal(report.reason, 'seat_worktree_has_no_registration')
  // No `drift` key at all. `false` would say the registrations were compared and agreed, and
  // nothing was compared -- a fleet report that read `drift: false` here would count a seat as
  // a root it had verified. Absent it is still falsy, so a consumer gating on it agrees with
  // the zero exit code, while anything that looks can tell "not checked" from "checked, clean".
  assert.ok(!('drift' in report), 'a check that did not run must not claim a drift verdict')
  assert.equal(report.drift, undefined, 'and reads as unknown, not as false')
  assert.equal(report.projectRoot, seat)
  assert.equal(report.integrationRoot, root, 'and is told where the question does apply')
  assert.equal(report.runId, RUN_ID)
  assert.equal(report.seat, SLUG)

  const prose = check(seat)
  assert.equal(prose.status, 0, 'the exit code does not depend on the rendering')
  assert.throws(() => JSON.parse(prose.stdout), 'prose is still the default')
  // The same two words a script would read, verbatim, so a human and a script quoting this
  // run are quoting the same thing.
  assert.match(prose.stdout, /not_applicable/)
  assert.match(prose.stdout, /seat_worktree_has_no_registration/)
  assert.ok(prose.stdout.includes(root), 'names the run root to check instead')
  assert.ok(!/DRIFT/.test(prose.stdout), 'and never presents itself as a drift report')
})

test('a seat worktree is recognised by layout, not by the manifest', (t) => {
  // `createSeatWorktrees` writes the manifest only after every tree exists, and cleanup can
  // remove it while a tree is retained. If the exemption depended on the manifest, a check run
  // in either window would go red in a directory that is unambiguously a seat.
  const { root, seat } = seatFixture(t)
  install(root)
  assert.equal(JSON.parse(check(seat, '--json').stdout).status, 'not_applicable', 'no manifest yet')

  // Present, it supplies the operator's own seat id -- the slug is a sanitized derivative and
  // is not necessarily what they typed.
  const manifest = join(root, '.conclave', 'worktrees', RUN_ID, 'manifest.json')
  writeFileSync(
    manifest,
    JSON.stringify({
      schema: 1,
      runId: RUN_ID,
      createdAt: 0,
      integrationRoot: root,
      seats: [
        {
          seatId: 'implementer 2',
          slug: SLUG,
          worktreePath: seat,
          branch: `conclave/${RUN_ID}/${SLUG}`,
          baseSha: '0'.repeat(40),
          mergeState: 'clean',
        },
      ],
    }),
  )
  const report = JSON.parse(check(seat, '--json').stdout)
  assert.equal(report.seat, 'implementer 2')
  assert.equal(report.status, 'not_applicable')
  assert.ok(check(seat).stdout.includes('implementer 2'), 'and the reader is told the same seat')
})

test('a directory merely shaped like a seat worktree is still checked', (t) => {
  // The exemption is the dangerous direction: anything it swallows is a drift report nobody
  // sees. A path under `.conclave/worktrees/` that is NOT a linked checkout -- a leftover
  // directory, or a project someone laid out this way -- gets the ordinary answer.
  const outer = tempDir(t, 'conclave-lookalike')
  const impostor = join(outer, '.conclave', 'worktrees', RUN_ID, SLUG)
  mkdirSync(impostor, { recursive: true })
  writeFileSync(join(impostor, 'package.json'), '{}')
  for (const t of TARGETS) {
    const dst = join(impostor, t.template)
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, readFileSync(join(REPO, t.template)))
  }
  const r = check(impostor, '--json')
  assert.equal(r.status, 1, 'an unregistered ordinary directory still drifts')
  assert.equal(JSON.parse(r.stdout).status, 'drift')
})

test('a `.git` FILE is not taken as proof: the exemption asks git, not the filesystem', (t) => {
  // The test above covers a directory with no `.git` at all. It is the weaker half: a `.git`
  // FILE was the whole of the linked-worktree evidence, and nothing read it. A file holding
  // arbitrary text passed, and the check exited zero without comparing anything -- so laying out
  // this shape was enough to switch a real project's drift reporting off.
  const outer = tempDir(t, 'conclave-fakegit')
  const impostor = join(outer, '.conclave', 'worktrees', RUN_ID, SLUG)
  mkdirSync(impostor, { recursive: true })
  writeFileSync(join(impostor, 'package.json'), '{}')
  writeFileSync(join(impostor, '.git'), 'total nonsense, not a gitdir pointer\n')
  for (const t of TARGETS) {
    const dst = join(impostor, t.template)
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, readFileSync(join(REPO, t.template)))
  }
  const r = check(impostor, '--json')
  assert.equal(r.status, 1, 'an invented .git buys nothing')
  assert.equal(JSON.parse(r.stdout).status, 'drift')
})

test("a real linked worktree of ANOTHER repository at that path is still checked", (t) => {
  // The other false positive, and the one no amount of reading the `.git` file would catch: a
  // genuine linked worktree, genuinely pointing at a genuine repository -- just not this one. A
  // seat shares its repository with the run root by construction, so a checkout that does not is
  // not a seat however its path reads.
  const outer = tempDir(t, 'conclave-foreign')
  const other = join(outer, 'other')
  mkdirSync(other, { recursive: true })
  git(other, 'init', '-q', '.')
  writeFileSync(join(other, 'seed'), 'x')
  git(other, 'add', '-A')
  git(other, '-c', 'user.email=a@b', '-c', 'user.name=c', 'commit', '-qm', 'init')
  const victim = join(outer, 'victim')
  const impostor = join(victim, '.conclave', 'worktrees', RUN_ID, SLUG)
  mkdirSync(join(impostor, '..'), { recursive: true })
  git(other, 'worktree', 'add', '-q', '--detach', impostor, 'HEAD')
  writeFileSync(join(impostor, 'package.json'), '{}')
  for (const t of TARGETS) {
    const dst = join(impostor, t.template)
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, readFileSync(join(REPO, t.template)))
  }
  const r = check(impostor, '--json')
  assert.equal(r.status, 1, 'a foreign worktree is not this run root\'s seat')
  assert.equal(JSON.parse(r.stdout).status, 'drift')
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

  // Anything else flag-shaped is a mistake, and is refused rather than interpreted -- each
  // now for its OWN reason. All three used to answer "looks like a flag, not a goal", because
  // the goal was argv[1] and anything else standing there was a mistake by definition. Since
  // #172 the goal is the token no flag claimed, so the refusal can name what is actually
  // wrong: a value that went missing, a flag this command does not have, or a flag that is
  // fine with no goal beside it. What has not changed is the property this test is for --
  // status 1, and nothing spawned.
  for (const [bad, expected] of [
    ['--rounds', /--rounds was given without a value/],
    ['--lead', /--lead was given without a value/],
    ['-x', /-x is not a flag this command takes/],
    ['--json', /relay needs a goal/],
  ] as const) {
    const r = run(bad)
    assert.equal(r.status, 1, `${bad} must be refused`)
    assert.match(r.stderr, expected)
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

test('a flag typed with a unicode dash is refused, not ignored', () => {
  // Em and en dashes reach a command line constantly -- autocorrect, a copied snippet, a chat
  // client being helpful. `--bypass` typed with an em dash matches no flag and was ignored
  // SILENTLY, which is the dangerous direction: the operator believes permissions are
  // bypassed, the run is unattended, and it stops at the first prompt with nobody to answer.
  const EM = String.fromCharCode(0x2014)
  const r = spawnSync(process.execPath, [CLI, 'relay', 'a goal', `${EM}-bypass`], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.equal(r.status, 1, 'refused rather than run')
  assert.match(r.stderr, /starts with an em dash/)
  assert.match(r.stderr, /Did you mean "--bypass"/, 'and says what was probably meant')
  assert.ok(!/joined as/.test(r.stdout), 'no participant may start')
})

test('a GOAL beginning with a unicode dash is refused, and `--` is how it is said anyway', () => {
  // The guard above moved to cover the token no flag claimed, which tightened relay: a goal
  // that BEGINS with an em or en dash was accepted before and is refused now. The run that
  // made the change flagged this as pinned by no test of its own, which is what this is.
  //
  // The direction is right. `—rounds 4` off a smart-dash substitution matches no flag, and
  // the goal token is exactly where such a token lands once no flag has claimed it -- so
  // exempting the goal would reopen the silent drop this issue is about, one position over.
  //
  // But it is still a sentence somebody may have meant, so the escape has to be real and has
  // to be asserted beside the refusal. Both halves here: refused when bare, taken after `--`.
  const EM = String.fromCharCode(0x2014)
  const GOAL = `${EM}rewrite the onboarding copy`
  const run = (argv: string[]) =>
    spawnSync(process.execPath, [CLI, 'relay', ...argv], { cwd: REPO, encoding: 'utf8', timeout: 20_000 })

  const bare = run([GOAL, '--dry-run'])
  assert.equal(bare.status, 1, 'refused rather than run')
  assert.match(bare.stderr, /starts with an em dash/)
  // The dry-run half of #172, at the goal token: a plan for an argv that was not read is the
  // failure this issue is about, so the ABSENCE of the plan is what is asserted.
  assert.ok(!/dry run/.test(bare.stdout), 'and no plan comes back')

  const marked = run(['--dry-run', '--', GOAL])
  assert.equal(marked.status, 0, '`--` is a real escape, not advice the parser then ignores')
  assert.match(marked.stdout, /dry run/, 'the plan comes back')
  assert.ok(!/starts with an em dash/.test(marked.stderr), 'and the goal is not re-read as a flag')
})
