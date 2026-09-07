/**
 * The release script's refusals.
 *
 * Only the refusals, deliberately. The half that cuts a tag pushes to a remote, so exercising
 * it would mean either a fake remote elaborate enough to stop testing the thing, or a real
 * push. What IS worth pinning is every path that decides NOT to act -- because #182 is a
 * release step that reported success and did nothing, and a guard that silently passes is the
 * same defect wearing the opposite sign.
 *
 *   node --test src/release.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from './testkit/tempDir.ts'

const REPO = realpathSync(join(import.meta.dirname, '..'))
const SCRIPT = join(REPO, 'scripts', 'release.sh')

function run(args: string[], cwd: string = REPO): { code: number; out: string } {
  const r = spawnSync('sh', [SCRIPT, ...args], { cwd, encoding: 'utf8' })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}

/**
 * A checkout that looks enough like the repo for the script to reach its own checks.
 *
 * `origin` is a real bare repository rather than omitted, because the preconditions run in
 * order and `git fetch origin` sits above the ones worth testing. Without a remote the script
 * dies at the fetch and every later refusal is unreachable -- which is how the tag test first
 * failed, reporting the dirty-tree refusal from the checkout the test was launched in.
 */
function fakeRepo(t: TestContext, version = '9.9.9'): string {
  const dir = tempDir(t, 'conclave-release')
  const origin = tempDir(t, 'conclave-release-origin')
  execFileSync('git', ['init', '-q', '--bare', origin])
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }, null, 2))
  git('add', '.')
  git('commit', '-qm', 'init')
  git('remote', 'add', 'origin', origin)
  git('push', '-q', '-u', 'origin', 'main')
  return dir
}

test('#182 a version is required, and an unknown flag is refused rather than ignored', () => {
  // Exit 2 for usage, distinct from 1 for a refusal: a caller scripting this must be able to
  // tell "you asked wrongly" from "the tree is not ready".
  assert.equal(run([]).code, 2, 'no version is a usage error')
  assert.equal(run(['0.9.99', '--bogus']).code, 2, 'an unknown flag is a usage error')
  // Silently ignoring a misspelled --dry-run would cut a real release.
  assert.match(run(['0.9.99', '--bogus']).out, /unknown flag/)

  // And the operations do not combine. `release.sh 0.5.30 --prune-install` reads like one thing
  // and is two; guessing which was meant would either skip a release or remove directories from
  // somebody who was only cutting a tag (#250).
  assert.equal(run(['--prune-install', '0.9.99']).code, 2, 'a version with a prune is a usage error')
  assert.match(run(['--prune-install', '0.9.99']).out, /cuts no release/)
  assert.equal(run(['--prune-install', '--install-only']).code, 2, 'two operations at once is a usage error')
  assert.match(run(['--prune-install', '--install-only']).out, /one at a time/)
})

test('#182 a tag that already exists is refused', (t) => {
  // In a fixture, not in this checkout: the preconditions run in order, and a working tree
  // with anything uncommitted in it refuses first. Asserting this against the live repo tests
  // whether the author happened to be mid-edit.
  const dir = fakeRepo(t, '9.9.9')
  execFileSync('git', ['tag', 'v9.9.10'], { cwd: dir })
  const r = run(['9.9.10', '--dry-run'], dir)
  assert.equal(r.code, 1, 'cutting a tag that exists must be refused')
  assert.match(r.out, /already exists/)

  // And a version that does NOT exist gets past this guard, or the check would be a wall.
  //
  // `would run:` rather than only the absence of "already exists": a negative assertion passes
  // whenever the script refuses for ANY other reason, which is how the dry-run test in this file
  // came to prove nothing (#248). This one was conditionally vacuous the same way — until #248
  // let a dry run past the run-in-flight guard, it refused outright whenever a conclave session
  // was live anywhere on the machine, and an output with no "already exists" in it was exactly
  // what that refusal produced.
  const past = run(['9.9.11', '--dry-run'], dir)
  assert.doesNotMatch(past.out, /already exists/)
  assert.match(past.out, /would run:/, 'and it reached the actions, rather than refusing for something else')
})

test('#182 a dirty tree and a branch that is not main are both refused', (t) => {
  const dir = fakeRepo(t)
  writeFileSync(join(dir, 'scratch.txt'), 'uncommitted\n')
  const dirty = run(['0.9.99', '--dry-run'], dir)
  assert.equal(dirty.code, 1)
  assert.match(dirty.out, /uncommitted changes/)

  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'checkout', '-q', '-b', 'side'], { cwd: dir })
  execFileSync('git', ['checkout', '--', '.'], { cwd: dir })
  execFileSync('rm', ['-f', join(dir, 'scratch.txt')])
  const branch = run(['0.9.99', '--dry-run'], dir)
  assert.equal(branch.code, 1)
  assert.match(branch.out, /not on main/)
})

/**
 * A machine laid out the way the versioned install expects, all inside one temp directory.
 *
 *   base/repo/                      the repository, tags v9.9.9 and v9.9.10
 *   base/conclave-releases/v9.9.9/  the current install, once it has been migrated
 *   base/conclave-stable/           the current install, before it has
 *   base/bin/conclave               the PATH entry, a symlink into whichever of those it is
 *
 * NESTED IN ONE `tempDir` rather than spread across several, because `releases_root` derives
 * the versions directory from the repository's own location -- `dirname(repo)/conclave-releases`.
 * A fixture whose repo sat directly in `$TMPDIR` would make every test compute the SAME versions
 * directory, so concurrent tests would collide in it and the testkit could not clean it up: it
 * only removes directories it issued itself.
 */
/**
 * The ownership record an installer writes beside a version directory.
 *
 * Written here rather than by running an installer, because the machine a prune test starts on
 * is one that was ALREADY installed -- there is no earlier run to have made it. The format is
 * pinned from the other end by `src/install.test.ts`, where `scripts/install.sh` writes a real
 * record and `scripts/release.sh` reuses the directory on the strength of it: if either script's
 * spelling drifted, that reuse turns into a refusal rather than a silent acceptance.
 */
function writeRecord(
  root: string,
  name: string,
  fields: { path: string; repo: string; ref: string; commit: string },
): void {
  mkdirSync(join(root, '.installed'), { recursive: true })
  writeFileSync(
    join(root, '.installed', `${name}.rec`),
    `path=${fields.path}\nrepo=${fields.repo}\nref=${fields.ref}\ncommit=${fields.commit}\n`,
  )
}

interface Machine {
  base: string
  repo: string
  root: string
  dir: string
  link: string
  /** The repository's common dir, physically, which is what a record binds as `repo=`. */
  repoId: string
  /** The commit a tag points at, for writing records and for forging them. */
  commitOf: (tag: string) => string
  env: NodeJS.ProcessEnv
}

function machine(
  t: TestContext,
  opts: { migrated: boolean; lockA?: string; lockB?: string; brokenNew?: boolean },
): Machine {
  const base = tempDir(t, 'conclave-install')
  const repo = join(base, 'repo')
  const origin = join(base, 'origin')
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', origin])
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo })
  git('init', '-q', '-b', 'main')
  mkdirSync(join(repo, 'bin'), { recursive: true })

  // `session` stays alive, because a live RUN is what both guards look for and the fixture has
  // to BE that run rather than merely be named on some other process's command line (#245).
  // Anything else prints the version out of package.json, which is what the script verifies an
  // install with -- before the symlink moves and again after.
  const bin = (version?: string) =>
    `#!/usr/bin/env node\n` +
    `import { readFileSync } from 'node:fs'\n` +
    `import { join } from 'node:path'\n` +
    `if (process.argv.includes('session')) { setTimeout(() => {}, 30_000) } else {\n` +
    (version === undefined
      ? `  const p = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))\n` +
        `  process.stdout.write(p.version + '\\n')\n`
      : `  process.stdout.write(${JSON.stringify(version)} + '\\n')\n`) +
    `}\n`

  // THE LAUNCHER, verbatim from this repository rather than a stand-in. What is under test
  // includes what `ps` records for a run started through the PATH symlink, and a fixture that
  // wrote its own launcher would be testing the fixture's idea of that.
  const launcher = readFileSync(join(REPO, 'bin', 'conclave'), 'utf8')

  const writeBin = (version?: string) => {
    writeFileSync(join(repo, 'bin', 'conclave.ts'), bin(version))
    chmodSync(join(repo, 'bin', 'conclave.ts'), 0o755)
    writeFileSync(join(repo, 'bin', 'conclave'), launcher)
    chmodSync(join(repo, 'bin', 'conclave'), 0o755)
  }

  writeBin()
  // node_modules must be IGNORED, or the install checkout reads as dirty and the migration
  // refuses for that instead of for the thing under test.
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n')
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ version: '9.9.9' }, null, 2))
  writeFileSync(join(repo, 'package-lock.json'), opts.lockA ?? lock('9.9.9'))
  git('add', '.')
  git('commit', '-qm', 'v9.9.9')
  git('tag', 'v9.9.9')
  // More tags on the same commit, so the prune tests have release-tag NAMES nothing has taken.
  // A directory can then claim to be `v9.9.8` while being something else entirely, which is
  // what every identity check below exists to notice.
  git('tag', 'v9.9.8')
  git('tag', 'v9.9.6')
  git('tag', 'v9.9.5')
  git('tag', 'v9.9.4')

  // The version the release moves TO. `brokenNew` makes it answer with somebody else's version,
  // which is the only way to ask whether the symlink waits for a directory that works.
  if (opts.brokenNew) writeBin('0.0.0-broken')
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ version: '9.9.10' }, null, 2))
  writeFileSync(join(repo, 'package-lock.json'), opts.lockB ?? lock('9.9.10'))
  git('add', '.')
  git('commit', '-qm', 'v9.9.10')
  git('tag', 'v9.9.10')
  git('remote', 'add', 'origin', origin)
  git('push', '-q', 'origin', 'main', '--tags')

  // The install is its own worktree at the OLD tag, which is the state a release has to move.
  const root = join(base, 'conclave-releases')
  const dir = opts.migrated ? join(root, 'v9.9.9') : join(base, 'conclave-stable')
  git('worktree', 'add', '--detach', '-q', dir, 'v9.9.9')
  // What the new version directory is supposed to CLONE rather than reinstall. A marker file
  // rather than a real install: what is under test is which directory the tree came from.
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'marker.txt'), 'cloned from the previous install\n')

  const binDir = join(base, 'bin')
  mkdirSync(binDir, { recursive: true })
  const link = join(binDir, 'conclave')
  symlinkSync(join(dir, 'bin', 'conclave'), link)

  const repoId = realpathSync(join(repo, '.git'))
  const commitOf = (tag: string) =>
    execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], { cwd: repo, encoding: 'utf8' }).trim()
  // A machine that is already on the versioned layout got there through an installer, so the
  // version it is running carries that installer's record. Without it the fixture would be
  // describing a directory somebody made by hand, which is a different machine and a different
  // test.
  if (opts.migrated) {
    writeRecord(root, 'v9.9.9', { path: dir, repo: repoId, ref: 'v9.9.9', commit: commitOf('v9.9.9') })
    // And READY: the install it is running finished, which is what having got there means. The
    // half-finished case is a fixture of its own below, because it is a different machine.
    writeFileSync(join(root, '.installed', 'v9.9.9.ready'), `commit=${commitOf('v9.9.9')}\n`)
  }
  return { base, repo, root, dir, link, repoId, commitOf, env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` } }
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * A live run started the way a checkout starts one: node, with the version directory's own
 * path. Already version-pinned in argv, so it is the easy case for the guards.
 */
function liveRun(dir: string): ChildProcess {
  return spawn(process.execPath, [join(dir, 'bin', 'conclave.ts'), 'session', 'probe'], { stdio: 'ignore' })
}

/**
 * A live run started the way an operator starts one: by NAME, off PATH.
 *
 * This is the launch whose argv used to lie. `conclave` on PATH is a symlink an install moves,
 * and a shebang puts the path you typed into argv -- so `ps` recorded the symlink and every
 * question about which version a process was running was answered by resolving it TODAY.
 */
function liveRunViaPath(env: NodeJS.ProcessEnv): ChildProcess {
  return spawn('conclave', ['session', 'probe'], { env, stdio: 'ignore' })
}

/** Whether the script's own matcher would see this pid as a live run. */
function guardSees(pid: number): boolean {
  const program = readFileSync(SCRIPT, 'utf8').match(/awk '(\$0 ~ .*?)'/)
  assert.ok(program, 'release.sh must still select runs with an awk program')
  const ps = execFileSync('sh', ['-c', 'ps -eo pid=,command='], { encoding: 'utf8' })
  const out = execFileSync('awk', [program[1]!], { input: ps, encoding: 'utf8' })
  return out.trim().split('\n').includes(String(pid))
}

test('#250 a live run does not block the install, and the symlink lands on the finished worktree', async (t) => {
  // THE POINT OF #250. The old layout moved one checkout to the new tag, so every run on the
  // machine was executing out of the directory being rewritten and the release had to refuse.
  // A version gets its own directory now: the live run keeps importing out of the one it exec'd
  // from, and the release has nothing to wait for.
  const m = machine(t, { migrated: true })
  const child = liveRun(m.dir)
  try {
    await settle(400)
    // The guard's own matcher must actually SEE this process, or "it did not block" is a claim
    // about a run nothing was looking for -- which is how the first version of the old refusal
    // test passed with the guard deleted.
    assert.ok(guardSees(child.pid!), 'the fixture run must be one the script would recognise')

    const r = spawnSync('sh', [SCRIPT, '--install-only'], { cwd: m.repo, env: m.env, encoding: 'utf8' })
    const out = `${r.stdout}${r.stderr}`
    assert.equal(r.status, 0, out)
    assert.doesNotMatch(out, /refusing/, 'a live run must not stop an ordinary install')
    assert.match(out, /install is on v9\.9\.10/)

    // The PATH entry points at the NEW directory, not at a rewritten old one.
    assert.equal(
      realpathSync(m.link),
      join(m.root, 'v9.9.10', 'bin', 'conclave'),
      'the symlink must resolve into the new version directory',
    )
    // FINISHED, not merely created. A directory with no node_modules is a version that cannot
    // run, and pointing PATH at one is the same defect as not moving PATH at all.
    assert.ok(
      existsSync(join(m.root, 'v9.9.10', 'node_modules', 'marker.txt')),
      'node_modules must have been provisioned into the new directory',
    )
    // And it really is the clone path rather than a reinstall: the marker only exists because
    // it was copied from the previous install, which is the rule the dependency diff decides.
    assert.match(out, /cloning node_modules from/)
  } finally {
    child.kill('SIGKILL')
  }
})

test('#250 the directory a live run is executing from is not touched', async (t) => {
  // The other half of the same claim, and the one that would break silently: a release that
  // moved the symlink correctly but also checked the old directory out to the new tag would
  // pass every assertion in the test above while producing exactly the half-a-version run the
  // old refusal existed to prevent.
  const m = machine(t, { migrated: true })
  const state = () => ({
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: m.dir, encoding: 'utf8' }).trim(),
    tree: execFileSync('git', ['status', '--porcelain'], { cwd: m.dir, encoding: 'utf8' }).trim(),
    version: JSON.parse(readFileSync(join(m.dir, 'package.json'), 'utf8')).version,
    modules: readFileSync(join(m.dir, 'node_modules', 'marker.txt'), 'utf8'),
  })

  const child = liveRun(m.dir)
  try {
    await settle(400)
    const before = state()
    // Not vacuous: the old directory is on the OLD version, so a checkout under it would change
    // this field. Asserted rather than assumed, because a fixture that started on v9.9.10 would
    // make the comparison below true no matter what the script did.
    assert.equal(before.version, '9.9.9', 'the install starts on the old tag')

    const r = spawnSync('sh', [SCRIPT, '--install-only'], { cwd: m.repo, env: m.env, encoding: 'utf8' })
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
    assert.deepEqual(state(), before, 'the directory the live run is executing from is unchanged')
  } finally {
    child.kill('SIGKILL')
  }
})

test('#250 a version directory that does not answer with its own version never gets the symlink', async (t) => {
  // What "finished" is worth. The new directory is proved by running it OUT OF ITS OWN PATH,
  // before the symlink moves -- so a broken version leaves the install exactly where it was
  // instead of breaking it. The old shape could not do this: it rewrote the one checkout and
  // then asked, by which time there was nothing to fall back to.
  const m = machine(t, { migrated: true, brokenNew: true })
  const wasPointingAt = realpathSync(m.link)

  const r = spawnSync('sh', [SCRIPT, '--install-only'], { cwd: m.repo, env: m.env, encoding: 'utf8' })
  const out = `${r.stdout}${r.stderr}`
  assert.equal(r.status, 1, out)
  assert.match(out, /MISMATCH/)
  assert.equal(realpathSync(m.link), wasPointingAt, 'the PATH entry must still be the version that works')
  assert.equal(wasPointingAt, join(m.root, 'v9.9.9', 'bin', 'conclave'))
})

test('#250 migrating off the single legacy checkout still refuses while it is live', async (t) => {
  // The ONE refusal left, and it is not the old one renamed. A version directory is safe because
  // its name pins its contents; `conclave-stable` carries no such promise, so moving the symlink
  // off it strands a live run in the only directory this scheme stops protecting.
  const m = machine(t, { migrated: false })
  const child = liveRun(m.dir)
  try {
    await settle(400)
    const busy = spawnSync('sh', [SCRIPT, '--install-only'], { cwd: m.repo, env: m.env, encoding: 'utf8' })
    const out = `${busy.stdout}${busy.stderr}`
    assert.equal(busy.status, 1, out)
    assert.match(out, /refusing to update/)
    // Naming what is live is half the point: a refusal the operator cannot act on is a wall.
    assert.match(out, new RegExp(`pid ${child.pid}\\b`), 'the pid is named')
    // And it refused before doing anything, rather than after.
    assert.equal(realpathSync(m.link), join(m.dir, 'bin', 'conclave'))
    assert.ok(existsSync(join(m.dir, 'bin', 'conclave.ts')), 'a refused migration removes nothing')
  } finally {
    child.kill('SIGKILL')
  }

  // And it goes clear once the run is gone, or the migration would be a permanent refusal --
  // which is the failure mode #250 is about, one directory further along.
  await settle(700)
  const after = spawnSync('sh', [SCRIPT, '--install-only'], { cwd: m.repo, env: m.env, encoding: 'utf8' })
  const out = `${after.stdout}${after.stderr}`
  assert.equal(after.status, 0, out)
  assert.doesNotMatch(out, /refusing/)
  assert.equal(
    realpathSync(m.link),
    join(m.root, 'v9.9.10', 'bin', 'conclave'),
    'the migration puts the install under the versions directory',
  )
})

test('#250 --force still carries the migration past a live run', async (t) => {
  // The escape hatch has one use left. It does not make the hazard untrue; it asserts the
  // operator has checked that the run is finished.
  const m = machine(t, { migrated: false })
  const child = liveRun(m.dir)
  try {
    await settle(400)
    const forced = spawnSync('sh', [SCRIPT, '--install-only', '--force'], { cwd: m.repo, env: m.env, encoding: 'utf8' })
    const out = `${forced.stdout}${forced.stderr}`
    assert.match(out, /--force was given/)
    assert.equal(forced.status, 0, out)
    assert.equal(realpathSync(m.link), join(m.root, 'v9.9.10', 'bin', 'conclave'))
    // AND IT DOES NOT REACH THE DELETE. `--force` says the operator has checked that the runs
    // are finished, which is an answer about swapping a symlink; the removal at the end asks
    // again and keeps the directory, because a swap can be re-run and a delete cannot.
    assert.match(out, /keeping .* a run started in it while the migration was running/)
    assert.ok(existsSync(join(m.dir, 'bin', 'conclave.ts')), 'the directory the run is in survives --force')
  } finally {
    child.kill('SIGKILL')
  }
})

/** Move the install to the newest tag, which every prune test needs a superseded version for. */
function upgrade(m: { repo: string; env: NodeJS.ProcessEnv }): string {
  const r = spawnSync('sh', [SCRIPT, '--install-only'], { cwd: m.repo, env: m.env, encoding: 'utf8' })
  const out = `${r.stdout}${r.stderr}`
  assert.equal(r.status, 0, out)
  return out
}

const prune = (m: { repo: string; env: NodeJS.ProcessEnv }, args: string[] = []) => {
  const r = spawnSync('sh', [SCRIPT, '--prune-install', ...args], { cwd: m.repo, env: m.env, encoding: 'utf8' })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}

const worktrees = (repo: string) => execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' })

test('#250 an ordinary install retains every version it supersedes', (t) => {
  // THE DEFAULT, and it is the whole retention policy: releases and installs never remove
  // anything. A run that started on the old version can be read afterwards against the code
  // that actually ran it, and that evidence is worth more than the disk.
  const m = machine(t, { migrated: true })
  const out = upgrade(m)

  assert.ok(existsSync(join(m.root, 'v9.9.9', 'bin', 'conclave.ts')), 'the superseded version stays on disk')
  assert.ok(existsSync(join(m.root, 'v9.9.10', 'bin', 'conclave.ts')), 'and the new one is beside it')
  assert.doesNotMatch(out, /removing/, 'an install that removes anything is not an install any more')
  // Both are still worktrees git knows about, rather than directories it has lost track of.
  assert.match(worktrees(m.repo), /v9\.9\.9/)
  assert.match(worktrees(m.repo), /v9\.9\.10/)
})

test('#250 --prune-install removes a superseded version and never the one on PATH', (t) => {
  const m = machine(t, { migrated: true })
  upgrade(m)

  const r = prune(m)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /removing v9\.9\.9/)
  assert.equal(existsSync(join(m.root, 'v9.9.9')), false, 'the superseded version is gone')
  // REMOVED, not deleted. `git worktree remove` unregisters it; an `rm -rf` would leave git
  // holding a record of a worktree that is not there, which is the state `git worktree prune`
  // exists to clean up and which this is written to never produce.
  assert.doesNotMatch(worktrees(m.repo), /v9\.9\.9/, 'git must no longer list it')
  // And so does its ownership record. Left behind, it would be an account of a directory that
  // is not there -- which is the first half of adopting whatever appears at that path next.
  assert.equal(existsSync(join(m.root, '.installed', 'v9.9.9.rec')), false, 'the record goes with it')

  assert.ok(existsSync(join(m.root, 'v9.9.10', 'bin', 'conclave.ts')), 'the active version is never a candidate')
  assert.equal(realpathSync(m.link), join(m.root, 'v9.9.10', 'bin', 'conclave'))
  assert.match(r.out, /keeping the active install/)
})

test('#250 --prune-install keeps a version something is still running from, and names what', async (t) => {
  // The rule that matters most, because a prune is the one operation whose mistake cannot be
  // undone. A live run holds no handle on the modules it has not imported yet -- which is why
  // the test is the resolved-script one rather than `lsof` -- so a directory that looks idle to
  // the filesystem can still be the one a session is about to read its next module from.
  const m = machine(t, { migrated: true })
  upgrade(m)

  const child = liveRun(join(m.root, 'v9.9.9'))
  try {
    await settle(400)
    assert.ok(guardSees(child.pid!), 'the fixture run must be one the script would recognise')

    const r = prune(m)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /keeping v9\.9\.9 — processes are running from it/)
    assert.match(r.out, new RegExp(`pid ${child.pid}\\b`), 'a refusal the operator cannot act on is a wall')
    assert.ok(existsSync(join(m.root, 'v9.9.9', 'bin', 'conclave.ts')), 'and the version is still there')
    assert.match(worktrees(m.repo), /v9\.9\.9/)
  } finally {
    child.kill('SIGKILL')
  }
})

test('#250 a run started off PATH is still found in its own version after the link moves', async (t) => {
  // THE FAIL-OPEN THE OTHER LIVENESS TEST COULD NOT SEE, because it started its run the way a
  // checkout does — node, with the version directory's own path — which is already pinned.
  //
  // An operator types `conclave`. That resolves off PATH to a symlink, and a shebang puts the
  // path you typed into argv, so `ps` used to record the SYMLINK. Everything that asks which
  // version a live process is running reads that line and resolves it, and an install MOVES it.
  // So a run that started on v9.9.9 began answering "v9.9.10" the moment the link swapped, and
  // the prune — which asks exactly that before removing a directory — found v9.9.9 idle.
  //
  // Measured before it was written: the same live pid resolved to v1 before a swap and v2 after
  // it, while still executing out of v1.
  const m = machine(t, { migrated: true })
  const child = liveRunViaPath(m.env)
  try {
    await settle(600)
    assert.ok(guardSees(child.pid!), 'the run must be one the script would recognise')

    // THE PREMISE, asserted rather than assumed: the command line names the version directory
    // it is actually executing out of, and not the symlink it was reached through. Without this
    // the assertions below would be about a run nobody could have attributed.
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(child.pid)], { encoding: 'utf8' })
    // Containment rather than a regex: these are filesystem paths full of dots, and escaping
    // them into a pattern is a second thing to get wrong in an assertion about a first.
    assert.ok(
      cmd.includes(join(m.root, 'v9.9.9', 'bin', 'conclave.ts')),
      `ps must carry the version directory's real path, got: ${cmd}`,
    )
    assert.ok(!cmd.includes(m.link), `and not the symlink an install is about to move, got: ${cmd}`)

    // The link moves out from under it, which is the whole point of the layout.
    upgrade(m)
    assert.equal(realpathSync(m.link), join(m.root, 'v9.9.10', 'bin', 'conclave'))

    const r = prune(m)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /keeping v9\.9\.9 — processes are running from it/)
    assert.match(r.out, new RegExp(`pid ${child.pid}\\b`), 'and it names what is live')
    assert.ok(existsSync(join(m.root, 'v9.9.9', 'bin', 'conclave.ts')), 'the directory it is running in survives')
    assert.ok(existsSync(join(m.root, '.installed', 'v9.9.9.rec')), 'and so does its record')
    assert.match(worktrees(m.repo), /v9\.9\.9/)
  } finally {
    child.kill('SIGKILL')
  }
})

test('#250 --prune-install leaves a branch worktree, another repository, and anything not named for a tag', (t) => {
  // Everything under the root that is not identifiable as a superseded version of THIS
  // repository. The machine this runs on has twenty-odd worktrees of this repo, so "it is in
  // the directory I look at" was never going to be enough to make something mine to delete.
  const m = machine(t, { migrated: true })
  upgrade(m)
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: m.repo })

  // Named exactly like a version, and holding somebody's branch.
  git('worktree', 'add', '-q', '-b', 'someones-work', join(m.root, 'v9.9.7'), 'v9.9.9')

  // Named for a tag THIS repository really has, and belonging to a different repository. This
  // is the case a path-shaped check gets wrong: the directory is in the right place with the
  // right name, and is still not ours.
  const other = join(m.base, 'other')
  mkdirSync(other, { recursive: true })
  const og = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: other })
  og('init', '-q', '-b', 'main')
  writeFileSync(join(other, 'unrelated.txt'), 'not conclave\n')
  og('add', '.')
  og('commit', '-qm', 'other')
  og('tag', 'v9.9.8')
  og('worktree', 'add', '--detach', '-q', join(m.root, 'v9.9.8'), 'v9.9.8')

  // And something that is not a checkout at all.
  mkdirSync(join(m.root, 'notes'), { recursive: true })
  writeFileSync(join(m.root, 'notes', 'why.txt'), 'kept by hand\n')

  // A NAME THAT IS NOT A VERSION, and one the old test could not tell from one. The rule used
  // to be the shell glob `v[0-9]*.[0-9]*.[0-9]*`, and `*` matches anything -- so `v9.9.9-rc1`
  // passed it and was carried into the identity checks on the strength of its name.
  mkdirSync(join(m.root, 'v9.9.9-rc1'), { recursive: true })
  writeFileSync(join(m.root, 'v9.9.9-rc1', 'why.txt'), 'a pre-release is not a release\n')

  const r = prune(m)
  assert.equal(r.code, 0, r.out)

  assert.ok(existsSync(join(m.root, 'v9.9.7')), 'a branch worktree is somebody’s work')
  assert.match(r.out, /keeping v9\.9\.7 — it holds someones-work/)
  assert.ok(existsSync(join(m.root, 'v9.9.8', 'unrelated.txt')), 'another repository’s worktree is not ours')
  assert.match(r.out, /keeping v9\.9\.8 — it belongs to another repository/)
  assert.ok(existsSync(join(m.root, 'notes', 'why.txt')), 'and a directory that is not a checkout is left alone')
  assert.match(r.out, /keeping notes — not named for a release tag/)
  assert.ok(existsSync(join(m.root, 'v9.9.9-rc1', 'why.txt')), 'a pre-release is not a version this installs')
  // THE MESSAGE, not just survival: under the old glob this reached the identity checks and was
  // kept for failing one of those instead, which is the same outcome for a different reason and
  // would have gone on passing.
  assert.match(r.out, /keeping v9\.9\.9-rc1 — not named for a release tag/)

  // The one thing it SHOULD have taken, so the test is not passing because the prune did nothing.
  assert.equal(existsSync(join(m.root, 'v9.9.9')), false, 'the superseded version was still removed')
})

test('#250 --prune-install keeps a version of this repository it cannot identify as finished', (t) => {
  // The other half of the identity rules, and the half that is about OUR OWN directories.
  // Everything here is a detached worktree of this repository named for a real release tag --
  // which is as far as a path-and-name check gets. What separates them from the version that is
  // actually removed is whether the directory is what its name says: at that tag's commit, with
  // nothing in it that somebody would miss.
  const m = machine(t, { migrated: true })
  upgrade(m)
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: m.repo })

  // At its tag, and carrying work. `git worktree remove` would refuse this too -- which is the
  // point of never passing `--force`, and no reason to make git the only thing that checks.
  git('worktree', 'add', '--detach', '-q', join(m.root, 'v9.9.6'), 'v9.9.6')
  writeFileSync(join(m.root, 'v9.9.6', 'someones-notes.txt'), 'not committed\n')

  // Named for a tag, and sitting on a different commit. A name is not evidence: this directory
  // says `v9.9.5` and holds v9.9.10, so whatever it is, it is not the version it claims.
  git('worktree', 'add', '--detach', '-q', join(m.root, 'v9.9.5'), 'v9.9.10')

  const r = prune(m)
  assert.equal(r.code, 0, r.out)

  assert.ok(existsSync(join(m.root, 'v9.9.6', 'someones-notes.txt')), 'uncommitted work is not this script’s to discard')
  assert.match(r.out, /keeping v9\.9\.6 — it has uncommitted changes/)
  assert.ok(existsSync(join(m.root, 'v9.9.5', 'bin', 'conclave.ts')), 'a directory that is not what it is named is left alone')
  assert.match(r.out, /keeping v9\.9\.5 — it is not checked out at v9\.9\.5/)

  // And the one that IS identifiable still goes, so this is not passing because nothing ran.
  assert.equal(existsSync(join(m.root, 'v9.9.9')), false, 'the superseded version was still removed')
})

test('#250 --prune-install keeps a version it did not install, however exactly it matches', (t) => {
  // THE GAP EVERY OTHER RULE LEAVES. All of them ask what a directory LOOKS like, and a person
  // with a terminal satisfies the whole set in one command:
  //
  //     git worktree add --detach ~/workspace/conclave-releases/v9.9.6 v9.9.6
  //
  // Same repository, detached, clean, under the root, named exactly for a release tag and
  // checked out at it. Resembling an install is not being one, so the only question left is
  // whether an installer wrote down that it made this — and nothing here adopts a directory on
  // the strength of a resemblance a human reproduces by accident.
  const m = machine(t, { migrated: true })
  upgrade(m)
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    'worktree', 'add', '--detach', '-q', join(m.root, 'v9.9.6'), 'v9.9.6'], { cwd: m.repo })

  const r = prune(m)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /keeping v9\.9\.6 — no ownership record says this installer made it/)
  assert.ok(existsSync(join(m.root, 'v9.9.6', 'bin', 'conclave.ts')), 'somebody else’s directory stays')
  assert.match(worktrees(m.repo), /v9\.9\.6/)
  // And the one that IS ours still goes, so this is not passing on a prune that did nothing.
  assert.equal(existsSync(join(m.root, 'v9.9.9')), false)
})

test('#250 --prune-install keeps a version whose record does not describe it', (t) => {
  // A record that matches three fields of four is a record for something else. Each of these
  // directories is a real, clean, detached worktree of this repository at the tag it is named
  // for, WITH a record — and each record is wrong in exactly one way, which is the shape a
  // record copied from another directory or left behind by a rename actually takes.
  const m = machine(t, { migrated: true })
  upgrade(m)
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: m.repo })
  for (const tag of ['v9.9.6', 'v9.9.5', 'v9.9.8', 'v9.9.4']) {
    git('worktree', 'add', '--detach', '-q', join(m.root, tag), tag)
  }

  // The commit is another version's: what a record copied from the directory beside it says.
  writeRecord(m.root, 'v9.9.6', {
    path: join(m.root, 'v9.9.6'), repo: m.repoId, ref: 'v9.9.6', commit: m.commitOf('v9.9.10'),
  })
  // The path is another directory's: what a record left behind by a rename says.
  writeRecord(m.root, 'v9.9.5', {
    path: join(m.root, 'v9.9.9'), repo: m.repoId, ref: 'v9.9.5', commit: m.commitOf('v9.9.5'),
  })
  // The repository is somebody else's, which is the field a forgery would get wrong last.
  writeRecord(m.root, 'v9.9.8', {
    path: join(m.root, 'v9.9.8'), repo: join(m.base, 'elsewhere', '.git'), ref: 'v9.9.8', commit: m.commitOf('v9.9.8'),
  })

  // The ref is a different version's, which is what a record kept through a re-tag says.
  writeRecord(m.root, 'v9.9.4', {
    path: join(m.root, 'v9.9.4'), repo: m.repoId, ref: 'v9.9.5', commit: m.commitOf('v9.9.4'),
  })

  const r = prune(m)
  assert.equal(r.code, 0, r.out)
  for (const tag of ['v9.9.6', 'v9.9.5', 'v9.9.8', 'v9.9.4']) {
    assert.ok(existsSync(join(m.root, tag, 'bin', 'conclave.ts')), `${tag} must survive a record that is not its own`)
    assert.match(r.out, new RegExp(`keeping ${tag.replace(/\./g, '\\.')} — no ownership record says this installer made it`))
  }
  assert.equal(existsSync(join(m.root, 'v9.9.9')), false, 'and the properly recorded one still goes')
})

test('#250 a record this installer wrote is one it will reuse and one it will prune', (t) => {
  // The round trip, in the direction the negative tests cannot cover: the record `release.sh`
  // writes has to be a record `release.sh` accepts. A format that only ever refuses would pass
  // every test above and install nothing twice.
  const m = machine(t, { migrated: true })
  upgrade(m)

  const rec = join(m.root, '.installed', 'v9.9.10.rec')
  assert.ok(existsSync(rec), 'creating a version directory records that it did')
  assert.equal(
    readFileSync(rec, 'utf8'),
    `path=${join(m.root, 'v9.9.10')}\nrepo=${m.repoId}\nref=v9.9.10\ncommit=${m.commitOf('v9.9.10')}\n`,
    'and the record binds the directory, the repository, the ref and the commit',
  )

  // REUSED, not refused. Re-running finds the directory it made and says so.
  const again = spawnSync('sh', [SCRIPT, '--install-only'], { cwd: m.repo, env: m.env, encoding: 'utf8' })
  const out = `${again.stdout}${again.stderr}`
  assert.equal(again.status, 0, out)
  assert.match(out, /already exists — reusing it/)

  // AND PRUNED. Moved back to the older version — a rollback, which is the reason a machine has
  // two of these at once — the version release.sh built is no longer active and is removed on
  // the strength of the record release.sh wrote for it.
  execFileSync('ln', ['-sfn', join(m.root, 'v9.9.9', 'bin', 'conclave'), `${m.link}.tmp`])
  execFileSync('mv', ['-f', `${m.link}.tmp`, m.link])
  const r = prune(m)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /removing v9\.9\.10/)
  assert.equal(existsSync(join(m.root, 'v9.9.10')), false)
  assert.equal(existsSync(rec), false, 'and its record goes with it')
  assert.ok(existsSync(join(m.root, 'v9.9.9', 'bin', 'conclave.ts')), 'the one on PATH is never a candidate')
})

test('#250 an unmarked directory at the destination cannot capture the PATH link', (t) => {
  // The other end of the same rule, and the one with teeth: if something is already sitting
  // where the new version goes, reusing it would put whatever is inside it on PATH under the
  // name of a release. The install refuses and changes nothing — the link still points where it
  // did, and the directory is left exactly as it was found.
  const m = machine(t, { migrated: true })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    'worktree', 'add', '--detach', '-q', join(m.root, 'v9.9.10'), 'v9.9.10'], { cwd: m.repo })
  const before = realpathSync(m.link)
  assert.equal(before, join(m.root, 'v9.9.9', 'bin', 'conclave'))

  const r = spawnSync('sh', [SCRIPT, '--install-only'], { cwd: m.repo, env: m.env, encoding: 'utf8' })
  const out = `${r.stdout}${r.stderr}`
  assert.equal(r.status, 1, out)
  assert.match(out, /is not one this installer made/)
  assert.equal(realpathSync(m.link), before, 'PATH must not be moved onto a directory nothing accounts for')
  assert.ok(existsSync(join(m.root, 'v9.9.10', 'bin', 'conclave.ts')), 'and the directory is left where it is')
  assert.equal(existsSync(join(m.root, '.installed', 'v9.9.10.rec')), false, 'nor is one written for it after the fact')
})

/** The record and readiness files, as one comparable snapshot. */
function records(root: string): Record<string, string> {
  const dir = join(root, '.installed')
  if (!existsSync(dir)) return {}
  return Object.fromEntries(readdirSync(dir).map((n) => [n, readFileSync(join(dir, n), 'utf8')]))
}

test('#250 an owned directory that never finished is rebuilt, not topped up', (t) => {
  // The gap the ownership record cannot close. It is written the moment the worktree exists,
  // before `npm ci` — so an install killed in between leaves a directory that is owned, has a
  // PARTIAL node_modules, and passes every ownership check there is. The old rule was
  // `[ -d node_modules ]`, which reads a half-written tree as a finished one and puts it on
  // PATH. What separates the two is not the directory: it is whether anything ever got to the
  // end, which is what the readiness marker records.
  const m = machine(t, { migrated: true })
  const half = join(m.root, 'v9.9.10')
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    'worktree', 'add', '--detach', '-q', half, 'v9.9.10'], { cwd: m.repo })
  writeRecord(m.root, 'v9.9.10', {
    path: half, repo: m.repoId, ref: 'v9.9.10', commit: m.commitOf('v9.9.10'),
  })
  // What a killed `npm ci` leaves: something, and not enough. A DOT-DIRECTORY, measured
  // rather than picked -- npm prunes plain files and extraneous packages out of `node_modules`
  // on its next run, but leaves dot-entries alone, and `.package-lock.json` is exactly such an
  // entry and exactly the one that makes a later install believe the tree is already correct.
  // A marker npm would have tidied up would have tested npm rather than this script.
  mkdirSync(join(half, 'node_modules', '.half-written'), { recursive: true })
  writeFileSync(join(half, 'node_modules', '.half-written', 'marker.txt'), 'killed part way\n')
  assert.equal(existsSync(join(m.root, '.installed', 'v9.9.10.ready')), false, 'and it never got to the end')

  const out = upgrade(m)
  assert.match(out, /was never finished — discarding its partial dependencies/)
  assert.equal(
    existsSync(join(half, 'node_modules', '.half-written')),
    false,
    'the partial tree is discarded rather than added to',
  )
  assert.ok(existsSync(join(half, 'node_modules', 'marker.txt')), 'and rebuilt from the previous install')
  assert.ok(existsSync(join(m.root, '.installed', 'v9.9.10.ready')), 'and only now is it marked ready')
  assert.equal(realpathSync(m.link), join(half, 'bin', 'conclave'))
})

test('#250 a directory that did finish is reused without touching its dependencies again', (t) => {
  // The other side, or "rebuild always" would pass the test above and make every install a
  // fresh `npm ci`.
  const m = machine(t, { migrated: true })
  upgrade(m)
  const provisioned = readFileSync(join(m.root, 'v9.9.10', 'node_modules', 'marker.txt'), 'utf8')

  const out = upgrade(m)
  assert.match(out, /already exists — reusing it/)
  assert.match(out, /is provisioned and verified — leaving its dependencies alone/)
  assert.doesNotMatch(out, /discarding its partial dependencies/)
  assert.doesNotMatch(out, /cloning node_modules/)
  assert.equal(readFileSync(join(m.root, 'v9.9.10', 'node_modules', 'marker.txt'), 'utf8'), provisioned)
})

test('#250 a recorded directory that is no longer what its record describes is refused', (t) => {
  // A record says who made a directory and what was put in it. It says nothing about what has
  // happened since, and nothing at all lives inside the worktree for git to notice — so a
  // recorded version can be checked out elsewhere, put on a branch, or edited without a single
  // ownership check changing its answer. Each of these is the version that would go on PATH.
  const m = machine(t, { migrated: true })
  upgrade(m)
  const dir = join(m.root, 'v9.9.10')
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', dir, ...a])
  // Rolled back, so the install has something to do and v9.9.10 is the destination again.
  const rollback = () => {
    execFileSync('ln', ['-sfn', join(m.root, 'v9.9.9', 'bin', 'conclave'), `${m.link}.tmp`])
    execFileSync('mv', ['-f', `${m.link}.tmp`, m.link])
  }

  for (const [what, breakIt, fixIt] of [
    ['edited', () => writeFileSync(join(dir, 'package.json'), '{"version":"forged"}\n'), () => git('checkout', '--', '.')],
    ['moved to another commit', () => git('checkout', '-q', '--detach', 'v9.9.9'), () => git('checkout', '-q', '--detach', 'v9.9.10')],
    ['put on a branch', () => git('checkout', '-q', '-b', 'someones-work'), () => git('checkout', '-q', '--detach', 'v9.9.10')],
  ] as const) {
    rollback()
    breakIt()
    const r = spawnSync('sh', [SCRIPT, '--install-only'], { cwd: m.repo, env: m.env, encoding: 'utf8' })
    const out = `${r.stdout}${r.stderr}`
    assert.equal(r.status, 1, `${what}: ${out}`)
    assert.match(out, /no longer the checkout its record describes/, what)
    assert.equal(realpathSync(m.link), join(m.root, 'v9.9.9', 'bin', 'conclave'), `${what}: PATH must not move`)
    fixIt()
  }

  // And once it is what it says again, the install goes through — so the refusal is a check and
  // not a wall.
  rollback()
  assert.match(upgrade(m), /already exists — reusing it/)
})

test('#250 --prune-install --dry-run changes neither a worktree nor a record', (t) => {
  const m = machine(t, { migrated: true })
  upgrade(m)
  const before = { trees: worktrees(m.repo), recs: records(m.root) }
  assert.ok(before.recs['v9.9.9.rec'], 'the fixture must have something a real prune would take')

  const r = prune(m, ['--dry-run'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /would run: git -C .* worktree remove .*v9\.9\.9/, 'it must say what it would do')
  assert.match(r.out, /would run: mv .*v9\.9\.9\.rec/, 'including to the record')

  assert.equal(worktrees(m.repo), before.trees, 'a dry run must not remove a worktree')
  assert.deepEqual(records(m.root), before.recs, 'nor move, rewrite or delete a record')
  assert.ok(existsSync(join(m.root, 'v9.9.9', 'bin', 'conclave.ts')))
})

test('#250 a removal git refuses puts the ownership record back', (t) => {
  // CRASH ORDER, from the recoverable end. The record is invalidated BEFORE the directory goes,
  // because the other order leaves a window where a valid record describes a directory that is
  // not there — and the next worktree somebody adds at that path is then vouched for by a record
  // nobody wrote for it. `git worktree remove` on a large tree is the slowest step here, so that
  // window is not theoretical.
  //
  // The cost of that order is that an ordinary refusal from git would strand the record, so it
  // is moved aside rather than deleted and put back when the removal does not happen. Provoked
  // by taking write permission off the releases root, which is where the directory entry has to
  // be removed from — `.installed` is its own directory and stays writable, which is why the
  // record can still be moved.
  const m = machine(t, { migrated: true })
  upgrade(m)
  const rec = join(m.root, '.installed', 'v9.9.9.rec')
  const before = readFileSync(rec, 'utf8')

  chmodSync(m.root, 0o555)
  let r
  try {
    r = prune(m)
  } finally {
    chmodSync(m.root, 0o755)
  }
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /keeping v9\.9\.9 — git refused to remove it, so its record is put back/)
  assert.equal(readFileSync(rec, 'utf8'), before, 'the record is back, byte for byte')
  assert.equal(existsSync(`${rec}.removing`), false, 'and nothing is left half-way')
  // The moved-aside name is not a name records are read from, so even a crash mid-way leaves a
  // directory nothing will adopt rather than a record for a directory that is not there.
  assert.equal(existsSync(join(m.root, '.installed', 'v9.9.9.rec.removing')), false)
})

test('#250 the legacy checkout is removed, and only after the switch and only when nothing is in it', async (t) => {
  // The migration ends by deleting the directory it moved off, because that directory is the
  // one the new layout cannot keep promises about. Which is exactly why it is last: the worktree
  // is built, its version proved out of its own path, and the symlink renamed onto it before
  // anything is removed. Reversed, a bad new version would leave the machine with no CLI at all.
  const m = machine(t, { migrated: false })

  const child = liveRun(m.dir)
  try {
    await settle(400)
    const busy = spawnSync('sh', [SCRIPT, '--install-only'], { cwd: m.repo, env: m.env, encoding: 'utf8' })
    assert.equal(busy.status, 1, `${busy.stdout}${busy.stderr}`)
    assert.ok(existsSync(join(m.dir, 'bin', 'conclave.ts')), 'a refused migration removes nothing')
  } finally {
    child.kill('SIGKILL')
  }

  await settle(700)
  const r = spawnSync('sh', [SCRIPT, '--install-only'], { cwd: m.repo, env: m.env, encoding: 'utf8' })
  const out = `${r.stdout}${r.stderr}`
  assert.equal(r.status, 0, out)
  assert.match(out, /removing the checkout the install migrated from/)
  assert.equal(existsSync(m.dir), false, 'the legacy checkout is gone')
  assert.doesNotMatch(worktrees(m.repo), /conclave-stable/, 'and git no longer lists it')

  // ONLY AFTER THE SWITCH. The removal is safe because this is already true when it happens.
  assert.equal(realpathSync(m.link), join(m.root, 'v9.9.10', 'bin', 'conclave'))
  assert.match(out, /install is on v9\.9\.10/)
})

test('#182 a dry run executes nothing, and says what it would have done', (t) => {
  // AGAINST A FIXTURE, not against this checkout (#248). Run in `REPO`, every assertion below
  // holds when the script refuses at its first guard and never reaches the dry-run path at all:
  // HEAD unchanged, tree unchanged and a non-empty stderr are exactly what a refusal produces.
  // Proved by mutation — an unconditional `exit 1` after argument parsing left this test green.
  //
  // And it was not hypothetical. `REPO` refuses on an uncommitted tree, which this file's own
  // comment admitted is the normal state of it, and refused again whenever a conclave run was
  // live anywhere on the machine. The test has been passing without reaching its subject for
  // most of its life.
  //
  // A fixture is clean, committed and has an origin, so the script gets past its preconditions
  // and the dry run actually runs.
  const dir = fakeRepo(t)
  const state = () => ({
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(),
    tree: execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim(),
  })

  const before = state()
  const r = run(['9.9.100', '--dry-run'], dir)
  const after = state()

  // THE DISCRIMINATOR. `run()` in the script prints `would run: …` instead of executing, and it
  // prints that ONLY once the preconditions are past — so this is what separates "the dry run
  // executed nothing" from "nothing executed at all", which is the whole claim of the test.
  assert.match(r.out, /would run:/, 'the dry-run path must actually be reached')
  assert.doesNotMatch(r.out, /refusing/, 'and not be refused before it gets there')

  assert.equal(after.head, before.head, 'a dry run must not commit')
  assert.equal(after.tree, before.tree, 'a dry run must not change what is modified')

  // AND IT MUST SUCCEED. Comparing the tree cannot catch a dry run that really executes: the
  // first thing it would execute is `npm run test` in a fixture with no dependencies, which
  // fails and stops the script before it reaches anything that writes. So the tree looks
  // untouched for the wrong reason, and only the exit code tells the two apart.
  assert.equal(r.code, 0, 'a dry run must run to the end rather than die partway')
})

const lock = (version: string, extra = '') =>
  JSON.stringify({ name: 'x', version, packages: { '': { version, ...(extra ? { dependencies: { dep: extra } } : {}) } } }, null, 2)

test('#182 a pure version bump is not a dependency move', (t) => {
  // `scripts/release.sh` reported "the release moved a dependency" while cutting v0.5.12 and ran
  // a needless `npm ci`. The rule counted changed lines and treated more than two as a move --
  // but package-lock.json carries the version TWICE, at the root and under `packages[""]`, so a
  // pure bump is four lines.
  //
  // A FIXTURE, not the repo's own tags. The first version of this test diffed `v0.5.11..v0.5.12`
  // and failed on all three CI runners with `fatal: bad revision` -- the checkout has no tags,
  // so it was asserting about the environment rather than the code.
  const m = machine(t, { migrated: true })
  const r = spawnSync('sh', [SCRIPT, '--install-only'], { cwd: m.repo, env: m.env, encoding: 'utf8' })
  const out = `${r.stdout}${r.stderr}`
  assert.equal(r.status, 0, out)
  assert.match(out, /install is on v9\.9\.10/, 'it still moves the checkout')
  assert.doesNotMatch(out, /moved a dependency/, 'a version bump alone must not trigger a reinstall')
})

test('#182 a dependency that really moved is still detected', (t) => {
  // The other half, or the fix would be "never reinstall", which is worse than reinstalling
  // always: node_modules would silently disagree with the source it was installed from.
  const m = machine(t, { migrated: true, lockA: lock('9.9.9', '^1.0.0'), lockB: lock('9.9.10', '^2.0.0') })
  const out = (() => {
    const r = spawnSync('sh', [SCRIPT, '--install-only'], { cwd: m.repo, env: m.env, encoding: 'utf8' })
    return `${r.stdout}${r.stderr}`
  })()
  assert.match(out, /moved a dependency/, 'a changed dependency must still be noticed')
})

test('#249 a run in ANOTHER repository does not block the tag; one in this repository does', (t) => {
  // The tag guard protects this repo's branch and tree, so only runs working HERE can threaten
  // it. It used to refuse for any conclave run on the machine, which held up a release for an
  // hour because a session was working in an unrelated project.
  //
  // The install guard is deliberately untouched and stays machine-wide: every run executes from
  // `conclave-stable`, so swapping that under any of them is the hazard it describes.
  const dir = fakeRepo(t, '9.9.9')
  const elsewhere = tempDir(t, 'conclave-elsewhere')

  // A process the guard's own matcher recognises: a resolved path ending `/conclave` followed by
  // a subcommand. Built rather than mocked, because what is under test is which PROCESSES the
  // script counts, and a mock would decide that itself.
  // OUTSIDE the fixture, or creating it dirties the tree and the release refuses for that
  // instead — which would have made the first assertion below pass for the wrong reason.
  const bin = join(tempDir(t, 'conclave-fakebin'), 'bin')
  mkdirSync(bin, { recursive: true })
  const entry = join(bin, 'conclave.ts')
  writeFileSync(entry, 'setTimeout(() => {}, 60000)\n')

  const started: ChildProcess[] = []
  const runIn = (cwd: string) => {
    const c = spawn(process.execPath, [entry, 'session', 'probe'], { cwd, stdio: 'ignore' })
    started.push(c)
    return c
  }
  try {
    runIn(elsewhere)
    execFileSync('/bin/sh', ['-c', 'sleep 1'])
    // NOT a dry run. Since #248 a dry run skips this guard entirely, so asking with `--dry-run`
    // would pass whatever the scoping did — which is what the first version of this test did,
    // and it stayed green with the guard reverted to machine-wide.
    //
    // A real invocation stops at `npm run test` in a fixture with no scripts, which is fine: the
    // guard is evaluated before verification, so reaching "verifying before" is proof it passed.
    const away = run(['9.9.100'], dir)
    assert.doesNotMatch(away.out, /a run is in flight/, 'a run in another repository is not this repo’s business')
    assert.match(away.out, /verifying before/, 'and the release got past the guard')

    runIn(dir)
    execFileSync('/bin/sh', ['-c', 'sleep 1'])
    const here = run(['9.9.100'], dir)
    assert.match(here.out, /a run is in flight in this repository/, 'a run working HERE still refuses')
    assert.equal(here.code, 1)
  } finally {
    for (const c of started) c.kill('SIGKILL')
  }
})
