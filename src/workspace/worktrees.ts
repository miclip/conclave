/**
 * A linked git worktree per implementer seat, and the manifest that makes one recoverable.
 *
 * Concurrent implementers do not share a working directory. Two sessions writing one checkout
 * produce a tree in which neither seat's diff is its own, and the repository cannot tell them
 * apart afterwards -- `worktreePaths` (`src/relay/subagents.ts`) says as much about subagents
 * and the limit is the same one. So each seat gets its own checkout, created before its
 * adapter is launched, and the integration checkout stays the operator's.
 *
 * In `src/workspace/` rather than `src/relay/` on purpose: this is a sibling of
 * `sessionLock.ts`, which already owns `.conclave/` state and already knows to exclude it from
 * `porcelain()`. The two have to agree about what is Conclave's own bookkeeping and what is
 * someone's work, and that agreement is cheapest when they are neighbours.
 *
 * ## N=1 never comes here
 *
 * One implementer works in the operator's cwd on the operator's branch, with no worktree, no
 * branch, no manifest and no merge -- the default run must not pay for an isolation it does
 * not need. `Relay.start` gates every call in this module on the seat count, and D1 makes that
 * a rule rather than an optimisation: the identity case is the absence of this file, not a
 * one-element pass through it.
 *
 * ## The posture, which is the same one the session lock takes
 *
 * Nothing here uses `--force`, and nothing runs `git worktree prune`. Both are broad
 * operations that cannot tell a live seat from stale bookkeeping: `prune` removes the record
 * of any worktree whose directory is merely missing, which on a network mount is a seat that
 * is working; `--force` removes a tree with uncommitted changes, which is the exact loss the
 * clean-base rule exists to prevent. Remove by exact recorded path, delete only branches git
 * already considers merged, and where the state is ambiguous, RETAIN and report. `guard()` in
 * `sessionLock.ts` set that precedent for a lock left by a dead pid -- tell the operator what
 * to run once they have accounted for the files, rather than clearing it for them.
 *
 * ## Codex in a linked worktree — observed, version-scoped
 *
 * A Codex seat in a linked worktree needs an EMPTY `.codex/` directory in the MAIN worktree,
 * or Codex loads no hooks there at all: no turn-completion signal, and preflight correctly
 * refuses the session. `installConfig` creates it when the resolved Codex project root differs
 * from the project root (`src/config/install.ts`), and the measurements behind that are
 * recorded at the same site: on Codex **0.146.0**, no `.codex` dir loaded 0 hooks, an empty
 * one loaded 5 sourced from the main worktree, and a linked `hooks.json` was still ignored in
 * favour of the main worktree's. The directory is a trigger whose contents do not matter.
 *
 * That is one CLI version's measured behaviour and not a documented protocol guarantee, and
 * every Codex-filled seat in this module depends on it. Re-measure on upgrade, and read a
 * preflight failure for a worktree-hosted Codex seat as pointing here first.
 *
 *   node --test src/workspace/worktrees.test.ts
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/**
 * How far a seat's work has got towards the integration checkout.
 *
 * Four states and no boolean, because "can this tree be removed" and "was this seat's work
 * integrated" are different questions with different answers, and a flag would let a reader
 * take one for the other.
 */
export type MergeState =
  /** Created, nothing merged yet. A seat that never ran ends here and is safe to remove. */
  | 'clean'
  /** Its work is in the integration checkout, and its branch is an ancestor of that HEAD. */
  | 'merged'
  /** A merge conflicted and was aborted. The work is intact on the seat branch; nothing else. */
  | 'merge_blocked'
  /** Cleanup looked at it and left it alone. Terminal, and the operator's to resolve. */
  | 'retained'

export interface SeatWorktree {
  /** The operator-supplied participant id, verbatim. What the routing log and report say. */
  seatId: string
  /** The sanitized id used in the path and the ref. Distinct from `seatId`; see `sanitize`. */
  slug: string
  /** Absolute, because recovery instructions are printed for a human in some other directory. */
  worktreePath: string
  branch: string
  /**
   * The integration HEAD this worktree was created from. Written once, never rewritten.
   *
   * An earlier version of this file moved it forward at every reset, on the argument that
   * recovery wants to know where the branch stands NOW. That reading is wrong and the field is
   * immutable for the reason the design record gives it this meaning: `baseSha` is the fixed
   * point a recovering operator diffs against, and a value that advances with the run cannot
   * answer "what did this seat start from" at all — after a reset it equals the integration
   * HEAD, so `baseSha..branch` shows nothing and a tree full of work reads as empty. Where the
   * branch stands now is a question git answers directly; where it started is only recorded
   * here.
   */
  readonly baseSha: string
  mergeState: MergeState
}

export interface WorktreeManifest {
  schema: number
  runId: string
  createdAt: number
  /** The checkout every seat merges into: the operator's cwd, never one of these trees. */
  integrationRoot: string
  seats: SeatWorktree[]
}

export const MANIFEST_SCHEMA = 1

/** Conclave's own bookkeeping, filtered out of the clean-base check for the reason below. */
const OWN_STATE = '.conclave/'

export function worktreesRoot(repoRoot: string, runId: string): string {
  return join(repoRoot, '.conclave', 'worktrees', runId)
}

export function manifestPath(repoRoot: string, runId: string): string {
  return join(worktreesRoot(repoRoot, runId), 'manifest.json')
}

/**
 * Where a seat worktree sits, and which run root owns it.
 *
 * `worktreePath` is the seat checkout itself -- the directory a command run inside the seat
 * resolves as its repository root. `integrationRoot` is the run root that actually holds the
 * rendered registrations, and is where a drift check is meaningful.
 */
export interface SeatWorktreeIdentity {
  worktreePath: string
  integrationRoot: string
  runId: string
  slug: string
  /** The operator-supplied id when the manifest is there to say so; the slug otherwise. */
  seatId: string
}

/**
 * The seat worktree a directory is inside, if it is inside one.
 *
 * `config check` is the caller this exists for. A seat is a LINKED checkout of the run root,
 * and the rendered registrations are generated and git-ignored -- so git never checks them
 * out into a seat, and a drift check run there reports the run root's registrations as
 * missing. That reading is accurate and useless: nothing in a seat is what an operator would
 * install, and every seat would fail a check the run root passes. The command answers
 * `not_applicable` instead, and this function is the fact it answers on.
 *
 * Recognised by LAYOUT plus the linked-worktree fact, not by the manifest. `createSeatWorktrees`
 * writes the manifest only after every tree exists, and cleanup can remove it while a tree is
 * retained, so a manifest read would answer "not a seat" during two windows in which the
 * directory unambiguously is one. The manifest is consulted only to recover the operator's
 * seat id, which is presentation.
 */
export function seatWorktreeAt(dir: string): SeatWorktreeIdentity | undefined {
  const parts = resolve(dir).split(sep)
  // The LAST occurrence: a run root that is itself inside some other run's worktrees tree
  // still has seats of its own, and the innermost pair is the one this directory belongs to.
  let at = -1
  for (let n = 0; n + 3 < parts.length; n++) {
    if (parts[n] === '.conclave' && parts[n + 1] === 'worktrees') at = n
  }
  if (at < 0) return undefined
  const runId = parts[at + 2]!
  const slug = parts[at + 3]!
  if (!runId || !slug) return undefined
  const integrationRoot = parts.slice(0, at).join(sep) || sep
  const worktreePath = parts.slice(0, at + 4).join(sep)
  // A linked worktree is exactly the case where `.git` is a FILE pointing into the main
  // worktree's admin directory. Without this check, a stale directory left under
  // `.conclave/worktrees/` -- or a project someone laid out this way -- would exempt itself
  // from a drift check it does need, which is the direction that hides a real problem.
  const dotGit = join(worktreePath, '.git')
  if (!existsSync(dotGit) || statSync(dotGit).isDirectory()) return undefined
  // And ASK GIT, rather than trusting the shape. A `.git` file is a pointer, and nothing above
  // reads it: a file holding arbitrary text passes every check so far, and so does a real linked
  // worktree of some entirely different repository that happens to sit at this path. Either one
  // would exempt itself from a drift check it does need -- the direction that hides a real
  // problem, and strictly worse than the false failure this exemption exists to stop.
  //
  // Two questions, because one is not enough. That git can resolve the directory at all rejects
  // the invented `.git`; that its common directory is the SAME repository the integration root
  // resolves to rejects the foreigner. A seat shares its repository with the run root by
  // construction -- `createSeatWorktrees` cuts it from there -- so a directory that does not is
  // not a seat, whatever it is called.
  const seatRepo = tryGit(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!seatRepo.ok) return undefined
  const rootRepo = tryGit(integrationRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!rootRepo.ok) return undefined
  if (resolve(seatRepo.out.trim()) !== resolve(rootRepo.out.trim())) return undefined
  const seat = readManifest(integrationRoot, runId)?.seats.find(
    (s) => resolve(s.worktreePath) === worktreePath,
  )
  return { worktreePath, integrationRoot, runId, slug, seatId: seat?.seatId ?? slug }
}

/**
 * Run git and give back its stdout, or throw with what git actually said.
 *
 * stderr is CAPTURED rather than discarded. `sessionLock.porcelain` discards it because its
 * caller has already decided the failure is fine; here every failure is either a refusal the
 * operator must be able to act on or a state this module has to classify, and a refusal whose
 * reason was thrown away is the thing being guarded against.
 */
function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string }
    const detail = (err.stderr || err.stdout || err.message || '').trim()
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${detail}`)
  }
}

/** The same, for a command whose failure is an answer rather than an error. */
function tryGit(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: git(cwd, args) }
  } catch (e) {
    return { ok: false, out: (e as Error).message }
  }
}

/** `git status --porcelain`, unfiltered and un-swallowed. One reader, so the rules agree. */
function porcelain(root: string): { code: string; path: string }[] {
  return parseStatus(git(root, ['status', '--porcelain', '--untracked-files=all']))
}

/** The parse alone, so the throwing reader and the best-effort one cannot disagree. */
function parseStatus(out: string): { code: string; path: string }[] {
  return out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => ({ code: l.slice(0, 2), path: l.slice(3) }))
}

export interface UncleanPath {
  /** The porcelain code, so a refusal can say `staged`, `modified` or `untracked`. */
  code: string
  path: string
  kind: 'staged' | 'modified' | 'untracked'
}

function classify(code: string): UncleanPath['kind'] {
  if (code === '??') return 'untracked'
  // Column one is the index, column two the worktree. Anything in column one has been staged,
  // which is a different thing for the operator to undo and worth naming as itself.
  return code[0] !== ' ' && code[0] !== '?' ? 'staged' : 'modified'
}

/**
 * What stands between this checkout and a concurrent start.
 *
 * Everything `git status` reports except `.conclave/`, which is Conclave's own state and is
 * already excluded from `porcelain()` in `sessionLock.ts` for the same reason -- the seat
 * worktrees themselves live there, so counting it would make the first run block the second.
 */
export function uncleanPaths(repoRoot: string): UncleanPath[] {
  return described(porcelain(repoRoot).filter((e) => !e.path.startsWith(OWN_STATE)))
}

/** The shared classify step, so both readers describe the same line the same way. */
function described(entries: { code: string; path: string }[]): UncleanPath[] {
  return entries.map((e) => ({ code: e.code, path: e.path, kind: classify(e.code) }))
}

/**
 * What a tree holds that is not committed, read now, without throwing.
 *
 * `uncleanPaths` is the version for a caller that is about to refuse a start: git failing
 * there IS the answer and an exception is the right shape for it. This one exists for the
 * callers that are already reporting a failure -- a kept worktree, an aborted merge, a
 * boundary that threw -- where a second exception would replace the diagnosis with its own.
 * `readable: false` is a distinct answer from "clean", and the notices keep it distinct.
 */
export interface TreeState {
  /** False when `git status` could not be run in the tree at all. */
  readable: boolean
  /** Empty when the tree is clean, and also when it could not be read. Check `readable`. */
  unclean: UncleanPath[]
}

export function treeState(worktreePath: string): TreeState {
  const r = tryGit(worktreePath, ['status', '--porcelain', '--untracked-files=all'])
  if (!r.ok) return { readable: false, unclean: [] }
  // Unfiltered, unlike `uncleanPaths`. That function drops `.conclave/` because a run must not
  // block the next one on its own bookkeeping; this one is reporting to an operator who is
  // about to decide whether a tree can go, and the retain rule below already keys off the raw
  // status. Describing a smaller set than the one that caused the retain would be the same
  // kind of untruth this whole change is removing.
  return { readable: true, unclean: described(parseStatus(r.out)) }
}

/** How many paths a notice names before it stops naming them. */
const NAMED = 10

/**
 * One clause about a seat's tree, for a notice that would otherwise assert its work is safe.
 *
 * Every kept-worktree and merge-conflict notice used to end in some form of "the work is
 * committed on its branch and nothing has been discarded". That sentence is a claim about a
 * tree NOBODY READ. A seat's boundary commit is a snapshot: the child is still alive and can
 * write after it, a merge that conflicts is aborted long after the commit, and `.gitignore`d
 * files are never in the commit at all. So an operator who was told "nothing has been
 * discarded" and then ran `git worktree remove --force` on the strength of it could lose real
 * work -- the notice would have been the reason they stopped looking.
 *
 * This reads the tree at the moment the notice is written and says what is actually in it.
 * A fragment rather than a sentence: it is appended after a semicolon at four call sites, and
 * one shared renderer is what stops those four from drifting apart.
 */
export function uncommittedClause(worktreePath: string): string {
  return renderTreeState(treeState(worktreePath), worktreePath)
}

/** The wording alone, for a caller that has already read the tree and must not read it twice. */
export function renderTreeState(state: TreeState, worktreePath: string): string {
  if (!state.readable) return `whether it still holds uncommitted work could not be read from ${worktreePath}`
  if (state.unclean.length === 0) return `nothing else in ${worktreePath} is uncommitted`
  const counts: string[] = []
  for (const kind of ['staged', 'modified', 'untracked'] as const) {
    const n = state.unclean.filter((u) => u.kind === kind).length
    if (n > 0) counts.push(`${n} ${kind}`)
  }
  const named = state.unclean.slice(0, NAMED).map((u) => u.path)
  const more = state.unclean.length > named.length ? `, and ${state.unclean.length - named.length} more` : ''
  return (
    `${worktreePath} ALSO holds uncommitted work that no commit and no merge carries: ` +
    `${counts.join(', ')} (${named.join(', ')}${more})`
  )
}

/**
 * Refuse a concurrent start on a dirty integration checkout, naming what is in the way.
 *
 * Not negotiable down to a warning, and untracked files block on exactly the same grounds as
 * modified ones. A linked worktree is created FROM A COMMIT and carries nothing uncommitted,
 * so starting anyway would silently give every seat a base that is not what the operator sees.
 * Each seat would then diff against the wrong parent, and the mismatch would surface at merge
 * time as conflicts attributed to the seats rather than to the launch.
 *
 * An earlier draft of the design proposed naming untracked files without blocking on them, so
 * that stray build output would not stop a run. That is wrong in a way worth recording: naming
 * a file and then omitting it produces the very divergence the rule exists to prevent, and the
 * message having mentioned it does not make the base match.
 */
export function requireCleanBase(repoRoot: string): void {
  const unclean = uncleanPaths(repoRoot)
  if (unclean.length === 0) return
  const shown = unclean.slice(0, 20).map((u) => `  ${u.kind.padEnd(9)} ${u.path}`)
  const more = unclean.length > shown.length ? [`  ... and ${unclean.length - shown.length} more`] : []
  throw new Error(
    [
      `refusing to start ${'concurrent implementers'} with uncommitted work in ${repoRoot}:`,
      ...shown,
      ...more,
      '',
      'Each seat works in a linked worktree created from a commit, so anything uncommitted here',
      'would be missing from every seat and would come back as conflicts blamed on the seats.',
      'Commit, stash, or gitignore the paths above and start again.',
    ].join('\n'),
  )
}

/**
 * One path or ref segment, made safe.
 *
 * Seat ids come from participant specs and are operator-supplied, so they can hold path
 * separators, spaces, `..`, or a leading dash. Unsanitized, that is a path traversal and an
 * invalid ref name at the same time. Lowercase, everything outside `[a-z0-9-]` collapsed to a
 * single `-`, trimmed of leading and trailing `-`.
 *
 * An id that sanitizes to nothing -- `..`, `///`, `   ` -- becomes `seat` rather than an empty
 * segment, because an empty segment would silently resolve to the parent directory.
 */
export function sanitize(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s === '' ? 'seat' : s
}

/**
 * Sanitized ids, one per input, with collisions broken deterministically.
 *
 * Sanitizing is lossy: `api/one` and `api one` are the same string afterwards, and two seats
 * sharing a path would have one silently check out over the other. The first occurrence keeps
 * the bare slug and each later one gets `-2`, `-3` in input order, so a given seat list always
 * produces the same layout.
 */
export function uniqueSlugs(ids: readonly string[]): Map<string, string> {
  const used = new Set<string>()
  const out = new Map<string, string>()
  for (const id of ids) {
    const base = sanitize(id)
    let slug = base
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`
    used.add(slug)
    out.set(id, slug)
  }
  return out
}

/**
 * A run id that is chronological, safe as a path segment, and not already on disk.
 *
 * The stamp shape is `sessionRecord.newSessionId`'s deliberately -- an operator looking at
 * `.conclave/worktrees/` and at `.conclave/sessions/` should be able to line them up by eye --
 * but it is generated here rather than imported, because a run may have no session record at
 * all and the worktree layout cannot depend on one existing.
 *
 * `existing` is consulted rather than assumed: the pid makes a collision impossible for one
 * process per second, and an embedder running two relays in one process is exactly the caller
 * that assumption is wrong for.
 */
export function newRunId(now: number, pid: number, existing: (id: string) => boolean = () => false): string {
  const d = new Date(now)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  const base = sanitize(`${stamp}-${pid}`)
  let id = base
  for (let n = 2; existing(id); n++) id = `${base}-${n}`
  return id
}

/** The run id a fresh run should use in this repository. */
export function nextRunId(repoRoot: string, now: number, pid: number): string {
  return newRunId(now, pid, (id) => existsSync(worktreesRoot(repoRoot, id)))
}

/**
 * Containment, checked rather than trusted.
 *
 * `sanitize` already makes traversal unrepresentable, so this can only fire if that function
 * is changed or bypassed -- which is the point. The cost of the check is a string compare and
 * the cost of missing it is `git worktree add` writing outside the repository.
 */
function containedPath(repoRoot: string, runId: string, slug: string): string {
  const root = resolve(worktreesRoot(repoRoot, runId))
  const path = resolve(root, slug)
  if (path !== root && !path.startsWith(root + sep)) {
    throw new Error(`refusing to create a seat worktree outside ${root}: ${path}`)
  }
  if (path === root) throw new Error(`a seat worktree path must be a child of ${root}`)
  return path
}

export function readManifest(repoRoot: string, runId: string): WorktreeManifest | undefined {
  const p = manifestPath(repoRoot, runId)
  if (!existsSync(p)) return undefined
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as WorktreeManifest
  } catch {
    // A manifest that cannot be parsed is not an absent one, but it is not something to act
    // on either. Reporting it as absent would make cleanup think there is nothing to retain.
    return undefined
  }
}

export function writeManifest(manifest: WorktreeManifest): void {
  const p = manifestPath(manifest.integrationRoot, manifest.runId)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `${JSON.stringify(manifest, null, 2)}\n`)
}

export interface CreateOptions {
  repoRoot: string
  runId: string
  /** Operator-supplied seat ids, in configured order. Sanitized here, never by the caller. */
  seatIds: readonly string[]
  now?: number
}

/**
 * Every seat's worktree, created before any adapter is launched.
 *
 * All of them, or none of them. An adapter's cwd is fixed at launch and a session started in
 * the integration checkout cannot be moved into a worktree afterwards, so a half-created
 * layout is not something the caller can proceed from -- it would either launch some seats
 * into the shared checkout or leave trees behind that no manifest names.
 *
 * The unwind is deliberately narrow: it removes only the trees THIS call created, only while
 * they are still clean, and without `--force`. Nothing here has run yet, so clean is the
 * expected state; anything else is reported and retained rather than deleted, because a tree
 * that became dirty between two lines of this function is a fact worth stopping on.
 */
export function createSeatWorktrees(opts: CreateOptions): WorktreeManifest {
  const { repoRoot, runId, seatIds } = opts
  if (seatIds.length === 0) throw new Error('createSeatWorktrees needs at least one seat')
  requireCleanBase(repoRoot)

  // One captured base for the whole run. Reading HEAD per seat would let a commit landing
  // mid-startup give two seats different parents, which is the divergence the clean-base rule
  // exists to prevent, arrived at from inside.
  const baseSha = git(repoRoot, ['rev-parse', 'HEAD']).trim()
  if (!/^[0-9a-f]{7,}$/.test(baseSha)) {
    throw new Error(`cannot create seat worktrees: ${repoRoot} has no commit to branch from`)
  }

  const slugs = uniqueSlugs(seatIds)
  const manifest: WorktreeManifest = {
    schema: MANIFEST_SCHEMA,
    runId,
    createdAt: opts.now ?? Date.now(),
    integrationRoot: resolve(repoRoot),
    seats: [],
  }

  try {
    for (const seatId of seatIds) {
      const slug = slugs.get(seatId)!
      const worktreePath = containedPath(repoRoot, runId, slug)
      const branch = `conclave/${runId}/${slug}`
      // `-b` creates the branch at the captured base. No `--force`: a branch or path that
      // already exists is a collision this run must not paper over.
      git(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, baseSha])
      manifest.seats.push({ seatId, slug, worktreePath, branch, baseSha, mergeState: 'clean' })
    }
  } catch (e) {
    const unwound = unwindSeatWorktrees(manifest)
    const stranded = unwound.retained.map((r) => `${r.seat.worktreePath} (${r.why})`)
    throw new Error(
      `failed to create seat worktrees: ${(e as Error).message}` +
        (stranded.length > 0 ? `\nleft in place, unwind by hand:\n  ${stranded.join('\n  ')}` : ''),
    )
  }

  writeManifest(manifest)
  return manifest
}

export interface RetainedSeat {
  seat: SeatWorktree
  /** One sentence, for an operator who has not read this file. */
  why: string
  /** Copy-pasteable. Inspect, merge, discard — in that order, and never run for them. */
  commands: string[]
}

export interface CleanupReport {
  /** Seat ids whose worktree and branch were removed. */
  removed: string[]
  retained: RetainedSeat[]
}

/** Whether git considers this branch already contained in the integration HEAD. */
function mergedIntoHead(repoRoot: string, branch: string): boolean {
  return tryGit(repoRoot, ['merge-base', '--is-ancestor', branch, 'HEAD']).ok
}

function recovery(repoRoot: string, seat: SeatWorktree): string[] {
  return [
    `inspect:  git -C ${seat.worktreePath} status && git -C ${repoRoot} log --oneline ${seat.baseSha}..${seat.branch}`,
    `merge:    git -C ${repoRoot} merge ${seat.branch}`,
    `discard:  git -C ${repoRoot} worktree remove ${seat.worktreePath} && git -C ${repoRoot} branch -D ${seat.branch}`,
  ]
}

/**
 * Why this tree cannot be removed, or `undefined` if it can.
 *
 * Every branch here is a reason to KEEP something. That asymmetry is the whole design: a
 * wrong retain costs an operator one command, and a wrong removal costs them work that only
 * existed in that tree.
 */
function blockedFrom(repoRoot: string, seat: SeatWorktree): string | undefined {
  if (seat.mergeState === 'merge_blocked') {
    // The tree is READ here rather than described from the manifest. `merge_blocked` records
    // what happened at the boundary; it says nothing about what the seat's child wrote in the
    // seconds after its boundary commit, and the sentence this used to return -- "the work is
    // committed on its branch and nothing has been discarded" -- was a claim about a tree
    // nobody had looked at since.
    return (
      'its merge conflicted and was aborted; what it committed is intact on its branch, and ' +
      uncommittedClause(seat.worktreePath)
    )
  }
  if (seat.mergeState === 'retained') return 'it was already retained by an earlier cleanup'
  if (!existsSync(seat.worktreePath)) {
    // NOT pruned. A missing directory is exactly the case `git worktree prune` gets wrong on a
    // network mount or a half-finished checkout, and the branch may still hold the only copy.
    return 'its directory is missing, which this cannot tell apart from a mount that is not there yet'
  }
  const state = treeState(seat.worktreePath)
  if (!state.readable) return 'its worktree could not be read, so whether it holds work is unknown'
  // Named, not counted. "it still holds uncommitted work" told an operator to go looking
  // without saying where, and a retained tree they cannot triage in one command is a tree
  // they eventually remove unexamined.
  if (state.unclean.length > 0) return renderTreeState(state, seat.worktreePath)
  if (!mergedIntoHead(repoRoot, seat.branch)) {
    return 'its branch holds commits the integration checkout does not have'
  }
  return undefined
}

/**
 * Remove one seat's worktree and branch, or say why it was kept.
 *
 * `git worktree remove` without `--force` refuses a dirty tree on its own, and `git branch -d`
 * without `-D` refuses an unmerged branch on its own. Both checks are made here first anyway:
 * the point is to retain and REPORT rather than to let a git error surface as a failed run,
 * and a caller reading `removed` must not have to wonder which of the two things happened.
 */
export function removeSeatWorktree(repoRoot: string, seat: SeatWorktree): RetainedSeat | undefined {
  const why = blockedFrom(repoRoot, seat)
  if (why !== undefined) {
    seat.mergeState = 'retained'
    return { seat, why, commands: recovery(repoRoot, seat) }
  }
  const removed = tryGit(repoRoot, ['worktree', 'remove', seat.worktreePath])
  if (!removed.ok) {
    seat.mergeState = 'retained'
    return { seat, why: `git declined to remove it: ${removed.out}`, commands: recovery(repoRoot, seat) }
  }
  // Only after the tree is gone, and only `-d`. A branch delete that failed here would leave a
  // ref nobody is checking out, which is recoverable; forcing it would not be.
  const deleted = tryGit(repoRoot, ['branch', '-d', seat.branch])
  if (!deleted.ok) {
    seat.mergeState = 'retained'
    return {
      seat,
      why: `its worktree was removed but git declined to delete the branch: ${deleted.out}`,
      commands: [`inspect:  git -C ${repoRoot} log --oneline ${seat.baseSha}..${seat.branch}`,
        `merge:    git -C ${repoRoot} merge ${seat.branch}`,
        `discard:  git -C ${repoRoot} branch -D ${seat.branch}`],
    }
  }
  seat.mergeState = 'merged'
  return undefined
}

/**
 * End-of-run cleanup: merged and clean trees go, everything else is reported and kept.
 *
 * The manifest is rewritten afterwards whatever happened, because the retained entries are the
 * account an operator recovers from and a manifest that still claims `clean` for a tree this
 * left behind would be worse than none.
 */
export function cleanupSeatWorktrees(manifest: WorktreeManifest): CleanupReport {
  const repoRoot = manifest.integrationRoot
  const report: CleanupReport = { removed: [], retained: [] }
  for (const seat of manifest.seats) {
    const retained = removeSeatWorktree(repoRoot, seat)
    if (retained) report.retained.push(retained)
    else report.removed.push(seat.seatId)
  }
  writeManifest(manifest)
  // The directory only goes when it is empty of trees AND nothing is retained -- the manifest
  // is the account, and deleting the account along with the last tree would leave a retained
  // seat from some other run with nothing pointing at it.
  if (report.retained.length === 0) {
    rmSync(worktreesRoot(repoRoot, manifest.runId), { recursive: true, force: true })
  }
  return report
}

/**
 * The startup unwind: remove what this run just created, keep anything that is not obviously
 * ours to remove, and report both.
 *
 * Separate from `cleanupSeatWorktrees` only in what it writes -- it does not rewrite a manifest
 * that was never persisted -- so the retain rules cannot drift between the two paths.
 */
export function unwindSeatWorktrees(manifest: WorktreeManifest): CleanupReport {
  const repoRoot = manifest.integrationRoot
  const report: CleanupReport = { removed: [], retained: [] }
  for (const seat of manifest.seats) {
    const retained = removeSeatWorktree(repoRoot, seat)
    if (retained) report.retained.push(retained)
    else report.removed.push(seat.seatId)
  }
  manifest.seats = manifest.seats.filter((s) => report.retained.some((r) => r.seat.seatId === s.seatId))
  return report
}

/** Every line an operator needs to deal with what was left behind. Empty when nothing was. */
export function recoveryLines(report: CleanupReport): string[] {
  if (report.retained.length === 0) return []
  const lines = [`${report.retained.length} seat worktree(s) were kept rather than removed:`]
  for (const r of report.retained) {
    lines.push(`  ${r.seat.seatId} — ${r.why}`)
    lines.push(`    branch ${r.seat.branch}`)
    lines.push(`    tree   ${r.seat.worktreePath}`)
    for (const c of r.commands) lines.push(`    ${c}`)
  }
  return lines
}

/**
 * The empty `.codex/` a linked worktree needs before a Codex seat is launched in it.
 *
 * OBSERVED, VERSION-SCOPED. On Codex **0.146.0**, measured from a linked worktree whose main
 * worktree had a valid sidecar (`src/config/install.ts` records the same run):
 *
 *   linked has no .codex directory   -> 0 hooks loaded
 *   linked has an EMPTY .codex dir   -> 5 hooks, sourced from the MAIN worktree
 *   linked has its own hooks.json    -> 5 hooks, still sourced from the main worktree
 *   main sidecar deleted             -> 0 hooks
 *
 * So the directory is a TRIGGER whose contents are ignored, and without it `codex` in a linked
 * worktree loads no hooks at all: no turn-completion signal, and preflight correctly refuses
 * the session with a diagnostic that names neither cause. That is one CLI version's measured
 * behaviour and not a documented protocol guarantee. Re-measure on upgrade; if a Codex seat in
 * a worktree fails preflight after one, look here first.
 *
 * Created for EVERY seat rather than only for Codex-filled ones. Asking "is this agent Codex"
 * here would be a copy of the registry's agent table in a module with no business holding one
 * -- the same argument `deadlines` makes against an `agent === 'kimi'` check in `relay.ts` --
 * and the cost of being wrong is an empty gitignored directory inside a tree this module
 * removes anyway. `installConfig` still owns the equivalent decision for real checkouts.
 */
export function ensureWorktreeHookTrigger(seat: SeatWorktree): void {
  mkdirSync(join(seat.worktreePath, '.codex'), { recursive: true })
}

/** Absolute, and asserted so a caller cannot hand a relative path to an adapter's cwd. */
export function seatCwd(seat: SeatWorktree): string {
  if (!isAbsolute(seat.worktreePath)) {
    throw new Error(`seat worktree path must be absolute: ${seat.worktreePath}`)
  }
  return seat.worktreePath
}
