/**
 * `conclave config show`.
 *
 * Fixtures are temp directories containing at most a `package.json` and a `.conclave/`
 * config: deliberately NOT a rendered checkout, because the thing under test must report
 * on registrations that do not exist yet without minding that they do not. Where a
 * registration's STATUS is what is under test, a second temp directory stands in for
 * Conclave itself, so a broken template can be arranged without breaking this checkout.
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
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'
import {
  resolveConclaveRoot,
  resolveRepoRoot,
  TARGETS,
  TEMPLATE_TOKEN,
  type RenderTarget,
} from './install.ts'
import { formatConfigShow, formatConfigShowJson, showConfig } from './show.ts'

const REPO = resolveRepoRoot(import.meta.dirname)
const CLI = join(REPO, 'bin', 'conclave.ts')

/**
 * A plain project: a `package.json` and nothing else. No git, so root resolution takes
 * the ancestor-walk path rather than depending on a `git` that may or may not be present.
 */
function project(t: TestContext, config?: string): string {
  // `tempDir` resolves the canonical path itself, which matters here: on macOS `tmpdir()`
  // is /var/... while the resolved root — and a spawned child's cwd — report /private/var/...
  const dir = tempDir(t, 'conclave-show')
  writeFileSync(join(dir, 'package.json'), '{}')
  if (config !== undefined) {
    mkdirSync(join(dir, '.conclave'), { recursive: true })
    writeFileSync(join(dir, '.conclave', 'config.json'), config)
  }
  return dir
}

/**
 * A stand-in Conclave checkout: every target's template, with the body chosen per target.
 * Omitting a target's entry leaves that template absent, which is how a broken
 * installation is arranged without touching the real one.
 */
function conclave(t: TestContext, bodies: Partial<Record<string, string>> = {}): string {
  const dir = tempDir(t, 'conclave-root')
  for (const target of TARGETS) {
    const body = target.template in bodies ? bodies[target.template] : templateFor(target)
    if (body === undefined) continue
    mkdirSync(dirname(join(dir, target.template)), { recursive: true })
    writeFileSync(join(dir, target.template), body)
  }
  return dir
}

/** Distinct per target, so a template read from the wrong place would not compare equal. */
function templateFor(target: RenderTarget): string {
  return `{"target":"${target.label}","command":"${TEMPLATE_TOKEN}/spikes/hooks/hook_post.py"}\n`
}

/**
 * What the file at a target's path must contain to count as current. Substituted here by
 * hand rather than through `render`, so the test states the expectation instead of
 * agreeing with the implementation by construction.
 */
function rendered(target: RenderTarget, conclaveRoot: string): string {
  return templateFor(target).split(TEMPLATE_TOKEN).join(conclaveRoot)
}

/** Every path under a directory, sorted, for before/after comparison. */
function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort()
}

function statusOf(dir: string, conclaveRoot: string, agent: string) {
  const report = showConfig({ projectRoot: dir, conclaveRoot })
  const reg = report.registrations.find((r) => r.agent === agent)
  assert.ok(reg, `no registration for ${agent}`)
  return reg
}

test('the project root is found from a nested working directory, not taken as the cwd', (t) => {
  // The case that matters: `config show` is run from wherever the operator happens to be
  // standing, which is usually somewhere down inside the tree. Reporting that directory
  // as the project would put every registration path in the wrong place.
  const root = project(t)
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

test('permissions are reported per agent, with the per-agent entry winning', (t) => {
  const asymmetric = project(t, '{"permissions":"bypass","agents":{"codex":{"permissions":"ask"}}}')
  assert.deepEqual(showConfig({ projectRoot: asymmetric }).permissions, {
    claude: 'bypass',
    codex: 'ask',
  })

  const shared = project(t, '{"permissions":"bypass"}')
  assert.deepEqual(showConfig({ projectRoot: shared }).permissions, {
    claude: 'bypass',
    codex: 'bypass',
  })

  // No config file at all: both agents ask, which is each CLI's own default. Every known
  // agent is present either way — a caller must never have to distinguish "asks" from
  // "was not mentioned".
  assert.deepEqual(showConfig({ projectRoot: project(t) }).permissions, {
    claude: 'ask',
    codex: 'ask',
  })
})

test('a malformed config throws rather than being shown as the default', (t) => {
  // Printing `ask` for a file that says `bypass` would make this command misleading about
  // the one thing it exists to report.
  assert.throws(
    () => showConfig({ projectRoot: project(t, '{"permissions":"bypasss"}') }),
    /permissions must be "ask" or "bypass"/,
  )
  assert.throws(() => showConfig({ projectRoot: project(t, '{ not json') }), /not valid JSON/)
})

test('every registration is listed, against the root that target actually uses', (t) => {
  // A linked worktree, forced rather than constructed: Codex reads project config from the
  // MAIN worktree, so a sidecar path under the linked one would be a file Codex never
  // opens — and the operator would see "hooks do not fire" with nothing pointing here.
  const linked = project(t)
  const main = project(t)
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

test('a registration that is not there is missing, not drifted', (t) => {
  // The distinction an operator acts on: `drifted` means reinstall to update, `missing`
  // means the hooks are not registered at all and the session gets no signal whatsoever.
  const reg = statusOf(project(t), conclave(t), 'claude')

  assert.equal(reg.exists, false)
  assert.equal(reg.status, 'missing')
  assert.equal(reg.error, undefined, 'a fine template and an absent file is not an error')
  assert.match(formatConfigShow(showConfig({ projectRoot: project(t), conclaveRoot: conclave(t) })),
    /missing +Claude project hooks/)
})

test('bytes identical to the rendered template are current; anything else is drifted', (t) => {
  const root = conclave(t)
  const dir = project(t)
  const claude = TARGETS.find((t) => t.agent === 'claude')!
  const dest = join(dir, claude.output)
  mkdirSync(dirname(dest), { recursive: true })

  writeFileSync(dest, rendered(claude, root))
  assert.equal(statusOf(dir, root, 'claude').status, 'current')
  assert.equal(statusOf(dir, root, 'claude').exists, true)

  // One byte. Drift is a byte comparison because that is what `installConfig` rewrites on
  // — a registration that is "basically the same" is still one Codex would re-hash.
  writeFileSync(dest, `${rendered(claude, root)} `)
  assert.equal(statusOf(dir, root, 'claude').status, 'drifted')

  // And rendering against a DIFFERENT Conclave is drift, not a match: the command path
  // inside points at a checkout that is not the one being reported.
  writeFileSync(dest, rendered(claude, conclave(t)))
  assert.equal(statusOf(dir, root, 'claude').status, 'drifted')
})

test('an unreadable destination is unknown rather than drifted', (t) => {
  // A directory where the settings file should be. We have not seen bytes, so claiming
  // they differ would be an assertion the command cannot support.
  const dir = project(t)
  const claude = TARGETS.find((t) => t.agent === 'claude')!
  mkdirSync(join(dir, claude.output), { recursive: true })

  const reg = statusOf(dir, conclave(t), 'claude')
  assert.equal(reg.exists, true)
  assert.equal(reg.status, 'unknown')
  assert.ok(reg.error, 'the reason is carried, not dropped')
})

test('a broken template fails its own registration and nothing else', (t) => {
  // The whole reason `show` does not call `installConfig`: that throws on the first
  // missing template, so a half-installed Conclave answers "which project am I in" with
  // a stack trace. Everything that does not depend on the broken template must survive.
  const claude = TARGETS.find((t) => t.agent === 'claude')!
  const codex = TARGETS.find((t) => t.agent === 'codex')!
  const root = conclave(t, { [claude.template]: undefined })
  const dir = project(t, '{"permissions":"bypass"}')
  const dest = join(dir, codex.output)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, rendered(codex, root))

  const report = showConfig({ projectRoot: dir, conclaveRoot: root })

  assert.equal(report.projectRoot, dir, 'roots still resolve')
  assert.deepEqual(report.permissions, { claude: 'bypass', codex: 'bypass' })
  const broken = report.registrations.find((r) => r.agent === 'claude')!
  assert.equal(broken.status, 'missing', 'the destination is absent, and that much is known')
  assert.match(broken.error ?? '', /missing template/)
  assert.match(broken.error ?? '', new RegExp(root), 'blames Conclave by name, not the project')
  assert.equal(
    report.registrations.find((r) => r.agent === 'codex')!.status,
    'current',
    'the intact target is unaffected by its neighbour',
  )

  // Both renderings survive it, and the prose attaches the reason to the line it belongs
  // to rather than to a footer that could be read as applying to everything.
  const prose = formatConfigShow(report)
  assert.ok(prose.includes(`project: ${dir}`))
  assert.ok(prose.includes('claude: bypass'))
  assert.match(prose, /could not compare: missing template/)
  assert.match(prose, /current +Codex sidecar/)
  assert.equal(JSON.parse(formatConfigShowJson(report)).registrations.length, TARGETS.length)
})

test('a malformed template is unknown when the file exists, with the reason kept', (t) => {
  const claude = TARGETS.find((t) => t.agent === 'claude')!
  const dir = project(t)
  mkdirSync(join(dir, dirname(claude.output)), { recursive: true })
  writeFileSync(join(dir, claude.output), '{}')

  // Renders to something no CLI can parse. `installConfig` refuses to write this; `show`
  // must report that it cannot judge the file rather than inventing a verdict.
  const notJson = statusOf(dir, conclave(t, { [claude.template]: `{"cmd": ${TEMPLATE_TOKEN}}` }), 'claude')
  assert.equal(notJson.status, 'unknown')
  assert.ok(notJson.error)

  // No token at all: it would render identically for every Conclave, so comparing against
  // it would say nothing about whether the hooks point back here.
  const noToken = statusOf(dir, conclave(t, { [claude.template]: '{"cmd":"hook_post.py"}' }), 'claude')
  assert.equal(noToken.status, 'unknown')
  assert.match(noToken.error ?? '', /CONCLAVE_ROOT/)

  // Prose says which state it is in, and says explicitly that unknown is not a verdict.
  const prose = formatConfigShow(
    showConfig({ projectRoot: dir, conclaveRoot: conclave(t, { [claude.template]: '{"cmd":"x"}' }) }),
  )
  assert.match(prose, /unknown +Claude project hooks/)
  assert.ok(prose.includes('`unknown` means the comparison could not be made'))
})

test('the JSON shape is exactly these fields', (t) => {
  // Pinned: this is the consumer contract, and a field quietly appearing or vanishing is
  // the failure a machine-readable mode exists to prevent.
  const report = JSON.parse(formatConfigShowJson(showConfig({ projectRoot: project(t) })))

  assert.deepEqual(Object.keys(report).sort(), [
    'codexProjectRoot',
    'conclaveRoot',
    'permissions',
    'projectRoot',
    'registrations',
  ])
  assert.deepEqual(Object.keys(report.permissions).sort(), ['claude', 'codex'])
  for (const reg of report.registrations) {
    // `error` is absent when there is nothing wrong, so it is not in the base shape: a
    // consumer must branch on its presence rather than on an empty string.
    assert.deepEqual(Object.keys(reg).sort(), ['agent', 'exists', 'label', 'outputRoot', 'path', 'status'])
    assert.equal(typeof reg.exists, 'boolean')
    assert.ok(['missing', 'current', 'drifted', 'unknown'].includes(reg.status), reg.status)
  }
  assert.equal(report.conclaveRoot, resolveConclaveRoot(), 'the hooks that run are Conclave\'s')

  // And `error` appears — as a string, on the failing entry only — when one does fail.
  const claude = TARGETS.find((t) => t.agent === 'claude')!
  const broken = JSON.parse(
    formatConfigShowJson(
      showConfig({ projectRoot: project(t), conclaveRoot: conclave(t, { [claude.template]: undefined }) }),
    ),
  )
  const entries = broken.registrations as { agent: string; error?: string }[]
  assert.equal(typeof entries.find((r) => r.agent === 'claude')?.error, 'string')
  assert.equal(entries.find((r) => r.agent === 'codex')?.error, undefined)
})

test('nothing is created — not the registrations, not their parent directories', (t) => {
  // The trap this guards: a report of where files WOULD go, answered by putting them
  // there. `installConfig` creates parents on the way to writing; nothing here may — and
  // computing a status is exactly the step that would tempt something into it.
  const dir = project(t, '{"permissions":"bypass"}')
  const root = conclave(t)
  const before = listing(dir)
  const rootBefore = listing(root)

  const report = showConfig({ projectRoot: dir, conclaveRoot: root })
  formatConfigShow(report)
  formatConfigShowJson(report)

  assert.deepEqual(listing(dir), before)
  assert.deepEqual(listing(root), rootBefore, 'nor is anything written back to Conclave')
  assert.ok(!before.includes('.claude'), 'the fixture never had one, and still must not')
  assert.ok(!before.includes('.codex'))
  assert.ok(report.registrations.every((r) => r.status === 'missing'))

  // Repeated on a checkout that IS rendered: an existing registration is read, never
  // rewritten. Rewriting identical bytes would re-hash the Codex handler and drop trust.
  const codex = TARGETS.find((t) => t.agent === 'codex')!
  const dest = join(dir, codex.output)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, rendered(codex, root))
  const stamped = listing(dir)
  const bytes = readFileSync(dest, 'utf8')

  formatConfigShow(showConfig({ projectRoot: dir, conclaveRoot: root }))

  assert.deepEqual(listing(dir), stamped)
  assert.equal(readFileSync(dest, 'utf8'), bytes)
})

test('the CLI routes `config show`, defaults to prose, and never writes', (t) => {
  // Spawned for real: flag routing, which renderer reaches stdout and the exit code are
  // precisely what the module tests cannot see. A `mkdir` anywhere in the command's call
  // graph would also be invisible above, and shows up here.
  const dir = project(t, '{"agents":{"claude":{"permissions":"bypass"}}}')
  const before = listing(dir)
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, 'config', 'show', ...args], { cwd: dir, encoding: 'utf8' })

  const prose = run()
  assert.equal(prose.status, 0, prose.stderr)
  assert.throws(() => JSON.parse(prose.stdout), 'prose is the default')
  assert.ok(prose.stdout.includes(`project: ${dir}`))
  assert.ok(prose.stdout.includes('claude: bypass'))
  assert.ok(prose.stdout.includes('codex: ask'))

  // An unregistered project, through the real templates in this checkout: everything is
  // missing, and the command still exits zero rather than treating that as a failure.
  assert.match(prose.stdout, /missing +Claude project hooks/)
  assert.match(prose.stdout, /missing +Codex sidecar/)

  const json = run('--json')
  assert.equal(json.status, 0, json.stderr)
  // The whole stream parses: a stray log line beside valid JSON makes the mode useless.
  const report = JSON.parse(json.stdout)
  assert.equal(report.projectRoot, dir)
  assert.deepEqual(report.permissions, { claude: 'bypass', codex: 'ask' })
  const codexReg = report.registrations.find((r: { agent: string }) => r.agent === 'codex')
  assert.equal(codexReg?.path, join(dir, '.codex', 'hooks.json'))
  assert.equal(codexReg?.exists, false)
  assert.equal(codexReg?.status, 'missing')

  assert.deepEqual(listing(dir), before, 'two runs of `show` left the project untouched')

  // Now register one for real — this checkout's own template, rendered against this
  // checkout — and the same command reports it as current. Doing it end to end is the
  // point: a status computed against a template the module resolved differently from the
  // way the CLI resolves it would be wrong in exactly the way nothing else would catch.
  const claude = TARGETS.find((t) => t.agent === 'claude')!
  const template = readFileSync(join(REPO, claude.template), 'utf8')
  const dest = join(dir, claude.output)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, template.split(TEMPLATE_TOKEN).join(resolveConclaveRoot()))

  const current = JSON.parse(run('--json').stdout)
  assert.equal(
    current.registrations.find((r: { agent: string }) => r.agent === 'claude')?.status,
    'current',
  )

  writeFileSync(dest, '{"hooks":{}}')
  const drifted = run()
  assert.equal(drifted.status, 0, 'drift is reported, not gated on — that is `config check`')
  assert.match(drifted.stdout, /drifted +Claude project hooks/)
  assert.equal(readFileSync(dest, 'utf8'), '{"hooks":{}}', 'and `show` did not repair it')
})
