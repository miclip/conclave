/**
 * Which file a detached child is launched from (#250).
 *
 * `conclave --detach` re-executes the CLI as a background `relay`, and it used to hand the
 * child `process.argv[1]`. Node makes that absolute but does NOT resolve it, so a run started
 * through the installed CLI carries the SYMLINK -- `~/.local/bin/conclave` -- and the child
 * follows that link at its own exec, a moment later. Measured rather than supposed:
 *
 *     node <symlink>   ->  argv[1]         = the symlink
 *                          import.meta.url = the file behind it
 *
 * For most of this project's life that was a window nobody could realistically hit. Since #250
 * it is a window a release opens ON PURPOSE: installing a version now ends by repointing that
 * exact symlink, so a `--detach` spanning the swap would put the parent on one version and the
 * child it launched on another -- the half-a-version run the old install guard existed to
 * prevent, reappearing one process further along.
 *
 *   node --test src/relay/detachEntry.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'
import { waitFor } from '../testkit/waitFor.ts'
import { listSessions } from '../workspace/sessionRecord.ts'

const BIN = join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts')

function repo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-detach-entry')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'work.ts'), 'export const answer = 42\n')
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

test('#250 a detached child is launched from the file its parent is running, not through the symlink', async (t) => {
  // DRIVEN THROUGH A DRIVER SCRIPT, and the reason is the whole difficulty of this test.
  //
  // The window under test opens when the process starts and closes when it spawns -- a few
  // hundred milliseconds of Node startup, all of it before anything observable happens. A test
  // that launches `node <symlink>` and then repoints the symlink is racing that window from
  // outside and loses in BOTH directions: measured here, repointing immediately after `spawn()`
  // returns beat the parent's own `open()` of the main module, so the parent ran the stub. There
  // is no signal in between to synchronise on.
  //
  // So the ordering is made sequential instead of raced. The driver sets `argv[1]` to the
  // symlink -- which is exactly and only what an install through PATH does -- repoints that
  // symlink, and only then calls `main`. "Before the spawn" is then a property of the program,
  // not a margin against another process's startup.
  //
  // In-process `main()` for a detach is possible for the first time BECAUSE of this fix: it was
  // unreachable while the child came from `argv[1]`, since under `node --test` that is the test
  // file, and the two existing detach tests say so. Here `argv[1]` is set explicitly, so it is
  // never the test file whichever way the line under test is written.
  const dir = repo(t)
  const box = tempDir(t, 'conclave-detach-box')
  const link = join(box, 'conclave')
  const stub = join(box, 'stub.ts')
  const marker = join(box, 'stub-ran.txt')

  // What the symlink is repointed AT: a stand-in for the next version's CLI. It records that it
  // was launched, which is the only thing this test needs it to do.
  writeFileSync(
    stub,
    `import { writeFileSync } from 'node:fs'\n` +
      `writeFileSync(${JSON.stringify(marker)}, process.argv.join(' ') + '\\n')\n`,
  )
  // Where the run started: the version directory the parent is executing out of.
  symlinkSync(BIN, link)

  const driver = join(box, 'driver.mjs')
  writeFileSync(
    driver,
    `import { renameSync, symlinkSync } from 'node:fs'\n` +
      `process.chdir(${JSON.stringify(dir)})\n` +
      `// As if this process had been started through the installed CLI on PATH.\n` +
      `process.argv[1] = ${JSON.stringify(link)}\n` +
      `// The release repoints it. Sequential, so "before the spawn" is not a race.\n` +
      `symlinkSync(${JSON.stringify(stub)}, ${JSON.stringify(link + '.tmp')})\n` +
      `renameSync(${JSON.stringify(link + '.tmp')}, ${JSON.stringify(link)})\n` +
      `const { main } = await import(${JSON.stringify(pathToFileURL(BIN).href)})\n` +
      // Agent names no registry knows, so the child fails at resolution and ends itself rather
      // than starting a real session -- the containment the other two detach tests use.
      `process.exit(await main(['relay', 'Keep the work moving.', '--detach', ` +
      `'--advisor', 'fake-advisor', '--implementer', 'fake-impl']))\n`,
  )

  let detached: number | undefined
  try {
    execFileSync(process.execPath, [driver], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
    const sessions = listSessions(dir)
    assert.equal(sessions.length, 1, 'the parent must record the session it handed off')
    detached = sessions[0]!.status.pid
    const log = join(dir, '.conclave', 'sessions', sessions[0]!.status.id, 'stdio.log')

    // THE POSITIVE HALF, and it is what makes the negative half below mean anything. The real
    // CLI refuses `fake-advisor` by name, and that line reaching the child's own stdio proves
    // the process that started was conclave out of the ORIGINAL directory -- not merely that
    // something other than the stub ran.
    await waitFor(() => existsSync(marker) || /unknown agent 'fake-advisor'/.test(readFileSync(log, 'utf8')), {
      within: 20_000,
      describe: "the detached child to identify itself, as conclave or as the stub",
    })

    // THE NEGATIVE HALF. The stub is two lines and boots in a fraction of the time the real CLI
    // takes to reach agent resolution, so once the line above has been written a stub launched
    // at the same instant would long since have left its marker. Its absence is therefore an
    // answer rather than a race.
    assert.equal(existsSync(marker), false, 'the child must not have been launched through the repointed symlink')
    assert.match(
      readFileSync(log, 'utf8'),
      /unknown agent 'fake-advisor'/,
      'the child must be the CLI out of the directory its parent is running from',
    )
  } finally {
    // Detaching means nothing here owns the child. It should already be gone -- `fake-advisor`
    // is in no registry -- but that is not a reason to leave a detached process to chance.
    if (detached !== undefined) {
      try {
        process.kill(detached, 'SIGKILL')
      } catch {
        // Already gone, which is the other legitimate ending.
      }
    }
  }
})
