/**
 * #313: a node child of the CLI must run under the flags the CLI was run under, or the
 * warning the launcher silences comes back on the child's stderr -- which is a log file
 * nobody reads until something else has gone wrong.
 *
 * Two layers. The ordering is a unit test, because a flag placed AFTER the entry file is an
 * argument to the script rather than to node. The forwarding is live: a real node started with
 * the flag spawns, through `nodeArgv`, a child that EMITS an `ExperimentalWarning` itself, and
 * the child's stderr is read. Emitting it rather than relying on type stripping to do so keeps
 * the control -- the same spawn without the flag -- true on a node that has stopped warning
 * about `.ts` files.
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { nodeArgv } from './nodeArgv.ts'

const REPO = join(import.meta.dirname, '..')
const FLAG = '--disable-warning=ExperimentalWarning'

test('node flags come first, then the entry, then the arguments', () => {
  assert.deepEqual(nodeArgv('/x/cli.ts', ['a', '--b'], [FLAG, '--no-deprecation']), [
    FLAG,
    '--no-deprecation',
    '/x/cli.ts',
    'a',
    '--b',
  ])
  assert.deepEqual(nodeArgv('/x/cli.ts', [], []), ['/x/cli.ts'])
})

test('the default is this process’s own execArgv', () => {
  // Under `node --test` execArgv is not empty, so this checks the real value is forwarded
  // rather than an empty one that happens to satisfy a weaker assertion.
  assert.deepEqual(nodeArgv('/x/cli.ts', ['a']), [...process.execArgv, '/x/cli.ts', 'a'])
})

/**
 * From a node started with `flags`, spawn the fixture child through `nodeArgv` exactly as the
 * spawn sites do, and return the CHILD's stderr.
 *
 * Files, not `-e`: `-e` puts itself in `execArgv`, so a harness written that way hands its own
 * script to the child, which hands it to ITS child, without end. Measured, not reasoned.
 */
function childStderr(flags: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-nodeargv-'))
  try {
    const child = join(dir, 'child.mjs')
    writeFileSync(child, `process.emitWarning('fixture', 'ExperimentalWarning')\nprocess.stdout.write('ran\\n')\n`)
    const harness = join(dir, 'harness.mjs')
    writeFileSync(
      harness,
      `import { spawnSync } from 'node:child_process'\n` +
        `import { nodeArgv } from ${JSON.stringify(join(REPO, 'src', 'nodeArgv.ts'))}\n` +
        `const r = spawnSync(process.execPath, nodeArgv(${JSON.stringify(child)}, ['arg']), { encoding: 'utf8' })\n` +
        `process.stdout.write(JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }))\n`,
    )
    const outer = spawnSync(process.execPath, [...flags, harness], { encoding: 'utf8', cwd: REPO })
    assert.equal(outer.status, 0, `outer node failed: ${outer.stderr}`)
    const r = JSON.parse(outer.stdout) as { status: number; stdout: string; stderr: string }
    assert.equal(r.status, 0, `child failed: ${r.stderr}`)
    assert.equal(r.stdout, 'ran\n', 'the child did run')
    return r.stderr
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a child spawned through nodeArgv inherits the launcher’s warning flag', () => {
  // The control first: without the flag the child's own warning reaches stderr, so the quiet
  // case below is the flag reaching the child and not the warning having gone missing.
  assert.match(childStderr([]), /ExperimentalWarning: fixture/)
  assert.equal(childStderr([FLAG]), '')
})
