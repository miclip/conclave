/**
 * Config rendering.
 *
 * No CLI is spawned here and nothing outside a temp directory is touched, so these run in
 * the default suite.
 *
 *   node --test src/config/install.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  formatInstallResult,
  hasDrift,
  installConfig,
  render,
  renderedRootOf,
  resolveCodexProjectRoot,
  resolveConclaveRoot,
  resolveRepoRoot,
  TARGETS,
  TEMPLATE_TOKEN,
  writeAtomic,
} from './install.ts'

const REPO = resolveRepoRoot(import.meta.dirname)

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-cfg-'))
  writeFileSync(join(dir, 'package.json'), '{}')
  for (const t of TARGETS) {
    const src = join(REPO, t.template)
    const dst = join(dir, t.template)
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, readFileSync(src))
  }
  return dir
}

/** Templates only, no git -- enough to render, which is all most tests need. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

/**
 * A real main worktree plus a real linked worktree, because the distinction this
 * exercises is one git makes on disk (`.git` as a file rather than a directory). A
 * hand-built fake would test the mock.
 */
function fixtureWorktreePair(): { main: string; linked: string } {
  const main = fixtureRepo()
  git(main, 'init', '--quiet', '--initial-branch=main')
  git(main, 'config', 'user.email', 'test@example.invalid')
  git(main, 'config', 'user.name', 'Test')
  git(main, 'add', '-A')
  git(main, 'commit', '--quiet', '-m', 'templates')
  const linked = join(main, '..', `linked-${Date.now().toString(36)}`)
  git(main, 'worktree', 'add', '--quiet', '--detach', linked)
  return { main, linked: realpathSync(linked) }
}

test('every template carries the substitution token', () => {
  // A template without it would render identically on every machine, which is exactly
  // the bug this whole mechanism exists to remove.
  for (const t of TARGETS) {
    const text = readFileSync(join(REPO, t.template), 'utf8')
    assert.ok(text.includes(TEMPLATE_TOKEN), `${t.template} has no ${TEMPLATE_TOKEN}`)
  }
})

test('no template contains a hardcoded home directory', () => {
  for (const t of TARGETS) {
    const text = readFileSync(join(REPO, t.template), 'utf8')
    assert.ok(!/\/Users\/|\/home\//.test(text), `${t.template} contains an absolute home path`)
  }
})

test('render substitutes every occurrence and yields valid JSON', () => {
  const out = render(`{"a":"${TEMPLATE_TOKEN}/x","b":"${TEMPLATE_TOKEN}/y"}`, '/repo')
  assert.equal(out, '{"a":"/repo/x","b":"/repo/y"}')
  assert.deepEqual(JSON.parse(out), { a: '/repo/x', b: '/repo/y' })
})

test('render refuses a template with no token', () => {
  assert.throws(() => render('{"a":1}', '/repo'), /no \{\{CONCLAVE_ROOT\}\}/)
})

test('render refuses to emit invalid JSON', () => {
  // An unparseable sidecar makes Codex load no hooks at all, which presents as a
  // lifecycle problem rather than a config one. Fail at render instead.
  assert.throws(() => render(`{"a": "${TEMPLATE_TOKEN}"`, '/repo'), /JSON/)
})

test('installing renders both targets, and is idempotent', async () => {
  const repo = fixtureRepo()

  const first = await installConfig({ projectRoot: repo, conclaveRoot: repo, diagnose: false })
  assert.equal(first.written.length, TARGETS.length)
  assert.ok(first.written.every((w) => w.changed))

  for (const t of TARGETS) {
    const text = readFileSync(join(repo, t.output), 'utf8')
    assert.ok(text.includes(repo), 'the checkout path must be substituted in')
    assert.ok(!text.includes(TEMPLATE_TOKEN), 'no token may survive rendering')
    JSON.parse(text)
  }

  // Second run must report unchanged. Rewriting identical bytes would be harmless for
  // Claude and actively wrong for Codex if it ever touched the handler.
  const second = await installConfig({ projectRoot: repo, conclaveRoot: repo, diagnose: false })
  assert.ok(second.written.every((w) => !w.changed))
})

test('rendering is checkout-relative, so two checkouts differ', async () => {
  const a = fixtureRepo()
  const b = fixtureRepo()
  await installConfig({ projectRoot: a, conclaveRoot: a, diagnose: false })
  await installConfig({ projectRoot: b, conclaveRoot: b, diagnose: false })

  const readA = readFileSync(join(a, '.codex/hooks.json'), 'utf8')
  const readB = readFileSync(join(b, '.codex/hooks.json'), 'utf8')
  assert.notEqual(readA, readB)
  assert.ok(readA.includes(a) && readB.includes(b))
  // Which is why each checkout must trust its own hooks: the command string is part of
  // the handler Codex hashes.
})

/** A project with no Conclave in it: package.json and nothing else. The common case. */
function fixtureProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-target-'))
  writeFileSync(join(dir, 'package.json'), '{}')
  return dir
}

test('registering a project that is not Conclave writes there and runs from here', async () => {
  // The capability the CLI on PATH exists for. The target has no templates, no
  // `src/hooks/client.ts`, and no dependency on Conclave -- which is exactly why the
  // rendered commands must point back at Conclave rather than at the project.
  const conclave = fixtureRepo()
  const project = fixtureProject()

  const result = await installConfig({ projectRoot: project, conclaveRoot: conclave, diagnose: false })

  assert.equal(result.selfHosted, false)
  assert.equal(result.projectRoot, project)
  assert.equal(result.conclaveRoot, conclave)

  // Registrations land in the project...
  for (const t of TARGETS) {
    assert.equal(existsSync(join(project, t.output)), true, `${t.output} belongs in the project`)
    assert.equal(existsSync(join(conclave, t.output)), false, 'and not in Conclave')
  }

  // ...and every command in them runs Conclave's code, not something the project lacks.
  const sidecar = readFileSync(join(project, '.codex/hooks.json'), 'utf8')
  const claude = readFileSync(join(project, '.claude/settings.json'), 'utf8')
  assert.ok(sidecar.includes(`node ${conclave}/src/hooks/client.ts`))
  assert.ok(claude.includes(`${conclave}/spikes/hooks/hook_post.py`))
  assert.ok(!sidecar.includes(project), 'the project path must not appear in a command')
  assert.ok(!claude.includes(project))
})

test('the same Conclave registers many projects, each with its own trust identity', async () => {
  const conclave = fixtureRepo()
  const one = fixtureProject()
  const two = fixtureProject()
  await installConfig({ projectRoot: one, conclaveRoot: conclave, diagnose: false })
  await installConfig({ projectRoot: two, conclaveRoot: conclave, diagnose: false })

  const a = readFileSync(join(one, '.codex/hooks.json'), 'utf8')
  const b = readFileSync(join(two, '.codex/hooks.json'), 'utf8')
  // Byte-identical, because the command is Conclave's in both. Codex keys trust by
  // sidecar PATH as well as content, so these are still two separate trust decisions --
  // which is the thing an operator has to be told once per project, not once ever.
  assert.equal(a, b)
})

test('naming one CLI registers only that one', async () => {
  // Both roles filled by Claude is a real configuration, and writing a Codex sidecar for
  // it is not merely untidy: the sidecar would then need TRUSTING before anything
  // reported ready, inventing a setup step for a CLI the session never launches.
  const conclave = fixtureRepo()
  const project = fixtureProject()

  const result = await installConfig({
    projectRoot: project,
    conclaveRoot: conclave,
    agents: ['claude'],
    diagnose: false,
  })

  assert.deepEqual(result.agents, ['claude'])
  assert.deepEqual(
    result.written.map((w) => w.label),
    ['Claude project hooks'],
  )
  assert.equal(existsSync(join(project, '.claude/settings.json')), true)
  assert.equal(existsSync(join(project, '.codex/hooks.json')), false, 'no sidecar for an unused CLI')
})

test('a repeated CLI is registered once, not twice', async () => {
  // What a session passes when the same CLI fills both roles.
  const conclave = fixtureRepo()
  const project = fixtureProject()
  const result = await installConfig({
    projectRoot: project,
    conclaveRoot: conclave,
    agents: ['codex', 'codex'],
    diagnose: false,
  })
  assert.deepEqual(result.agents, ['codex'])
  assert.equal(result.written.length, 1)
})

test('a Claude-only install never asks Codex anything', async () => {
  // `diagnose: true` would normally spawn `codex app-server`. With no Codex sidecar
  // written, diagnosing would report the file we deliberately skipped as missing — so the
  // report carries no Codex section at all rather than a misleading one.
  const conclave = fixtureRepo()
  const project = fixtureProject()
  const result = await installConfig({
    projectRoot: project,
    conclaveRoot: conclave,
    agents: ['claude'],
    diagnose: true,
  })
  assert.equal(result.codex, undefined)
  assert.ok(!formatInstallResult(result).includes('Codex'))
})

test('a project missing its templates blames Conclave, not the project', async () => {
  // The old message said "the checkout is incomplete", which pointed the reader at the
  // repository they were standing in — the one place that is guaranteed not to be at fault.
  const project = fixtureProject()
  const brokenConclave = mkdtempSync(join(tmpdir(), 'conclave-broken-'))
  await assert.rejects(
    () => installConfig({ projectRoot: project, conclaveRoot: brokenConclave, diagnose: false }),
    (e: Error) => e.message.includes(brokenConclave) && !e.message.includes(project),
  )
})

test('a plain checkout is its own Codex project root', () => {
  const repo = fixtureRepo()
  // No `.git` at all, and a normal checkout with a `.git` directory: neither has
  // anywhere else to redirect to, and neither should cost a git invocation.
  assert.equal(resolveCodexProjectRoot(repo), repo)
  git(repo, 'init', '--quiet')
  assert.equal(resolveCodexProjectRoot(repo), repo)
})

test('a linked worktree resolves its Codex project root to the MAIN worktree', () => {
  const { main, linked } = fixtureWorktreePair()
  assert.equal(statSync(join(linked, '.git')).isFile(), true, 'a linked worktree has a .git file')
  assert.equal(resolveCodexProjectRoot(linked), realpathSync(main))
  assert.equal(resolveCodexProjectRoot(main), main, 'the main worktree still resolves to itself')
})

test('installing from a linked worktree puts the sidecar where Codex will read it', async () => {
  // The regression this guards: rendering the sidecar into the linked worktree writes a
  // file that looks installed, and that Codex never reads. `hooks/list` then reports the
  // main worktree's registration -- or none -- and the hooks silently do not run.
  const { main, linked } = fixtureWorktreePair()
  const result = await installConfig({ projectRoot: linked, conclaveRoot: linked, diagnose: false })

  assert.equal(result.codexProjectRoot, realpathSync(main))
  assert.equal(
    result.written.find((w) => w.label === 'Codex sidecar')!.path,
    join(realpathSync(main), '.codex/hooks.json'),
  )
  assert.equal(
    existsSync(join(linked, '.codex/hooks.json')),
    false,
    'writing it into the linked worktree is the bug, not a harmless extra copy',
  )

  // Claude has no such indirection: it reads settings from the working directory.
  assert.equal(existsSync(join(linked, '.claude/settings.json')), true)

  // The command must still run the LINKED checkout's code -- only the file moved.
  const sidecar = readFileSync(join(realpathSync(main), '.codex/hooks.json'), 'utf8')
  assert.ok(sidecar.includes(`${linked}/src/hooks/client.ts`))
  assert.ok(!sidecar.includes(`${realpathSync(main)}/src/hooks/client.ts`))
})

test('a missing template fails loudly rather than rendering nothing', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'conclave-empty-'))
  writeFileSync(join(repo, 'package.json'), '{}')
  await assert.rejects(() => installConfig({ projectRoot: repo, conclaveRoot: repo, diagnose: false }), /missing template/)
})

test('writeAtomic leaves no temporary file behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-atomic-'))
  const target = join(dir, 'nested', 'out.json')
  writeAtomic(target, '{"ok":true}')
  assert.equal(readFileSync(target, 'utf8'), '{"ok":true}')
  assert.deepEqual(
    readdirSync(join(dir, 'nested')).filter((f) => f.includes('tmp-')),
    [],
    'a half-written registration must never be visible to a CLI',
  )
})

test('resolveRepoRoot finds this checkout', () => {
  assert.ok(existsSync(join(REPO, 'package.json')))
  assert.ok(existsSync(join(REPO, 'config', 'templates')))
})

test('a bare directory is its own project root rather than an error', () => {
  // Neither git nor a package.json anywhere above it. Refusing here would deny a session
  // in an ordinary scratch directory the only thing that gives it a completion signal.
  const bare = mkdtempSync(join(tmpdir(), 'conclave-bare-'))
  // The directory as given, not its realpath: this answers "which project", and resolving
  // symlinks would silently relocate a project reached through one.
  assert.equal(resolveRepoRoot(bare), bare)
})

test('resolveConclaveRoot survives being reached through a symlink', () => {
  // The CLI is expected to be on PATH as a symlink, whose own directory holds no
  // templates. Resolution must follow the link to the real checkout.
  assert.equal(resolveConclaveRoot(), realpathSync(REPO))
  for (const t of TARGETS) assert.ok(existsSync(join(resolveConclaveRoot(), t.template)))
})

test('a dry run detects a perturbed registration, and does not repair it', async () => {
  // This replaces a test that compared THIS CHECKOUT's installed registrations against its
  // templates. That test was ambient: its verdict came from the directory it happened to run
  // in rather than from anything the suite set up. In a Conclave seat worktree it failed
  // unconditionally -- registrations are git-ignored, so a seat checkout never has them, and
  // every seat reported drift with no change behind it. A test whose result depends on where
  // it is run cannot be acted on, because a failure does not say what to change.
  //
  // The PROPERTY it guarded is real and is kept: a dry run must notice that what is installed
  // no longer matches what the templates render, and must not fix it on the way past. Here
  // that is arranged rather than found -- install, perturb, observe.
  //
  // The live signal that this checkout's own registrations are current now lives in `config
  // check`, which is a command an operator or CI runs against a specific root, and which
  // reports `not_applicable` in a seat worktree instead of red. See src/config/checkCli.test.ts.
  const repo = fixtureRepo()
  const opts = { projectRoot: repo, conclaveRoot: repo, diagnose: false } as const

  const installed = await installConfig(opts)
  assert.ok(installed.written.every((w) => w.changed), 'a bare fixture starts unregistered')
  assert.equal(hasDrift(await installConfig({ ...opts, dryRun: true })), false, 'and is clean after')

  // The Codex sidecar, because it is the one whose rewrite costs a trust decision -- the
  // reason a check must report rather than repair.
  const sidecar = join(repo, '.codex', 'hooks.json')
  const perturbed = readFileSync(sidecar, 'utf8').replace('"timeout": 10', '"timeout": 11')
  assert.notEqual(perturbed, readFileSync(sidecar, 'utf8'), 'the perturbation must actually change it')
  writeFileSync(sidecar, perturbed)

  const checked = await installConfig({ ...opts, dryRun: true })
  assert.equal(hasDrift(checked), true, 'a changed registration is drift')
  const codex = checked.written.find((w) => w.label === 'Codex sidecar')
  assert.equal(codex?.changed, true)
  // Not SHARED: an edited file cannot be reconstructed as this template rendered against any
  // root, so the ownership exemption must not swallow it.
  assert.equal(codex?.sharedWith, undefined, 'a perturbed file is drift, not another owner')
  assert.equal(readFileSync(sidecar, 'utf8'), perturbed, 'a dry run must not repair what it reports')
})

test('a dry run detects a template that has moved away from what is installed', async () => {
  // The other direction, and the one the original ambient test was written for: the
  // registrations are untouched and the TEMPLATE changed, which is what happens when someone
  // edits config/templates/ and does not re-run the installer.
  const repo = fixtureRepo()
  const opts = { projectRoot: repo, conclaveRoot: repo, diagnose: false } as const
  await installConfig(opts)
  assert.equal(hasDrift(await installConfig({ ...opts, dryRun: true })), false)

  const template = join(repo, 'config', 'templates', 'codex-hooks.json')
  writeFileSync(template, readFileSync(template, 'utf8').replace('"timeout": 3', '"timeout": 4'))

  const checked = await installConfig({ ...opts, dryRun: true })
  assert.equal(hasDrift(checked), true, 'an edited template drifts from the installed file')
  assert.equal(checked.written.find((w) => w.label === 'Codex sidecar')?.sharedWith, undefined)
})

test('a registration owned by another Conclave is not reported as drift', () => {
  // Two different conditions that a byte comparison cannot tell apart, wanting opposite
  // responses. Drift means "rewrite this"; shared means "rewriting this hijacks a file
  // another worktree depends on, and kills its Codex trust on the way past".
  const template = readFileSync(join(REPO, 'config/templates/codex-hooks.json'), 'utf8')

  const mine = render(template, '/opt/conclave')
  assert.equal(renderedRootOf(template, mine), '/opt/conclave')

  const theirs = render(template, '/opt/elsewhere/conclave-dogfood')
  assert.equal(
    renderedRootOf(template, theirs),
    '/opt/elsewhere/conclave-dogfood',
    'the owning checkout must be recoverable from the file itself',
  )

  // A template that genuinely changed cannot reconstruct against any root, so it stays
  // drift. This is the half that stops the exemption swallowing real drift.
  const drifted = `${theirs.slice(0, -2)}, "extra": 1}`
  assert.equal(renderedRootOf(template, drifted), undefined)
})

test('a shared registration says what running the installer would cost', async () => {
  // The first version called this DRIFT, which sent the reader to `config install` -- and
  // running it is exactly what hijacks the sidecar and drops the other checkout's trust.
  // A diagnostic that recommends the damage is worse than one that says nothing.
  const dir = mkdtempSync(join(tmpdir(), 'conclave-shared-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  const sidecar = join(dir, '.codex', 'hooks.json')
  mkdirSync(dirname(sidecar), { recursive: true })
  const template = readFileSync(join(REPO, 'config/templates/codex-hooks.json'), 'utf8')
  writeFileSync(sidecar, render(template, '/somewhere/else/conclave'))

  const result = await installConfig({
    projectRoot: dir,
    conclaveRoot: REPO,
    agents: ['codex'],
    diagnose: false,
    dryRun: true,
  })
  const codex = result.written.find((w) => w.label === 'Codex sidecar')
  assert.equal(codex?.sharedWith, '/somewhere/else/conclave')

  const text = formatInstallResult(result)
  assert.match(text, /SHARED/, 'shown as its own state, not as drift')
  // ...and under a REAL install the state must still say what happened to the file. It
  // used to say only `SHARED`, so an operator taking a registration over from another
  // checkout could not tell whether anything had been written without reading it.
  const wrote = formatInstallResult({ ...result, dryRun: false })
  assert.match(wrote, /wrote /, 'a real install must report the write')
  assert.match(wrote, /taken over from \/somewhere\/else\/conclave/, 'and who it took it from')
  assert.match(text, /\/somewhere\/else\/conclave/, 'and names who owns it')
  assert.match(text, /invalidates that checkout's Codex trust/, 'and what re-installing costs')
  assert.doesNotMatch(
    text,
    /Registrations differ from the templates/,
    'the drift advice must not also appear; it is the advice that causes the damage',
  )
  rmSync(dir, { recursive: true, force: true })
})

test('no tracked source file hardcodes an absolute home path', () => {
  // Guards the portability this task establishes. Deliberately exempt:
  //
  //   - the evidence corpora (spikes/hooks/{fixtures,journal,results}, spikes/codex/
  //     {runs,journal}): those are RECORDINGS of real runs, and the paths in them are
  //     part of what was observed -- transcript_path and cwd are payload fields.
  //     Rewriting them would falsify the evidence behind the conformance claims.
  //   - prose (*.md): the FINDINGS documents and docs/ discuss these paths by name,
  //     which is the point of documenting them.
  //   - rendered registrations: git-ignored, so they cannot be tracked anyway.
  const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !f.startsWith('spikes/hooks/fixtures/'))
    .filter((f) => !f.startsWith('spikes/hooks/journal/'))
    .filter((f) => !f.startsWith('spikes/codex/runs/'))
    .filter((f) => !f.startsWith('spikes/codex/journal/'))
    .filter((f) => f !== 'spikes/hooks/results.ndjson')
    .filter((f) => !f.endsWith('.md'))

  // Match a plausible real home directory, not a synthetic one. `/home/x` appears as a
  // literal in the childenv sanitizer tests and is not a portability problem, so require
  // a username of at least three characters followed by a path separator.
  const REAL_HOME = /\/(?:Users|home)\/[A-Za-z][A-Za-z0-9._-]{2,}\//

  const offenders = tracked.filter((f) => {
    const p = join(REPO, f)
    if (!existsSync(p)) return false
    return REAL_HOME.test(readFileSync(p, 'utf8'))
  })

  assert.deepEqual(
    offenders,
    [],
    `these tracked files hardcode a home directory; render them from a template instead:\n${offenders.join('\n')}`,
  )
})

test('dry run reports drift without writing', async () => {
  const repo = fixtureRepo()
  await installConfig({ projectRoot: repo, conclaveRoot: repo, diagnose: false })

  // Perturb one registration, then check without installing.
  const codexOut = join(repo, '.codex/hooks.json')
  const perturbed = readFileSync(codexOut, 'utf8').replace('"timeout": 10', '"timeout": 11')
  writeFileSync(codexOut, perturbed)

  const check = await installConfig({ projectRoot: repo, conclaveRoot: repo, diagnose: false, dryRun: true })
  assert.equal(hasDrift(check), true)
  assert.equal(
    readFileSync(codexOut, 'utf8'),
    perturbed,
    'a check must not rewrite the handler; that would re-hash it and drop Codex trust',
  )

  const install = await installConfig({ projectRoot: repo, conclaveRoot: repo, diagnose: false })
  assert.equal(hasDrift(install), true)
  assert.notEqual(readFileSync(codexOut, 'utf8'), perturbed, 'install does write')
})

test('an unchanged checkout is a true no-op, not a rewrite', async () => {
  // The property the pre-fixture guidance depends on: running install before an
  // experiment must not cause a deployment-state transition.
  const repo = fixtureRepo()
  await installConfig({ projectRoot: repo, conclaveRoot: repo, diagnose: false })
  const before = TARGETS.map((t) => statSync(join(repo, t.output)).mtimeMs)

  await new Promise((r) => setTimeout(r, 20))
  const again = await installConfig({ projectRoot: repo, conclaveRoot: repo, diagnose: false })

  assert.equal(hasDrift(again), false)
  assert.deepEqual(
    TARGETS.map((t) => statSync(join(repo, t.output)).mtimeMs),
    before,
    'identical bytes must not be rewritten; mtime must not move',
  )
})

test('registrations a project does not ignore are reported, not fixed', async () => {
  // Found by pointing Conclave at a fresh repository: these files carry absolute paths and
  // are machine-local by construction, so writing them into a repo that does not ignore
  // them leaves untracked files someone had no reason to expect. In a repo with a
  // `git add -A` habit that is a real hazard, not untidiness.
  const conclave = fixtureRepo()
  const project = fixtureProject()
  git(project, 'init', '--quiet')

  const dirty = await installConfig({ projectRoot: project, conclaveRoot: conclave, diagnose: false })
  assert.deepEqual(
    dirty.unignored.map((p) => p.replace(`${project}/`, '')).sort(),
    ['.claude/settings.json', '.codex/hooks.json'],
    'an un-ignoring repo is told which paths it will see as untracked',
  )
  assert.match(formatInstallResult(dirty), /does not ignore them/)

  // Ignored by any mechanism git honours, including ones no string match would find.
  writeFileSync(join(project, '.gitignore'), '.claude/\n.codex/\n')
  const clean = await installConfig({ projectRoot: project, conclaveRoot: conclave, diagnose: false })
  assert.deepEqual(clean.unignored, [])
  assert.ok(!formatInstallResult(clean).includes('does not ignore them'))

  // Nothing was appended on the operator's behalf: a tracked .gitignore is theirs.
  assert.equal(readFileSync(join(project, '.gitignore'), 'utf8'), '.claude/\n.codex/\n')
})

test('a project that is not a git repository reports nothing to ignore', async () => {
  // `git check-ignore` cannot answer outside a repository, and a warning nobody can act on
  // is worse than none.
  const conclave = fixtureRepo()
  const project = fixtureProject()
  const result = await installConfig({ projectRoot: project, conclaveRoot: conclave, diagnose: false })
  assert.deepEqual(result.unignored, [])
})

test('SessionEnd asks for the timeout Codex will actually honour', () => {
  // Every other handler asks for 10; Codex clamps SessionEnd to 3 and warns about it on
  // install and on every check. Asking for 10 bought a per-invocation warning and no extra
  // budget, in the channel where real diagnostics appear.
  const sidecar = JSON.parse(readFileSync(join(REPO, 'config/templates/codex-hooks.json'), 'utf8'))
  const timeoutOf = (event: string) => sidecar.hooks[event][0].hooks[0].timeout
  assert.equal(timeoutOf('SessionEnd'), 3)
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop']) {
    assert.equal(timeoutOf(event), 10, `${event} is not clamped and keeps its budget`)
  }
})

test('a linked worktree gets an empty .codex/ so Codex looks for the sidecar at all', async () => {
  // Measured on codex 0.146.0, from a linked worktree whose MAIN worktree had a valid
  // sidecar:
  //
  //   linked has no .codex directory  -> 0 hooks loaded
  //   linked has an EMPTY .codex dir  -> 5 hooks, sourced from the MAIN worktree
  //   linked has its own hooks.json   -> 5 hooks, still sourced from the main worktree
  //   main sidecar deleted            -> 0 hooks
  //
  // The directory is a TRIGGER and its contents are ignored. `resolveCodexProjectRoot` was
  // right that the file belongs in the main worktree; what was missing was the thing that
  // makes Codex go and read it. Without this, `codex` in ANY linked worktree loads no hooks,
  // has no turn-completion signal, and the preflight refuses to start a session -- with a
  // diagnostic that names neither cause.
  const main = mkdtempSync(join(tmpdir(), 'wt-main-'))
  execFileSync('git', ['init', '-q', '.'], { cwd: main })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: main })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: main })
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: main })
  const linked = join(main, '..', `wt-linked-${process.pid}`)
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'probe', linked], { cwd: main })

  await installConfig({
    projectRoot: linked,
    conclaveRoot: REPO,
    agents: ['codex'],
    diagnose: false,
  })

  // The sidecar itself belongs to the main worktree...
  assert.ok(existsSync(join(realpathSync(main), '.codex', 'hooks.json')), 'sidecar in the main worktree')
  // ...and the linked worktree needs the directory, without which Codex never looks.
  assert.ok(existsSync(join(linked, '.codex')), 'trigger directory in the linked worktree')

  execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: main })
})

test('a plain checkout gets no stray .codex directory', async () => {
  // The trigger is only needed when the roots diverge. Creating it unconditionally would
  // leave an empty directory in every project Conclave has ever registered.
  const plain = mkdtempSync(join(tmpdir(), 'wt-plain-'))
  execFileSync('git', ['init', '-q', '.'], { cwd: plain })
  await installConfig({ projectRoot: plain, conclaveRoot: REPO, agents: ['claude'], diagnose: false })
  assert.equal(existsSync(join(plain, '.codex')), false, 'no codex agent, no codex directory')
})

test('#41 the ready line says what it cannot see', async () => {
  // A run that dies with "no UserPromptSubmit hook after send" sends its operator here, and this
  // reported that everything was fine. Three states produce that death and this distinguishes
  // only two: registration and trust are static facts about configuration, and whether a handler
  // finishes inside its timeout is a fact about the machine at the moment it runs. A remedy
  // offered for the wrong cause is worse than "I do not know".
  // Built from a real install rather than a hand-made object: `formatInstallResult` reads
  // several fields, and a fixture that guesses which ones is a fixture that breaks when the
  // shape moves for unrelated reasons.
  const project = fixtureProject()
  const result = await installConfig({
    projectRoot: project,
    conclaveRoot: REPO,
    agents: ['codex'],
    diagnose: false,
    dryRun: true,
  })
  const text = formatInstallResult({ ...result, codex: { ready: true, retrustRequired: false, messages: [] } })

  assert.match(text, /loaded, enabled and trusted/, 'it still says what it did establish')
  assert.match(text, /registration and trust only/, 'and now says what it did not')
  assert.match(text, /timeout on a loaded machine/, 'naming the state it cannot see')
  assert.match(text, /attempts journal/, 'and where the answer actually is')
})
