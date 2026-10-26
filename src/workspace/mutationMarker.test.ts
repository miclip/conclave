/**
 * A durable record that a file is deliberately broken right now.
 *
 *   node --test src/workspace/mutationMarker.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'
import { mutationWarning, preflightRefusals, preflightWarnings } from '../relay/guardrails.ts'
import { begin, end, mutationsDir, outstanding, restore, UnreadableMarkerError } from './mutationMarker.ts'
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

  const all = outstanding(dir).mutations
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

  const all = outstanding(dir).mutations
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
  assert.equal(outstanding(dir).mutations.length, 1, 'and the marker is KEPT')
})

test('end clears the marker and the stored copy once the file really is back', (t) => {
  const dir = repo(t)
  begin(dir, 'f.ts')
  writeFileSync(join(dir, 'f.ts'), 'mutated\n')
  writeFileSync(join(dir, 'f.ts'), 'original\n')

  const r = end(dir, 'f.ts')
  assert.ok(r.checked)
  assert.equal(r.restored, true)
  assert.deepEqual(outstanding(dir).mutations, [], 'nothing outstanding')
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
  assert.deepEqual(outstanding(dir).mutations, [], 'the marker is gone')
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
  assert.equal(outstanding(dir).mutations.length, 1, 'the marker is KEPT')
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
  assert.deepEqual(outstanding(dir).mutations, [], 'restoring closes the marker')
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
  assert.equal(outstanding(dir).mutations.length, 1, 'the marker is KEPT -- it is the record of what was wanted')
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
  assert.equal(outstanding(dir).mutations.length, 1, 'and the marker stays, because the file is still broken')
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
  assert.deepEqual(outstanding(dir).mutations, [], 'marker and backup cleared on the match')
})

test('#363 `mutations restore` from a damaged backup is loud, non-zero, and keeps the marker', (t) => {
  // Symmetrical with `end`'s mismatch, down to the sentence and both hashes -- but it does not
  // tell you to run `restore`, which is what just failed.
  const { dir, run, sha } = cliRepo(t)
  const original = sha()
  assert.equal(run('begin', 'f.ts').status, 0)
  writeFileSync(join(dir, 'f.ts'), 'MUTATED\n')
  const backup = join(dir, outstanding(dir).mutations[0]!.marker.backup)
  writeFileSync(backup, 'a truncated backu')

  const r = run('restore', 'f.ts')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /f\.ts is NOT back to its original — marker kept/, "`end`'s mismatch sentence")
  assert.ok(r.stderr.includes(`expected sha256 ${original.slice(0, 12)}`), 'says what it should have been')
  assert.ok(r.stderr.includes(`found ${sha().slice(0, 12)}`), 'and what it found')
  assert.doesNotMatch(r.stderr, /conclave mutations restore f\.ts/, 'no advice to re-run what just failed')
  assert.equal(outstanding(dir).mutations.length, 1, 'the marker is KEPT')
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
  rmSync(join(dir, outstanding(dir).mutations[0]!.marker.backup), { force: true })

  const r = run('restore', 'f.ts')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /marker for f\.ts has no stored original — nothing to restore from/)
  assert.doesNotMatch(r.stderr, /no marker for f\.ts/, 'it does not send them looking for the wrong thing')
  assert.equal(outstanding(dir).mutations.length, 1, 'the marker stays, because the file is still broken')
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
  assert.deepEqual(!second.begun && second.reason === 'outstanding' && second.existing, first, 'and it hands back the marker already there')
  assert.ok(readFileSync(backup).equals(origBytes), 'the stored original is byte-for-byte unchanged')
  assert.equal(sha256(backup), first.sha256)
  assert.equal(outstanding(dir).mutations[0]!.marker.note, undefined, 'the marker was not rewritten either')

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

test('#390 a begin over an orphaned backup refuses and leaves both files byte-for-byte', (t) => {
  // The marker deleted by hand, the `.orig` left behind. The second begin used to exit 0 and
  // copy the mutant over the stored original. Its provenance cannot be verified, so it is
  // neither overwritten nor adopted.
  const dir = repo(t, 'the true original\n')
  const first = began(dir, 'f.ts')
  const backup = join(dir, first.backup)
  const origBytes = readFileSync(backup)
  writeFileSync(join(dir, 'f.ts'), 'MUTANT ONE\n')
  const mutantBytes = readFileSync(join(dir, 'f.ts'))
  rmSync(join(dir, first.backup.replace(/\.orig$/, '.json')))
  assert.deepEqual(outstanding(dir).mutations, [], 'the fixture has no marker left')

  const second = begin(dir, 'f.ts')
  assert.equal(second.begun, false, 'refused')
  assert.equal(!second.begun && second.reason, 'orphaned-backup')
  assert.deepEqual(!second.begun && second.reason === 'orphaned-backup' && [second.path, second.backup], ['f.ts', first.backup])
  assert.ok(readFileSync(backup).equals(origBytes), 'the stored original is byte-for-byte unchanged')
  assert.equal(sha256(backup), first.sha256, 'and still hashes to the original')
  assert.ok(readFileSync(join(dir, 'f.ts')).equals(mutantBytes), 'the working file is untouched')
  assert.deepEqual(outstanding(dir).mutations, [], 'and no marker was left behind')
  assert.deepEqual(readdirSync(mutationsDir(dir)), [first.backup.split('/').pop()], 'the directory holds the orphan and nothing else')
})

test('#390 a begin on a different path is still allowed while one is outstanding', (t) => {
  const dir = repo(t)
  began(dir, 'f.ts')
  writeFileSync(join(dir, 'f.ts'), 'MUTANT\n')
  writeFileSync(join(dir, 'g.ts'), 'other\n')
  assert.equal(begin(dir, 'g.ts').begun, true)
  assert.deepEqual(outstanding(dir).mutations.map((m) => m.marker.path), ['f.ts', 'g.ts'])
})

test('#390 `mutations begin` over an outstanding marker exits 1 and names what is on record', (t) => {
  const { dir, run, sha } = cliRepo(t)
  const original = sha()
  assert.equal(run('begin', 'f.ts').status, 0)
  writeFileSync(join(dir, 'f.ts'), 'MUTANT ONE\n')
  const { marker } = outstanding(dir).mutations[0]!

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

test('#390 `mutations begin` over an orphaned backup exits 1, names both files, and changes neither', (t) => {
  const { dir, run, sha } = cliRepo(t)
  const original = sha()
  assert.equal(run('begin', 'f.ts').status, 0)
  const { marker } = outstanding(dir).mutations[0]!
  const backup = join(dir, marker.backup)
  const origBytes = readFileSync(backup)
  writeFileSync(join(dir, 'f.ts'), 'MUTANT ONE\n')
  const mutant = sha()
  rmSync(join(dir, marker.backup.replace(/\.orig$/, '.json')))

  const r = run('begin', 'f.ts')
  assert.equal(r.status, 1)
  assert.ok(r.stderr.includes(`orphaned backup ${marker.backup}`), 'it names the orphaned backup')
  assert.ok(r.stderr.includes('target f.ts'), 'and the target path')
  assert.match(r.stderr, /inspect both and reconcile/, 'and tells the operator what to do')
  assert.ok(readFileSync(backup).equals(origBytes), 'the stored original is byte-for-byte unchanged')
  assert.equal(sha256(backup), original, 'and still hashes to the original')
  assert.equal(sha(), mutant, 'the working file is untouched')
  assert.deepEqual(outstanding(dir).mutations, [], 'and no marker was written')
})

/**
 * A same-path marker that does not parse, with its `.orig` and a mutated target beside it.
 * Returns everything a verb could touch, as bytes, so a test can prove it touched none of it.
 */
function corruptMarkerRepo(t: TestContext) {
  const { dir, run } = cliRepo(t)
  assert.equal(run('begin', 'f.ts').status, 0)
  const { marker } = outstanding(dir).mutations[0]!
  const markerFile = marker.backup.replace(/\.orig$/, '.json')
  writeFileSync(join(dir, 'f.ts'), 'MUTANT ONE\n')
  writeFileSync(join(dir, markerFile), '{"path": "f.ts", not json')
  const files = [markerFile, marker.backup, 'f.ts']
  const snapshot = () => files.map((f) => readFileSync(join(dir, f)))
  return { dir, run, markerFile, backup: marker.backup, snapshot }
}

for (const verb of ['begin', 'end', 'restore']) {
  test(`\`mutations ${verb}\` over a corrupt marker exits 1, says what to inspect, and changes nothing`, (t) => {
    // Each verb used to reach its own bare JSON.parse, and the CLI printed only the parser's
    // message -- naming neither the marker nor the file. The marker is the only record of the
    // original's hash, so no verb may rewrite or remove it on the way to failing.
    const { run, markerFile, backup, snapshot } = corruptMarkerRepo(t)
    const before = snapshot()

    const r = run(verb, 'f.ts')
    assert.equal(r.status, 1)
    assert.ok(r.stderr.includes(markerFile), 'it names the marker file')
    assert.match(r.stderr, /the marker for f\.ts cannot be read/, 'and the target path')
    assert.match(r.stderr, /JSON/, 'with the parser detail')
    assert.match(r.stderr, /nothing was changed/)
    assert.ok(r.stderr.includes(`inspect ${markerFile} and its sibling ${backup}`), 'and what to inspect')
    assert.match(r.stderr, /recover or repair them by hand/, 'and the remedy')
    // A control, not a regression the old code had: the handler prints the message and must not
    // be replaced by one that lets the error escape to a stack.
    assert.doesNotMatch(r.stderr, /at .*mutationMarker\.ts/, 'no stack trace')
    const after = snapshot()
    for (const [i, b] of before.entries()) assert.ok(after[i]!.equals(b), `byte-for-byte unchanged: ${i}`)
  })
}

test('the unreadable-marker error keeps the parser failure as its cause', (t) => {
  const { dir, markerFile } = corruptMarkerRepo(t)
  assert.throws(
    () => end(dir, 'f.ts'),
    (err: unknown) =>
      err instanceof UnreadableMarkerError &&
      err.markerFile === markerFile &&
      err.path === 'f.ts' &&
      err.cause instanceof SyntaxError,
  )
})

test('a corrupt marker is reported by name, not thrown on and not dropped', (t) => {
  // `outstanding` is called from a preflight. A bad file in the bookkeeping directory that
  // could stop a run from starting would be a bigger hazard than the one it guards against --
  // but it used to be skipped silently, which made a tree whose only marker was corrupt read
  // as a clean one.
  const dir = repo(t)
  begin(dir, 'f.ts')
  writeFileSync(join(dir, 'f.ts'), 'mutated\n')
  writeFileSync(join(mutationsDir(dir), 'garbage.json'), '{not json')

  const { mutations, unreadable } = outstanding(dir)
  assert.equal(mutations.length, 1, 'the good marker still reports')
  assert.equal(mutations[0]!.dirty, true)
  assert.deepEqual(unreadable.map((u) => u.markerFile), ['.conclave/mutations/garbage.json'], 'and the bad one is named')
  assert.match(unreadable[0]!.problem, /JSON/, 'with what was wrong with it')
})

test('a marker that parses but has no string path or sha256 is unreadable too, and all are sorted', (t) => {
  const dir = repo(t)
  mkdirSync(mutationsDir(dir), { recursive: true })
  writeFileSync(join(mutationsDir(dir), 'c.json'), '{"path": "f.ts"}')
  writeFileSync(join(mutationsDir(dir), 'a.json'), 'null')
  writeFileSync(join(mutationsDir(dir), 'b.json'), '{"path": 5, "sha256": "x"}')

  const { mutations, unreadable } = outstanding(dir)
  assert.deepEqual(mutations, [])
  assert.deepEqual(unreadable, [
    { markerFile: '.conclave/mutations/a.json', problem: 'no string path or sha256' },
    { markerFile: '.conclave/mutations/b.json', problem: 'no string path' },
    { markerFile: '.conclave/mutations/c.json', problem: 'no string sha256' },
  ])
})

test('`conclave mutations` over only a corrupt marker names it, exits 0, and claims nothing is clean', (t) => {
  const { dir, run } = cliRepo(t)
  mkdirSync(mutationsDir(dir), { recursive: true })
  writeFileSync(join(mutationsDir(dir), '0123456789abcdef.json'), '{not json')

  const r = run()
  assert.equal(r.status, 0, 'unknown is a reason to look, not a known defect')
  assert.doesNotMatch(r.stdout, /no mutations are recorded/, 'no clean claim over an unreadable marker')
  assert.match(r.stdout, /^1 mutation marker could not be read; the file it guards may be mutated:$/m, 'the count')
  assert.ok(r.stdout.includes('.conclave/mutations/0123456789abcdef.json'), 'and the name')
})

test('several unreadable markers are counted in the plural, in the listing and the warning alike', (t) => {
  const { dir, run } = cliRepo(t)
  mkdirSync(mutationsDir(dir), { recursive: true })
  writeFileSync(join(mutationsDir(dir), 'a.json'), '{not json')
  writeFileSync(join(mutationsDir(dir), 'b.json'), 'null')

  const r = run()
  assert.equal(r.status, 0)
  assert.match(r.stdout, /^2 mutation markers could not be read; the file each guards may be mutated:$/m)
  assert.equal(
    mutationWarning(dir)?.reason,
    '2 mutation markers could not be read, so the file each guards may be mutated: ' +
      '.conclave/mutations/a.json, .conclave/mutations/b.json',
  )
})

test('`conclave mutations` over an ordinary dirty mutation prints what it always printed', (t) => {
  const { dir, run } = cliRepo(t)
  assert.equal(run('begin', 'f.ts', '--note', 'why').status, 0)
  writeFileSync(join(dir, 'f.ts'), 'MUTANT\n')
  const { pid } = outstanding(dir).mutations[0]!.marker

  const r = run()
  assert.equal(r.status, 1)
  assert.equal(r.stdout, `f.ts  [MUTATED — not restored]  pid ${pid}  — why\n`)
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
  // The exact text, written out rather than computed: the unreadable-marker case was added
  // beside this one, and must not have changed it.
  assert.deepEqual(w, {
    reason: '1 file(s) are deliberately mutated and were never restored: f.ts',
    remedy:
      'A mutation left by a crash looks exactly like work in progress, which is how #180 ' +
      'nearly committed a reverted fix. `conclave mutations` says what each one was for, ' +
      'and `conclave mutations restore <path>` puts the original back from the stored copy.',
  })
})

test('a corrupt marker alone is warned about by name before a run, and not refused', (t) => {
  const dir = repo(t)
  mkdirSync(mutationsDir(dir), { recursive: true })
  writeFileSync(join(mutationsDir(dir), '0123456789abcdef.json'), '{not json')

  const roomy = 8 * 1024 * 1024 * 1024
  assert.deepEqual(preflightRefusals(dir, { readFree: () => roomy }), [], 'never a refusal')
  const warnings = preflightWarnings(dir, { readFree: () => roomy })
  assert.equal(warnings.length, 1, 'but the run is told')
  assert.ok(warnings[0]!.reason.includes('.conclave/mutations/0123456789abcdef.json'), 'which marker')
  assert.match(warnings[0]!.remedy, /\.orig/, 'and what to inspect beside it')
})

test('a dirty mutation and a corrupt marker together are both in the one warning', (t) => {
  const dir = repo(t)
  begin(dir, 'f.ts')
  writeFileSync(join(dir, 'f.ts'), 'mutated\n')
  writeFileSync(join(mutationsDir(dir), 'garbage.json'), '{not json')

  const w = mutationWarning(dir)
  assert.ok(w)
  assert.match(w.reason, /1 file\(s\) are deliberately mutated and were never restored: f\.ts/)
  assert.ok(w.reason.includes('.conclave/mutations/garbage.json'))
  assert.match(w.remedy, /conclave mutations restore <path>/)
  assert.match(w.remedy, /\.orig/)
})

test('a real `relay --dry-run` over a corrupt marker prints the warning and still exits 0', (t) => {
  // Through the binary, because "warned, not refused" is a claim about what the CLI DOES with
  // the warning, and `preflightWarnings` returning one cannot show it. No agent is launched by a
  // dry run. The environment is built, not inherited: an empty HOME so no user configuration
  // reaches it, and nothing else, so an ambient CONCLAVE_* variable cannot either.
  const dir = repo(t)
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  mkdirSync(mutationsDir(dir), { recursive: true })
  writeFileSync(join(mutationsDir(dir), '0123456789abcdef.json'), '{not json')

  const cli = join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts')
  const r = spawnSync(process.execPath, [cli, 'relay', '--dry-run', 'make the tests pass'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: process.env['PATH'] ?? '', HOME: tempDir(t, 'conclave-home') },
  })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /1 mutation marker could not be read, so the file it guards may be mutated/)
  assert.ok(r.stderr.includes('.conclave/mutations/0123456789abcdef.json'))
})

test('a clean tree, and a merely stale marker, say nothing before a run', (t) => {
  const clean = repo(t)
  assert.equal(mutationWarning(clean), undefined, 'no markers at all')

  const roomy = 8 * 1024 * 1024 * 1024
  assert.deepEqual(preflightWarnings(clean, { readFree: () => roomy }), [], 'and nothing reaches the preflight')

  const stale = repo(t)
  begin(stale, 'f.ts')
  assert.equal(mutationWarning(stale), undefined, 'a marker whose file matches is not a defect')
})

test('a bookkeeping directory that cannot be read is silent rather than fatal', (t) => {
  const dir = repo(t)
  begin(dir, 'f.ts')
  writeFileSync(join(dir, 'f.ts'), 'mutated\n')
  rmSync(mutationsDir(dir), { recursive: true, force: true })
  assert.deepEqual(outstanding(dir).mutations, [], 'a missing directory is no markers, not a throw')
  assert.equal(mutationWarning(dir), undefined)
})
