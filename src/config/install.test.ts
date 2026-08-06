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
  hasDrift,
  installConfig,
  render,
  resolveCodexProjectRoot,
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
  assert.throws(() => render('{"a":1}', '/repo'), /no \{\{REPO_ROOT\}\}/)
})

test('render refuses to emit invalid JSON', () => {
  // An unparseable sidecar makes Codex load no hooks at all, which presents as a
  // lifecycle problem rather than a config one. Fail at render instead.
  assert.throws(() => render(`{"a": "${TEMPLATE_TOKEN}"`, '/repo'), /JSON/)
})

test('installing renders both targets, and is idempotent', async () => {
  const repo = fixtureRepo()

  const first = await installConfig({ repoRoot: repo, diagnose: false })
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
  const second = await installConfig({ repoRoot: repo, diagnose: false })
  assert.ok(second.written.every((w) => !w.changed))
})

test('rendering is checkout-relative, so two checkouts differ', async () => {
  const a = fixtureRepo()
  const b = fixtureRepo()
  await installConfig({ repoRoot: a, diagnose: false })
  await installConfig({ repoRoot: b, diagnose: false })

  const readA = readFileSync(join(a, '.codex/hooks.json'), 'utf8')
  const readB = readFileSync(join(b, '.codex/hooks.json'), 'utf8')
  assert.notEqual(readA, readB)
  assert.ok(readA.includes(a) && readB.includes(b))
  // Which is why each checkout must trust its own hooks: the command string is part of
  // the handler Codex hashes.
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
  const result = await installConfig({ repoRoot: linked, diagnose: false })

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
  await assert.rejects(() => installConfig({ repoRoot: repo, diagnose: false }), /missing template/)
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

test('the rendered output matches what this checkout currently has installed', async () => {
  // Guards against the templates drifting from the registrations actually in use --
  // which would silently invalidate Codex trust the next time anyone ran the installer.
  const result = await installConfig({ repoRoot: REPO, diagnose: false })
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
  //   - prose (*.md): TODO.md and the FINDINGS documents discuss these paths by name,
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
  await installConfig({ repoRoot: repo, diagnose: false })

  // Perturb one registration, then check without installing.
  const codexOut = join(repo, '.codex/hooks.json')
  const perturbed = readFileSync(codexOut, 'utf8').replace('"timeout": 10', '"timeout": 11')
  writeFileSync(codexOut, perturbed)

  const check = await installConfig({ repoRoot: repo, diagnose: false, dryRun: true })
  assert.equal(hasDrift(check), true)
  assert.equal(
    readFileSync(codexOut, 'utf8'),
    perturbed,
    'a check must not rewrite the handler; that would re-hash it and drop Codex trust',
  )

  const install = await installConfig({ repoRoot: repo, diagnose: false })
  assert.equal(hasDrift(install), true)
  assert.notEqual(readFileSync(codexOut, 'utf8'), perturbed, 'install does write')
})

test('an unchanged checkout is a true no-op, not a rewrite', async () => {
  // The property the pre-fixture guidance depends on: running install before an
  // experiment must not cause a deployment-state transition.
  const repo = fixtureRepo()
  await installConfig({ repoRoot: repo, diagnose: false })
  const before = TARGETS.map((t) => statSync(join(repo, t.output)).mtimeMs)

  await new Promise((r) => setTimeout(r, 20))
  const again = await installConfig({ repoRoot: repo, diagnose: false })

  assert.equal(hasDrift(again), false)
  assert.deepEqual(
    TARGETS.map((t) => statSync(join(repo, t.output)).mtimeMs),
    before,
    'identical bytes must not be rewritten; mtime must not move',
  )
})
