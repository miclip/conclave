/**
 * Finding every registration that still names an install path (#275).
 *
 * Fixture paths are deliberately NOT under `/Users` or `/home`: `install.test.ts` refuses a
 * tracked file that hardcodes a real home directory, and it scans TRACKED files only -- so a
 * new test file passes locally while untracked and fails in CI the moment it is committed.
 * That is how this one was caught.
 *
 * The manual answer to this question was wrong, and wrong in the direction that matters: a
 * `find` written by hand reported 12 and the scanner found 21, because the hand-written one
 * relied on a depth and a path filter somebody happened to type. Under-reporting is the bad
 * direction — it leaves an operator believing they have dealt with it.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'

import { formatStale, scanStale } from './staleScan.ts'
import { tempDir } from '../testkit/tempDir.ts'

/** A registration at `dir`, in the shape the named era wrote. */
function register(dir: string, kind: 'legacy' | 'modern', file = join('.claude', 'settings.json')): string {
  const p = join(dir, file)
  mkdirSync(join(p, '..'), { recursive: true })
  const command =
    kind === 'legacy'
      ? '/opt/agents/conclave-stable/spikes/hooks/hook_post.py claude'
      : 'conclave hook claude'
  writeFileSync(p, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] } }, null, 2))
  return p
}

test('#275 a stale registration is found and its install root named', (t: TestContext) => {
  const root = tempDir(t, 'conclave-275-scan')
  const p = register(join(root, 'project'), 'legacy')

  const found = scanStale(root)
  assert.equal(found.length, 1)
  assert.equal(found[0]!.path, p)
  assert.equal(
    found[0]!.installRoot,
    '/opt/agents/conclave-stable',
    'the install root is what will stop existing, so it is what the operator needs',
  )
})

test('#275 a modern registration is not reported, because it names no directory', (t: TestContext) => {
  const root = tempDir(t, 'conclave-275-modern')
  register(join(root, 'project'), 'modern')
  assert.deepEqual(scanStale(root), [], '`conclave hook claude` is the repaired form and needs nothing')
})

test('#275 both registration files are checked, not just the Claude one', (t: TestContext) => {
  // The survey that started this found `.codex/hooks.json` stale in six roots whose
  // `.claude/settings.json` had already been repaired. Checking one and not the other would
  // report a project as clean while half of it was not.
  const root = tempDir(t, 'conclave-275-both')
  register(join(root, 'p'), 'modern')
  register(join(root, 'p'), 'legacy', join('.codex', 'hooks.json'))

  const found = scanStale(root)
  assert.equal(found.length, 1)
  assert.match(found[0]!.path, /\.codex\/hooks\.json$/)
})

test('#275 nested projects are found, which is where the manual survey went wrong', (t: TestContext) => {
  // Two of the originals were at `<repo>/cli/` and `<repo>/backend/`, inside a root whose own
  // registration was already clean — so a check run at the root reported healthy and the
  // operator had no reason to look deeper.
  const root = tempDir(t, 'conclave-275-nested')
  register(join(root, 'repo'), 'modern')
  register(join(root, 'repo', 'backend'), 'legacy')
  register(join(root, 'repo', 'cli'), 'legacy')

  const found = scanStale(root)
  assert.equal(found.length, 2, 'the clean root must not hide the stale children')
})

test('#275 node_modules is not descended into', (t: TestContext) => {
  // A dependency's fixture is not this operator's registration, and one package can hold more
  // files than the rest of the scan put together.
  const root = tempDir(t, 'conclave-275-deps')
  register(join(root, 'node_modules', 'somepkg', 'fixture'), 'legacy')
  assert.deepEqual(scanStale(root), [])
})

test('#275 the depth limit is real, and bounded rather than unbounded', (t: TestContext) => {
  // Pointed at a home directory an unbounded walk would take long enough that nobody runs it,
  // which is the same as not having the feature.
  const root = tempDir(t, 'conclave-275-depth')
  register(join(root, 'a', 'b', 'c', 'd', 'e', 'f'), 'legacy')
  assert.deepEqual(scanStale(root, 2), [], 'beyond the limit is not reported')
  assert.equal(scanStale(root, 8).length, 1, 'and within it, is')
})

test('#275 finding nothing is said, not printed as emptiness', (t: TestContext) => {
  const root = tempDir(t, 'conclave-275-empty')
  assert.match(formatStale([], root), /no registration at or below .* names an install path/)
})

test('#275 the report says when it stops working, because the list alone does not', (t: TestContext) => {
  const root = tempDir(t, 'conclave-275-msg')
  register(join(root, 'p'), 'legacy')
  const text = formatStale(scanStale(root), root)
  assert.match(text, /resolve while/, 'these work today — that is why nobody has noticed')
  assert.match(text, /stop the moment/, 'and they stop together, which is the urgency')
  assert.match(text, /conclave config install/, 'and the repair is named')
})
