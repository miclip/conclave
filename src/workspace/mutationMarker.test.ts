/**
 * A durable record that a file is deliberately broken right now.
 *
 *   node --test src/workspace/mutationMarker.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'
import { mutationWarning, preflightRefusals, preflightWarnings } from '../relay/guardrails.ts'
import { begin, end, mutationsDir, outstanding, restore } from './mutationMarker.ts'
import type { MutationMarker } from './mutationMarker.ts'

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** A repository with one file in it, which is all any of these need. */
function repo(t: TestContext, content = 'original\n'): string {
  const dir = tempDir(t, 'conclave-mut')
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })
  writeFileSync(join(dir, 'f.ts'), content)
  return dir
}

/** `begin` on a path with no marker, which is every test here but #390's: it must record. */
function began(dir: string, path: string): MutationMarker {
  const b = begin(dir, path)
  assert.ok(b.begun, 'a path with no marker is recorded')
  return b.marker
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
  const rr = restore(dir, 'f.ts')
  assert.equal(rr.checked && rr.restored, true)
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
  const marker = began(dir, 'f.ts')
  writeFileSync(join(dir, 'f.ts'), 'destroyed\n')

  const r = restore(dir, 'f.ts')
  assert.equal(r.checked, true, 'it checked the file it had just written')
  assert.equal(r.checked && r.restored, true)
  assert.equal(r.checked && r.expected, marker.sha256, 'against the hash `begin` took')
  assert.equal(readFileSync(join(dir, 'f.ts'), 'utf8'), 'exact\ncontents\twith  spacing\n')
  assert.deepEqual(outstanding(dir), [], 'restoring closes the marker')
  assert.equal(existsSync(join(dir, marker.backup)), false, 'and takes the stored copy with it')
})

test('restoring something with no marker says so rather than pretending it worked', (t) => {
  const dir = repo(t)
  const r = restore(dir, 'f.ts')
  assert.equal(r.checked, false)
  assert.equal(r.checked === false && r.reason, 'no-marker')
})

test('#363 a restore from a damaged stored original is refused, and keeps both halves', (t) => {
  // The stored copy is an ordinary file: a full volume, a crash mid-`begin`, or someone
  // tidying `.conclave` can leave it short. Restoring from it produces a file that is neither
  // the mutation nor the original, and clearing the marker THERE deletes the only record of
  // what it should have been. So the marker and the backup are kept, exactly as `end` keeps
  // them when the caller's own restore was wrong.
  const dir = repo(t)
  const marker = began(dir, 'f.ts')
  writeFileSync(join(dir, 'f.ts'), 'mutated\n')
  writeFileSync(join(dir, marker.backup), 'a truncated backu')

  const r = restore(dir, 'f.ts')
  assert.equal(r.checked, true, 'it looked, which is the whole change')
  assert.equal(r.checked && r.restored, false, 'and the answer is no')
  assert.equal(r.checked && r.expected, marker.sha256)
  assert.notEqual(r.checked && r.actual, marker.sha256, 'it reports what is actually on disk now')
  assert.equal(outstanding(dir).length, 1, 'the marker is KEPT -- it is the record of what was wanted')
  assert.equal(existsSync(join(dir, marker.backup)), true, 'and so is the backup, which is now the evidence')
})

test('#363 a marker whose stored original has vanished is a different answer from no marker', (t) => {
  // One message for both was a lie in this case: there IS a marker, so the file is known to be
  // deliberately broken, and the thing that would fix it is what is missing.
  const dir = repo(t)
  const marker = began(dir, 'f.ts')
  writeFileSync(join(dir, 'f.ts'), 'mutated\n')
  rmSync(join(dir, marker.backup), { force: true })

  const r = restore(dir, 'f.ts')
  assert.equal(r.checked, false)
  assert.equal(r.checked === false && r.reason, 'no-backup')
  assert.equal(outstanding(dir).length, 1, 'and the marker stays, because the file is still broken')
})

test('#363 `mutations restore` verifies what it wrote and says it in `end`\'s words', (t) => {
  // The issue: `restore` then `end` -- the natural reading of "restore, then verify" -- exited
  // 1 with "the file may or may not be back to its original" over a tree that was fine, because
  // `restore` had cleared the marker `end` needed. Now `restore` answers that question itself,
  // in the sentence `end` uses for the same fact.
  const { dir, run, sha } = cliRepo(t)
  const original = sha()
  assert.equal(run('begin', 'f.ts').status, 0)
  writeFileSync(join(dir, 'f.ts'), 'MUTATED\n')

  const r = run('restore', 'f.ts')
  assert.equal(r.status, 0)
  assert.match(r.stdout, /conclave: restored f\.ts from its stored original/)
  assert.match(r.stdout, /conclave: f\.ts is back to its original; marker cleared/, "`end`'s sentence, verbatim")
  assert.equal(sha(), original, 'and it is true')
  assert.deepEqual(outstanding(dir), [], 'marker and backup cleared on the match')
})

test('#363 `mutations restore` from a damaged backup is loud, non-zero, and keeps the marker', (t) => {
  // Symmetrical with `end`'s mismatch, down to the sentence and both hashes -- but it does not
  // tell you to run `restore`, which is what just failed.
  const { dir, run, sha } = cliRepo(t)
  const original = sha()
  assert.equal(run('begin', 'f.ts').status, 0)
  writeFileSync(join(dir, 'f.ts'), 'MUTATED\n')
  const backup = join(dir, outstanding(dir)[0]!.marker.backup)
  writeFileSync(backup, 'a truncated backu')

  const r = run('restore', 'f.ts')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /f\.ts is NOT back to its original — marker kept/, "`end`'s mismatch sentence")
  assert.ok(r.stderr.includes(`expected sha256 ${original.slice(0, 12)}`), 'says what it should have been')
  assert.ok(r.stderr.includes(`found ${sha().slice(0, 12)}`), 'and what it found')
  assert.doesNotMatch(r.stderr, /conclave mutations restore f\.ts/, 'no advice to re-run what just failed')
  assert.equal(outstanding(dir).length, 1, 'the marker is KEPT')
  assert.equal(existsSync(backup), true, 'and the backup, which is the evidence')
  assert.equal(run().status, 1, 'and the bare listing still refuses')
})

test('#363 `mutations restore` with no marker still says so and exits 1', (t) => {
  const { run } = cliRepo(t)
  const r = run('restore', 'f.ts')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /conclave: no marker for f\.ts/)
})

test('#363 `mutations restore` with a marker but no stored original says which is missing', (t) => {
  // Not the same situation as no marker, and it used to print the same sentence. Here the file
  // IS known to be deliberately broken; what is gone is the thing that would fix it, and an
  // operator told "no marker" would go looking for the wrong problem.
  const { dir, run } = cliRepo(t)
  assert.equal(run('begin', 'f.ts').status, 0)
  writeFileSync(join(dir, 'f.ts'), 'MUTATED\n')
  rmSync(join(dir, outstanding(dir)[0]!.marker.backup), { force: true })

  const r = run('restore', 'f.ts')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /marker for f\.ts has no stored original — nothing to restore from/)
  assert.doesNotMatch(r.stderr, /no marker for f\.ts/, 'it does not send them looking for the wrong thing')
  assert.equal(outstanding(dir).length, 1, 'the marker stays, because the file is still broken')
})

test('#363 `conclave --help` describes all three mutation verbs, not two', (t) => {
  // The issue as filed: the help described `begin` and `end` and said nothing about `restore`,
  // so an operator could not tell which verb was the recovery path and which was the check.
  const { dir } = cliRepo(t)
  const cli = join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts')
  const usage = spawnSync(process.execPath, [cli, '--help'], { cwd: dir, encoding: 'utf8', timeout: 60_000 })
  assert.equal(usage.status, 0)
  const block = usage.stdout.slice(usage.stdout.indexOf('  mutations '))
  const mutations = block.slice(0, block.indexOf('\n  relay '))
  assert.ok(mutations.length > 0 && mutations.length < 2000, 'found the mutations entry and nothing else')
  for (const verb of ['begin', 'end', 'restore']) {
    assert.match(mutations, new RegExp(`"${verb}"`), `the help describes "${verb}"`)
  }
  assert.match(mutations, /"restore"[\s\S]*recovery path/, 'and says which one is the recovery path')
})

test('#390 a clean first begin records the original and keeps a byte-for-byte copy', (t) => {
  const dir = repo(t, 'the true original\n')
  const b = begin(dir, 'f.ts')
  assert.ok(b.begun)
  assert.equal(b.marker.sha256, sha256(join(dir, 'f.ts')))
  assert.equal(readFileSync(join(dir, b.marker.backup), 'utf8'), 'the true original\n')
})

test('#390 a second begin on a marked path refuses and leaves the stored original alone', (t) => {
  // The issue's shape: begin, mutate, begin again for the "next" mutant. The second begin used
  // to copy the mutant over the `.orig`, after which `restore` put the mutant back and called
  // it success. The `.orig` is the only writer's output (`restore` only reads it), so guarding
  // `begin` is guarding the backup.
  const dir = repo(t, 'the true original\n')
  const first = began(dir, 'f.ts')
  const backup = join(dir, first.backup)
  const origBytes = readFileSync(backup)
  writeFileSync(join(dir, 'f.ts'), 'MUTANT ONE\n')

  const second = begin(dir, 'f.ts', { note: 'the next mutant' })
  assert.equal(second.begun, false, 'refused')
  assert.deepEqual(!second.begun && second.existing, first, 'and it hands back the marker already there')
  assert.ok(readFileSync(backup).equals(origBytes), 'the stored original is byte-for-byte unchanged')
  assert.equal(sha256(backup), first.sha256)
  assert.equal(outstanding(dir)[0]!.marker.note, undefined, 'the marker was not rewritten either')

  const r = restore(dir, 'f.ts')
  assert.equal(r.checked && r.restored, true)
  assert.equal(readFileSync(join(dir, 'f.ts'), 'utf8'), 'the true original\n', 'restore returns the TRUE original')
})

test('#390 a refused begin creates no backup at all: the claim is taken before the copy', (t) => {
  // The ORDERING, which the refusal test above cannot see because it always has a `.orig`
  // already. `begin` claims the marker with `wx` and copies only after winning it, so a caller
  // that loses cannot write a backup it does not own. CodeQL flagged the original as
  // check-then-act (js/file-system-race) and it was right: with the copy ABOVE the check, two
  // racing calls would both reach it and the loser would clobber the `.orig` before the marker
  // write told it to stop -- #390 again, one layer down.
  //
  // What this proves and what it does not: it pins the order, so moving the copy back above the
  // claim fails here. It does NOT reproduce a real race -- two processes interleaving is not
  // something this test schedules, and a test that claimed to would be lying about what it ran.
  const dir = repo(t, 'the true original\n')
  const marked = began(dir, 'f.ts')
  const backup = join(dir, marked.backup)
  rmSync(backup)
  assert.equal(existsSync(backup), false, 'the fixture starts with a marker and no stored copy')

  writeFileSync(join(dir, 'f.ts'), 'MUTANT ONE\n')
  const second = begin(dir, 'f.ts')

  assert.equal(second.begun, false, 'refused, because the marker is still there')
  assert.equal(existsSync(backup), false, 'and it wrote no backup on its way to refusing')
})

test('#390 a begin on a different path is still allowed while one is outstanding', (t) => {
  const dir = repo(t)
  began(dir, 'f.ts')
  writeFileSync(join(dir, 'f.ts'), 'MUTANT\n')
  writeFileSync(join(dir, 'g.ts'), 'other\n')
  assert.equal(begin(dir, 'g.ts').begun, true)
  assert.deepEqual(outstanding(dir).map((m) => m.marker.path), ['f.ts', 'g.ts'])
})

test('#390 `mutations begin` over an outstanding marker exits 1 and names what is on record', (t) => {
  const { dir, run, sha } = cliRepo(t)
  const original = sha()
  assert.equal(run('begin', 'f.ts').status, 0)
  writeFileSync(join(dir, 'f.ts'), 'MUTANT ONE\n')
  const { marker } = outstanding(dir)[0]!

  const r = run('begin', 'f.ts')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /f\.ts already has an outstanding marker/)
  assert.ok(r.stderr.includes(`original sha256 ${original}`), 'the recorded hash, in full')
  assert.ok(r.stderr.includes(`.conclave/mutations/`) && r.stderr.includes('.json'), 'the marker file')
  assert.ok(r.stderr.includes(new Date(marker.startedAt).toISOString()), 'when it was begun')
  assert.match(r.stderr, /conclave mutations end f\.ts/, 'the remedy if already restored')
  assert.match(r.stderr, /conclave mutations restore f\.ts/, 'and the one if not')
  assert.equal(sha256(join(dir, marker.backup)), original, 'the stored original still hashes to the original')
  assert.equal(run('restore', 'f.ts').status, 0)
  assert.equal(sha(), original, 'and restore really does bring it back')
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
