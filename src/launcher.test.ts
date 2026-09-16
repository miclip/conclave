/**
 * #313: the two real entry points are silent on stderr.
 *
 * Node runs the CLI's TypeScript source directly, and v24 says so -- `ExperimentalWarning:
 * Type Stripping` -- on every invocation, ahead of whatever the command was going to say. The
 * flag that switches that off lives in two places because there are two ways in: the sh
 * launcher the install puts on PATH, and the shebang of `bin/conclave.ts` for a checkout (and
 * for the npm `bin` symlink). A bare `node bin/conclave.ts` skips both by design and is not
 * held to this.
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'

const REPO = join(import.meta.dirname, '..')

function run(file: string, ...argv: string[]): { stdout: string; stderr: string } {
  const r = spawnSync(file, argv, { encoding: 'utf8', cwd: REPO })
  assert.equal(r.status, 0, `${file} failed: ${r.stderr}`)
  assert.match(r.stdout, /^\d+\.\d+\.\d+/, `${file} did not print a version`)
  return r
}

test('the sh launcher prints nothing on stderr', () => {
  assert.equal(run(join(REPO, 'bin', 'conclave'), '--version').stderr, '')
})

test('the TypeScript entry, via its shebang, prints nothing on stderr', () => {
  assert.equal(run(join(REPO, 'bin', 'conclave.ts'), '--version').stderr, '')
})
