/**
 * A durable record that a file is deliberately broken right now.
 *
 *   node --test src/workspace/mutationMarker.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  assert.ok(r.checked, 'there was a marker, so a comparison happened')
  assert.equal(r.restored, false)
  assert.notEqual(r.expected, r.actual, 'the caller is told what it should have been')
  assert.equal(outstanding(dir).length, 1, 'and the marker is KEPT')
})

test('end clears the marker and the stored copy once the file really is back', (t) => {
  const dir = repo(t)
  begin(dir, 'f.ts')
  writeFileSync(join(dir, 'f.ts'), 'mutated\n')
  writeFileSync(join(dir, 'f.ts'), 'original\n')

  const r = end(dir, 'f.ts')
  assert.ok(r.checked)
  assert.equal(r.restored, true)
  assert.deepEqual(outstanding(dir), [], 'nothing outstanding')
  // The copy goes too. A backup left behind for every mutation ever made would turn the
  // bookkeeping directory into the disk problem that #180 was about.
  assert.equal(readFileSync(join(dir, 'f.ts'), 'utf8'), 'original\n')
})

test('#343 end with no marker says nothing was checked, not that the file is back', (t) => {
  // The reported shape: begin, mutate, restore, mutate AGAIN without a new begin, then end.
  // `restore` took the marker with it, so `end` has nothing to compare against -- and it used
  // to report that as a verified restore. The file below is still mutated at the point `end`
  // says its piece, which is the whole point.
  const dir = repo(t)
  begin(dir, 'f.ts')
  writeFileSync(join(dir, 'f.ts'), 'MUTATED\n')
  assert.equal(restore(dir, 'f.ts'), true)
  writeFileSync(join(dir, 'f.ts'), 'MUTATED SECOND TIME\n')

  const r = end(dir, 'f.ts')
  assert.equal(r.checked, false, 'no marker means no comparison, and the result says so')
  assert.ok(!('restored' in r), 'and it does not carry a verdict it did not reach')
  assert.equal(readFileSync(join(dir, 'f.ts'), 'utf8'), 'MUTATED SECOND TIME\n', 'the file really is still mutated')
})

/** A repository plus the binary pointed at it, for the tests that exercise the CLI's wording and exit codes. */
function cliRepo(t: TestContext) {
  const dir = repo(t)
  const cli = join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts')
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, 'mutations', ...args], { cwd: dir, encoding: 'utf8', timeout: 60_000 })
  const sha = () => createHash('sha256').update(readFileSync(join(dir, 'f.ts'))).digest('hex')
  return { dir, run, sha }
}

test('#343 the CLI reproduction: `mutations end` on an unmarked file is loud and non-zero', (t) => {
  // The issue's transcript, run through the binary. The old output was "is back to its
  // original; marker cleared" with exit 0 over a file holding the second mutation.
  const { dir, run, sha } = cliRepo(t)
  const original = sha()

  assert.equal(run('begin', 'f.ts').status, 0)
  writeFileSync(join(dir, 'f.ts'), 'MUTATED\n')
  assert.equal(run('restore', 'f.ts').status, 0)
  assert.equal(sha(), original, 'restore itself is unchanged by this fix')
  writeFileSync(join(dir, 'f.ts'), 'MUTATED SECOND TIME\n')

  const r = run('end', 'f.ts')
  assert.equal(r.status, 1, 'nothing was verified, so nothing is green')
  assert.match(r.stderr, /no marker for f\.ts/, 'it names the file')
  assert.match(r.stderr, /nothing was checked/, 'and says what it did not do')
  assert.doesNotMatch(r.stdout + r.stderr, /is back to its original|marker cleared/, 'no claim of a restore it never checked')
  assert.notEqual(sha(), original, 'the file is still mutated, and the command did not touch it')
})

test('`mutations end` on a file that matches its marker exits 0 and clears the marker', (t) => {
  // The tracked half of the pair #343 is about: a marker WAS there, the hash WAS compared, and
  // it matched. This is the only case that gets to say "back to its original".
  const { dir, run } = cliRepo(t)
  assert.equal(run('begin', 'f.ts').status, 0)
  writeFileSync(join(dir, 'f.ts'), 'MUTATED\n')
  writeFileSync(join(dir, 'f.ts'), 'original\n')

  const r = run('end', 'f.ts')
  assert.equal(r.status, 0)
  assert.match(r.stdout, /f\.ts is back to its original; marker cleared/)
  assert.deepEqual(outstanding(dir), [], 'the marker is gone')
  const list = run()
  assert.equal(list.status, 0)
  assert.match(list.stdout, /no mutations are recorded/)
})

test('`mutations end` on a file that differs from its marker exits non-zero, keeps it, and says both hashes', (t) => {
  // The other tracked half. Both hashes are printed because the caller restored from its own
  // copy and believed in it; "wrong" without "expected what" is a puzzle.
  const { dir, run, sha } = cliRepo(t)
  const original = sha()
  assert.equal(run('begin', 'f.ts').status, 0)
  writeFileSync(join(dir, 'f.ts'), 'still mutated\n')
  const mutated = sha()

  const r = run('end', 'f.ts')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /f\.ts is NOT back to its original — marker kept/)
  assert.ok(r.stderr.includes(`expected sha256 ${original.slice(0, 12)}`), 'says what it should have been')
  assert.ok(r.stderr.includes(`found ${mutated.slice(0, 12)}`), 'and what it found')
  assert.match(r.stderr, /conclave mutations restore f\.ts/, 'with the command that fixes it')
  assert.equal(outstanding(dir).length, 1, 'the marker is KEPT')
  assert.equal(run().status, 1, 'and the bare listing still refuses')
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
