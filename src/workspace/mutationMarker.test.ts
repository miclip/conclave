/**
 * A durable record that a file is deliberately broken right now.
 *
 *   node --test src/workspace/mutationMarker.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'
import { mutationWarning, preflightRefusals, preflightWarnings } from '../relay/guardrails.ts'
import { begin, end, mutationsDir, outstanding, restore } from './mutationMarker.ts'

/** A repository with one file in it, which is all any of these need. */
function repo(t: TestContext, content = 'original\n'): string {
  const dir = tempDir(t, 'conclave-mut')
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })
  writeFileSync(join(dir, 'f.ts'), content)
  return dir
}

test('a file broken and not put back is reported as exactly that', (t) => {
  // #180 died holding a mutation, and the tree it left had a fix REVERTED in it -- a diff
  // indistinguishable from work in progress. This is the report that tells them apart.
  const dir = repo(t)
  begin(dir, 'f.ts', { note: 'the #180 shape' })
  writeFileSync(join(dir, 'f.ts'), 'reverted fix\n')

  const all = outstanding(dir)
  assert.equal(all.length, 1)
  assert.equal(all[0]!.dirty, true, 'the tree is holding a defect right now')
  assert.equal(all[0]!.marker.path, 'f.ts')
  // The note is what a stranger reads first, and the reason a report beats a bare diff.
  assert.equal(all[0]!.marker.note, 'the #180 shape')
})

test('a marker that outlived its restore is stale, not a defect', (t) => {
  // The distinction the whole report turns on. Treating these the same would cry wolf on every
  // tidy tree, and a guard that cries wolf is deleted by the first person it inconveniences.
  const dir = repo(t)
  begin(dir, 'f.ts')
  writeFileSync(join(dir, 'f.ts'), 'mutated\n')
  writeFileSync(join(dir, 'f.ts'), 'original\n')

  const all = outstanding(dir)
  assert.equal(all.length, 1, 'the marker is still there')
  assert.equal(all[0]!.dirty, false, 'but the file is not')
})

test('end refuses to clear a marker while the file is still broken, and says both hashes', (t) => {
  // A restore the caller believed in and got wrong is exactly the state this exists to catch.
  // Clearing the marker there would delete the evidence of the thing being reported.
  const dir = repo(t)
  begin(dir, 'f.ts')
  writeFileSync(join(dir, 'f.ts'), 'still mutated\n')

  const r = end(dir, 'f.ts')
  assert.equal(r.restored, false)
  assert.notEqual(r.expected, r.actual, 'the caller is told what it should have been')
  assert.equal(outstanding(dir).length, 1, 'and the marker is KEPT')
})

test('end clears the marker and the stored copy once the file really is back', (t) => {
  const dir = repo(t)
  begin(dir, 'f.ts')
  writeFileSync(join(dir, 'f.ts'), 'mutated\n')
  writeFileSync(join(dir, 'f.ts'), 'original\n')

  assert.equal(end(dir, 'f.ts').restored, true)
  assert.deepEqual(outstanding(dir), [], 'nothing outstanding')
  // The copy goes too. A backup left behind for every mutation ever made would turn the
  // bookkeeping directory into the disk problem that #180 was about.
  assert.equal(readFileSync(join(dir, 'f.ts'), 'utf8'), 'original\n')
})

test('restore puts the original back byte for byte, from the copy rather than a guess', (t) => {
  // A hash proves a restore was correct; it cannot perform one. The copy is what makes the
  // report actionable instead of a puzzle.
  const dir = repo(t, 'exact\ncontents\twith  spacing\n')
  begin(dir, 'f.ts')
  writeFileSync(join(dir, 'f.ts'), 'destroyed\n')

  assert.equal(restore(dir, 'f.ts'), true)
  assert.equal(readFileSync(join(dir, 'f.ts'), 'utf8'), 'exact\ncontents\twith  spacing\n')
  assert.deepEqual(outstanding(dir), [], 'restoring closes the marker')
})

test('restoring something with no marker says so rather than pretending it worked', (t) => {
  const dir = repo(t)
  assert.equal(restore(dir, 'f.ts'), false)
})

test('a corrupt marker is skipped, because a guard must not become the outage', (t) => {
  // `outstanding` is called from a preflight. A bad file in the bookkeeping directory that
  // could stop a run from starting would be a bigger hazard than the one it guards against.
  const dir = repo(t)
  begin(dir, 'f.ts')
  writeFileSync(join(dir, 'f.ts'), 'mutated\n')
  writeFileSync(join(mutationsDir(dir), 'garbage.json'), '{not json')

  const all = outstanding(dir)
  assert.equal(all.length, 1, 'the good marker still reports')
  assert.equal(all[0]!.dirty, true)
})

test('a tree holding a mutation is warned about before a run starts, and not refused', (t) => {
  // Reported, never obeyed -- the lesson `sessionLock.read` states about a stale lock. A
  // marker that blocked work would be deleted by the first person it inconvenienced.
  const dir = repo(t)
  begin(dir, 'f.ts', { note: 'why it was broken' })
  writeFileSync(join(dir, 'f.ts'), 'mutated\n')

  const w = mutationWarning(dir)
  assert.ok(w, 'the run is told')
  assert.match(w.reason, /f\.ts/, 'and told which file')
  assert.match(w.remedy, /conclave mutations restore/, 'with the command that fixes it')
  // The refusal list is where a fatal condition goes. This is not one.
  const roomy = 8 * 1024 * 1024 * 1024
  assert.deepEqual(preflightRefusals(dir, { readFree: () => roomy }), [])
  // And it reaches the preflight, rather than merely being defined next to it. Without this
  // every assertion above passes with the check never called from anywhere -- a guard that
  // looks configured and does nothing.
  const warnings = preflightWarnings(dir, { readFree: () => roomy })
  assert.equal(warnings.length, 1, 'the run is warned through the preflight')
  assert.match(warnings[0]!.reason, /f\.ts/)
})

test('a clean tree, and a merely stale marker, say nothing before a run', (t) => {
  const clean = repo(t)
  assert.equal(mutationWarning(clean), undefined, 'no markers at all')

  const stale = repo(t)
  begin(stale, 'f.ts')
  assert.equal(mutationWarning(stale), undefined, 'a marker whose file matches is not a defect')
})

test('a bookkeeping directory that cannot be read is silent rather than fatal', (t) => {
  const dir = repo(t)
  begin(dir, 'f.ts')
  writeFileSync(join(dir, 'f.ts'), 'mutated\n')
  rmSync(mutationsDir(dir), { recursive: true, force: true })
  assert.deepEqual(outstanding(dir), [], 'a missing directory is no markers, not a throw')
  assert.equal(mutationWarning(dir), undefined)
})
