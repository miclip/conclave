/**
 * The boundary reads each tree state ONCE, and every answer it gives comes from the reading it
 * was built on.
 *
 *   node --test src/relay/boundaryReads.test.ts
 *
 * `integrate.test.ts` proves what the boundary does. This file proves something narrower and
 * harder to see: that it does not ask the same question twice and then mix the answers. Two
 * `git status` calls a few milliseconds apart look equivalent right up until the case this
 * whole module exists for -- a child that has not stopped writing -- and then they are two
 * different trees wearing one name.
 *
 * There were two such pairs, and each produced a specific untruth:
 *
 *   pre-commit   `observeTree` said dirty, `commitSeatWork` re-read and found clean, and the
 *                boundary reported `nothing_to_merge` DATED FROM the reading that had said the
 *                tree was full of work. The operator was told "no changes were present at
 *                10:04:03" about an instant when there were.
 *
 *   post-commit  `dirty()` decided the tree still held work, then a separate render re-read it
 *                to say what -- so the note could be taken on one tree and written from
 *                another: "was still dirty after its boundary commit ... nothing else is
 *                uncommitted", contradicting itself inside a single line.
 *
 * A race cannot be proven by running the code quickly and hoping. So `git` itself is shimmed
 * here: the stand-in passes every call through to the real binary, logs it, and can delete a
 * file at exactly the moment BETWEEN two reads. That makes the window deterministic, which is
 * the only way a test can say anything about it at all.
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSeatWorktrees, type SeatWorktree, type WorktreeManifest } from '../workspace/worktrees.ts'
import { integrateSeat } from './integrate.ts'

/** Resolved BEFORE the shim shadows it, or the shim would exec itself. */
const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()

/**
 * A `git` that is otherwise the real one.
 *
 * Every call is appended to `ORCH_GIT_LOG`. `status` calls are counted, and when the count
 * reaches `ORCH_RACE_AT` the sentinel at `ORCH_RACE_FILE` is deleted AFTER the real command has
 * answered -- so that read still sees the file and the next one does not. That is the window,
 * held open on purpose.
 */
const GIT_SHIM = `#!/bin/sh
printf '%s\\n' "$*" >> "$ORCH_GIT_LOG"
if [ "$1" = "status" ]; then
  n=$(cat "$ORCH_GIT_COUNT" 2>/dev/null || echo 0)
  n=$((n + 1))
  printf '%s' "$n" > "$ORCH_GIT_COUNT"
  "$ORCH_REAL_GIT" "$@"
  rc=$?
  if [ -n "$ORCH_RACE_FILE" ] && [ "$n" = "$ORCH_RACE_AT" ]; then rm -f "$ORCH_RACE_FILE"; fi
  exit $rc
fi
exec "$ORCH_REAL_GIT" "$@"
`

const SHIM_DIR = mkdtempSync(join(tmpdir(), 'conclave-git-shim-'))
writeFileSync(join(SHIM_DIR, 'git'), GIT_SHIM, { mode: 0o755 })
chmodSync(join(SHIM_DIR, 'git'), 0o755)

const GIT_LOG = join(SHIM_DIR, 'calls.log')
const GIT_COUNT = join(SHIM_DIR, 'status-count')

// This file runs in its own process under `node --test`, so shadowing git on PATH cannot leak
// into any other suite.
process.env['PATH'] = `${SHIM_DIR}:${process.env['PATH'] ?? ''}`
process.env['ORCH_REAL_GIT'] = REAL_GIT
process.env['ORCH_GIT_LOG'] = GIT_LOG
process.env['ORCH_GIT_COUNT'] = GIT_COUNT

/** Arm the shim: nothing is deleted unless a test asks for a window. */
function race(file: string | undefined, atStatusCall: number): void {
  process.env['ORCH_RACE_FILE'] = file ?? ''
  process.env['ORCH_RACE_AT'] = String(atStatusCall)
}

/** Start counting from here, so the setup's git calls are not in the answer. */
function startCounting(): void {
  writeFileSync(GIT_LOG, '')
  writeFileSync(GIT_COUNT, '0')
}

const statusReads = (): string[] =>
  readFileSync(GIT_LOG, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('status '))

function realGit(cwd: string, ...args: string[]): string {
  return execFileSync(REAL_GIT, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function withSeat(work: (repo: string, manifest: WorktreeManifest, seat: SeatWorktree) => void): void {
  const repo = mkdtempSync(join(tmpdir(), 'conclave-reads-'))
  try {
    realGit(repo, 'init', '--quiet')
    realGit(repo, 'config', 'user.email', 'test@example.com')
    realGit(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, '.gitignore'), '.conclave/\n')
    writeFileSync(join(repo, 'shared.txt'), 'base\n')
    realGit(repo, 'add', '.')
    realGit(repo, 'commit', '-m', 'init', '--quiet')
    const manifest = createSeatWorktrees({ repoRoot: repo, runId: 'r1', seatIds: ['a'] })
    race(undefined, 0)
    work(repo, manifest, manifest.seats[0]!)
  } finally {
    race(undefined, 0)
    rmSync(repo, { recursive: true, force: true })
  }
}

const META = { taskId: 't1', seq: 1, advisorTurn: 1 }

/**
 * The count IS the claim.
 *
 * A boundary makes exactly two decisions about a tree -- was there anything to commit, and is
 * anything left afterwards -- so it reads the tree exactly twice. A third read means some
 * answer was derived from a state no decision was taken on, which is the whole failure this
 * file is about; it does not matter which of the two pairs came back.
 */
test('a boundary asks the tree exactly one question per decision', () => {
  withSeat((_repo, manifest, seat) => {
    writeFileSync(join(seat.worktreePath, 'shared.txt'), 'seat work\n')
    startCounting()
    const result = integrateSeat(manifest, seat, META)
    assert.equal(result.status, 'merged')

    const reads = statusReads()
    assert.equal(
      reads.length,
      2,
      `one read for "is there anything to commit", one for "is anything left"; got:\n${reads.join('\n')}`,
    )
  })
})

/**
 * The same, for the path that reads the tree and then commits nothing.
 *
 * `nothing_to_merge` reports its observation to an operator, so there had better be only one.
 */
test('a boundary with nothing to commit reads the tree once before it decides', () => {
  withSeat((_repo, manifest, seat) => {
    startCounting()
    const result = integrateSeat(manifest, seat, META)
    assert.equal(result.status, 'nothing_to_merge')

    const before = statusReads()
    assert.equal(before.length, 1, `the answer and its timestamp come from one read; got:\n${before.join('\n')}`)
  })
})

/**
 * The pre-commit window, held open.
 *
 * The tree holds one uncommitted file when the boundary looks, and nothing by the time anyone
 * could look again. With one observation that is a boundary which tried to commit work that
 * vanished under it, and it says so by failing -- the run cannot describe what happened in that
 * window and must not pretend it can. With two, `commitSeatWork` finds the tree clean, returns
 * `undefined`, and the boundary reports a tidy `nothing_to_merge` stamped with the time of the
 * reading that said the opposite.
 *
 * So the assertion is not about the error. It is that no result is built on a reading the
 * result contradicts.
 */
test('a tree that empties between the two reads cannot produce a false no-op', () => {
  withSeat((_repo, manifest, seat) => {
    const vanishing = join(seat.worktreePath, 'vanishing.txt')
    writeFileSync(vanishing, 'here when the boundary looked\n')
    startCounting()
    // Deleted immediately after the FIRST status returns: that read saw it, a second would not.
    race(vanishing, 1)

    let outcome: string | undefined
    let raised: Error | undefined
    try {
      outcome = integrateSeat(manifest, seat, META).status
    } catch (e) {
      raised = e as Error
    }

    assert.equal(
      outcome,
      undefined,
      'a reading that said DIRTY must not come back as an outcome meaning the tree was clean',
    )
    assert.ok(raised, 'the boundary cannot say what happened in that window, and must not claim it can')
    assert.match(raised.message, /nothing to commit/, 'and the reason is the one git gave')
    assert.ok(!existsSync(vanishing), 'the window really did open')
  })
})

/**
 * The post-commit window, held open the same way.
 *
 * The boundary commits, the child writes one more file, the boundary reads the tree and finds
 * it -- and then the file goes. The note is written from the reading the decision was taken on,
 * so it names the file. Written from a second reading it would say the tree was dirty and then
 * that nothing in it was uncommitted, in one sentence, about one tree.
 */
test('the post-commit note is written from the reading its decision was taken on', () => {
  withSeat((repo, manifest, seat) => {
    writeFileSync(join(seat.worktreePath, 'shared.txt'), 'seat work\n')
    // `post-commit` survives `commit --no-verify`, so this lands in the window between the
    // boundary's snapshot and its post-merge read -- exactly where a live child would.
    const late = join(seat.worktreePath, 'late.txt')
    writeFileSync(
      join(repo, '.git', 'hooks', 'post-commit'),
      `#!/bin/sh\n[ "$(${JSON.stringify(REAL_GIT)} rev-parse --abbrev-ref HEAD)" = "${seat.branch}" ] || exit 0\necho late > late.txt\n`,
      { mode: 0o755 },
    )
    startCounting()
    // The post-commit read is the second one. Delete after it answers.
    race(late, 2)

    const result = integrateSeat(manifest, seat, META)
    assert.equal(result.status, 'merged')
    const notes = (result.status === 'merged' ? result.notes : []).join('\n')

    assert.match(notes, /still dirty after its boundary commit/, 'the decision was taken on a dirty tree')
    assert.ok(notes.includes('late.txt'), 'so the note says what was in it, from that same reading')
    assert.ok(
      !/nothing else in/.test(notes),
      'a note cannot decide on one tree and describe another; that sentence contradicts its own line',
    )
    assert.ok(!existsSync(late), 'the window really did open')
  })
})
