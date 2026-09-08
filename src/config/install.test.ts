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
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'
import { legacyInstallRootOf } from './legacyRegistration.ts'
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
  understandsHook,
  writeAtomic,
} from './install.ts'

const REPO = resolveRepoRoot(import.meta.dirname)

function fixtureRepo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-cfg')
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
function fixtureWorktreePair(t: TestContext): { main: string; linked: string } {
  const main = fixtureRepo(t)
  git(main, 'init', '--quiet', '--initial-branch=main')
  git(main, 'config', 'user.email', 'test@example.invalid')
  git(main, 'config', 'user.name', 'Test')
  git(main, 'add', '-A')
  git(main, 'commit', '--quiet', '-m', 'templates')
  // Inside a container the testkit issued, rather than beside `main` in the temp root. A
  // sibling is nobody's to remove: `main` is cleaned up because the helper made it, and a
  // directory one level up from it is simply orphaned -- which is what this used to leave
  // behind on every run, passing or failing.
  const linked = join(tempDir(t, 'linked-worktree'), 'linked')
  git(main, 'worktree', 'add', '--quiet', '--detach', linked)
  return { main, linked: realpathSync(linked) }
}

test('#258 every template invokes the CLI by name and pins no install directory', () => {
  // The inverse of what this asserted before, and the inversion IS the fix. It used to
  // require the substitution token in every template, reasoning that a template without
  // one "would render identically on every machine". Rendering identically everywhere is
  // now the point: `conclaveRoot` was a single checkout when that rule was written, and
  // since #250 it is `conclave-releases/v<version>` — a new directory every release. A
  // project registered on one release kept firing that release's hook code indefinitely,
  // or stopped firing when `--prune-install` removed the directory.
  for (const t of TARGETS) {
    const text = readFileSync(join(REPO, t.template), 'utf8')
    assert.ok(text.includes(`conclave hook ${t.agent}`), `${t.template} must invoke \`conclave hook ${t.agent}\``)
    assert.ok(!text.includes(TEMPLATE_TOKEN), `${t.template} must not render an install path`)
    // The two spellings that carried one. Named individually rather than by matching the
    // token, because a template could reach an install directory without going through it.
    assert.ok(!text.includes('spikes/hooks/hook_post.py'), `${t.template} still names the spike client`)
    assert.ok(!text.includes('src/hooks/client.ts'), `${t.template} still names a path inside the install`)
  }
})

test('#258 the same registration renders byte-identically from any release root', async (t) => {
  // The property every other claim here rests on. Two Conclaves standing in for two
  // releases -- which is what an upgrade produces -- must write the same bytes into a
  // project, or the registration is pinned to whichever one ran last.
  const releaseA = fixtureRepo(t)
  const releaseB = fixtureRepo(t)
  const project = fixtureProject(t)

  await installConfig({ projectRoot: project, conclaveRoot: releaseA, diagnose: false })
  const first = TARGETS.map((t) => readFileSync(join(project, t.output), 'utf8'))

  const second = await installConfig({ projectRoot: project, conclaveRoot: releaseB, diagnose: false })
  assert.deepEqual(
    TARGETS.map((t) => readFileSync(join(project, t.output), 'utf8')),
    first,
    'a second release must not rewrite a registration the first one wrote',
  )
  // And says so: an upgrade that rewrote these would re-hash the Codex handlers and cost
  // the operator a re-trust on every release.
  assert.ok(second.written.every((w) => !w.changed), 'upgrading must be a no-op for registrations')
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

test('render copies a tokenless template through, and still validates it', () => {
  // This used to assert the opposite: `render` threw on a template with no token, on the
  // grounds that it would render identically everywhere. Both shipped templates have no
  // token now and identical rendering is the fix, so the refusal had to go -- but the JSON
  // check it was bundled with is the half that was earning its keep, because an
  // unparseable sidecar makes Codex load no hooks at all.
  assert.equal(render('{"a":1}', '/repo'), '{"a":1}')
  assert.throws(() => render('{"a":1', '/repo'), /JSON/)
  // Substitution still works for a template that does carry one.
  assert.equal(render(`{"a":"${TEMPLATE_TOKEN}/x"}`, '/repo'), '{"a":"/repo/x"}')
})

test('render refuses to emit invalid JSON', () => {
  // An unparseable sidecar makes Codex load no hooks at all, which presents as a
  // lifecycle problem rather than a config one. Fail at render instead.
  assert.throws(() => render(`{"a": "${TEMPLATE_TOKEN}"`, '/repo'), /JSON/)
})

test('installing renders both targets, and is idempotent', async (t) => {
  const repo = fixtureRepo(t)

  const first = await installConfig({ projectRoot: repo, conclaveRoot: repo, diagnose: false })
  assert.equal(first.written.length, TARGETS.length)
  assert.ok(first.written.every((w) => w.changed))

  for (const t of TARGETS) {
    const text = readFileSync(join(repo, t.output), 'utf8')
    // No checkout path, where this used to require one. See `#258 every template invokes
    // the CLI by name`: the path was the thing that went stale on every release.
    assert.ok(!text.includes(repo), 'a registration must not name the checkout that wrote it')
    assert.ok(!text.includes(TEMPLATE_TOKEN), 'no token may survive rendering')
    JSON.parse(text)
  }

  // Second run must report unchanged. Rewriting identical bytes would be harmless for
  // Claude and actively wrong for Codex if it ever touched the handler.
  const second = await installConfig({ projectRoot: repo, conclaveRoot: repo, diagnose: false })
  assert.ok(second.written.every((w) => !w.changed))
})

test('#258 rendering is NOT checkout-relative: two checkouts write the same bytes', async (t) => {
  // The reverse of what this asserted, and the reversal is the point. Two checkouts
  // producing different registrations is what made an upgrade a silent downgrade: the
  // project kept whichever release's path was written first.
  const a = fixtureRepo(t)
  const b = fixtureRepo(t)
  await installConfig({ projectRoot: a, conclaveRoot: a, diagnose: false })
  await installConfig({ projectRoot: b, conclaveRoot: b, diagnose: false })

  const readA = readFileSync(join(a, '.codex/hooks.json'), 'utf8')
  const readB = readFileSync(join(b, '.codex/hooks.json'), 'utf8')
  assert.equal(readA, readB)
  assert.ok(!readA.includes(a) && !readB.includes(b), 'neither names the checkout that wrote it')
  // A project still trusts its own hooks once: Codex keys trust by sidecar PATH as well as
  // by handler content, so identical bytes in two projects are still two decisions. What
  // changed is that upgrading Conclave no longer costs a THIRD.
})

/** A project with no Conclave in it: package.json and nothing else. The common case. */
function fixtureProject(t: TestContext): string {
  const dir = tempDir(t, 'conclave-target')
  writeFileSync(join(dir, 'package.json'), '{}')
  return dir
}

test('registering a project that is not Conclave writes there and runs from here', async (t) => {
  // The capability the CLI on PATH exists for. The target has no templates, no
  // `src/hooks/client.ts`, and no dependency on Conclave -- which is exactly why the
  // rendered commands must run Conclave's own client rather than something the project is
  // expected to provide. They reach it through `conclave` on PATH, so the command names
  // neither the project nor the release that wrote it.
  const conclave = fixtureRepo(t)
  const project = fixtureProject(t)

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
  // Through the CLI on PATH rather than a path into this checkout: the project needs
  // nothing installed either way, and the name does not move when a release does (#258).
  const sidecar = readFileSync(join(project, '.codex/hooks.json'), 'utf8')
  const claude = readFileSync(join(project, '.claude/settings.json'), 'utf8')
  assert.ok(sidecar.includes('conclave hook codex'))
  assert.ok(claude.includes('conclave hook claude'))
  assert.ok(!sidecar.includes(project), 'the project path must not appear in a command')
  assert.ok(!claude.includes(project))
  assert.ok(!sidecar.includes(conclave), 'nor the release directory that wrote it')
  assert.ok(!claude.includes(conclave))
})

test('the same Conclave registers many projects, each with its own trust identity', async (t) => {
  const conclave = fixtureRepo(t)
  const one = fixtureProject(t)
  const two = fixtureProject(t)
  await installConfig({ projectRoot: one, conclaveRoot: conclave, diagnose: false })
  await installConfig({ projectRoot: two, conclaveRoot: conclave, diagnose: false })

  const a = readFileSync(join(one, '.codex/hooks.json'), 'utf8')
  const b = readFileSync(join(two, '.codex/hooks.json'), 'utf8')
  // Byte-identical, because the command is Conclave's in both. Codex keys trust by
  // sidecar PATH as well as content, so these are still two separate trust decisions --
  // which is the thing an operator has to be told once per project, not once ever.
  assert.equal(a, b)
})

test('naming one CLI registers only that one', async (t) => {
  // Both roles filled by Claude is a real configuration, and writing a Codex sidecar for
  // it is not merely untidy: the sidecar would then need TRUSTING before anything
  // reported ready, inventing a setup step for a CLI the session never launches.
  const conclave = fixtureRepo(t)
  const project = fixtureProject(t)

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

test('a repeated CLI is registered once, not twice', async (t) => {
  // What a session passes when the same CLI fills both roles.
  const conclave = fixtureRepo(t)
  const project = fixtureProject(t)
  const result = await installConfig({
    projectRoot: project,
    conclaveRoot: conclave,
    agents: ['codex', 'codex'],
    diagnose: false,
  })
  assert.deepEqual(result.agents, ['codex'])
  assert.equal(result.written.length, 1)
})

test('a Claude-only install never asks Codex anything', async (t) => {
  // `diagnose: true` would normally spawn `codex app-server`. With no Codex sidecar
  // written, diagnosing would report the file we deliberately skipped as missing — so the
  // report carries no Codex section at all rather than a misleading one.
  const conclave = fixtureRepo(t)
  const project = fixtureProject(t)
  const result = await installConfig({
    projectRoot: project,
    conclaveRoot: conclave,
    agents: ['claude'],
    diagnose: true,
  })
  assert.equal(result.codex, undefined)
  assert.ok(!formatInstallResult(result).includes('Codex'))
})

test('a project missing its templates blames Conclave, not the project', async (t) => {
  // The old message said "the checkout is incomplete", which pointed the reader at the
  // repository they were standing in — the one place that is guaranteed not to be at fault.
  const project = fixtureProject(t)
  const brokenConclave = tempDir(t, 'conclave-broken')
  await assert.rejects(
    () => installConfig({ projectRoot: project, conclaveRoot: brokenConclave, diagnose: false }),
    (e: Error) => e.message.includes(brokenConclave) && !e.message.includes(project),
  )
})

test('a plain checkout is its own Codex project root', (t) => {
  const repo = fixtureRepo(t)
  // No `.git` at all, and a normal checkout with a `.git` directory: neither has
  // anywhere else to redirect to, and neither should cost a git invocation.
  assert.equal(resolveCodexProjectRoot(repo), repo)
  git(repo, 'init', '--quiet')
  assert.equal(resolveCodexProjectRoot(repo), repo)
})

test('a linked worktree resolves its Codex project root to the MAIN worktree', (t) => {
  const { main, linked } = fixtureWorktreePair(t)
  assert.equal(statSync(join(linked, '.git')).isFile(), true, 'a linked worktree has a .git file')
  assert.equal(resolveCodexProjectRoot(linked), realpathSync(main))
  assert.equal(resolveCodexProjectRoot(main), main, 'the main worktree still resolves to itself')
})

test('installing from a linked worktree puts the sidecar where Codex will read it', async (t) => {
  // The regression this guards: rendering the sidecar into the linked worktree writes a
  // file that looks installed, and that Codex never reads. `hooks/list` then reports the
  // main worktree's registration -- or none -- and the hooks silently do not run.
  const { main, linked } = fixtureWorktreePair(t)
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

  // Only the file moved. The command names no checkout at all now, which is what retires
  // #40's worktree conflict along the way: a linked worktree and its main worktree render
  // the same sidecar, so neither can hijack the other's Codex trust by re-installing.
  const sidecar = readFileSync(join(realpathSync(main), '.codex/hooks.json'), 'utf8')
  assert.ok(sidecar.includes('conclave hook codex'))
  assert.ok(!sidecar.includes(linked))
  assert.ok(!sidecar.includes(realpathSync(main)))
})

test('a missing template fails loudly rather than rendering nothing', async (t) => {
  const repo = tempDir(t, 'conclave-empty')
  writeFileSync(join(repo, 'package.json'), '{}')
  await assert.rejects(() => installConfig({ projectRoot: repo, conclaveRoot: repo, diagnose: false }), /missing template/)
})

test('writeAtomic leaves no temporary file behind', (t) => {
  const dir = tempDir(t, 'conclave-atomic')
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

test('a bare directory is its own project root rather than an error', (t) => {
  // Neither git nor a package.json anywhere above it. Refusing here would deny a session
  // in an ordinary scratch directory the only thing that gives it a completion signal.
  const bare = tempDir(t, 'conclave-bare')
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

test('a dry run detects a perturbed registration, and does not repair it', async (t) => {
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
  const repo = fixtureRepo(t)
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

test('a dry run detects a template that has moved away from what is installed', async (t) => {
  // The other direction, and the one the original ambient test was written for: the
  // registrations are untouched and the TEMPLATE changed, which is what happens when someone
  // edits config/templates/ and does not re-run the installer.
  const repo = fixtureRepo(t)
  const opts = { projectRoot: repo, conclaveRoot: repo, diagnose: false } as const
  await installConfig(opts)
  assert.equal(hasDrift(await installConfig({ ...opts, dryRun: true })), false)

  const template = join(repo, 'config', 'templates', 'codex-hooks.json')
  writeFileSync(template, readFileSync(template, 'utf8').replace('"timeout": 3', '"timeout": 4'))

  const checked = await installConfig({ ...opts, dryRun: true })
  assert.equal(hasDrift(checked), true, 'an edited template drifts from the installed file')
  assert.equal(checked.written.find((w) => w.label === 'Codex sidecar')?.sharedWith, undefined)
})

/**
 * A template that still carries the token, kept because `renderedRootOf` still has to work
 * for one. Both SHIPPED templates lost theirs in #258; see the test below this pair, which
 * pins the consequence.
 */
// The command is deliberately NOT either historical spelling. A template rendering
// `src/hooks/client.ts` would be recognised as a legacy registration and reported as a
// migration, which is the right answer for a real one and would leave the ownership
// mechanism below untested.
const TOKENED = `{"hooks":[{"command":"${TEMPLATE_TOKEN}/bin/conclave hook codex"}]}\n`

test('a registration owned by another Conclave is not reported as drift', () => {
  // Two different conditions that a byte comparison cannot tell apart, wanting opposite
  // responses. Drift means "rewrite this"; shared means "rewriting this hijacks a file
  // another worktree depends on, and kills its Codex trust on the way past".
  //
  // Exercised against a synthetic template rather than the shipped one: the shipped
  // templates no longer substitute anything, so using one would assert nothing about the
  // reconstruction this function performs.
  const mine = render(TOKENED, '/opt/conclave')
  assert.equal(renderedRootOf(TOKENED, mine), '/opt/conclave')

  const theirs = render(TOKENED, '/opt/elsewhere/conclave-dogfood')
  assert.equal(
    renderedRootOf(TOKENED, theirs),
    '/opt/elsewhere/conclave-dogfood',
    'the owning checkout must be recoverable from the file itself',
  )

  // A template that genuinely changed cannot reconstruct against any root, so it stays
  // drift. This is the half that stops the exemption swallowing real drift.
  const drifted = `${theirs.slice(0, -2)}, "extra": 1}`
  assert.equal(renderedRootOf(TOKENED, drifted), undefined)
})

test('#258 a stable registration has no owning checkout to recover', () => {
  // The consequence of the templates losing their token, stated so it is a decision rather
  // than something noticed later: nothing can be reconstructed as "rendered against root X"
  // when no root was substituted, so no shipped registration is ever owned by a checkout.
  // That is what retires the SHARED case in practice -- a file two worktrees share now
  // contains the same bytes whichever wrote it, so there is nothing to hijack.
  for (const t of TARGETS) {
    const template = readFileSync(join(REPO, t.template), 'utf8')
    assert.equal(
      renderedRootOf(template, template),
      undefined,
      `${t.template} must not be attributable to a checkout`,
    )
  }
})

test('#258 a registration from an older Conclave is recognised by the path baked into it', () => {
  // Both historical spellings, because an operator upgrading today may be carrying either:
  // Claude's registration pointed at the spike's Python client until this change, and the
  // Codex sidecar moved to `src/hooks/client.ts` before it.
  assert.equal(
    legacyInstallRootOf('{"command": "/home/x/.local/share/conclave-releases/v0.5.29/spikes/hooks/hook_post.py claude"}'),
    '/home/x/.local/share/conclave-releases/v0.5.29',
  )
  assert.equal(
    legacyInstallRootOf('{"command": "node /opt/conclave/src/hooks/client.ts codex"}'),
    '/opt/conclave',
  )
  // What must NOT be claimed. A stable registration names no root; a project's own
  // unrelated hook is not ours to report on; and a relative path was never something these
  // templates rendered, so matching one would misattribute somebody else's script.
  assert.equal(legacyInstallRootOf('{"command": "conclave hook claude"}'), undefined)
  assert.equal(legacyInstallRootOf('{"command": "/usr/local/bin/their-own-hook.sh"}'), undefined)
  assert.equal(legacyInstallRootOf('{"command": "node ./src/hooks/client.ts codex"}'), undefined)
})

/**
 * A Conclave whose Codex template still carries the token, for the ownership case only.
 *
 * Both shipped templates lost theirs in #258, so a checkout can no longer OWN a shipped
 * registration -- see `#258 a stable registration has no owning checkout to recover`. The
 * mechanism is still here and still correct for a template that substitutes, so it is
 * exercised against one that does rather than against a file it can say nothing about.
 */
function fixtureRepoWithTokenedCodex(t: TestContext): string {
  const dir = fixtureRepo(t)
  writeFileSync(join(dir, 'config/templates/codex-hooks.json'), TOKENED)
  return dir
}

test('a shared registration says what running the installer would cost', async (t) => {
  // The first version called this DRIFT, which sent the reader to `config install` -- and
  // running it is exactly what hijacks the sidecar and drops the other checkout's trust.
  // A diagnostic that recommends the damage is worse than one that says nothing.
  const dir = tempDir(t, 'conclave-shared')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  const sidecar = join(dir, '.codex', 'hooks.json')
  mkdirSync(dirname(sidecar), { recursive: true })
  const conclaveRoot = fixtureRepoWithTokenedCodex(t)
  writeFileSync(sidecar, render(TOKENED, '/somewhere/else/conclave'))

  const result = await installConfig({
    projectRoot: dir,
    conclaveRoot,
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
})

test('#258 an old registration is a migration, not another checkout to defer to', async (t) => {
  // The two findings collide exactly here, and the order matters. A sidecar written by an
  // older Conclave IS reconstructible as "this template rendered against another root",
  // which is the shape `sharedWith` was built to recognise -- and deferring to it is the
  // wrong answer twice over: it is not a rival checkout, it is this project's own
  // registration one release behind, and leaving it in place is the quiet failure in #258
  // rather than a fix for it.
  const dir = tempDir(t, 'conclave-legacy')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  const sidecar = join(dir, '.codex', 'hooks.json')
  mkdirSync(dirname(sidecar), { recursive: true })
  const old = '/home/x/.local/share/conclave-releases/v0.5.29'
  writeFileSync(sidecar, `{"hooks":[{"command":"node ${old}/src/hooks/client.ts codex"}]}\n`)

  const checked = await installConfig({
    projectRoot: dir,
    conclaveRoot: REPO,
    agents: ['codex'],
    diagnose: false,
    dryRun: true,
  })
  const codex = checked.written.find((w) => w.label === 'Codex sidecar')
  assert.equal(codex?.changed, true, 'it must still be reported as changing')
  assert.equal(codex?.replaces, old, 'and named as pinned to the release it came from')
  assert.equal(codex?.sharedWith, undefined, 'never deferred to as another checkout')

  const text = formatInstallResult(checked)
  assert.match(text, /STALE/, 'shown as its own state, not as drift and not as SHARED')
  assert.doesNotMatch(text, /SHARED/)
  // Nothing has been replaced yet, and a check claiming otherwise is a check an operator
  // stops trusting the moment they open the file.
  assert.doesNotMatch(text, /replaced a registration/, 'a dry run must not report a write')
  assert.match(text, /\[pinned to /)
  assert.ok(text.includes(old), 'naming the release it was pinned to')
  assert.match(text, /each release\s+gets its own/, 'and why that went stale')
  // The drift advice must not also appear: it tells a reader somebody edited this file.
  assert.doesNotMatch(text, /Registrations differ from the templates/)

  // ...and a real install says it replaced it, rather than only that it wrote.
  const wrote = await installConfig({ projectRoot: dir, conclaveRoot: REPO, agents: ['codex'], diagnose: false })
  const done = formatInstallResult(wrote)
  assert.match(done, /replaced a registration pinned to/, 'a write must say what it displaced')
  assert.ok(done.includes(old))
  assert.ok(
    readFileSync(sidecar, 'utf8').includes('conclave hook codex'),
    'and the old command must be gone, not retained',
  )
})

test('#258 an install says so when the command it just wrote cannot be found', async (t) => {
  // The dependency this change creates, and the one way it can fail that an absolute path
  // could not. `conclave hook claude` is resolved at fire time, which is what makes it
  // survive a release -- and if `conclave` is not on PATH the CLI reports a hook that
  // FAILED, not an installation that is missing. Nothing else the operator sees at that
  // moment would connect the two.
  const result = await installConfig({
    projectRoot: fixtureProject(t),
    conclaveRoot: REPO,
    agents: ['claude'],
    diagnose: false,
  })
  // Overridden rather than arranged: making `conclave` genuinely unfindable means editing
  // PATH for the whole test process, and a suite that does that breaks every other test
  // that shells out.
  const missing = formatInstallResult({ ...result, conclaveOnPath: undefined })
  assert.match(missing, /does not resolve on PATH/)
  assert.match(missing, /the hooks will not run/)

  const found = formatInstallResult({ ...result, conclaveOnPath: '/somewhere/bin/conclave' })
  assert.doesNotMatch(found, /does not resolve on PATH/, 'silent when there is nothing to say')
})

test('#258 the report says what runs the hooks, not which release rendered them', async (t) => {
  // The line this replaces read `hooks run from: <conclaveRoot>`, and it was true only
  // while the rendered command named that directory. Printing it afterwards told a reader
  // the one thing they must not believe: that a hook in this project runs the Conclave
  // somebody happened to install from. It runs whatever is on PATH at the time.
  const result = await installConfig({
    projectRoot: fixtureProject(t),
    conclaveRoot: REPO,
    agents: ['claude'],
    diagnose: false,
    dryRun: true,
  })

  const text = formatInstallResult({ ...result, conclaveOnPath: '/u/bin/conclave', conclaveOnPathUnderstandsHook: true })
  assert.match(text, /hooks run: \/u\/bin\/conclave hook <agent>/)
  assert.doesNotMatch(text, /hooks run from:/, 'the release must not be named as the thing that runs')
  // The release is still reported, labelled as the provenance it is.
  assert.match(text, new RegExp(`templates from: ${REPO}`))

  // ...and suppressed inside Conclave's own checkout, where it is noise on every run.
  assert.doesNotMatch(formatInstallResult({ ...result, selfHosted: true }), /templates from:/)
})

test('#258 an install says when the conclave on PATH is too old to run what it wrote', async (t) => {
  // Measured, not reasoned: with a v0.5.32 binary on PATH and a current sidecar, codex-cli
  // 0.153.4 reported every handler as `Failed` — `unknown command: hook`, exit 1 — for a
  // registration that was perfectly correct. `config check` says `current`, because it is,
  // so nothing else the operator can see connects the failing hook to an old binary.
  const result = await installConfig({
    projectRoot: fixtureProject(t),
    conclaveRoot: REPO,
    agents: ['claude'],
    diagnose: false,
  })

  const old = formatInstallResult({ ...result, conclaveOnPath: '/u/bin/conclave', conclaveOnPathUnderstandsHook: false })
  assert.match(old, /does not understand `hook`/)
  assert.match(old, /unknown command: hook/, 'quoting what the operator will actually see')
  assert.match(old, /config check` will keep saying so/, 'and why the check does not catch it')

  // Two separate failures wanting two separate fixes: no PATH entry is not an old binary.
  const absent = formatInstallResult({ ...result, conclaveOnPath: undefined })
  assert.match(absent, /does not resolve on PATH/)
  assert.doesNotMatch(absent, /does not understand/)

  const fine = formatInstallResult({ ...result, conclaveOnPath: '/u/bin/conclave', conclaveOnPathUnderstandsHook: true })
  assert.doesNotMatch(fine, /does not understand|does not resolve on PATH/)
})

test('#258 understandsHook asks the binary what it can do, not what version it is', (t) => {
  // A version comparison would work today and rot the moment the subcommand is backported
  // or renamed. The refusal for a MISSING AGENT is the probe because it is the one answer
  // only a conclave that HAS this subcommand can give.
  assert.equal(understandsHook(join(REPO, 'bin', 'conclave')), true)

  const dir = tempDir(t, 'conclave-old-binary')
  const older = join(dir, 'conclave')
  // What a pre-#258 conclave actually answers, taken from running v0.5.32.
  writeFileSync(older, '#!/bin/sh\necho "unknown command: hook $*" >&2\nexit 1\n')
  execFileSync('chmod', ['+x', older])
  assert.equal(understandsHook(older), false)

  // A binary that is not there at all is "cannot confirm", not "confirmed".
  assert.equal(understandsHook(join(dir, 'nothing-here')), false)
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

test('dry run reports drift without writing', async (t) => {
  const repo = fixtureRepo(t)
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

test('an unchanged checkout is a true no-op, not a rewrite', async (t) => {
  // The property the pre-fixture guidance depends on: running install before an
  // experiment must not cause a deployment-state transition.
  const repo = fixtureRepo(t)
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

test('registrations a project does not ignore are reported, not fixed', async (t) => {
  // Found by pointing Conclave at a fresh repository: these files carry absolute paths and
  // are machine-local by construction, so writing them into a repo that does not ignore
  // them leaves untracked files someone had no reason to expect. In a repo with a
  // `git add -A` habit that is a real hazard, not untidiness.
  const conclave = fixtureRepo(t)
  const project = fixtureProject(t)
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

test('a project that is not a git repository reports nothing to ignore', async (t) => {
  // `git check-ignore` cannot answer outside a repository, and a warning nobody can act on
  // is worse than none.
  const conclave = fixtureRepo(t)
  const project = fixtureProject(t)
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

test('a linked worktree gets an empty .codex/ so Codex looks for the sidecar at all', async (t) => {
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
  const main = tempDir(t, 'wt-main')
  execFileSync('git', ['init', '-q', '.'], { cwd: main })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: main })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: main })
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: main })
  // As in `fixtureWorktreePair`: the linked worktree goes inside a container the testkit
  // owns, not beside `main`. The `git worktree remove` that used to end this test removed it
  // only when every assertion below passed, so a failure left the directory behind for good.
  const linked = join(tempDir(t, 'wt-linked'), 'linked')
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

})

test('a plain checkout gets no stray .codex directory', async (t) => {
  // The trigger is only needed when the roots diverge. Creating it unconditionally would
  // leave an empty directory in every project Conclave has ever registered.
  const plain = tempDir(t, 'wt-plain')
  execFileSync('git', ['init', '-q', '.'], { cwd: plain })
  await installConfig({ projectRoot: plain, conclaveRoot: REPO, agents: ['claude'], diagnose: false })
  assert.equal(existsSync(join(plain, '.codex')), false, 'no codex agent, no codex directory')
})

test('#41 the ready line says what it cannot see', async (t) => {
  // A run that dies with "no UserPromptSubmit hook after send" sends its operator here, and this
  // reported that everything was fine. Three states produce that death and this distinguishes
  // only two: registration and trust are static facts about configuration, and whether a handler
  // finishes inside its timeout is a fact about the machine at the moment it runs. A remedy
  // offered for the wrong cause is worse than "I do not know".
  // Built from a real install rather than a hand-made object: `formatInstallResult` reads
  // several fields, and a fixture that guesses which ones is a fixture that breaks when the
  // shape moves for unrelated reasons.
  const project = fixtureProject(t)
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

test('#243 the shipped template warns that editing a statusMessage costs a re-trust', () => {
  // The trap this guards, measured against codex-cli 0.153.4 and recorded in
  // `codexHookTrust.ts`: Codex hashes the NORMALISED HANDLER DEFINITION, `statusMessage` is
  // part of it, and the shipped template sets one on every hook. Rewording the text Codex shows
  // while a hook runs therefore invalidates that handler exactly as changing its command would.
  //
  // The warning lives in the template because that is the file someone edits. A maintainer
  // rewording a status message will never open `codexHookTrust.ts`, which is where the old
  // enumeration — "(command, type, async, timeout)" — told them it was safe.
  const template = JSON.parse(readFileSync(join(REPO, 'config/templates/codex-hooks.json'), 'utf8')) as {
    description: string
    hooks: Record<string, { hooks: { statusMessage?: string }[] }[]>
  }

  assert.match(
    template.description,
    /statusMessage/,
    'the template must warn about statusMessage where the edit would be made (#243)',
  )
  assert.match(template.description, /re-trust/i, 'and say what the edit costs')

  // The warning has to be about a real situation: every handler carries one, so every handler
  // is exposed. A handler added without one would make the warning partly false.
  const handlers = Object.values(template.hooks).flatMap((entries) => entries.flatMap((e) => e.hooks))
  assert.ok(handlers.length > 0, 'the template must have handlers, or this asserts nothing')
  for (const h of handlers) {
    assert.ok(typeof h.statusMessage === 'string' && h.statusMessage.length > 0, 'every handler sets a statusMessage')
  }

  // The description itself is NOT hashed — measured the same way — which is why this warning can
  // exist at all without invalidating the handlers it warns about.
})
