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
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  formatInstallResult,
  hasDrift,
  installConfig,
  render,
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

test('the rendered output matches what this checkout currently has installed', async () => {
  // Guards against the templates drifting from the registrations actually in use --
  // which would silently invalidate Codex trust the next time anyone ran the installer.
  const result = await installConfig({ projectRoot: REPO, conclaveRoot: REPO, diagnose: false })
  assert.ok(
    result.written.every((w) => !w.changed),
    'templates have drifted from the installed registrations; run `npm run config:install`',
  )
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
