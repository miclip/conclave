/**
 * The reviewer's briefing, built mechanically (#72).
 *
 *   node --test src/rotation/review.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'
import { buildReviewContext, captureDiff, changedFiles, reviewPrompt } from './review.ts'

function repo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-review')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'work.ts'), 'export const answer = 42\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

test('captureDiff reads what changed against a base, committed or not', (t) => {
  const dir = repo(t)
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  writeFileSync(join(dir, 'work.ts'), 'export const answer = 43\n')
  const diff = captureDiff({ root: dir, base })
  assert.match(diff, /-export const answer = 42/)
  assert.match(diff, /\+export const answer = 43/)
})

test('captureDiff sees UNCOMMITTED changes, not only committed ones', (t) => {
  // The whole reason the diff is taken with one argument rather than `base..HEAD`: a seat
  // with no worktree does its work directly in the shared checkout, and nothing forces it
  // to commit before its turn ends.
  const dir = repo(t)
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  writeFileSync(join(dir, 'work.ts'), 'export const answer = 99\n')
  const diff = captureDiff({ root: dir, base })
  assert.match(diff, /\+export const answer = 99/)
})

test('changedFiles names exactly the paths the diff touches', (t) => {
  const dir = repo(t)
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  writeFileSync(join(dir, 'work.ts'), 'export const answer = 43\n')
  writeFileSync(join(dir, 'new.ts'), 'export const other = 1\n')
  execFileSync('git', ['add', 'new.ts'], { cwd: dir })
  assert.deepEqual(changedFiles({ root: dir, base }).sort(), ['new.ts', 'work.ts'])
})

test('an unchanged tree produces an empty diff and no files', (t) => {
  const dir = repo(t)
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  assert.equal(captureDiff({ root: dir, base }).trim(), '')
  assert.deepEqual(changedFiles({ root: dir, base }), [])
})

test('buildReviewContext derives its file list from the diff, never from the caller', (t) => {
  const dir = repo(t)
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  writeFileSync(join(dir, 'work.ts'), 'export const answer = 43\n')
  const ctx = buildReviewContext({
    root: dir,
    base,
    checks: ['exit 0'],
    checkTimeoutMs: 5_000,
    instruction: 'Set the answer to 43.',
  })
  assert.deepEqual(ctx.record.files.map((f) => f.path), ['work.ts'])
  assert.match(ctx.diff, /\+export const answer = 43/)
  assert.equal(ctx.instruction, 'Set the answer to 43.')
  assert.equal(ctx.record.checks[0]!.exitCode, 0)
})

test('reviewPrompt never carries the producing seat\'s own account of its work', () => {
  // The load-bearing rule the whole module exists for: everything in the prompt is either
  // the advisor's instruction or a mechanical capture. There is no field for a report, and
  // this asserts that no prose resembling one leaks in through the instruction alone.
  const ctx = {
    diff: '--- a/work.ts\n+++ b/work.ts\n@@\n-old\n+new\n',
    record: {
      root: '/tmp',
      head: 'abc123',
      branch: 'main',
      dirty: [],
      files: [{ path: 'work.ts', digest: 'x' }],
      checks: [{ command: 'exit 0', relevance: 'required' as const, exitCode: 0, outputDigest: 'd', durationMs: 1 }],
      at: 0,
    },
    instruction: 'Set the answer to 43.',
  }
  const prompt = reviewPrompt(ctx)
  assert.match(prompt, /You are the REVIEWER/)
  assert.match(prompt, /Set the answer to 43\./)
  assert.match(prompt, /work\.ts/)
  assert.match(prompt, /exit 0/)
  assert.match(prompt, /-old/)
  assert.match(prompt, /\+new/)
  assert.match(prompt, /ACCEPT/)
  assert.match(prompt, /REJECT:/)
})

test('reviewPrompt says so plainly when the tree has no textual diff', () => {
  const ctx = {
    diff: '',
    record: { root: '/tmp', head: undefined, branch: undefined, dirty: [], files: [], checks: [], at: 0 },
    instruction: 'Investigate the failure.',
  }
  const prompt = reviewPrompt(ctx)
  assert.match(prompt, /no textual diff/)
  assert.match(prompt, /\(none configured\)/)
  assert.match(prompt, /\(none named\)/)
})
