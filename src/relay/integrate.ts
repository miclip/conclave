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
 * ## The configured checks run here, against the INTEGRATION tree
 *
 * This reverses a decision recorded in this header, so the reversal is recorded rather than
 * the old text quietly replaced. What stood here was: an earlier draft put "run that seat's
 * checks" between quiesce and commit, reusing `--checks`; `rotation.checks` has one
 * established meaning -- what a replacement must REPRODUCE (`src/rotation/record.ts`) -- and
 * firing the same commands at every task boundary turns a rotation gate into a per-task CI
 * step, changing how often they run and what a failure means on an operator's existing
 * configuration without them asking; whether a merge boundary should gate on anything needs
 * its own option.
 *
 * That objection was answered by a real run rather than argued away (#80). Three tasks merged
 * with no git conflict at all and the resulting tree failed two tests, both cross-seat: each
 * seat's work was correct in the tree it was written in, and the pair was not. Nothing in the
 * design looked at the RESULT. An option that must be discovered and armed separately would
 * have left exactly that run unprotected -- the operator who has already said `--checks "npm
 * test"` has already said what "working" means for this project, and asking them to say it
 * twice is a second chance to say it zero times.
 *
 * So the objection is honoured in the part that was actually load-bearing and dropped in the
 * part that was not. What does NOT happen is the earlier draft: the seat's checks are still
 * not run in the seat's own tree at every boundary. What happens is that the same configured
 * commands are ALSO run once per merge, in the integration checkout, on the tree the seats
 * produced together. The cost is real and is stated plainly here: an existing N>1
 * configuration now runs those commands more often, and their failure now means a second
 * thing. At N=1 nothing changes at all, because there is no merge and no integration checkout
 * distinct from the tree the implementer has been working in all along.
 *
 * A red result is reported, never acted on here. This module does not blame a seat, does not
 * mark one blocked and does not undo the merge: the failure belongs to a COMBINATION of
 * tasks, and the merge that produced it is a fact whatever the checks say. What to do about
 * it -- a repair the advisor dispatches, or an unsuccessful outcome when no seat is left to
 * dispatch it to -- is the caller's decision, in `relay.ts`.
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

import { execFileSync, spawnSync } from 'node:child_process'
import type { Verdict } from '../contract/outcome.ts'
import { checkCommand, checkRelevance, type CheckRelevance, type CheckSpec } from '../rotation/record.ts'
import {
  renderTreeState,
  treeState,
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
  /**
   * How the turn that produced this work ended, already resolved through supersession.
   *
   * `TaskRuntime.end.verdict` and nothing else -- passed IN rather than read here, because the
   * only correct answer to "how did that turn end" is the one the relay already graded. A
   * boundary that re-read the latest event would sometimes disagree with the run's own record,
   * and the case it would disagree on is exactly the one this field exists for: a verdict a
   * late revision withdrew.
   *
   * Optional because a caller may not have one, and an absent verdict adds nothing rather than
   * being guessed at. See `turnEndTrailer`.
   */
  turnEnd?: Verdict | undefined
}

/**
 * The trailer a commit earns when the turn behind it ended UNCERTAIN, or nothing.
 *
 * The boundary commit is a snapshot. It has to be: no bounded signal can prove a child has
 * stopped writing, so a boundary that waited for one would wait forever on exactly the turns
 * that need it most. What can be recorded is that the snapshot was taken under that doubt --
 * and recorded in the one place that outlives the run, is immutable, and travels with the work
 * rather than beside it.
 *
 * Deliberately NOT a gate. Refusing to merge an uncertain turn would strand every one of them
 * on a condition nothing can ever discharge, which is a worse failure than a merge carrying a
 * caveat: the work would be neither integrated nor recoverable without an operator reading a
 * manifest. The trailer says what is true and lets the run continue.
 *
 * Only `uncertain`, and precisely because of what that confidence means: absence of terminal
 * evidence. Nothing said the turn ended. The other three all rest on something -- `proven` on a
 * positive signal from the child, `inferred` on a composite of signals, `assumed` on the
 * orchestrator's own bookkeeping, which is explicitly unverifiable from the child but is still
 * a record of something this process DID. Only `uncertain` rests on nothing at all, and that is
 * the case a commit has to carry. A trailer on every commit would be noise a reader learns to
 * skip, which is how the one that mattered gets skipped too.
 */
export function turnEndTrailer(verdict: Verdict | undefined): string {
  if (verdict?.confidence !== 'uncertain') return ''
  return `Conclave-Turn-End: ${verdict.outcome} (uncertain)\n`
}

/**
 * The same fact, for the operator notice rather than for the commit.
 *
 * A trailer is found by someone already reading `git log`. The notice is what reaches a human
 * who is not, and a merge reported without this reads as an ordinary one.
 */
export function uncertainSnapshotNote(verdict: Verdict | undefined): string {
  if (verdict?.confidence !== 'uncertain') return ''
  // Boundary-neutral, because the same caveat has to be true on paths where NO commit exists:
  // a boundary that found a clean tree, and one that threw before `commitSeatWork` ran. Saying
  // "what was committed is a snapshot" on those was a claim about an object that was never
  // created -- a false sentence attached to a true warning, which is how a warning stops being
  // read. What is true on every path is that the boundary ran at all.
  return (
    ` Its turn ended ${verdict.outcome} (uncertain), so the boundary ran after an end nothing ` +
    `confirmed: the child may still have been writing, and any commit it made may be mid-edit or incomplete.`
  )
}

/** One configured integration check, as it actually ran against the integration checkout. */
export interface IntegrationCheckResult {
  command: string
  /**
   * As declared when the check was configured, and it decides the same thing it decides for
   * a rotation: `required` is a gate, the other two are reported and gate nothing. Declared by
   * the orchestrator, never by a participant -- see `CheckRelevance`.
   */
  relevance: CheckRelevance
  /** `null` when the command could not be launched, or was killed by the timeout. */
  exitCode: number | null
  /** Combined stdout and stderr, tail-trimmed. What a repair instruction has to carry. */
  output: string
}

/** How much output travels with a failure. Enough to name the failing test, not a log file. */
const MAX_CHECK_OUTPUT = 4000

/** A red check is one that is BOTH a gate and did not pass. Everything else is reported. */
export function failedRequired(checks: IntegrationCheckResult[]): IntegrationCheckResult[] {
  return checks.filter((c) => c.relevance === 'required' && c.exitCode !== 0)
}

/**
 * Run the configured checks against the integration checkout.
 *
 * Its own runner rather than `runCheck` from `src/rotation/record.ts`, and the difference is
 * the whole point: rotation compares a check against a RECORDING of itself, so a digest of the
 * output is all it needs and all it keeps. Here nothing is being compared -- the question is
 * whether the tree works -- so what a reader needs is the failure text, and a digest of it
 * would be the one thing that cannot be put in a repair instruction.
 */
export function runIntegrationChecks(
  root: string,
  checks: CheckSpec[],
  timeoutMs = 600_000,
): IntegrationCheckResult[] {
  return checks.map((spec) => {
    const command = checkCommand(spec)
    const r = spawnSync(command, {
      cwd: root,
      shell: true,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    })
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
    return {
      command,
      relevance: checkRelevance(spec),
      // A signalled or un-launchable command has no exit code, and recording 0 for it would
      // report a check that never ran as a check that passed -- which is the failure this
      // whole station exists to stop happening silently.
      exitCode: r.status,
      output: output.length > MAX_CHECK_OUTPUT ? `…${output.slice(-MAX_CHECK_OUTPUT)}` : output,
    }
  })
}

export type MergeResult =
  /** The seat wrote nothing this task. Not a failure, and not a merge either. */
  | {
      status: 'nothing_to_merge'
      /** When the `git status` behind this answer returned. See `observeTree`. */
      checkedAt: number
    }
  | {
      status: 'merged'
      seatCommit: string
      integrationSha: string
      notes: string[]
      /**
       * The configured integration checks as they ran against the merged tree.
       *
       * Empty when none are configured, which is every run that has not armed them and every
       * run at N=1 -- there is no integration checkout distinct from the seat's own tree, so
       * this module does not run at all. Empty means NOT CHECKED, and it must not be read as
       * checked-and-green: `failedRequired([])` is empty for both.
       */
      checks: IntegrationCheckResult[]
    }
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

/**
 * One reading of a seat's tree, and the instant it finished.
 *
 * A VALUE rather than a question, and that is the whole point of the type. Everything the
 * boundary decides about a tree -- whether to commit, what to report, what instant to date the
 * report from -- has to come from the same reading, or the boundary reports one tree while
 * having acted on another. Two reads a few milliseconds apart look equivalent right up until
 * the case this module exists for: a child that has not stopped writing.
 *
 * The time is stamped when the command RETURNS, so it is when the answer was known rather than
 * when it was asked for. A timestamp applied later is a different instant wearing this one's
 * clothes.
 */
export interface TreeObservation {
  /** Anything at all, tracked or not, that this seat has not committed. */
  dirty: boolean
  /** When the `git status` behind `dirty` returned. */
  at: number
}

/**
 * Read the tree once.
 *
 * Throws, like everything else in this module that reads a tree it is about to act on. A
 * boundary that cannot see the tree must not proceed as though it had seen an empty one.
 */
export function observeTree(root: string): TreeObservation {
  const out = must(root, ['status', '--porcelain', '--untracked-files=all'])
  return { dirty: out.trim() !== '', at: Date.now() }
}

/**
 * Commit a seat's work on its own branch, tracked and untracked alike.
 *
 * `add -A` rather than `add -u`: a seat that created a file did work, and a boundary that
 * committed modifications but not new files would merge half of a task and leave the rest to
 * be swept into whatever came next. `.gitignore` is still honoured -- this is the seat's own
 * checkout, so what it ignores is the project's own rule.
 *
 * Returns the new commit, or `undefined` when the tree held nothing uncommitted AT THE MOMENT
 * IT WAS CHECKED. That is weaker than "the seat changed nothing" and the difference matters: a
 * child that had not finished writing looks identical to one with nothing to say. A read-only
 * task is an ordinary outcome at any N and must not look like a failed boundary.
 *
 * `observed` is that moment, and a caller with one of its own MUST pass it. `integrateSeat`
 * does, because it reports that observation to an operator: reading the tree here a second
 * time would let this return `undefined` on the strength of a reading the caller never saw,
 * and the caller would then date its "no changes were present" notice from the reading that
 * said the opposite. The default is for direct callers, who have no such second answer to
 * contradict -- they get their own reading, and it is the only one.
 *
 * When the passed observation says dirty and the tree has since gone clean, `git commit` finds
 * nothing to commit and this THROWS. That is the honest outcome and it is deliberate: the run
 * cannot say what happened in that window, and a boundary that reported a tidy no-op would be
 * claiming it could. The relay's error path already handles it -- the seat blocks, the tree is
 * retained, and the operator is told what is in it.
 */
export function commitSeatWork(
  seat: SeatWorktree,
  meta: BoundaryMeta,
  observed: TreeObservation = observeTree(seat.worktreePath),
): string | undefined {
  if (!observed.dirty) return undefined
  must(seat.worktreePath, ['add', '-A'])
  // Trailers rather than prose: the point is that `git log` alone attributes a commit to a
  // decision, and a reader grepping for a task id should not have to parse a sentence.
  const message =
    `conclave: ${seat.seatId} work for task ${meta.taskId}\n\n` +
    `Conclave-Task: ${meta.taskId}\n` +
    `Conclave-Task-Seq: ${meta.seq}\n` +
    `Conclave-Seat: ${seat.seatId}\n` +
    `Conclave-Advisor-Turn: ${meta.advisorTurn}\n` +
    turnEndTrailer(meta.turnEnd)
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
      // The merge itself checks nothing. `integrateSeat` is the whole boundary and it is
      // where the configured checks run; a caller reaching past it gets an honest empty list
      // rather than one that looks like a green result.
      checks: [],
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
 * What the boundary runs against the merged tree, and how long any one command gets.
 *
 * Plumbing rather than configuration: the caller passes the run's already-configured checks
 * (`RelayOptions.rotation.checks`). There is no second thing for an operator to set, which is
 * the whole point of #80's ruling -- a station nobody armed catches nothing.
 *
 * Absent or empty means the tree is not checked, which is a run with no checks configured at
 * all. Unchecked is not green; see `MergeResult.checks`.
 */
export interface IntegrationChecks {
  checks?: CheckSpec[] | undefined
  checkTimeoutMs?: number | undefined
}

/**
 * The whole boundary for one seat: commit, merge, check, and record what happened.
 *
 * The manifest is written on every path including the blocked one. It is what makes a crash
 * recoverable -- a directory on disk is not evidence of whose it is or what state it is in --
 * so a transition that happened and was not recorded is worse than one that did not happen.
 *
 * Checks run only after a merge that SUCCEEDED, and only when they are configured. A blocked
 * merge left the checkout exactly where it was, so checking it would be checking the previous
 * merge's result a second time and reporting the answer against this seat's task; and a
 * boundary that found nothing to merge left the integration checkout untouched, so there is
 * nothing about it that a check has not already answered. That is a statement about the
 * CHECKOUT, not about the seat: what the seat did or did not do is not established by one
 * `git status`, and `commitSeatWork` says why.
 */
export function integrateSeat(
  manifest: WorktreeManifest,
  seat: SeatWorktree,
  meta: BoundaryMeta,
  integration: IntegrationChecks = {},
): MergeResult {
  const repoRoot = manifest.integrationRoot
  // ONE reading, and it is the one everything below is built from: whether there was anything
  // to commit, and the instant `nothing_to_merge` is dated from. Passing it into
  // `commitSeatWork` rather than letting that function read again is the whole of it -- with
  // two readings, a tree that went clean in between would return `undefined` from the second
  // while this outcome carried the timestamp of the first, and the notice would report an
  // observation of "no changes" at an instant when the tree was full of them.
  const observed = observeTree(seat.worktreePath)
  const seatCommit = commitSeatWork(seat, meta, observed)

  // A read-only task on a seat that is already contained in the integration HEAD has nothing
  // to cross this boundary. Said as its own outcome rather than run through `git merge` for an
  // "Already up to date": a merge that did nothing and a merge that moved the tree must not
  // arrive at the caller as the same answer.
  const contained = run(repoRoot, ['merge-base', '--is-ancestor', seat.branch, 'HEAD']).ok
  if (seatCommit === undefined && contained) {
    writeManifest(manifest)
    return { status: 'nothing_to_merge', checkedAt: observed.at }
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
  //
  // Read ONCE, and the same value both decides and describes. `dirty()` followed by a separate
  // render was two readings: the branch could be taken on a tree that held work and the
  // sentence written from a tree that no longer did, producing "was still dirty ... nothing
  // else is uncommitted" -- a note contradicting itself inside one line.
  const after = treeState(seat.worktreePath)
  if (!after.readable) {
    // The same posture as `observeTree`. A tree this cannot see is not a tree it may reset.
    throw new Error(`git status --porcelain failed in ${seat.worktreePath} after the boundary commit`)
  }
  if (after.unclean.length > 0) {
    // Named, by the same renderer every other tree notice uses. "still dirty" was true and
    // useless: it is reported on the MERGED path, where everything else the operator reads
    // says the work went through, so a line that does not say what was left behind is a line
    // that reads as a formality.
    notes.push(
      `${seat.seatId} was still dirty after its boundary commit and is left on its own branch: ` +
        `${renderTreeState(after, seat.worktreePath)}`,
    )
  } else if (must(seat.worktreePath, ['rev-parse', 'HEAD']).trim() !== head) {
    const reset = run(seat.worktreePath, ['reset', '--hard', head])
    if (!reset.ok) notes.push(`${seat.seatId} could not be reset onto ${head}: ${reset.out}`)
  }

  writeManifest(manifest)
  // Last, and after the manifest: the checks can take as long as the project's test suite
  // takes, and a crash during them must not lose the record that the merge happened. What
  // they produce is a judgement about the tree, not a state transition -- the merge is in the
  // checkout either way -- so nothing above this line depends on their result.
  const checks =
    integration.checks && integration.checks.length > 0
      ? runIntegrationChecks(repoRoot, integration.checks, integration.checkTimeoutMs)
      : []
  return { ...result, notes, checks }
}
