/**
 * A durable record that a file is deliberately broken right now.
 *
 * Mutation testing is load-bearing here. `docs/NOTES.md` ("Mutation evidence") records it as a
 * table of removed / fails / on, and states the discipline: every control restored
 * byte-for-byte, verified by sha256. The discipline is right. What it had no answer for is a
 * crash between the two halves.
 *
 * #180's run died on a full volume holding a mutation, and the tree it left behind had a fix
 * REVERTED in it -- a diff that looked exactly like work in progress. Recovering meant first
 * working out that a plausible uncommitted change was an artifact, and `git diff` cannot tell
 * you that.
 *
 * ## What this is for, and what it is not
 *
 * It answers one question: is a file in this tree deliberately broken and unrestored? The
 * value is in DETECTING that, not in preventing it -- a marker cannot stop a crash, it can
 * only make the wreckage legible afterwards.
 *
 * So an orphan is REPORTED, never obeyed. `sessionLock.read` learned this the hard way and
 * says it best: the run that motivated all of this ended by crashing, and a crash-proof guard
 * that refuses forever after a crash would be abandoned within a day. A marker that blocked
 * work would be deleted by the first person it inconvenienced, and then it guards nothing.
 *
 * ## Why the original is copied and not just hashed
 *
 * A hash proves a restore was correct. It cannot perform one. The copy is what makes the
 * report actionable: "this file is mutated" plus "here is what it was" is a fix, and the first
 * half alone is a puzzle. Storing both is a few kilobytes against losing an afternoon.
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export const MUTATIONS_RELATIVE = '.conclave/mutations'

export interface MutationMarker {
  /** Repo-relative, so a marker survives the tree being moved or checked out elsewhere. */
  path: string
  /** sha256 of the file as it was BEFORE the mutation. The restore is checked against this. */
  sha256: string
  /** Where the original is kept. Repo-relative, for the same reason as `path`. */
  backup: string
  /**
   * Which process opened it. Kept for forensics -- whose run left this -- and deliberately NOT
   * used to infer whether the mutation is "in flight". Through the CLI the process that writes
   * a marker has always exited by the time anything reads it, so a liveness check would label
   * every marker orphaned and the word would stop meaning anything.
   */
  pid: number
  startedAt: number
  /** What the mutation was for. Free text, and the thing a stranger reads first. */
  note?: string | undefined
}

/** A marker plus what is true of the file NOW, which is the part a reader acts on. */
export interface OutstandingMutation {
  marker: MutationMarker
  /**
   * Whether the file currently differs from the original the marker recorded.
   *
   * The distinction the whole report turns on. A marker whose file already matches is merely
   * STALE -- the restore happened and the marker outlived it, which is untidy and harmless. A
   * marker whose file differs means the tree is holding a deliberate defect right now, and
   * that is the case worth interrupting someone for.
   */
  dirty: boolean
}

export function mutationsDir(repoRoot: string): string {
  return join(repoRoot, MUTATIONS_RELATIVE)
}

function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** One marker file per mutated path, named by the hash of the path so it is stable and flat. */
function markerPathFor(repoRoot: string, relPath: string): string {
  return join(mutationsDir(repoRoot), `${createHash('sha256').update(relPath).digest('hex').slice(0, 16)}.json`)
}

/**
 * Record that `filePath` is about to be mutated, keeping a copy of what it is now.
 *
 * Call this BEFORE writing the mutation. Called after, it records the broken file as the
 * original and the marker becomes a lie -- so the ordering is the one thing a caller must get
 * right, and `end` cannot detect that mistake.
 */
export function begin(
  repoRoot: string,
  filePath: string,
  opts: { note?: string | undefined } = {},
): MutationMarker {
  const abs = resolve(repoRoot, filePath)
  const rel = relative(repoRoot, abs)
  const dir = mutationsDir(repoRoot)
  mkdirSync(dir, { recursive: true })
  const backupRel = join(MUTATIONS_RELATIVE, `${createHash('sha256').update(rel).digest('hex').slice(0, 16)}.orig`)
  const backupAbs = join(repoRoot, backupRel)
  mkdirSync(dirname(backupAbs), { recursive: true })
  copyFileSync(abs, backupAbs)
  const marker: MutationMarker = {
    path: rel,
    sha256: sha256Of(abs),
    backup: backupRel,
    pid: process.pid,
    startedAt: Date.now(),
    ...(opts.note === undefined ? {} : { note: opts.note }),
  }
  writeFileSync(markerPathFor(repoRoot, rel), JSON.stringify(marker, null, 2))
  return marker
}

/**
 * Close the marker for `filePath`, reporting whether the file really is back to its original.
 *
 * The verification is the point, and it is why this returns a result rather than throwing. A
 * caller that restored from its own copy and got it wrong wants to be TOLD, with both hashes,
 * not to have the marker silently removed as though the restore had been checked.
 */
export function end(repoRoot: string, filePath: string): { restored: boolean; expected: string; actual: string } {
  const abs = resolve(repoRoot, filePath)
  const rel = relative(repoRoot, abs)
  const mp = markerPathFor(repoRoot, rel)
  if (!existsSync(mp)) return { restored: true, expected: '', actual: '' }
  const marker: MutationMarker = JSON.parse(readFileSync(mp, 'utf8'))
  const actual = existsSync(abs) ? sha256Of(abs) : ''
  const restored = actual === marker.sha256
  // The marker is cleared only when the file is genuinely back. A failed restore that removed
  // its own evidence would leave exactly the state this module exists to make visible.
  if (restored) {
    rmSync(mp, { force: true })
    rmSync(join(repoRoot, marker.backup), { force: true })
  }
  return { restored, expected: marker.sha256, actual }
}

/** Put the original back from the stored copy, then clear the marker. */
export function restore(repoRoot: string, filePath: string): boolean {
  const abs = resolve(repoRoot, filePath)
  const rel = relative(repoRoot, abs)
  const mp = markerPathFor(repoRoot, rel)
  if (!existsSync(mp)) return false
  const marker: MutationMarker = JSON.parse(readFileSync(mp, 'utf8'))
  const backupAbs = join(repoRoot, marker.backup)
  if (!existsSync(backupAbs)) return false
  copyFileSync(backupAbs, abs)
  rmSync(mp, { force: true })
  rmSync(backupAbs, { force: true })
  return true
}

/**
 * Every marker in the tree, with what is currently true of the file it names.
 *
 * Unreadable markers are skipped rather than thrown on. This is called from a preflight, and a
 * corrupt file in the bookkeeping directory must not be able to stop a run from starting --
 * that would make the guard a bigger hazard than the thing it guards against.
 */
export function outstanding(repoRoot: string): OutstandingMutation[] {
  const dir = mutationsDir(repoRoot)
  if (!existsSync(dir)) return []
  const out: OutstandingMutation[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    let marker: MutationMarker
    try {
      marker = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (typeof marker.path !== 'string' || typeof marker.sha256 !== 'string') continue
    } catch {
      continue
    }
    const abs = join(repoRoot, marker.path)
    let dirty = false
    try {
      dirty = !existsSync(abs) || sha256Of(abs) !== marker.sha256
    } catch {
      dirty = true
    }
    out.push({ marker, dirty })
  }
  return out.sort((a, b) => a.marker.path.localeCompare(b.marker.path))
}
