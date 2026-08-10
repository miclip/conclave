/**
 * The seat worktree lifecycle, against real git in real temporary repositories.
 *
 * Nothing here is faked. A fake `git` would prove that this module composes strings, which is
 * not the claim: the claims are that a dirty checkout is REFUSED, that an operator-supplied
 * seat id cannot escape `.conclave/worktrees/`, that a partially-created layout is unwound,
 * and that cleanup would rather leave a tree behind than remove one it is not sure about. Each
 * of those is a statement about what git does, so git is what answers it.
 *
 *   node --test src/workspace/worktrees.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import {
  cleanupSeatWorktrees,
  createSeatWorktrees,
  ensureWorktreeHookTrigger,
  manifestPath,
  newRunId,
  nextRunId,
  readManifest,
  recoveryLines,
  requireCleanBase,
  sanitize,
  uncleanPaths,
  uniqueSlugs,
  worktreesRoot,
  type WorktreeManifest,
} from './worktrees.ts'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** A repository with one commit and `.conclave/` ignored, which is what a real project has. */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-wt-'))
  git(dir, 'init', '--quiet')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'README.md'), '# hello\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'init', '--quiet')
  return dir
}

function branches(repo: string): string[] {
  return git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')
    .split('\n')
    .filter(Boolean)
}

function withRepo(work: (repo: string) => void): void {
  const repo = tempRepo()
  try {
    work(repo)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

test('sanitize lowercases, collapses, trims, and never yields an empty segment', () => {
  assert.equal(sanitize('Impl'), 'impl')
  assert.equal(sanitize('api/one'), 'api-one')
  assert.equal(sanitize('  spaced  out  '), 'spaced-out')
  assert.equal(sanitize('a___b...c'), 'a-b-c')
  assert.equal(sanitize('--edges--'), 'edges')
  // The three that matter. An empty segment resolves to the parent directory, and `..` and a
  // leading dash are a traversal and an invalid ref name respectively.
  assert.equal(sanitize('..'), 'seat')
  assert.equal(sanitize('///'), 'seat')
  assert.equal(sanitize('   '), 'seat')
})

test('uniqueSlugs breaks collisions deterministically and keeps the first bare', () => {
  const slugs = uniqueSlugs(['api/one', 'api one', 'API-ONE', 'other'])
  assert.deepEqual(
    [...slugs.values()],
    ['api-one', 'api-one-2', 'api-one-3', 'other'],
    'sanitizing is lossy, so three distinct seat ids can arrive at one slug and must not share a path',
  )
  assert.deepEqual(
    [...uniqueSlugs(['api/one', 'api one']).values()],
    [...slugs.values()].slice(0, 2),
    'the same seat list must always produce the same layout',
  )
})

test('a clean checkout passes, and every kind of uncommitted work is refused by name', () => {
  withRepo((repo) => {
    assert.deepEqual(uncleanPaths(repo), [], 'a freshly committed repository is clean')
    requireCleanBase(repo)

    // Modified, tracked.
    writeFileSync(join(repo, 'README.md'), '# changed\n')
    assert.deepEqual(
      uncleanPaths(repo).map((u) => [u.kind, u.path]),
      [['modified', 'README.md']],
      'a modified tracked file must be reported as modified',
    )
    assert.throws(() => requireCleanBase(repo), /refusing to start.*README\.md/s)

    // Staged.
    git(repo, 'add', 'README.md')
    assert.deepEqual(
      uncleanPaths(repo).map((u) => u.kind),
      ['staged'],
      'a staged change is a different thing for the operator to undo and is named as itself',
    )
    assert.throws(() => requireCleanBase(repo), /staged\s+README\.md/)
    git(repo, 'checkout', 'HEAD', '--', 'README.md')
    git(repo, 'reset', '--quiet')

    // Untracked. This is the one an earlier draft of the design wanted to name without
    // blocking on, and it blocks: a linked worktree is created from a commit, so an untracked
    // file here is simply absent from every seat.
    writeFileSync(join(repo, 'notes.txt'), 'scratch\n')
    assert.deepEqual(
      uncleanPaths(repo).map((u) => [u.kind, u.path]),
      [['untracked', 'notes.txt']],
      'an untracked file must be reported as untracked',
    )
    assert.throws(() => requireCleanBase(repo), /untracked\s+notes\.txt/)
    rmSync(join(repo, 'notes.txt'))

    // And Conclave's own state never counts, or the first run would block the second.
    mkdirSync(join(repo, '.conclave', 'runs'), { recursive: true })
    writeFileSync(join(repo, '.conclave', 'runs', 'x.ndjson'), '{}\n')
    assert.deepEqual(uncleanPaths(repo), [], '.conclave/ is Conclave bookkeeping, not anyone work')
    requireCleanBase(repo)
  })
})

test('createSeatWorktrees refuses a dirty base and creates nothing', () => {
  withRepo((repo) => {
    writeFileSync(join(repo, 'stray.txt'), 'x\n')
    assert.throws(
      () => createSeatWorktrees({ repoRoot: repo, runId: 'r1', seatIds: ['a', 'b'] }),
      /refusing to start/,
    )
    assert.ok(!existsSync(worktreesRoot(repo, 'r1')), 'a refused start must leave no layout behind')
    assert.deepEqual(branches(repo).filter((b) => b.startsWith('conclave/')), [], 'and no branches')
  })
})

test('two seats get distinct trees, distinct branches off one base, and a manifest that names both', () => {
  withRepo((repo) => {
    const base = git(repo, 'rev-parse', 'HEAD').trim()
    const manifest = createSeatWorktrees({ repoRoot: repo, runId: 'r1', seatIds: ['impl-a', 'impl-b'] })

    assert.equal(manifest.seats.length, 2)
    const [a, b] = manifest.seats as [(typeof manifest.seats)[0], (typeof manifest.seats)[0]]
    assert.notEqual(a.worktreePath, b.worktreePath, 'two seats must not share a checkout')
    assert.equal(a.worktreePath, join(resolve(repo), '.conclave', 'worktrees', 'r1', 'impl-a'))
    assert.equal(a.branch, 'conclave/r1/impl-a')
    assert.equal(b.branch, 'conclave/r1/impl-b')
    for (const seat of manifest.seats) {
      assert.ok(seat.worktreePath.startsWith(sep), 'paths must be absolute for a recovery message')
      assert.ok(existsSync(join(seat.worktreePath, 'README.md')), 'the tree must be checked out')
      assert.equal(seat.baseSha, base, 'every seat forks from ONE captured base')
      assert.equal(seat.mergeState, 'clean')
      assert.equal(git(seat.worktreePath, 'rev-parse', 'HEAD').trim(), base)
      assert.equal(git(seat.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), seat.branch)
    }

    // Persisted, with exactly the fields recovery needs.
    const onDisk = readManifest(repo, 'r1') as WorktreeManifest
    assert.deepEqual(onDisk, manifest, 'the manifest on disk is the record, and must match')
    assert.deepEqual(
      Object.keys(onDisk.seats[0]!).sort(),
      ['baseSha', 'branch', 'mergeState', 'seatId', 'slug', 'worktreePath'],
      'a manifest entry that lost a field would make a crashed run unrecoverable',
    )
    assert.ok(manifestPath(repo, 'r1').endsWith(join('worktrees', 'r1', 'manifest.json')))

    // Creating the layout must not dirty the checkout the clean-base rule depends on.
    assert.deepEqual(uncleanPaths(repo), [], 'seat worktrees live in .conclave/ so they cost nothing here')
  })
})

test('an operator seat id cannot put a worktree outside the run directory', () => {
  withRepo((repo) => {
    const root = resolve(worktreesRoot(repo, 'r1'))
    const manifest = createSeatWorktrees({
      repoRoot: repo,
      runId: 'r1',
      seatIds: ['../../escape', '/etc/passwd', 'Impl One'],
    })
    for (const seat of manifest.seats) {
      assert.ok(
        seat.worktreePath.startsWith(root + sep),
        `a seat worktree must stay under ${root}, got ${seat.worktreePath}`,
      )
      assert.match(seat.slug, /^[a-z0-9][a-z0-9-]*$/, 'a slug must be a safe path and ref segment')
      assert.ok(existsSync(seat.worktreePath))
      // And the ref is real: an unsanitized id is a broken ref name as well as a traversal.
      assert.equal(git(repo, 'rev-parse', '--verify', seat.branch).trim().length, 40)
    }
    assert.ok(!existsSync(join(resolve(repo), '..', 'escape')), 'nothing may be written beside the repo')
  })
})

test('a failure partway through creation unwinds the trees it had already made', () => {
  withRepo((repo) => {
    // The second seat cannot be created: its branch name is already taken. Anything that makes
    // `git worktree add` fail would do; this one needs no permissions games.
    git(repo, 'branch', 'conclave/r1/beta')
    assert.throws(
      () => createSeatWorktrees({ repoRoot: repo, runId: 'r1', seatIds: ['alpha', 'beta'] }),
      /failed to create seat worktrees/,
    )
    assert.ok(
      !existsSync(join(worktreesRoot(repo, 'r1'), 'alpha')),
      'the tree created before the failure must be unwound, or it is a tree nothing will work in',
    )
    assert.deepEqual(
      branches(repo).filter((b) => b.startsWith('conclave/')),
      ['conclave/r1/beta'],
      'the branch this run created must be gone, and the pre-existing one untouched',
    )
    assert.deepEqual(uncleanPaths(repo), [], 'and the integration checkout is where it was')
  })
})

test('cleanup removes merged and clean trees, and deletes their branches without force', () => {
  withRepo((repo) => {
    const manifest = createSeatWorktrees({ repoRoot: repo, runId: 'r1', seatIds: ['a', 'b'] })
    const report = cleanupSeatWorktrees(manifest)

    assert.deepEqual(report.removed.sort(), ['a', 'b'], 'a seat that never ran is safe to remove')
    assert.deepEqual(report.retained, [])
    assert.deepEqual(recoveryLines(report), [], 'nothing retained means nothing for the operator to do')
    assert.deepEqual(branches(repo).filter((b) => b.startsWith('conclave/')), [], 'branches go with the trees')
    assert.ok(!existsSync(worktreesRoot(repo, 'r1')), 'the run directory goes when nothing is retained')
    assert.deepEqual(
      git(repo, 'worktree', 'list').split('\n').filter(Boolean).length,
      1,
      'git must be left holding only the main worktree',
    )
  })
})

test('cleanup retains a dirty tree with its work intact and prints what to run', () => {
  withRepo((repo) => {
    const manifest = createSeatWorktrees({ repoRoot: repo, runId: 'r1', seatIds: ['a', 'b'] })
    const dirty = manifest.seats[0]!
    writeFileSync(join(dirty.worktreePath, 'unsaved.txt'), 'the only copy\n')

    const report = cleanupSeatWorktrees(manifest)
    assert.deepEqual(report.removed, ['b'], 'the clean seat is still removed; retention is per seat')
    assert.equal(report.retained.length, 1)
    const kept = report.retained[0]!
    assert.equal(kept.seat.seatId, 'a')
    assert.match(kept.why, /uncommitted work/)
    assert.equal(kept.seat.mergeState, 'retained', 'the manifest must say the tree was kept')

    assert.equal(
      readFileSync(join(dirty.worktreePath, 'unsaved.txt'), 'utf8'),
      'the only copy\n',
      'a retained tree keeps its work — this is the loss `--force` would cause',
    )
    assert.ok(existsSync(worktreesRoot(repo, 'r1')), 'the run directory stays while anything is retained')
    assert.deepEqual(
      branches(repo).filter((b) => b.startsWith('conclave/')),
      ['conclave/r1/a'],
      'a retained seat keeps its branch, and the removed one loses it',
    )

    const lines = recoveryLines(report).join('\n')
    for (const verb of ['inspect:', 'merge:', 'discard:']) {
      assert.ok(lines.includes(verb), `the operator must be told how to ${verb.slice(0, -1)} it`)
    }
    assert.ok(lines.includes(dirty.worktreePath) && lines.includes(dirty.branch))

    // The manifest is rewritten, or a later reader would still be told this tree was clean.
    assert.equal(readManifest(repo, 'r1')?.seats.find((s) => s.seatId === 'a')?.mergeState, 'retained')
  })
})

test('cleanup retains a blocked seat and a seat holding unmerged commits', () => {
  withRepo((repo) => {
    const manifest = createSeatWorktrees({ repoRoot: repo, runId: 'r1', seatIds: ['blocked', 'ahead'] })
    const blocked = manifest.seats[0]!
    const ahead = manifest.seats[1]!
    blocked.mergeState = 'merge_blocked'

    // Committed, clean, and not in the integration checkout: the tree is tidy and the work
    // would still be gone. `git worktree remove` would allow this one; the branch delete is
    // what refuses, and this module refuses before either.
    writeFileSync(join(ahead.worktreePath, 'work.txt'), 'done\n')
    git(ahead.worktreePath, 'add', '-A')
    git(ahead.worktreePath, 'commit', '-m', 'seat work', '--quiet')

    const report = cleanupSeatWorktrees(manifest)
    assert.deepEqual(report.removed, [], 'neither seat may be removed')
    assert.deepEqual(
      report.retained.map((r) => r.seat.seatId).sort(),
      ['ahead', 'blocked'],
      'blocked and unmerged are both retain-and-report',
    )
    assert.match(report.retained.find((r) => r.seat.seatId === 'blocked')!.why, /conflicted/)
    assert.match(report.retained.find((r) => r.seat.seatId === 'ahead')!.why, /commits the integration checkout does not have/)
    assert.deepEqual(
      branches(repo).filter((b) => b.startsWith('conclave/')).sort(),
      ['conclave/r1/ahead', 'conclave/r1/blocked'],
      'no branch is deleted while its work is only there',
    )
  })
})

test('a missing directory is retained rather than pruned', () => {
  withRepo((repo) => {
    const manifest = createSeatWorktrees({ repoRoot: repo, runId: 'r1', seatIds: ['gone'] })
    // What a network mount that is not there yet looks like, and what `git worktree prune`
    // would take as permission to forget the seat.
    rmSync(manifest.seats[0]!.worktreePath, { recursive: true, force: true })

    const report = cleanupSeatWorktrees(manifest)
    assert.deepEqual(report.removed, [])
    assert.match(report.retained[0]!.why, /directory is missing/)
    assert.deepEqual(
      branches(repo).filter((b) => b.startsWith('conclave/')),
      ['conclave/r1/gone'],
      'the branch may be the only copy, so it stays',
    )
  })
})

test('a run id is chronological, path-safe, and stepped aside when one is already on disk', () => {
  withRepo((repo) => {
    const at = new Date(2026, 7, 10, 9, 5, 3).getTime()
    assert.equal(newRunId(at, 4242), '20260810-090503-4242')
    assert.match(newRunId(at, 4242), /^[a-z0-9-]+$/)
    assert.equal(newRunId(at, 4242, (id) => id === '20260810-090503-4242'), '20260810-090503-4242-2')

    const first = nextRunId(repo, at, 4242)
    createSeatWorktrees({ repoRoot: repo, runId: first, seatIds: ['a'] })
    assert.equal(
      nextRunId(repo, at, 4242),
      `${first}-2`,
      'a second relay in one process and one second must not reuse the layout of the first',
    )
  })
})

/**
 * The Codex hook trigger — observed on 0.146.0, and version-scoped for that reason.
 *
 * A linked worktree with no `.codex/` directory loads ZERO hooks: no turn-completion signal,
 * and preflight refuses the session. An EMPTY one loads five, sourced from the main worktree,
 * so the directory is a trigger whose contents are ignored. That is one CLI version's measured
 * behaviour and not a protocol guarantee — if this assertion starts looking pointless after a
 * Codex upgrade, re-measure before deleting it.
 */
test('every seat worktree can be given the empty .codex trigger, idempotently', () => {
  withRepo((repo) => {
    const manifest = createSeatWorktrees({ repoRoot: repo, runId: 'r1', seatIds: ['a'] })
    const seat = manifest.seats[0]!
    assert.ok(!existsSync(join(seat.worktreePath, '.codex')), 'git creates no such thing on its own')

    ensureWorktreeHookTrigger(seat)
    assert.ok(existsSync(join(seat.worktreePath, '.codex')))
    // Empty is the whole of it: the contents are ignored, so writing any would be a file
    // nothing reads and one more thing to keep current.
    assert.deepEqual(readdirSync(join(seat.worktreePath, '.codex')), [])

    ensureWorktreeHookTrigger(seat)
    assert.ok(existsSync(join(seat.worktreePath, '.codex')), 'a second start must not fail on it')

    // Inside the seat tree, which is inside `.conclave/`, so the integration checkout is
    // unaffected and the trigger goes when the tree does.
    assert.deepEqual(uncleanPaths(repo), [])
  })
})
