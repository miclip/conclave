/**
 * A missing agent binary is a report, not a stack trace (#270).
 *
 * `spawn` does not throw when the file is not there -- it emits an asynchronous 'error' event,
 * and unhandled that ends the process. `kimi.ts` already carried the lesson at its own spawn
 * ("spawn opencode ENOENT killed a run outright, with no verdict, no summary and no routing
 * log"); this site did not, so a Codex CLI off PATH ended conclave with eight lines of node
 * internals -- during hook DIAGNOSIS, which runs on the operator's behalf before any work starts.
 */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'

import { readCodexHooks } from './codexHookTrust.ts'
import { tempDir } from '../testkit/tempDir.ts'

/** A PATH with the ordinary tools on it and deliberately no `codex`. */
function pathWithoutCodex(t: TestContext): string {
  const bin = tempDir(t, 'conclave-no-codex')
  for (const tool of ['sh', 'env', 'node', 'git', 'uname']) {
    const found = execFileSync('sh', ['-c', `command -v ${tool} || true`], { encoding: 'utf8' }).trim()
    if (found) symlinkSync(found, join(bin, tool))
  }
  return bin
}

test('#270 a codex that is not on PATH is reported, and does not end the process', async (t) => {
  const cwd = tempDir(t, 'conclave-270-cwd')
  mkdirSync(join(cwd, '.codex'), { recursive: true })

  const realPath = process.env['PATH']
  process.env['PATH'] = pathWithoutCodex(t)
  t.after(() => {
    process.env['PATH'] = realPath
  })

  // The assertion is that this RESOLVES. Before the fix the 'error' event was unhandled, which
  // is not something a caller can catch -- it ends the process, so a test cannot observe it as a
  // rejection either. What is observable is that the call now completes and says why.
  const report = await readCodexHooks(cwd, 5_000)

  assert.deepEqual(report.hooks, [], 'a codex that never started reports no hooks')
  assert.equal(report.errors.length, 1, 'and says exactly once why it could not')
  assert.match(report.errors[0]!.message, /not on PATH/, 'naming the actual condition')
  assert.match(report.errors[0]!.message, /ENOENT/, 'and the syscall evidence behind it')
  assert.equal(report.cwd, cwd, 'the report is still about the directory that was asked for')
})

test('#270 the diagnosis reads it as a real answer rather than an empty one', async (t) => {
  // The point of returning a report instead of throwing: every caller already handles a report
  // it could not read, and "codex is not on PATH" is a diagnosis an operator can act on. A throw
  // here would put the burden of catching it on each caller instead.
  const cwd = tempDir(t, 'conclave-270-diag')
  mkdirSync(join(cwd, '.codex'), { recursive: true })
  const realPath = process.env['PATH']
  process.env['PATH'] = pathWithoutCodex(t)
  t.after(() => {
    process.env['PATH'] = realPath
  })

  const report = await readCodexHooks(cwd, 5_000)
  assert.ok(report.errors.some((e) => e.path === 'codex'), 'the error is attributed to the binary')
})
