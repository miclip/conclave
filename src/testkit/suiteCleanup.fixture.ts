/**
 * A file whose scratch directory is made at import time, so another test can watch what
 * happens to it when the file's tests are over. Not named `*.test.ts`, so `npm test` never
 * collects it; `tempDir.test.ts` runs it as an explicit argument, reads the path off stdout,
 * and checks the directory is gone once the child has exited.
 *
 * Unlike the throwing fixture this one passes: the case being proved is that the top-level
 * `after` hook fires at all, not that it survives a failure.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { suiteTempDir } from './tempDir.ts'

const SCRATCH = suiteTempDir('suite-fixture')
process.stdout.write(`FIXTURE_SUITE_DIR=${SCRATCH}\n`)

test('the suite directory is there while the file is running', () => {
  assert.ok(existsSync(SCRATCH))

  // And it is moved out from under the hook on the way past: TMPDIR is left pointing
  // somewhere else, so the cleanup that runs after this file can only succeed if it kept the
  // root it was given at creation. Nothing restores it -- the process is about to end.
  const elsewhere = join(SCRATCH, 'moved-tmpdir')
  mkdirSync(elsewhere)
  process.env.TMPDIR = elsewhere
})
