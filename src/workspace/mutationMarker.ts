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
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
 * A marker for the requested path exists and does not parse.
 *
 * Thrown rather than returned, and from one place, so `begin`, `end` and `restore` fail in the
 * same words. Before this each verb hit its own bare `JSON.parse`, and the CLI printed only the
 * parser's message ("Expected property name or '}' in JSON at position 1") -- naming neither the
 * marker nor the file it guards, over a tree that still holds the only copy of the original.
 *
 * None of the verbs can act safely on it: the marker is the sole record of the original's hash,
 * so it is never rewritten or removed here, and the operator is pointed at it and at its `.orig`
 * instead.
 */
export class UnreadableMarkerError extends Error {
  /** Repo-relative, as every other path this module reports. */
  readonly markerFile: string
  /** The path the caller asked about. */
  readonly path: string

  constructor(markerFile: string, path: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(
      `the marker for ${path} cannot be read: ${markerFile} (${detail}) — nothing was changed\n` +
        `  inspect ${markerFile} and its sibling ${markerFile.replace(/\.json$/, '.orig')}, and recover or repair them by hand`,
      { cause },
    )
    this.name = 'UnreadableMarkerError'
    this.markerFile = markerFile
    this.path = path
  }
}

/** Read the marker at `mp`, which guards `rel`. The one parse every verb goes through. */
function readMarker(repoRoot: string, mp: string, rel: string): MutationMarker {
  const text = readFileSync(mp, 'utf8')
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new UnreadableMarkerError(relative(repoRoot, mp), rel, err)
  }
}

/**
 * What `begin` did. Refusal is its own shape, as with `EndResult`, because "recorded" and "an
 * original is already on record" are answers a caller has to act on differently.
 *
 * #390: `begin` used to copy and rewrite unconditionally, so a second `begin` over an
 * outstanding marker replaced the stored original with the file on disk -- the previous mutant.
 * From then on `restore` put the mutant back and reported success, and `end` accepted it as
 * the baseline. The refusal carries the marker that is already there, and where it is, because
 * it holds the only hash of the true original and the caller needs it to choose a remedy.
 */
export type BeginResult =
  | { begun: true; marker: MutationMarker }
  | { begun: false; reason: 'outstanding'; existing: MutationMarker; markerFile: string }
  | { begun: false; reason: 'orphaned-backup'; path: string; backup: string }

/**
 * Record that `filePath` is about to be mutated, keeping a copy of what it is now.
 *
 * Call this BEFORE writing the mutation. Called after, it records the broken file as the
 * original and the marker becomes a lie -- so the ordering is the one thing a caller must get
 * right, and `end` cannot detect that mistake.
 *
 * A path that already has a marker is refused, and the check comes before anything is created
 * or copied. It lives here rather than in the CLI so that every caller is protected: whatever
 * is on disk while a marker is outstanding may be a mutant, and re-beginning is never a valid
 * way to take a new baseline while the old one is unresolved. A stale marker (file already
 * back) is refused too; `end` clears it in one step, and telling the two apart here would mean
 * hashing a file this function is about to trust anyway.
 *
 * A stored original with NO marker is refused as well (`orphaned-backup`), and the backup is
 * copied write-once to enforce it. Deleting the marker by hand -- someone tidying `.conclave`,
 * or acting on a marker they took to be stale -- used to leave the `.orig` behind, and the next
 * `begin` copied whatever was on disk over it: #390 again, through the marker's absence rather
 * than its presence.
 *
 * The ordinary case -- an orphan already sitting there -- is caught by looking for it BEFORE the
 * marker is claimed, so the refusal writes nothing at all. The write-once copy after the claim
 * is only the backstop for a backup that appears between that look and the copy; there the
 * claimed marker is withdrawn again.
 *
 * Adopting the orphan instead -- rebuilding a marker around it -- was considered and rejected.
 * Nothing records where an orphaned `.orig` came from: it may be the true original, or a
 * mutant copied in by an earlier version of this bug, and its own hash is no evidence either
 * way. A rebuilt marker would authorize `restore` to overwrite the working file with bytes
 * merely ASSUMED to be original, and would report that as a verified restore. Only a person
 * can reconcile the two files, so both are left exactly as they are and the caller is told.
 */
export function begin(
  repoRoot: string,
  filePath: string,
  opts: { note?: string | undefined } = {},
): BeginResult {
  const abs = resolve(repoRoot, filePath)
  const rel = relative(repoRoot, abs)
  const mp = markerPathFor(repoRoot, rel)
  const dir = mutationsDir(repoRoot)
  mkdirSync(dir, { recursive: true })
  const backupRel = join(MUTATIONS_RELATIVE, `${createHash('sha256').update(rel).digest('hex').slice(0, 16)}.orig`)
  const backupAbs = join(repoRoot, backupRel)
  const marker: MutationMarker = {
    path: rel,
    sha256: sha256Of(abs),
    backup: backupRel,
    pid: process.pid,
    startedAt: Date.now(),
    ...(opts.note === undefined ? {} : { note: opts.note }),
  }
  // The early look for an orphan. Not the guard on its own -- see the EXCL copy below -- but the
  // path every real orphan takes, and the one that leaves no transient marker behind. A backup
  // WITH its marker is not an orphan, and falls through to the claim's refusal below, which
  // also reads that marker -- so a corrupt one is reported as corrupt rather than as missing.
  if (existsSync(backupAbs) && !existsSync(mp)) return { begun: false, reason: 'orphaned-backup', path: rel, backup: backupRel }
  // The marker is CLAIMED atomically, with `wx`, and claimed BEFORE the backup is copied.
  // `existsSync` then `writeFileSync` is check-then-act: two `begin` calls racing on one path
  // could both pass the check, and the loser would have already overwritten the `.orig` by the
  // time the marker write told it so -- which is #390 again, narrower. `wx` makes the marker
  // itself the lock, so exactly one caller proceeds to the copy.
  try {
    writeFileSync(mp, JSON.stringify(marker, null, 2), { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    return {
      begun: false,
      reason: 'outstanding',
      existing: readMarker(repoRoot, mp, rel),
      markerFile: relative(repoRoot, mp),
    }
  }
  // After the claim, so a lost race cannot touch a backup it does not own. A crash between the
  // two leaves a marker with no stored original, which `restore` already reports as its own
  // `no-backup` answer rather than as a restore (#363).
  //
  // EXCL, the backstop: a `.orig` that appeared since the early look is an orphan of unknown
  // provenance just the same (see above) and must not be overwritten. The marker this call just
  // claimed is withdrawn, so the refusal leaves the directory as it found it.
  mkdirSync(dirname(backupAbs), { recursive: true })
  try {
    copyFileSync(abs, backupAbs, constants.COPYFILE_EXCL)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    rmSync(mp, { force: true })
    return { begun: false, reason: 'orphaned-backup', path: rel, backup: backupRel }
  }
  return { begun: true, marker }
}

/**
 * What `end` found. The three cases are different answers and must not print the same.
 *
 * `checked: false` means there was no marker, so NOTHING was compared. #343 was this case being
 * returned as a verified restore: `begin`, mutate, `restore`, mutate AGAIN without a new
 * `begin`, then `end` -- which found no marker, said "back to its original", and exited 0 over
 * a file still holding the second mutation. "Nothing to check" and "checked and correct" have
 * to be distinguishable by the caller, so the absence is its own shape rather than a
 * `restored: true` with empty hashes.
 */
export type EndResult =
  | { checked: false }
  | { checked: true; restored: boolean; expected: string; actual: string }

/**
 * Close the marker for `filePath`, reporting whether the file really is back to its original.
 *
 * The verification is the point, and it is why this returns a result rather than throwing. A
 * caller that restored from its own copy and got it wrong wants to be TOLD, with both hashes,
 * not to have the marker silently removed as though the restore had been checked.
 */
export function end(repoRoot: string, filePath: string): EndResult {
  const abs = resolve(repoRoot, filePath)
  const rel = relative(repoRoot, abs)
  const mp = markerPathFor(repoRoot, rel)
  if (!existsSync(mp)) return { checked: false }
  const marker = readMarker(repoRoot, mp, rel)
  const actual = existsSync(abs) ? sha256Of(abs) : ''
  const restored = actual === marker.sha256
  // The marker is cleared only when the file is genuinely back. A failed restore that removed
  // its own evidence would leave exactly the state this module exists to make visible.
  if (restored) {
    rmSync(mp, { force: true })
    rmSync(join(repoRoot, marker.backup), { force: true })
  }
  return { checked: true, restored, expected: marker.sha256, actual }
}

/**
 * What `restore` found. The same shape as `EndResult`, and that is the point.
 *
 * #363: `restore` cleared the marker without ever checking the file it had just written, so
 * the only way to learn whether the tree was really back was to run `end` afterwards -- which
 * by then had no marker left and answered "nothing was checked" over a tree that was fine.
 * "restore, then verify" is the natural thing to script, and it read as a failed restore.
 *
 * Two verbs that both put a question to the same hash should answer it in the same words, so
 * the results they return are the same shape. `checked: false` carries a reason because the
 * two ways `restore` can decline -- no marker, or a marker whose backup is gone -- are
 * different situations for whoever is reading, and a single "no marker" for both was a lie in
 * the second case.
 */
export type RestoreResult =
  | { checked: false; reason: 'no-marker' | 'no-backup' }
  | { checked: true; restored: boolean; expected: string; actual: string }

/**
 * Put the original back from the stored copy, verify it, then clear the marker.
 *
 * The verification is not ceremony. The stored copy is an ordinary file in an ordinary
 * directory: it can be truncated by the same full volume that motivated all of this, edited by
 * someone tidying `.conclave`, or written short by a crash mid-`begin`. A `restore` from a
 * damaged backup leaves a file that is neither the mutation nor the original, and clearing the
 * marker at that moment destroys the only record of what it should have been.
 *
 * So the rule is `end`'s rule, for `end`'s reason: the marker and the backup are cleared ONLY
 * when the file on disk hashes to what `begin` recorded. On a mismatch both are kept, because
 * the backup is now the evidence -- it is the thing that did not restore, and deleting it
 * would leave a broken file and nothing to compare it against.
 *
 * Clearing the marker on success is still what leaves a later `begin`-less mutation
 * unprotected (#343's second half); that is unchanged, and #343 fixed the reporting for it.
 */
export function restore(repoRoot: string, filePath: string): RestoreResult {
  const abs = resolve(repoRoot, filePath)
  const rel = relative(repoRoot, abs)
  const mp = markerPathFor(repoRoot, rel)
  if (!existsSync(mp)) return { checked: false, reason: 'no-marker' }
  const marker = readMarker(repoRoot, mp, rel)
  const backupAbs = join(repoRoot, marker.backup)
  if (!existsSync(backupAbs)) return { checked: false, reason: 'no-backup' }
  copyFileSync(backupAbs, abs)
  const actual = existsSync(abs) ? sha256Of(abs) : ''
  const restored = actual === marker.sha256
  if (restored) {
    rmSync(mp, { force: true })
    rmSync(backupAbs, { force: true })
  }
  return { checked: true, restored, expected: marker.sha256, actual }
}

/** A marker file that exists and says nothing usable. Named, because a count cannot be inspected. */
export interface UnreadableMarker {
  /** Repo-relative, as every other path this module reports. */
  markerFile: string
  /** Why it was set aside: the parser's message, or the field that is missing. */
  problem: string
}

/**
 * "1 mutation marker could not be read" / "3 mutation markers could not be read", and whose file.
 * Shared so the listing and the pre-run warning count the same thing in the same words.
 */
export function unreadableMarkersPhrase(n: number): { counted: string; guarded: string } {
  return n === 1
    ? { counted: '1 mutation marker could not be read', guarded: 'the file it guards' }
    : { counted: `${n} mutation markers could not be read`, guarded: 'the file each guards' }
}

/**
 * Everything `outstanding` found, the markers it could NOT read included.
 *
 * An object rather than the array it used to be, because the array was a lossy answer: a
 * corrupt marker was dropped on the floor, so a tree whose only marker was unreadable listed as
 * "no mutations are recorded" -- a clean claim over a file that may be broken, from the one
 * command whose job is to say so. The marker could be guarding anything, so its existence is
 * the report even when its contents are not.
 */
export interface OutstandingReport {
  /** Sorted by path. */
  mutations: OutstandingMutation[]
  /** Sorted by marker file. */
  unreadable: UnreadableMarker[]
}

/**
 * Every marker in the tree, with what is currently true of the file it names.
 *
 * Unreadable markers are reported rather than thrown on. This is called from a preflight, and
 * a corrupt file in the bookkeeping directory must not be able to stop a run from starting --
 * that would make the guard a bigger hazard than the thing it guards against. Not throwing is
 * not the same as not telling, though: each one is named in `unreadable`.
 */
export function outstanding(repoRoot: string): OutstandingReport {
  const dir = mutationsDir(repoRoot)
  if (!existsSync(dir)) return { mutations: [], unreadable: [] }
  const mutations: OutstandingMutation[] = []
  const unreadable: UnreadableMarker[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const markerFile = join(MUTATIONS_RELATIVE, name)
    let marker: MutationMarker
    try {
      marker = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch (err) {
      unreadable.push({ markerFile, problem: err instanceof Error ? err.message : String(err) })
      continue
    }
    // `null`, a number, an array: valid JSON, and no marker. Read as "every field missing".
    const fields = (marker ?? {}) as unknown as Record<string, unknown>
    const missing = ['path', 'sha256'].filter((k) => typeof fields[k] !== 'string')
    if (missing.length > 0) {
      unreadable.push({ markerFile, problem: `no string ${missing.join(' or ')}` })
      continue
    }
    const abs = join(repoRoot, marker.path)
    let dirty = false
    try {
      dirty = !existsSync(abs) || sha256Of(abs) !== marker.sha256
    } catch {
      dirty = true
    }
    mutations.push({ marker, dirty })
  }
  return {
    mutations: mutations.sort((a, b) => a.marker.path.localeCompare(b.marker.path)),
    unreadable: unreadable.sort((a, b) => a.markerFile.localeCompare(b.markerFile)),
  }
}
