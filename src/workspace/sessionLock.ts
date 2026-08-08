/**
 * A record that participant sessions are live, and what the tree looked like before they
 * started.
 *
 * This exists because of a specific failure. During a relay run the orchestrator ran
 * `git add -A` and swept ~600 lines of a live implementer's work into two commits about
 * something else. That is the shared-workspace hazard the brief records in §5c — walked
 * into by the operator, not by either agent. The advisor is launched read-only; nothing
 * constrained the human.
 *
 * A rule that lives only in prose is a rule the person who wrote it breaks. So: the tree
 * state is recorded at session start, and Conclave's own tooling refuses broad staging
 * while participants are live.
 *
 * Deliberately NOT a git hook. A hook would also block the implementer from committing
 * its own work, which is legitimate — and possibly necessary, since an advisor in a
 * separate worktree can only see committed state. The guard belongs on the operator's
 * path, not on everyone's.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface LockedParticipant {
  id: string
  agent: string
}

export interface LiveSession {
  /** The orchestrator process. Used to detect a lock left behind by a crash. */
  pid: number
  startedAt: number
  participants: LockedParticipant[]
  /** `git status --porcelain` at session start: what was already dirty before them. */
  treeAtStart: string[]
}

export const LOCK_RELATIVE = '.conclave/session.lock'

export function lockPath(repoRoot: string): string {
  return join(repoRoot, LOCK_RELATIVE)
}

/** Conclave's own bookkeeping directory, which must never be reported as anyone's work. */
const OWN_STATE = '.conclave/'

function porcelain(repoRoot: string): string[] {
  try {
    // stderr discarded, not inherited. Outside a repository git writes `fatal: not a git
    // repository` straight to the operator's terminal, and the `catch` below has already
    // decided that case is fine — so the only thing the message did was print an alarming
    // line, unattributed and mid-banner, for a condition being handled.
    return execFileSync('git', ['status', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter((l) => l.trim())
      // The lock lives inside the repository, so acquiring one dirties the tree. Without
      // this the guard reports itself as a participant edit in any checkout that has not
      // gitignored .conclave/ -- which is every checkout on its first run.
      .filter((l) => !l.slice(3).startsWith(OWN_STATE))
  } catch {
    return []
  }
}

export function acquire(repoRoot: string, participants: LockedParticipant[]): LiveSession {
  const lock: LiveSession = {
    pid: process.pid,
    startedAt: Date.now(),
    participants,
    treeAtStart: porcelain(repoRoot),
  }
  const p = lockPath(repoRoot)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(lock, null, 2))
  return lock
}

export function release(repoRoot: string): void {
  rmSync(lockPath(repoRoot), { force: true })
}

/**
 * Read the lock, treating one left by a dead process as absent.
 *
 * This matters more than it looks: the run that motivated all of this ended by *crashing*,
 * and a crash-proof guard that refuses forever after a crash would be abandoned within a
 * day. A stale lock is reported so it can be explained, not obeyed.
 */
export function read(repoRoot: string): { session: LiveSession; stale: boolean } | undefined {
  const p = lockPath(repoRoot)
  if (!existsSync(p)) return undefined
  let session: LiveSession
  try {
    session = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return undefined
  }
  let alive = false
  try {
    process.kill(session.pid, 0)
    alive = true
  } catch {
    alive = false
  }
  return { session, stale: !alive }
}

export interface GuardReport {
  live: boolean
  stale: boolean
  session?: LiveSession
  /** Paths dirty now that were clean when the session started. */
  changedSinceStart: string[]
  messages: string[]
}

/**
 * The report as JSON, for a caller that parses the guard rather than reads it.
 *
 * The mirror of `formatInstallResultJson`: same information as the prose, JSON on stdout,
 * exit code untouched. Every field of the report is emitted rather than a hand-picked
 * subset, so a consumer gating on the guard sees what the prose reader sees — including
 * `session`, which names who is live and when they started. `session` is simply absent
 * when there is no lock; `live: false, stale: false` is the machine-readable form of the
 * prose "no participant sessions are live".
 */
export function formatGuardReportJson(r: GuardReport): string {
  return JSON.stringify(r, null, 2)
}

export function guard(repoRoot: string): GuardReport {
  const found = read(repoRoot)
  if (!found) {
    return { live: false, stale: false, changedSinceStart: [], messages: [] }
  }

  const before = new Set(found.session.treeAtStart.map((l) => l.slice(3)))
  const changedSinceStart = porcelain(repoRoot)
    .map((l) => l.slice(3))
    .filter((path) => !before.has(path))

  const messages: string[] = []
  if (found.stale) {
    messages.push(
      `a session lock from pid ${found.session.pid} is present but that process is gone — ` +
        `likely a crashed run. Remove ${LOCK_RELATIVE} once you have accounted for the files below.`,
    )
  } else {
    messages.push(
      `participants are live: ${found.session.participants.map((p) => `${p.id} (${p.agent})`).join(', ')}`,
    )
  }
  if (changedSinceStart.length > 0) {
    // Named as a SNAPSHOT, because that is the honest description and the thing a reader
    // gets wrong. This is `git status --porcelain` at the instant guard ran, minus what was
    // already dirty at session start — so it is a diff, not a record of writes.
    //
    // Reported live: guard listed a file that a `git status` moments later did not. The
    // natural conclusion is that one of them is wrong. Neither is: the participant reverted
    // or finished the file in between, and a tree with agents working in it moves between
    // any two commands. Saying "when this ran" is what makes the two accounts reconcilable
    // instead of contradictory.
    messages.push(
      `${changedSinceStart.length} path(s) dirty when this ran, beyond what was already ` +
        `dirty at session start, and may be a participant's work in progress:\n  ` +
        `${changedSinceStart.join('\n  ')}`,
    )
    if (!found.stale) {
      messages.push(
        `this is a snapshot — participants are live, so \`git status\` a moment later can ` +
          `legitimately differ`,
      )
    }
  }

  return {
    live: !found.stale,
    stale: found.stale,
    session: found.session,
    changedSinceStart,
    messages,
  }
}

/**
 * Throw rather than stage broadly while participants are live.
 *
 * Only ever called from Conclave's own tooling. A live participant's edits are
 * indistinguishable from the operator's at the filesystem level, which is exactly why
 * `git add -A` was able to do what it did.
 */
export function assertSafeToStage(repoRoot: string): void {
  const report = guard(repoRoot)
  if (!report.live) return
  throw new Error(
    `refusing a broad workspace mutation while participants are live.\n  ${report.messages.join('\n  ')}\n` +
      `  Stage explicitly, or stop the session first.`,
  )
}
