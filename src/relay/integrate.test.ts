/**
 * The task boundary against real git: commit, merge, reset — and abort.
 *
 * The conflict case is the one this file exists for. Everything else here would survive a
 * sloppy implementation; a conflict is where a merge can leave the operator's own checkout
 * mid-merge, with markers in the tree the advisor reads as committed state. So the assertions
 * are about the INTEGRATION checkout as much as about the return value: same HEAD as before,
 * no `MERGE_HEAD`, clean status, and the blocked seat's work still committed on its branch.
 *
 *   node --test src/relay/integrate.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSeatWorktrees, readManifest, type SeatWorktree, type WorktreeManifest } from '../workspace/worktrees.ts'
import {
  commitSeatWork,
  failedRequired,
  integrateSeat,
  mergeIntoIntegration,
  runIntegrationChecks,
} from './integrate.ts'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-int-'))
  git(dir, 'init', '--quiet')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'shared.txt'), 'base\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'init', '--quiet')
  return dir
}

const META = { taskId: 't1', seq: 1, advisorTurn: 1 }

function withSeats(
  seatIds: string[],
  work: (repo: string, manifest: WorktreeManifest, seats: Record<string, SeatWorktree>) => void,
): void {
  const repo = tempRepo()
  try {
    const manifest = createSeatWorktrees({ repoRoot: repo, runId: 'r1', seatIds })
    const seats = Object.fromEntries(manifest.seats.map((s) => [s.seatId, s]))
    work(repo, manifest, seats)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

test('a seat commit carries tracked and untracked work, with the task in its trailers', () => {
  withSeats(['a'], (repo, _manifest, seats) => {
    const seat = seats.a!
    writeFileSync(join(seat.worktreePath, 'shared.txt'), 'edited\n')
    writeFileSync(join(seat.worktreePath, 'brand-new.txt'), 'created\n')

    const sha = commitSeatWork(seat, { taskId: 't7', seq: 4, advisorTurn: 2 })
    assert.ok(sha, 'a seat that changed something must produce a commit')
    assert.equal(git(seat.worktreePath, 'status', '--porcelain').trim(), '', 'the tree is left clean')

    const files = git(repo, 'show', '--name-only', '--format=', sha!).split('\n').filter(Boolean).sort()
    assert.deepEqual(
      files,
      ['brand-new.txt', 'shared.txt'],
      'a boundary that committed modifications but not new files would merge half a task',
    )
    const message = git(repo, 'show', '--no-patch', '--format=%B', sha!)
    assert.match(message, /Conclave-Task: t7/)
    assert.match(message, /Conclave-Task-Seq: 4/)
    assert.match(message, /Conclave-Seat: a/)
    assert.match(message, /Conclave-Advisor-Turn: 2/)
  })
})

test('a seat that changed nothing produces no commit and no merge', () => {
  withSeats(['a'], (repo, manifest, seats) => {
    const before = git(repo, 'rev-parse', 'HEAD').trim()
    assert.equal(commitSeatWork(seats.a!, META), undefined, 'a read-only task is not a failed boundary')

    const result = integrateSeat(manifest, seats.a!, META)
    assert.equal(result.status, 'nothing_to_merge')
    assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), before, 'the integration checkout must not move')
    assert.equal(seats.a!.mergeState, 'clean', 'nothing happened, so nothing is claimed to have')
  })
})

test('a successful boundary merges the work, records it, and resets the seat onto the new HEAD', () => {
  withSeats(['a'], (repo, manifest, seats) => {
    const seat = seats.a!
    const base = seat.baseSha
    writeFileSync(join(seat.worktreePath, 'from-seat.txt'), 'work\n')

    const result = integrateSeat(manifest, seat, { taskId: 't2', seq: 3, advisorTurn: 1 })
    assert.equal(result.status, 'merged')

    const head = git(repo, 'rev-parse', 'HEAD').trim()
    assert.notEqual(head, base, 'the integration checkout must have moved')
    assert.equal(
      readFileSync(join(repo, 'from-seat.txt'), 'utf8'),
      'work\n',
      "the seat's work must be in the operator's own checkout, not just on a branch",
    )
    assert.equal(git(repo, 'status', '--porcelain').trim(), '', 'and the checkout is clean afterwards')

    assert.equal(seat.mergeState, 'merged')
    // IMMUTABLE. `baseSha` is the commit this worktree was created from and the fixed point a
    // recovering operator diffs against; advancing it to the new HEAD would make
    // `baseSha..branch` empty on a seat that is full of work.
    assert.equal(seat.baseSha, base, 'baseSha records where the seat started, not where it is')
    assert.notEqual(base, head, 'and the two must actually differ here, or this proves nothing')
    assert.equal(readManifest(repo, 'r1')?.seats[0]?.baseSha, base, 'including on disk')
    assert.equal(
      git(seat.worktreePath, 'rev-parse', 'HEAD').trim(),
      head,
      'without the reset the next task starts from a base that is already behind',
    )
    assert.equal(git(seat.worktreePath, 'status', '--porcelain').trim(), '', 'the reset leaves a clean tree')

    // Persisted at the transition, not at the end: a crash between here and `stop()` must
    // still leave a manifest that says what happened.
    assert.equal(readManifest(repo, 'r1')?.seats[0]?.mergeState, 'merged')
  })
})

test('two seats integrate one after the other and both diffs land', () => {
  withSeats(['a', 'b'], (repo, manifest, seats) => {
    writeFileSync(join(seats.a!.worktreePath, 'a.txt'), 'from a\n')
    writeFileSync(join(seats.b!.worktreePath, 'b.txt'), 'from b\n')

    assert.equal(integrateSeat(manifest, seats.a!, { taskId: 't1', seq: 1, advisorTurn: 1 }).status, 'merged')
    assert.equal(integrateSeat(manifest, seats.b!, { taskId: 't2', seq: 2, advisorTurn: 2 }).status, 'merged')

    assert.ok(existsSync(join(repo, 'a.txt')) && existsSync(join(repo, 'b.txt')))
    // The second seat forked before the first merged, so this is a real merge rather than a
    // fast-forward — which is the case the reset above exists to stop repeating every task.
    assert.equal(git(repo, 'status', '--porcelain').trim(), '')
    // Both seats still record the ONE base they were cut from, after two merges and a reset.
    assert.equal(seats.a!.baseSha, seats.b!.baseSha, 'one run, one base, unchanged by integrating')
    assert.notEqual(seats.b!.baseSha, git(repo, 'rev-parse', 'HEAD').trim())
    assert.equal(
      git(seats.b!.worktreePath, 'rev-parse', 'HEAD').trim(),
      git(repo, 'rev-parse', 'HEAD').trim(),
      'the seat itself is reset onto the new HEAD; only the recorded base stays put',
    )
  })
})

test('a conflicting merge is aborted, marks only that seat, and discards nothing', () => {
  withSeats(['a', 'b'], (repo, manifest, seats) => {
    // Both seats rewrite the same line from the same base. Nothing about this is exotic; it is
    // two implementers touching one file, which is the case isolation exists for.
    writeFileSync(join(seats.a!.worktreePath, 'shared.txt'), 'seat a wrote this\n')
    writeFileSync(join(seats.b!.worktreePath, 'shared.txt'), 'seat b wrote this\n')

    assert.equal(integrateSeat(manifest, seats.a!, { taskId: 't1', seq: 1, advisorTurn: 1 }).status, 'merged')
    const afterA = git(repo, 'rev-parse', 'HEAD').trim()

    const blocked = integrateSeat(manifest, seats.b!, { taskId: 't2', seq: 2, advisorTurn: 2 })
    assert.equal(blocked.status, 'blocked')
    assert.deepEqual(blocked.status === 'blocked' ? blocked.paths : [], ['shared.txt'], 'the conflict must be named')

    // The integration checkout is exactly where it was, and usable.
    assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), afterA, 'an aborted merge must not move HEAD')
    assert.ok(!existsSync(join(repo, '.git', 'MERGE_HEAD')), 'the checkout must not be left mid-merge')
    assert.equal(git(repo, 'status', '--porcelain').trim(), '', 'and must not be left dirty')
    assert.equal(
      readFileSync(join(repo, 'shared.txt'), 'utf8'),
      'seat a wrote this\n',
      'no conflict markers in the tree the advisor reads as committed state',
    )

    // Only that seat, and its work is intact and committed on its own branch.
    assert.equal(seats.b!.mergeState, 'merge_blocked')
    assert.equal(seats.a!.mergeState, 'merged', "one seat's conflict must not change another seat's state")
    assert.equal(
      git(seats.b!.worktreePath, 'show', 'HEAD:shared.txt'),
      'seat b wrote this\n',
      'nothing is discarded to make the merge tidy',
    )
    assert.equal(git(seats.b!.worktreePath, 'status', '--porcelain').trim(), '', 'the blocked seat was still committed')
    assert.equal(readManifest(repo, 'r1')?.seats.find((s) => s.seatId === 'b')?.mergeState, 'merge_blocked')
  })
})

test('a blocked seat integrates once its own worktree resolves the conflict', () => {
  withSeats(['a', 'b'], (repo, manifest, seats) => {
    writeFileSync(join(seats.a!.worktreePath, 'shared.txt'), 'seat a wrote this\n')
    writeFileSync(join(seats.b!.worktreePath, 'shared.txt'), 'seat b wrote this\n')
    integrateSeat(manifest, seats.a!, { taskId: 't1', seq: 1, advisorTurn: 1 })
    assert.equal(integrateSeat(manifest, seats.b!, { taskId: 't2', seq: 2, advisorTurn: 2 }).status, 'blocked')

    // What the retry task does, in the seat's OWN tree: merge integration in, resolve, resubmit.
    // The point of the assertion is that the boundary needs no repair path of its own — the
    // same flow runs again from step one.
    try {
      git(seats.b!.worktreePath, 'merge', git(repo, 'rev-parse', 'HEAD').trim())
    } catch {
      /* expected: this is the conflict, resolved on the next two lines */
    }
    writeFileSync(join(seats.b!.worktreePath, 'shared.txt'), 'both, reconciled\n')
    git(seats.b!.worktreePath, 'add', '-A')
    git(seats.b!.worktreePath, 'commit', '-m', 'resolve', '--quiet')

    const retried = integrateSeat(manifest, seats.b!, { taskId: 't3', seq: 3, advisorTurn: 3 })
    assert.equal(retried.status, 'merged')
    assert.equal(seats.b!.mergeState, 'merged')
    assert.equal(readFileSync(join(repo, 'shared.txt'), 'utf8'), 'both, reconciled\n')
  })
})

/**
 * The failure #80 is about, built from its own description.
 *
 * Two seats, disjoint files, no git conflict on either merge, and each seat's tree green when
 * measured in that seat's tree — the exact situation the first real two-seat run produced, and
 * the one every station in the design was blind to. Seat `a` renames what a symbol is called;
 * seat `b` writes the guard that requires the old name to be there. Neither is wrong. The tree
 * they make together does not pass.
 *
 * The check is a shell script IN the repository rather than a command supplied from outside,
 * because that is what makes each half individually green: `b`'s guard does not exist in `a`'s
 * tree, and `a`'s rename has not happened in `b`'s.
 */
test('two individually green trees merge cleanly into a tree that fails its checks', () => {
  const CHECKS = ['sh check.sh']
  withSeats(['a', 'b'], (repo, manifest, seats) => {
    // The base: a symbol, and a check that has nothing to say about it yet.
    writeFileSync(join(repo, 'api.txt'), 'alpha\n')
    writeFileSync(join(repo, 'check.sh'), 'exit 0\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'api and a check', '--quiet')
    for (const seat of [seats.a!, seats.b!]) {
      git(seat.worktreePath, 'merge', '--quiet', git(repo, 'rev-parse', 'HEAD').trim())
    }

    // Seat a renames the symbol. Seat b writes a guard that requires the old name. Different
    // files, so git has nothing to report on either merge.
    writeFileSync(join(seats.a!.worktreePath, 'api.txt'), 'gamma\n')
    writeFileSync(join(seats.b!.worktreePath, 'check.sh'), 'grep -q alpha api.txt\n')

    // The premise, measured rather than asserted: each seat's own tree passes the check that
    // exists in it. Without this the test would prove only that a broken tree is broken.
    for (const seat of [seats.a!, seats.b!]) {
      git(seat.worktreePath, 'add', '-A')
      git(seat.worktreePath, 'commit', '-m', 'work', '--quiet')
      assert.deepEqual(
        failedRequired(runIntegrationChecks(seat.worktreePath, CHECKS)),
        [],
        `seat ${seat.seatId}'s own tree must be green, or this proves nothing about the merge`,
      )
    }

    const first = integrateSeat(manifest, seats.a!, { taskId: 't1', seq: 1, advisorTurn: 1 }, { checks: CHECKS })
    assert.equal(first.status, 'merged')
    assert.deepEqual(
      failedRequired(first.status === 'merged' ? first.checks : []),
      [],
      'the first merge is green: the guard that will fail is not in the tree yet',
    )

    const second = integrateSeat(manifest, seats.b!, { taskId: 't2', seq: 2, advisorTurn: 2 }, { checks: CHECKS })
    assert.equal(second.status, 'merged', 'the merge itself is clean — that is the whole point')
    assert.equal(git(repo, 'status', '--porcelain').trim(), '', 'and left no conflict behind')

    const red = failedRequired(second.status === 'merged' ? second.checks : [])
    assert.equal(red.length, 1, 'the integrated tree must be measured, and it must be red')
    assert.equal(red[0]!.command, 'sh check.sh')
    assert.notEqual(red[0]!.exitCode, 0)
    // Both seats are `merged` and neither is blocked. The failure belongs to the pair, and a
    // boundary that marked one of them would be blaming a seat for work it could not see.
    assert.equal(seats.a!.mergeState, 'merged')
    assert.equal(seats.b!.mergeState, 'merged')
  })
})

test('an unconfigured boundary reports no checks, and an unchecked tree is not a green one', () => {
  withSeats(['a'], (_repo, manifest, seats) => {
    writeFileSync(join(seats.a!.worktreePath, 'x.txt'), 'x\n')
    const result = integrateSeat(manifest, seats.a!, META)
    assert.equal(result.status, 'merged')
    assert.deepEqual(
      result.status === 'merged' ? result.checks : undefined,
      [],
      'a run that armed nothing must not report a check it never ran',
    )
  })
})

test('a check that cannot be launched is not a check that passed', () => {
  withSeats(['a'], (repo) => {
    const [result] = runIntegrationChecks(repo, ['exit 3'])
    assert.equal(result!.exitCode, 3)
    assert.equal(failedRequired([result!]).length, 1)
    // Relevance decides what a failure is allowed to decide, here as in a rotation.
    const reported = runIntegrationChecks(repo, [{ command: 'exit 3', relevance: 'informational' }])
    assert.equal(reported[0]!.exitCode, 3)
    assert.deepEqual(failedRequired(reported), [], 'a check declared not to gate must not gate')
  })
})

test('mergeIntoIntegration on its own reports the merge without touching the manifest', () => {
  withSeats(['a'], (repo, manifest, seats) => {
    writeFileSync(join(seats.a!.worktreePath, 'x.txt'), 'x\n')
    commitSeatWork(seats.a!, META)

    const result = mergeIntoIntegration(repo, seats.a!, META)
    assert.equal(result.status, 'merged')
    assert.equal(result.status === 'merged' ? result.integrationSha : '', git(repo, 'rev-parse', 'HEAD').trim())
    assert.equal(
      seats.a!.mergeState,
      'clean',
      'the merge reports; recording the transition is the boundary job, in one place',
    )
    assert.equal(readManifest(repo, manifest.runId)?.seats[0]?.mergeState, 'clean')
  })
})
