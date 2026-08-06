/**
 * The mechanical half of a handoff.
 *
 * §7a says a replacement proves it can continue rather than saying so. Proof needs
 * something to compare against, and that something cannot be prose: the advisor writes
 * the narrative, but "the tests pass" from a model is a claim, and this file is where the
 * claim gets a checkable counterpart.
 *
 * So the record is captured by the orchestrator, at the moment the old session is
 * quiesced, and re-captured at acceptance. It carries HEAD, the working tree, digests of
 * the files the handoff names, and the exit status of the verification commands. The
 * authority table is the reason for the split — the arbiter owns checkable facts, and
 * neither participant is asked to vouch for these.
 *
 * Divergences are graded rather than boolean. An exit code that changed means the
 * repository no longer does what was recorded and the transfer must not proceed. Output
 * that differs while the exit code holds usually means a timing line moved, and treating
 * that as failure would make rotation refuse to work for no reason — so it is reported,
 * caveated, and left to the caller.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface CheckResult {
  command: string
  /** `null` when the command could not be launched at all. */
  exitCode: number | null
  /** Digest of normalized output. A weak signal on purpose — see `normalize`. */
  outputDigest: string
  /** Kept for the record, never compared: it is expected to differ every run. */
  durationMs: number
}

export interface FileState {
  path: string
  /** `null` means the file was absent, which is itself a fact worth recording. */
  digest: string | null
}

export interface RepoRecord {
  root: string
  head: string | undefined
  branch: string | undefined
  /** `git status --porcelain`, minus Conclave's own bookkeeping. */
  dirty: string[]
  files: FileState[]
  checks: CheckResult[]
  at: number
}

export type DivergenceSeverity =
  /** The recorded state is not reproducible. A transfer must not be accepted on this. */
  | 'blocking'
  /** Real, reported, and not sufficient on its own to refuse — the caller decides. */
  | 'advisory'

export interface Divergence {
  severity: DivergenceSeverity
  kind:
    | 'head_moved'
    | 'file_changed'
    | 'file_appeared'
    | 'file_vanished'
    | 'check_exit_changed'
    | 'check_missing'
    | 'check_output_changed'
    | 'tree_changed'
  detail: string
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * Strip what is expected to differ between two runs of the same command.
 *
 * Deliberately conservative. Over-normalizing would let a genuinely different result
 * digest identically, which is the failure this whole file exists to catch; the digest is
 * graded advisory precisely because this cannot be made exact.
 */
function normalize(output: string): string {
  return output
    // ANSI, which both CLIs emit and neither guarantees stable.
    .replace(/\[[0-9;?]*[A-Za-z]/g, '')
    // Durations: `(1234ms)`, `123.45ms`, `duration_ms 12`.
    .replace(/\d+(\.\d+)?\s*ms\b/g, '<ms>')
    .replace(/duration_ms[:\s]+\d+(\.\d+)?/g, 'duration_ms <ms>')
    // Absolute paths, which differ between checkouts and worktrees.
    .replace(/\/[^\s:]*\/(?=[\w.-]+\.[a-z]{2,4}\b)/g, '<path>/')
    // ISO timestamps.
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<time>')
    .trim()
}

function git(root: string, args: string[]): string | undefined {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) return undefined
  return r.stdout.trim()
}

/** Conclave's own state is not anyone's work, and rotation writes to it. */
const OWN_STATE = '.conclave/'

export interface CaptureOptions {
  root: string
  /** Paths, repo-relative, whose exact content the handoff depends on. */
  files: string[]
  /** Verification commands, run through a shell from `root`. */
  checks: string[]
  /** Per-check ceiling. A hung check must not hang the transaction. */
  checkTimeoutMs?: number
}

export function runCheck(root: string, command: string, timeoutMs: number): CheckResult {
  const started = Date.now()
  const r = spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  })
  return {
    command,
    // A signalled or un-launchable command has no exit code, and recording 0 or 1 for it
    // would make an unrunnable check compare equal to a passing or failing one.
    exitCode: r.status,
    outputDigest: digest(normalize(`${r.stdout ?? ''}${r.stderr ?? ''}`)),
    durationMs: Date.now() - started,
  }
}

export function capture(opts: CaptureOptions): RepoRecord {
  const { root } = opts
  const timeout = opts.checkTimeoutMs ?? 600_000
  return {
    root,
    head: git(root, ['rev-parse', 'HEAD']),
    branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: (git(root, ['status', '--porcelain']) ?? '')
      .split('\n')
      .filter((l) => l.trim())
      .filter((l) => !l.slice(3).startsWith(OWN_STATE)),
    files: opts.files.map((path) => ({
      path,
      digest: existsSync(join(root, path)) ? digest(readFileSync(join(root, path), 'utf8')) : null,
    })),
    checks: opts.checks.map((c) => runCheck(root, c, timeout)),
    at: Date.now(),
  }
}

/**
 * What changed between the record and now.
 *
 * Empty means the observed state reproduces the recorded one. Anything `blocking` means
 * it does not, and a transfer accepted over it would be exactly the silent failure §7a's
 * step 6 exists to prevent.
 */
export function compare(recorded: RepoRecord, observed: RepoRecord): Divergence[] {
  const out: Divergence[] = []

  if (recorded.head !== observed.head) {
    out.push({
      severity: 'blocking',
      kind: 'head_moved',
      detail: `HEAD was ${recorded.head ?? 'unknown'}, is now ${observed.head ?? 'unknown'}`,
    })
  }

  const before = new Map(recorded.files.map((f) => [f.path, f.digest]))
  for (const f of observed.files) {
    if (!before.has(f.path)) continue
    const was = before.get(f.path)!
    if (was === f.digest) continue
    if (was === null) {
      out.push({ severity: 'blocking', kind: 'file_appeared', detail: `${f.path} did not exist when the handoff was recorded` })
    } else if (f.digest === null) {
      out.push({ severity: 'blocking', kind: 'file_vanished', detail: `${f.path} has been removed since the handoff was recorded` })
    } else {
      out.push({ severity: 'blocking', kind: 'file_changed', detail: `${f.path} changed since the handoff was recorded (${was} → ${f.digest})` })
    }
  }

  const dirtyBefore = new Set(recorded.dirty)
  const newlyDirty = observed.dirty.filter((l) => !dirtyBefore.has(l))
  if (newlyDirty.length > 0) {
    // Advisory: a quiesced implementer writes nothing, but the human shares this tree and
    // is entitled to keep working in it. Blocking here would make rotation depend on the
    // operator sitting still.
    out.push({
      severity: 'advisory',
      kind: 'tree_changed',
      detail: `${newlyDirty.length} path(s) not dirty at handoff: ${newlyDirty.map((l) => l.slice(3)).join(', ')}`,
    })
  }

  const checksBefore = new Map(recorded.checks.map((c) => [c.command, c]))
  for (const c of observed.checks) {
    const was = checksBefore.get(c.command)
    if (!was) continue
    if (was.exitCode !== c.exitCode) {
      out.push({
        severity: 'blocking',
        kind: 'check_exit_changed',
        detail: `\`${c.command}\` exited ${was.exitCode} at handoff, ${c.exitCode} now`,
      })
    } else if (was.outputDigest !== c.outputDigest) {
      out.push({
        severity: 'advisory',
        kind: 'check_output_changed',
        detail: `\`${c.command}\` still exits ${c.exitCode} but its output differs; the digest is normalized, not exact`,
      })
    }
  }
  for (const command of checksBefore.keys()) {
    if (!observed.checks.some((c) => c.command === command)) {
      out.push({ severity: 'blocking', kind: 'check_missing', detail: `\`${command}\` was recorded but not re-run` })
    }
  }

  return out
}

export function blocking(ds: Divergence[]): Divergence[] {
  return ds.filter((d) => d.severity === 'blocking')
}
