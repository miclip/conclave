/**
 * The per-machine record of which install a run last launched from (#356).
 *
 * Every case builds its own install layout in a temp directory -- `<root>/bin/conclave` (the
 * sh launcher), `<root>/bin/conclave.ts` (what node runs), and a `conclave` symlink in a bin
 * directory that is the whole PATH -- and its own `XDG_STATE_HOME`, so nothing here reads or
 * writes the real one. No process is spawned: the function takes its entry file and env as
 * arguments precisely so the layout can be a fixture.
 *
 *   node --test src/workspace/installLaunch.test.ts
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'
import {
  installLaunchRecordPath,
  installLaunchStateDir,
  installedRoot,
  noteInstallLaunch,
  type InstallLaunchInputs,
} from './installLaunch.ts'

/** A version directory shaped like one `release.sh` installs: launcher script and entry. */
function install(t: TestContext, name: string): { root: string; entry: string } {
  const root = join(tempDir(t, `conclave-install-${name}`), name)
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(root, 'bin', 'conclave'), '#!/bin/sh\nexec node "$(dirname "$0")/conclave.ts" "$@"\n', { mode: 0o755 })
  writeFileSync(join(root, 'bin', 'conclave.ts'), '')
  return { root, entry: join(root, 'bin', 'conclave.ts') }
}

/** A `~/.local/bin`-style directory whose `conclave` points at the given launcher. */
function pathWith(t: TestContext, launcher: string | undefined): string {
  const bin = tempDir(t, 'conclave-path-bin')
  if (launcher !== undefined) symlinkSync(launcher, join(bin, 'conclave'))
  return bin
}

type Fixture = {
  inputs: InstallLaunchInputs
  recordPath: string
  /** The same machine, launching a different build from a different (or the same) install. */
  again: (build: string, entry?: string) => InstallLaunchInputs
}

/** A machine: one install on PATH, an empty state directory, and a way to launch again. */
function machine(t: TestContext, build: string, onPath: string | undefined, entry: string): Fixture {
  const state = tempDir(t, 'conclave-state')
  const env = { PATH: pathWith(t, onPath), XDG_STATE_HOME: state }
  const home = tempDir(t, 'conclave-home')
  const inputs: InstallLaunchInputs = { build, entry, env, home }
  return {
    inputs,
    recordPath: installLaunchRecordPath(env, home),
    again: (b, e = entry) => ({ build: b, entry: e, env, home }),
  }
}

function readRecord(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// ---------------------------------------------------------------------------------------------
// Where the record lives

test('the record lives under $XDG_STATE_HOME/conclave when that is set and absolute', () => {
  assert.equal(installLaunchStateDir({ XDG_STATE_HOME: '/var/state' }, '/home/u'), '/var/state/conclave')
  assert.equal(installLaunchRecordPath({ XDG_STATE_HOME: '/var/state' }, '/home/u'), '/var/state/conclave/install-launch.json')
})

test('unset, empty or relative XDG_STATE_HOME falls back to ~/.local/state, as the spec says', () => {
  const want = '/home/u/.local/state/conclave'
  assert.equal(installLaunchStateDir({}, '/home/u'), want)
  assert.equal(installLaunchStateDir({ XDG_STATE_HOME: '' }, '/home/u'), want)
  assert.equal(installLaunchStateDir({ XDG_STATE_HOME: '  ' }, '/home/u'), want)
  assert.equal(installLaunchStateDir({ XDG_STATE_HOME: 'state' }, '/home/u'), want, 'a relative value is ignored, not joined')
})

// ---------------------------------------------------------------------------------------------
// Installed or not

test('a launch through the install on PATH resolves to that install root', (t) => {
  // The real layout: PATH's `conclave` is a symlink to the sh launcher, and the process runs
  // the .ts entry beside it. Not the same file -- the same directory.
  const v1 = install(t, 'v1')
  const env = { PATH: pathWith(t, join(v1.root, 'bin', 'conclave')) }
  assert.equal(installedRoot(v1.entry, env), v1.root)
})

test('a checkout run directly, while a different install is on PATH, is not installed', (t) => {
  const v1 = install(t, 'v1')
  const checkout = install(t, 'checkout')
  const env = { PATH: pathWith(t, join(v1.root, 'bin', 'conclave')) }
  assert.equal(installedRoot(checkout.entry, env), undefined)
})

test('no conclave on PATH, an empty PATH, or a dangling link: not installed, and no throw', (t) => {
  const v1 = install(t, 'v1')
  assert.equal(installedRoot(v1.entry, { PATH: pathWith(t, undefined) }), undefined)
  assert.equal(installedRoot(v1.entry, { PATH: '' }), undefined)
  assert.equal(installedRoot(v1.entry, {}), undefined)
  assert.equal(installedRoot(v1.entry, { PATH: pathWith(t, join(v1.root, 'bin', 'gone')) }), undefined, 'dangling')
})

test('PATH is searched in order, like a shell, so the first conclave decides', (t) => {
  const v1 = install(t, 'v1')
  const v2 = install(t, 'v2')
  const first = pathWith(t, join(v1.root, 'bin', 'conclave'))
  const second = pathWith(t, join(v2.root, 'bin', 'conclave'))
  const env = { PATH: `${first}:${second}` }
  assert.equal(installedRoot(v1.entry, env), v1.root)
  assert.equal(installedRoot(v2.entry, env), undefined, 'v2 is on PATH but not what a shell would run')
})

test('a conclave on PATH that is not executable is skipped, as a shell would skip it', (t) => {
  // A stray file named `conclave` earlier on PATH -- a note, a download -- is not what a shell
  // runs, so it must not be what decides whether this launch is the install.
  const v1 = install(t, 'v1')
  const stray = tempDir(t, 'conclave-path-stray')
  writeFileSync(join(stray, 'conclave'), 'not a program', { mode: 0o644 })
  const real = pathWith(t, join(v1.root, 'bin', 'conclave'))
  assert.equal(installedRoot(v1.entry, { PATH: `${stray}:${real}` }), v1.root)
})

// ---------------------------------------------------------------------------------------------
// The four states

test('first: no record on the machine names this build and writes the record', (t) => {
  const v1 = install(t, 'v1')
  const m = machine(t, '0.5.1 (aaaaaaa)', join(v1.root, 'bin', 'conclave'), v1.entry)
  assert.ok(!existsSync(m.recordPath), 'fixture: fresh machine')

  const r = noteInstallLaunch(m.inputs)
  assert.deepEqual(r, { kind: 'first', build: '0.5.1 (aaaaaaa)', recorded: true })
  assert.deepEqual(readRecord(m.recordPath), { build: '0.5.1 (aaaaaaa)', root: v1.root })
})

test('unchanged: the same install as last time', (t) => {
  const v1 = install(t, 'v1')
  const m = machine(t, '0.5.1 (aaaaaaa)', join(v1.root, 'bin', 'conclave'), v1.entry)
  noteInstallLaunch(m.inputs)

  const r = noteInstallLaunch(m.again('0.5.1 (aaaaaaa)'))
  assert.deepEqual(r, {
    kind: 'unchanged',
    build: '0.5.1 (aaaaaaa)',
    previous: { build: '0.5.1 (aaaaaaa)', root: v1.root },
    recorded: true,
  })
})

test('changed: the install on PATH now resolves to a different directory, and both builds are named', (t) => {
  // The #356 case: a release cut elsewhere repointed the symlink between two launches.
  const v1 = install(t, 'v1')
  const v2 = install(t, 'v2')
  const m = machine(t, '0.5.1 (aaaaaaa)', join(v1.root, 'bin', 'conclave'), v1.entry)
  noteInstallLaunch(m.inputs)

  // Repoint: the same PATH directory, its `conclave` now leading to v2.
  const link = join(m.inputs.env['PATH']!, 'conclave')
  unlinkSync(link)
  symlinkSync(join(v2.root, 'bin', 'conclave'), link)

  const r = noteInstallLaunch(m.again('0.5.2 (bbbbbbb)', v2.entry))
  assert.equal(r.kind, 'changed')
  assert.equal(r.build, '0.5.2 (bbbbbbb)')
  assert.deepEqual((r as { previous: unknown }).previous, { build: '0.5.1 (aaaaaaa)', root: v1.root })
  assert.deepEqual(readRecord(m.recordPath), { build: '0.5.2 (bbbbbbb)', root: v2.root }, 'the record moves with the install')
})

test('changed: the same directory holding a different package version', (t) => {
  // Nothing installs in place today; this is the claim that the comparison is not ONLY the path.
  const v1 = install(t, 'v1')
  const m = machine(t, '0.5.1', join(v1.root, 'bin', 'conclave'), v1.entry)
  noteInstallLaunch(m.inputs)
  const r = noteInstallLaunch(m.again('0.5.2'))
  assert.equal(r.kind, 'changed')
})

test('a working tree on PATH that moved a commit is unchanged: the install did not move', (t) => {
  // The noise guard. A checkout symlinked onto PATH is that machine's install, and its build
  // string changes with every commit; comparing the commit would fire on nearly every run.
  const wt = install(t, 'worktree')
  const m = machine(t, '0.5.1 (aaaaaaa)', join(wt.root, 'bin', 'conclave'), wt.entry)
  noteInstallLaunch(m.inputs)
  const r = noteInstallLaunch(m.again('0.5.1 (bbbbbbb-dirty)'))
  assert.equal(r.kind, 'unchanged')
  assert.deepEqual(readRecord(m.recordPath), { build: '0.5.1 (bbbbbbb-dirty)', root: wt.root }, 'but the build named is the latest')
})

test('development: a direct launch neither notices nor writes, and leaves an existing record alone', (t) => {
  const v1 = install(t, 'v1')
  const checkout = install(t, 'checkout')
  const m = machine(t, '0.5.1 (aaaaaaa)', join(v1.root, 'bin', 'conclave'), v1.entry)
  noteInstallLaunch(m.inputs)
  const before = readFileSync(m.recordPath, 'utf8')

  const r = noteInstallLaunch(m.again('0.5.1 (zzzzzzz-dirty)', checkout.entry))
  assert.deepEqual(r, { kind: 'development', build: '0.5.1 (zzzzzzz-dirty)' })
  assert.equal(readFileSync(m.recordPath, 'utf8'), before, 'the record is not touched')
})

test('development on a fresh machine writes nothing at all', (t) => {
  const v1 = install(t, 'v1')
  const checkout = install(t, 'checkout')
  const m = machine(t, '0.5.1 (aaaaaaa)', join(v1.root, 'bin', 'conclave'), checkout.entry)
  assert.equal(noteInstallLaunch(m.inputs).kind, 'development')
  assert.ok(!existsSync(installLaunchStateDir(m.inputs.env, m.inputs.home)), 'not even the directory')
})

test('an entry file that does not exist is development, not a throw', (t) => {
  const v1 = install(t, 'v1')
  const m = machine(t, '0.5.1', join(v1.root, 'bin', 'conclave'), join(v1.root, 'bin', 'missing.ts'))
  assert.equal(noteInstallLaunch(m.inputs).kind, 'development')
})

// ---------------------------------------------------------------------------------------------
// The record cannot fail a run

for (const [what, content] of [
  ['not JSON', 'v0.5.1 aaaaaaa\n'],
  ['empty', ''],
  ['a JSON string', '"0.5.1"'],
  ['JSON null', 'null'],
  ['an object missing root', '{"build":"0.5.1"}'],
  ['an object with the wrong types', '{"build":1,"root":["x"]}'],
  ['an object with empty strings', '{"build":"","root":""}'],
] as const) {
  test(`a garbage record (${what}) reads as no record, and is replaced`, (t) => {
    const v1 = install(t, 'v1')
    const m = machine(t, '0.5.1 (aaaaaaa)', join(v1.root, 'bin', 'conclave'), v1.entry)
    mkdirSync(installLaunchStateDir(m.inputs.env, m.inputs.home), { recursive: true })
    writeFileSync(m.recordPath, content)

    const r = noteInstallLaunch(m.inputs)
    assert.deepEqual(r, { kind: 'first', build: '0.5.1 (aaaaaaa)', recorded: true })
    assert.deepEqual(readRecord(m.recordPath), { build: '0.5.1 (aaaaaaa)', root: v1.root })
  })
}

test('an unreadable record (a directory where the file should be) is first, and the failed write is reported', (t) => {
  // A directory, not a chmod: root reads a 000 file happily, and CI has run this as root.
  const v1 = install(t, 'v1')
  const m = machine(t, '0.5.1 (aaaaaaa)', join(v1.root, 'bin', 'conclave'), v1.entry)
  mkdirSync(m.recordPath, { recursive: true })

  const r = noteInstallLaunch(m.inputs)
  assert.deepEqual(r, { kind: 'first', build: '0.5.1 (aaaaaaa)', recorded: false })
})

test('an unwritable state directory (a file where the directory should be) still answers, unrecorded', (t) => {
  const v1 = install(t, 'v1')
  const m = machine(t, '0.5.1 (aaaaaaa)', join(v1.root, 'bin', 'conclave'), v1.entry)
  writeFileSync(installLaunchStateDir(m.inputs.env, m.inputs.home), 'not a directory')

  const r = noteInstallLaunch(m.inputs)
  assert.deepEqual(r, { kind: 'first', build: '0.5.1 (aaaaaaa)', recorded: false })
})

test('a write that fails leaves the previous record in place, and the launch still compares against it', (t) => {
  // The write is tmp+rename. A directory squatting on the tmp path makes the write fail without
  // touching the file that is there, so a launch that cannot record itself still says what
  // changed -- and the next one that can will compare against a record that was never lost.
  const v1 = install(t, 'v1')
  const m = machine(t, '0.5.1 (aaaaaaa)', join(v1.root, 'bin', 'conclave'), v1.entry)
  noteInstallLaunch(m.inputs)
  mkdirSync(`${m.recordPath}.tmp.${process.pid}`, { recursive: true })

  const r = noteInstallLaunch(m.again('0.5.2 (bbbbbbb)'))
  assert.deepEqual(r, {
    kind: 'changed',
    build: '0.5.2 (bbbbbbb)',
    previous: { build: '0.5.1 (aaaaaaa)', root: v1.root },
    recorded: false,
  })
  assert.deepEqual(readRecord(m.recordPath), { build: '0.5.1 (aaaaaaa)', root: v1.root }, 'the old record survives')
})
