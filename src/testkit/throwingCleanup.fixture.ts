/**
 * A test that fails on purpose, so another test can watch what happens to its scratch
 * directory. It is NOT named `*.test.ts`, so `npm test` never collects it; it is run as an
 * explicit argument by `tempDir.test.ts`, which reads the path off stdout and then checks
 * the directory is gone.
 *
 * The point being proved is node's, not ours: `t.after` runs when the body throws. That is
 * the whole reason cleanup is registered there rather than at the end of the test body, and
 * a belief about another program's behaviour is worth a test rather than a comment.
 */

import { test } from 'node:test'
import { tempDir } from './tempDir.ts'

test('throws after taking a scratch directory', (t) => {
  const dir = tempDir(t, 'throwing-fixture')
  process.stdout.write(`FIXTURE_TEMP_DIR=${dir}\n`)
  throw new Error('deliberate failure')
})
