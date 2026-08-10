/**
 * The task boundary: commit what a seat did, merge it into the integration checkout.
 *
 * A seat works in its own linked worktree (`src/workspace/worktrees.ts`), which means its work
 * is invisible to everyone else until it is committed and merged -- `sessionLock.ts` already
 * records the same fact from the other side, that an advisor in a separate worktree can only
 * see committed state. This module is where that crossing happens, and it happens at exactly
 * one point in the run: the `reported` boundary, after the turn ended, the transcript settled
 * and supersession was checked.
 *
 * ## No checks run here
 *
 * An earlier draft of the design put "run that seat's checks" between quiesce and commit,
 * reusing `--checks`. That is wrong quietly. `rotation.checks` has one established meaning --
 * what a replacement must REPRODUCE (`src/rotation/record.ts`) -- and firing the same commands
 * at every task boundary turns a rotation gate into a per-task CI step, changing how often
 * they run and what a failure means, on an operator's existing configuration, without them
 * asking. Whether a merge boundary should gate on anything is a separate decision that needs
 * its own option; it must not be acquired by reinterpreting this one.
 *
 * ## Conflicts are never resolved here
 *
 * On conflict the integration merge is ABORTED and the seat is marked `merge_blocked`. A
 * half-resolved merge in the shared checkout stops every other seat from integrating, puts
 * conflict markers in the tree the advisor reads as committed state, and makes the resulting
 * commit attributable to the orchestrator rather than to the seat whose work it is. The
 * blocked seat owns its conflict because the blocked seat owns the work: resolution is a task
 * dispatched to that seat, resolved in ITS worktree, and resubmitted through this boundary.
 *
 *   node --test src/relay/integrate.test.ts
 */

import { execFileSync } from 'node:child_process'
import {
  writeManifest,
  type SeatWorktree,
  type WorktreeManifest,
} from '../workspace/worktrees.ts'

/** What the commit message has to carry so a commit is attributable without the routing log. */
export interface BoundaryMeta {
  /** `Task.id`. */
  taskId: string
  /** `Task.seq` — admission order, an audit key rather than a priority. */
  seq: number
  /** `Task.origin` — the advisor turn whose reply produced this task. */
  advisorTurn: number
}

export type MergeResult =
  /** The seat wrote nothing this task. Not a failure, and not a merge either. */
  | { status: 'nothing_to_merge' }
  | { status: 'merged'; seatCommit: string; integrationSha: string; notes: string[] }
  /**
   * The merge was aborted and the integration checkout is back where it was.
   *
   * `parent` is the integration HEAD the merge was attempted against. It is the whole
   * difference between "this seat's repair did not work" and "the integration branch moved
   * under it and there is a new conflict": the caller decides how many attempts a seat gets,
   * and it cannot decide that without knowing what each attempt was against.
   */
  | { status: 'blocked'; paths: string[]; detail: string; parent: string }

/**
 * What a merge itself can produce.
 *
 * `nothing_to_merge` is deliberately not in here: it is a decision made BEFORE the merge, by
 * the boundary, and typing it as a possible merge outcome would let a caller believe git had
 * been asked something it was never asked.
 */
export type MergeOutcome = Extract<MergeResult, { status: 'merged' | 'blocked' }>

function run(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return {
      ok: true,
      out: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    }
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string }
    return { ok: false, out: (err.stderr || err.stdout || err.message || '').trim() }
  }
}

function must(cwd: string, args: string[]): string {
  const r = run(cwd, args)
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.out}`)
  return r.out
}

/** Anything at all, tracked or not, that this seat has not committed. */
function dirty(root: string): boolean {
  return must(root, ['status', '--porcelain', '--untracked-files=all']).trim() !== ''
}

/**
 * Commit a seat's work on its own branch, tracked and untracked alike.
 *
 * `add -A` rather than `add -u`: a seat that created a file did work, and a boundary that
 * committed modifications but not new files would merge half of a task and leave the rest to
 * be swept into whatever came next. `.gitignore` is still honoured -- this is the seat's own
 * checkout, so what it ignores is the project's own rule.
 *
 * Returns the new commit, or `undefined` when the seat changed nothing. A read-only task is
 * an ordinary outcome at any N and must not look like a failed boundary.
 */
export function commitSeatWork(seat: SeatWorktree, meta: BoundaryMeta): string | undefined {
  if (!dirty(seat.worktreePath)) return undefined
  must(seat.worktreePath, ['add', '-A'])
  // Trailers rather than prose: the point is that `git log` alone attributes a commit to a
  // decision, and a reader grepping for a task id should not have to parse a sentence.
  const message =
    `conclave: ${seat.seatId} work for task ${meta.taskId}\n\n` +
    `Conclave-Task: ${meta.taskId}\n` +
    `Conclave-Task-Seq: ${meta.seq}\n` +
    `Conclave-Seat: ${seat.seatId}\n` +
    `Conclave-Advisor-Turn: ${meta.advisorTurn}\n`
  must(seat.worktreePath, ['commit', '--no-verify', '-m', message])
  return must(seat.worktreePath, ['rev-parse', 'HEAD']).trim()
}

/**
 * The integration checkout's HEAD, or nothing if it cannot be read.
 *
 * `undefined` rather than a throw: the caller is a failure path that has already lost once, and
 * a helper that raises a second error there would replace the diagnosis with its own.
 */
export function integrationHead(repoRoot: string): string | undefined {
  const r = run(repoRoot, ['rev-parse', 'HEAD'])
  return r.ok ? r.out.trim() : undefined
}

/** The paths git could not merge, read before the abort throws the state away. */
function conflictedPaths(repoRoot: string): string[] {
  const r = run(repoRoot, ['diff', '--name-only', '--diff-filter=U'])
  return r.ok ? r.out.split('\n').filter((l) => l.trim()) : []
}

/**
 * Merge one seat's branch into the integration checkout.
 *
 * A fast-forward is allowed. With one seat ahead of the integration HEAD the seat's own commit
 * becomes the integration commit, which keeps the metadata trailers on the commit that
 * actually holds the work rather than one level above it; with two seats the second merge is a
 * real merge because it has to be.
 *
 * On failure the merge is aborted and the conflicted paths are reported. The abort is checked:
 * a merge that could not be aborted leaves the operator's checkout mid-merge, which is the one
 * outcome this must never report as a tidy `blocked`.
 */
export function mergeIntoIntegration(
  repoRoot: string,
  seat: SeatWorktree,
  meta: BoundaryMeta,
): MergeOutcome {
  const before = must(repoRoot, ['rev-parse', 'HEAD']).trim()
  const message = `conclave: integrate ${seat.seatId} (task ${meta.taskId}, seq ${meta.seq})`
  const merged = run(repoRoot, ['merge', '--no-edit', '-m', message, seat.branch])
  if (merged.ok) {
    return {
      status: 'merged',
      seatCommit: must(repoRoot, ['rev-parse', seat.branch]).trim(),
      integrationSha: must(repoRoot, ['rev-parse', 'HEAD']).trim(),
      notes: [],
    }
  }
  const paths = conflictedPaths(repoRoot)
  const aborted = run(repoRoot, ['merge', '--abort'])
  const after = run(repoRoot, ['rev-parse', 'HEAD'])
  // What "restored" means is the STATE, not whether the abort command succeeded. A merge git
  // refused to start -- local changes that would be overwritten -- leaves nothing to abort, so
  // `--abort` fails and the checkout was never disturbed. Reading the command's exit code alone
  // attached a scary warning to the tidiest possible outcome.
  const midMerge = run(repoRoot, ['rev-parse', '--verify', 'MERGE_HEAD']).ok
  const restored = after.ok && after.out.trim() === before && !midMerge
  return {
    status: 'blocked',
    paths,
    parent: before,
    detail: restored
      ? merged.out.trim()
      : `${merged.out.trim()}\nWARNING: the integration checkout could not be returned to ${before}: ${aborted.out}`,
  }
}

/**
 * The whole boundary for one seat: commit, merge, and record what happened.
 *
 * The manifest is written on every path including the blocked one. It is what makes a crash
 * recoverable -- a directory on disk is not evidence of whose it is or what state it is in --
 * so a transition that happened and was not recorded is worse than one that did not happen.
 */
export function integrateSeat(
  manifest: WorktreeManifest,
  seat: SeatWorktree,
  meta: BoundaryMeta,
): MergeResult {
  const repoRoot = manifest.integrationRoot
  const seatCommit = commitSeatWork(seat, meta)

  // A read-only task on a seat that is already contained in the integration HEAD has nothing
  // to cross this boundary. Said as its own outcome rather than run through `git merge` for an
  // "Already up to date": a merge that did nothing and a merge that moved the tree must not
  // arrive at the caller as the same answer.
  const contained = run(repoRoot, ['merge-base', '--is-ancestor', seat.branch, 'HEAD']).ok
  if (seatCommit === undefined && contained) {
    writeManifest(manifest)
    return { status: 'nothing_to_merge' }
  }

  const result = mergeIntoIntegration(repoRoot, seat, meta)
  if (result.status === 'blocked') {
    // ONLY this seat. No other seat's state changes, its branch and worktree are untouched,
    // and its work is committed and intact -- nothing is discarded to make the merge tidy.
    seat.mergeState = 'merge_blocked'
    writeManifest(manifest)
    return result
  }
  seat.mergeState = 'merged'

  const head = must(repoRoot, ['rev-parse', 'HEAD']).trim()
  const notes: string[] = []
  // Reset the seat onto the new integration HEAD, so its next task starts from what everyone
  // else now has. Without this every later merge re-resolves history the integration branch
  // has already absorbed. Safe ONLY because the commit above left the tree clean -- so that is
  // rechecked here rather than assumed, and a tree that is somehow dirty keeps its work and
  // loses only the fast base.
  //
  // `baseSha` is NOT touched. It records the integration HEAD this worktree was created from
  // and it is the fixed point a recovering operator diffs against; moving it forward with the
  // run would make `baseSha..branch` empty on a seat that is full of work.
  if (dirty(seat.worktreePath)) {
    notes.push(`${seat.seatId} was still dirty after its boundary commit; left on its own branch`)
  } else if (must(seat.worktreePath, ['rev-parse', 'HEAD']).trim() !== head) {
    const reset = run(seat.worktreePath, ['reset', '--hard', head])
    if (!reset.ok) notes.push(`${seat.seatId} could not be reset onto ${head}: ${reset.out}`)
  }

  writeManifest(manifest)
  return { ...result, notes }
}
