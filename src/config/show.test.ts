/**
 * `conclave config show`.
 *
 * Fixtures are temp directories containing at most a `package.json` and a `.conclave/`
 * config: deliberately NOT a rendered checkout, because the thing under test must report
 * on registrations that do not exist yet without minding that they do not.
 *
 * The read-only claim is tested as a claim, not assumed from reading the code — a
 * recursive listing before and after, plus the CLI spawned for real, since a `mkdirSync`
 * reached from anywhere in the call graph would be invisible to a module-level assertion
 * about return values.
 *
 *   node --test src/config/show.test.ts
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConclaveRoot, resolveRepoRoot, TARGETS } from './install.ts'
import { formatConfigShow, formatConfigShowJson, showConfig } from './show.ts'

const REPO = resolveRepoRoot(import.meta.dirname)
const CLI = join(REPO, 'bin', 'conclave.ts')

/**
 * A plain project: a `package.json` and nothing else. No git, so root resolution takes
 * the ancestor-walk path rather than depending on a `git` that may or may not be present.
 */
function project(config?: string): string {
  // Real path, not the symlinked one: on macOS `tmpdir()` is /var/... while the resolved
  // root — and a spawned child's cwd — report /private/var/...
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'conclave-show-')))
  writeFileSync(join(dir, 'package.json'), '{}')
  if (config !== undefined) {
    mkdirSync(join(dir, '.conclave'), { recursive: true })
    writeFileSync(join(dir, '.conclave', 'config.json'), config)
  }
  return dir
}

/** Every path under a directory, sorted, for before/after comparison. */
function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort()
}

test('the project root is found from a nested working directory, not taken as the cwd', () => {
  // The case that matters: `config show` is run from wherever the operator happens to be
  // standing, which is usually somewhere down inside the tree. Reporting that directory
  // as the project would put every registration path in the wrong place.
  const root = project()
  const nested = join(root, 'src', 'deep', 'inner')
  mkdirSync(nested, { recursive: true })

  const report = showConfig({ cwd: nested })

  assert.equal(report.projectRoot, root)
  assert.equal(report.codexProjectRoot, root, 'an ordinary checkout is its own Codex root')
  assert.equal(
    report.registrations.find((r) => r.agent === 'claude')?.path,
    join(root, '.claude', 'settings.json'),
    'paths hang off the resolved root, not the directory the command was run from',
  )
})

test('permissions are reported per agent, with the per-agent entry winning', () => {
  const asymmetric = project('{"permissions":"bypass","agents":{"codex":{"permissions":"ask"}}}')
  assert.deepEqual(showConfig({ projectRoot: asymmetric }).permissions, {
    claude: 'bypass',
    codex: 'ask',
  })

  const shared = project('{"permissions":"bypass"}')
  assert.deepEqual(showConfig({ projectRoot: shared }).permissions, {
    claude: 'bypass',
    codex: 'bypass',
  })

  // No config file at all: both agents ask, which is each CLI's own default. Every known
  // agent is present either way — a caller must never have to distinguish "asks" from
  // "was not mentioned".
  assert.deepEqual(showConfig({ projectRoot: project() }).permissions, {
    claude: 'ask',
    codex: 'ask',
  })
})

test('a malformed config throws rather than being shown as the default', () => {
  // Printing `ask` for a file that says `bypass` would make this command misleading about
  // the one thing it exists to report.
  assert.throws(
    () => showConfig({ projectRoot: project('{"permissions":"bypasss"}') }),
    /permissions must be "ask" or "bypass"/,
  )
  assert.throws(() => showConfig({ projectRoot: project('{ not json') }), /not valid JSON/)
})

test('every registration is listed, against the root that target actually uses', () => {
  // A linked worktree, forced rather than constructed: Codex reads project config from the
  // MAIN worktree, so a sidecar path under the linked one would be a file Codex never
  // opens — and the operator would see "hooks do not fire" with nothing pointing here.
  const linked = project()
  const main = project()
  const report = showConfig({ projectRoot: linked, codexProjectRoot: main })

  assert.equal(report.registrations.length, TARGETS.length)
  assert.deepEqual(
    report.registrations.map((r) => r.label).sort(),
    TARGETS.map((t) => t.label).sort(),
  )
  const byAgent = Object.fromEntries(report.registrations.map((r) => [r.agent, r]))
  assert.equal(byAgent.claude?.path, join(linked, '.claude', 'settings.json'))
  assert.equal(byAgent.claude?.outputRoot, 'project')
  assert.equal(byAgent.codex?.path, join(main, '.codex', 'hooks.json'))
  assert.equal(byAgent.codex?.outputRoot, 'codexProject')

  // And the prose says why the Codex path is somewhere else, rather than leaving it to
  // read as a bug in this command.
  const prose = formatConfigShow(report)
  assert.ok(prose.includes('linked worktree'))
  assert.ok(prose.includes(main))
})

test('the JSON shape is exactly these fields', () => {
  // Pinned: this is the consumer contract, and a field quietly appearing or vanishing is
  // the failure a machine-readable mode exists to prevent.
  const report = JSON.parse(formatConfigShowJson(showConfig({ projectRoot: project() })))

  assert.deepEqual(Object.keys(report).sort(), [
    'codexProjectRoot',
    'conclaveRoot',
    'permissions',
    'projectRoot',
    'registrations',
  ])
  assert.deepEqual(Object.keys(report.permissions).sort(), ['claude', 'codex'])
  for (const reg of report.registrations) {
    assert.deepEqual(Object.keys(reg).sort(), ['agent', 'label', 'outputRoot', 'path'])
  }
  assert.equal(report.conclaveRoot, resolveConclaveRoot(), 'the hooks that run are Conclave\'s')
})

test('nothing is created — not the registrations, not their parent directories', () => {
  // The trap this guards: a report of where files WOULD go, answered by putting them
  // there. `installConfig` creates parents on the way to writing; nothing here may.
  const dir = project('{"permissions":"bypass"}')
  const before = listing(dir)

  const report = showConfig({ projectRoot: dir })
  formatConfigShow(report)
  formatConfigShowJson(report)

  assert.deepEqual(listing(dir), before)
  assert.ok(!before.includes('.claude'), 'the fixture never had one, and still must not')
  assert.ok(!before.includes('.codex'))
})

test('the CLI routes `config show`, defaults to prose, and never writes', () => {
  // Spawned for real: flag routing, which renderer reaches stdout and the exit code are
  // precisely what the module tests cannot see. A `mkdir` anywhere in the command's call
  // graph would also be invisible above, and shows up here.
  const dir = project('{"agents":{"claude":{"permissions":"bypass"}}}')
  const before = listing(dir)
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, 'config', 'show', ...args], { cwd: dir, encoding: 'utf8' })

  const prose = run()
  assert.equal(prose.status, 0, prose.stderr)
  assert.throws(() => JSON.parse(prose.stdout), 'prose is the default')
  assert.ok(prose.stdout.includes(`project: ${dir}`))
  assert.ok(prose.stdout.includes('claude: bypass'))
  assert.ok(prose.stdout.includes('codex: ask'))

  const json = run('--json')
  assert.equal(json.status, 0, json.stderr)
  // The whole stream parses: a stray log line beside valid JSON makes the mode useless.
  const report = JSON.parse(json.stdout)
  assert.equal(report.projectRoot, dir)
  assert.deepEqual(report.permissions, { claude: 'bypass', codex: 'ask' })
  assert.equal(
    report.registrations.find((r: { agent: string }) => r.agent === 'codex')?.path,
    join(dir, '.codex', 'hooks.json'),
  )

  assert.deepEqual(listing(dir), before, 'two runs of `show` left the project untouched')
})
