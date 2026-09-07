/**
 * `scripts/install.sh`, and the layout a fresh install starts in (#250).
 *
 * The install used to be one directory that every upgrade rewrote, which is the layout that
 * forced `release.sh` to refuse an install while anything was running. #250 took that out of
 * the release script; this file is the other half -- a machine that installs for the first
 * time has to START in the versioned layout, or the first release on it would be a migration
 * and the problem would ship again with every new user.
 *
 * Driven as the real script against a real `file://` origin. A fixture that stubbed git would
 * decide by itself the one thing worth asking here, which is what git actually does with a
 * shallow clone.
 *
 *   node --test src/install.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from './testkit/tempDir.ts'

const REPO = realpathSync(join(import.meta.dirname, '..'))
const INSTALL = join(REPO, 'scripts', 'install.sh')
const RELEASE = join(REPO, 'scripts', 'release.sh')

interface Fixture {
  base: string
  origin: string
  prefix: string
  releases: string
  bindir: string
  link: string
  env: NodeJS.ProcessEnv
}

/**
 * An origin to install FROM, and the empty machine to install onto.
 *
 *   base/origin/          a bare repository with v9.9.9, v9.9.10 and a `feature/x` branch
 *   base/share/conclave   where the clone will land -- CONCLAVE_PREFIX
 *   base/share/conclave-releases/…   where the script must put version directories
 *   base/bin/             CONCLAVE_BINDIR
 *
 * `file://` rather than a plain path, and that is not decoration: `git clone --depth 1` is
 * SILENTLY IGNORED for a local path, so a fixture cloning `base/origin` would produce a full
 * repository and the shallow test below would assert nothing. Measured before it was written.
 */
function fixture(t: TestContext): Fixture {
  const base = tempDir(t, 'conclave-install-sh')
  const src = join(base, 'src')
  const origin = join(base, 'origin')
  mkdirSync(src, { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', origin])
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: src })
  git('init', '-q', '-b', 'main')
  mkdirSync(join(src, 'bin'), { recursive: true })

  // Prints the version out of package.json, which is what the script verifies a new directory
  // with before it lets anything on PATH point at it.
  writeFileSync(
    join(src, 'bin', 'conclave.ts'),
    `#!/usr/bin/env node\nimport { readFileSync } from 'node:fs'\nimport { join } from 'node:path'\n` +
      `const p = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))\n` +
      `process.stdout.write(p.version + '\\n')\n`,
  )
  chmodSync(join(src, 'bin', 'conclave.ts'), 0o755)
  // THE LAUNCHER, verbatim from this repository: what the PATH symlink points at, and the
  // reason `ps` records a version-pinned path rather than a symlink the next install moves.
  writeFileSync(join(src, 'bin', 'conclave'), readFileSync(join(REPO, 'bin', 'conclave'), 'utf8'))
  chmodSync(join(src, 'bin', 'conclave'), 0o755)
  writeFileSync(join(src, '.gitignore'), 'node_modules\n')

  // ONE dependency, and it is a directory inside the repository. `npm install` resolves a
  // `file:` specifier without reaching the network, in under a second, and leaves a real
  // `node_modules` -- which is the artefact the tests read to decide WHERE the install ran. A
  // fixture with no dependencies at all produces no `node_modules`, so there would be nothing
  // to point at.
  mkdirSync(join(src, 'dep'), { recursive: true })
  writeFileSync(join(src, 'dep', 'package.json'), JSON.stringify({ name: 'fixture-dep', version: '1.0.0' }, null, 2))
  for (const version of ['9.9.9', '9.9.10']) {
    writeFileSync(
      join(src, 'package.json'),
      JSON.stringify({ name: 'conclave-fixture', version, private: true, dependencies: { 'fixture-dep': 'file:dep' } }, null, 2),
    )
    // The lockfile is COMMITTED, as a real repository's is. `release.sh` reads it to decide
    // whether a release moved a dependency, and its fallback when a version directory has no
    // `node_modules` is `npm ci`, which needs one -- so a fixture without it would make the two
    // scripts' tests depend on each other for the wrong reason.
    execFileSync('npm', ['install', '--package-lock-only', '--silent'], { cwd: src })
    git('add', '.')
    git('commit', '-qm', `v${version}`)
    git('tag', `v${version}`)
  }
  // A PRE-RELEASE, tagged after the newest release and sorting above it on the numeric field
  // (`11-rc1` reads as 11). It is in the fixture so that every other test in this file is a
  // guard on `latest_release`: if a pre-release could win, they would all install it and fail
  // on the version they expect.
  git('tag', 'v9.9.11-rc1')
  git('branch', 'feature/x')
  git('remote', 'add', 'origin', origin)
  git('push', '-q', 'origin', 'main', 'feature/x', '--tags')

  const prefix = join(base, 'share', 'conclave')
  const bindir = join(base, 'bin')
  return {
    base,
    origin,
    prefix,
    releases: join(base, 'share', 'conclave-releases'),
    bindir,
    link: join(bindir, 'conclave'),
    env: {
      ...process.env,
      CONCLAVE_REPO: `file://${origin}`,
      CONCLAVE_PREFIX: prefix,
      CONCLAVE_BINDIR: bindir,
    },
  }
}

function install(f: Fixture, env: NodeJS.ProcessEnv = {}): { code: number; out: string } {
  const r = spawnSync('sh', [INSTALL], { cwd: f.base, env: { ...f.env, ...env }, encoding: 'utf8' })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}

test('#250 a fresh install lands in a version directory beside the repository, not in it', (t) => {
  const f = fixture(t)
  const r = install(f)
  assert.equal(r.code, 0, r.out)

  // The newest tag, resolved from the remote the way the script has always resolved it.
  const dir = join(f.releases, 'v9.9.10')
  assert.ok(existsSync(join(dir, 'bin', 'conclave.ts')), 'the version directory must be a real checkout')
  // A worktree of the clone, not a second clone: `.git` is a file pointing into the shared
  // repository, which is what makes retaining versions cost a checkout rather than a download.
  assert.ok(lstatSync(join(dir, '.git')).isFile(), 'the version directory must be a linked worktree')

  // AT THE LAUNCHER. Pointing PATH straight at `conclave.ts` makes the kernel exec
  // `node <the symlink>`, so `ps` records a path the next install moves — and everything that
  // asks which version a live process is running reads that line.
  assert.equal(realpathSync(f.link), join(dir, 'bin', 'conclave'), 'PATH must point at the launcher in the version directory')
  assert.ok(
    existsSync(join(dir, 'node_modules', 'fixture-dep')),
    'dependencies belong to the version that uses them',
  )
  // AND NOT IN THE REPOSITORY. The clone is backing store now; installing into it would put a
  // second dependency tree on disk that nothing ever runs.
  assert.equal(existsSync(join(f.prefix, 'node_modules')), false, 'the repository must not carry its own node_modules')
  assert.match(r.out, /installed 9\.9\.10/)
})

test('#250 release.sh finds a fresh install already versioned, in the directory it would have chosen', (t) => {
  // THE AGREEMENT, and it is the reason either script derives the path instead of spelling it
  // out. If these two named the directory differently, `release.sh` would build a second copy
  // of a version already on disk and the symlink would follow whichever ran last.
  const f = fixture(t)
  assert.equal(install(f).code, 0)

  const r = spawnSync('sh', [RELEASE, '--install-only'], {
    cwd: f.prefix,
    env: { ...process.env, PATH: `${f.bindir}:${process.env.PATH ?? ''}` },
    encoding: 'utf8',
  })
  const out = `${r.stdout}${r.stderr}`
  assert.equal(r.status, 0, out)
  assert.doesNotMatch(out, /migrating/, 'a fresh install is not a legacy checkout')
  // And it agrees on what a release IS, too. `git tag --sort=-v:refname` puts the fixture's
  // pre-release above v9.9.10, so an unfiltered `head -1` would have this script trying to
  // install `v9.9.11-rc1` over an install that is already current.
  assert.match(out, /newest release: v9\.9\.10/)
  // REUSED, which is the assertion that actually pins the name. "Not migrating" holds for any
  // directory under the releases root, however it is spelled; only reuse proves the two scripts
  // arrived at the same one.
  assert.match(out, /already exists — reusing it/)
})

test('#250 a shallow clone can still build the version worktree', (t) => {
  const f = fixture(t)
  const r = install(f)
  assert.equal(r.code, 0, r.out)

  // PROVED, not assumed, and it is the assertion this test exists for: `--depth 1` is silently
  // ignored when cloning a local path, so without a `file://` origin this fixture would be a
  // full repository and the claim below would be about nothing.
  assert.equal(
    execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: f.prefix, encoding: 'utf8' }).trim(),
    'true',
    'the fixture must actually be shallow, or it proves nothing about shallow clones',
  )
  assert.equal(
    execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: f.prefix, encoding: 'utf8' }).trim(),
    '1',
    'one commit, which is what makes it a depth-1 clone rather than a small repository',
  )

  // And the worktree built out of it is a working install, not merely a directory.
  const dir = join(f.releases, 'v9.9.10')
  const ran = spawnSync(process.execPath, [join(dir, 'bin', 'conclave.ts'), '--version'], { encoding: 'utf8' })
  assert.equal(ran.stdout.trim(), '9.9.10', `${ran.stdout}${ran.stderr}`)
})

test('#250 a ref that is not a release gets a filesystem-safe directory pinned to its commit', (t) => {
  const f = fixture(t)
  const r = install(f, { CONCLAVE_REF: 'feature/x' })
  assert.equal(r.code, 0, r.out)

  const head = execFileSync('git', ['rev-parse', 'feature/x'], { cwd: f.prefix, encoding: 'utf8' }).trim()
  const expected = `feature-x-${head.slice(0, 12)}`
  // `.installed` is the ownership records, which live beside the versions rather than inside
  // them. Filtered rather than asserted away: what this test is about is the version directory.
  const dirs = readdirSync(f.releases).filter((n) => n !== '.installed')
  assert.deepEqual(dirs, [expected], 'a branch is one directory name, pinned to what it pointed at')
  // A branch moves, so its name alone would be a directory whose contents nobody can name --
  // and reusing it on the next install would hand back a stale checkout that looks current.
  assert.equal(existsSync(join(f.releases, 'feature')), false, 'the slash must not become a directory')
  assert.equal(realpathSync(f.link), join(f.releases, expected, 'bin', 'conclave'))
})

test('#250 install.sh refuses a destination it has no record of, and changes nothing', (t) => {
  // The same ownership rule on the install side. A version directory that no installer wrote
  // down is one nothing here will reuse: reusing it would put whatever is inside on PATH under
  // the name of a release, and the operator would have no way to tell that from an install.
  //
  // Staged by removing the record rather than by building a worktree by hand, because what is
  // under test is the ABSENCE of the record: the directory left behind is byte-for-byte one
  // this script made, so nothing but the record distinguishes the two runs.
  const f = fixture(t)
  assert.equal(install(f).code, 0)
  const rec = join(f.releases, '.installed', 'v9.9.10.rec')
  assert.ok(existsSync(rec), 'the first install records that it made the directory')
  const before = realpathSync(f.link)
  execFileSync('rm', ['-f', rec])

  const r = install(f)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /is not one this installer made/)
  assert.equal(realpathSync(f.link), before, 'and nothing on PATH moved')
  assert.equal(existsSync(rec), false, 'nor was a record written for it after the fact')
  assert.ok(existsSync(join(f.releases, 'v9.9.10', 'bin', 'conclave.ts')), 'the directory is left alone')
})

test('#250 install.sh rebuilds an install that never finished, and reuses one that did', (t) => {
  // The record is written the moment the worktree exists — before `npm install`, which here
  // compiles a native module. An install killed in between leaves an owned directory with a
  // partial node_modules, and deciding by `[ -d node_modules ]` reads that as done.
  const f = fixture(t)
  assert.equal(install(f).code, 0)
  const dir = join(f.releases, 'v9.9.10')
  const ready = join(f.releases, '.installed', 'v9.9.10.ready')
  assert.ok(existsSync(ready), 'a finished install says so')

  // REUSED, when it did finish: no second dependency install, and nothing discarded.
  const again = install(f)
  assert.equal(again.code, 0, again.out)
  assert.match(again.out, /is provisioned and verified/)
  assert.doesNotMatch(again.out, /discarding its partial dependencies/)
  assert.doesNotMatch(again.out, /installing dependencies/)

  // And rebuilt when it did not. Staged by removing the readiness marker and gutting
  // node_modules, which is the state a killed `npm install` leaves.
  execFileSync('rm', ['-f', ready])
  execFileSync('rm', ['-rf', join(dir, 'node_modules')])
  // A dot-directory, because npm prunes plain files and extraneous packages on its next run
  // but leaves dot-entries alone — measured. `.package-lock.json` is such an entry, and a stale
  // one is what makes a later install believe the tree is already what it should be.
  mkdirSync(join(dir, 'node_modules', '.half-written'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '.half-written', 'marker.txt'), 'killed part way\n')

  const retry = install(f)
  assert.equal(retry.code, 0, retry.out)
  assert.match(retry.out, /was never finished — discarding its partial dependencies/)
  assert.equal(existsSync(join(dir, 'node_modules', '.half-written')), false, 'the partial tree goes')
  assert.ok(existsSync(join(dir, 'node_modules', 'fixture-dep')), 'and a real one is installed in its place')
  assert.ok(existsSync(ready), 'and only then is it ready')
})

test('#250 install.sh refuses a recorded directory that is no longer what its record describes', (t) => {
  const f = fixture(t)
  assert.equal(install(f).code, 0)
  const dir = join(f.releases, 'v9.9.10')
  const before = realpathSync(f.link)
  // Edited. Nothing about this touches the record, which lives outside the worktree.
  writeFileSync(join(dir, 'package.json'), '{"version":"forged"}\n')

  const r = install(f)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no longer the checkout its record describes/)
  assert.equal(realpathSync(f.link), before, 'and nothing on PATH moved')
})

test('#250 a pre-release is not a release: it is neither installed by default nor given a bare version directory', (t) => {
  const f = fixture(t)

  // NOT THE NEWEST RELEASE, though it is the newest tag and sorts above v9.9.10 on the last
  // numeric field. `v*` is a refspec and not a version test, so the default install used to
  // read `9.9.11-rc1` as `9.9.11` and hand everyone running the one-line installer a
  // pre-release.
  const byDefault = install(f)
  assert.equal(byDefault.code, 0, byDefault.out)
  assert.match(byDefault.out, /installed 9\.9\.10/, 'the newest RELEASE is what a default install gets')
  assert.equal(existsSync(join(f.releases, 'v9.9.11-rc1')), false)

  // And asked for by name it still is not a release, so it gets the commit-pinned directory a
  // moving-or-unversioned ref gets rather than the bare name `release.sh` reserves for versions.
  // Under the old glob `v[0-9]*.[0-9]*.[0-9]*` this was a bare `v9.9.11-rc1`, which the release
  // script would then look at and decline to recognise as any version at all.
  const g = fixture(t)
  const pinned = install(g, { CONCLAVE_REF: 'v9.9.11-rc1' })
  assert.equal(pinned.code, 0, pinned.out)
  const head = execFileSync('git', ['rev-parse', 'v9.9.11-rc1'], { cwd: g.prefix, encoding: 'utf8' }).trim()
  const expected = `v9.9.11-rc1-${head.slice(0, 12)}`
  assert.deepEqual(readdirSync(g.releases).filter((n) => n !== '.installed'), [expected])
  assert.equal(realpathSync(g.link), join(g.releases, expected, 'bin', 'conclave'))
})

test('#250 an existing link is replaced without being taken away, and never left dangling', (t) => {
  const f = fixture(t)
  mkdirSync(f.bindir, { recursive: true })
  // What a previous install leaves behind once its directory is gone. Starting from a dangling
  // link is the case that would pass vacuously against a fresh machine: there is nothing to
  // replace there, so "the link resolves" says nothing about replacing anything.
  symlinkSync(join(f.base, 'gone', 'bin', 'conclave.ts'), f.link)
  assert.equal(existsSync(f.link), false, 'the fixture must start dangling, or it tests nothing')

  const r = install(f)
  assert.equal(r.code, 0, r.out)
  assert.ok(lstatSync(f.link).isSymbolicLink(), 'it must still be a symlink, not a copied file')
  assert.ok(existsSync(f.link), 'and it must resolve to something that is there')
  assert.equal(realpathSync(f.link), join(f.releases, 'v9.9.10', 'bin', 'conclave'))

  // The temporary link is the mechanism, and it is not allowed to be the residue. `mv` renames
  // it onto the live name in one step; a temp file still sitting here means the switch was two
  // steps, and two steps is the window where `conclave` is on nobody's PATH.
  assert.deepEqual(
    readdirSync(f.bindir).filter((n) => n.startsWith('conclave.tmp.')),
    [],
    'the temporary link must have been renamed, not left beside the real one',
  )
  assert.deepEqual(readdirSync(f.bindir), ['conclave'], 'and nothing else may be left in the bin directory')
})
